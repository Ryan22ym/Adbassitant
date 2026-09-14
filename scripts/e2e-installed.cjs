#!/usr/bin/env node
/**
 * 安装版验收 · Stage 4 —— 真实安装产物
 *
 * 与 Stage 1~3 的区别：它跑的不是 out-v1/win-unpacked，而是 **NSIS 安装到
 * %LOCALAPPDATA%\Programs\ADBDesktopAssistant 之后的真实安装目录**。
 * 目的是验证「用户双击安装 → 开始菜单启动 → 程序能用」这条完整链路，
 * 而不是只验证打包目录能跑。
 *
 * 额外覆盖安装版特有产物：Uninstall 程序、resources/bin 随包二进制。
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
const UNINST = path.join(INSTALL_DIR, 'Uninstall ADB桌面助手.exe');
const PORT = 9335;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitTarget(retries = 90, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
              if (page) return resolve(page);
            } catch { /* ignore */ }
            if (n >= retries) return resolve(null);
            setTimeout(tick, interval);
          });
        })
        .on('error', () => {
          if (n >= retries) return resolve(null);
          setTimeout(tick, interval);
        });
    };
    tick();
  });
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  console.log('=== 生产包验收 · Stage 4：NSIS 安装版 ===\n');
  console.log(`安装目录：${INSTALL_DIR}\n`);

  // —— 安装产物完整性 ——
  check('安装目录存在', fs.existsSync(INSTALL_DIR), INSTALL_DIR);
  if (!fs.existsSync(INSTALL_DIR)) { summarize(); return; }

  check('主程序已安装', fs.existsSync(EXE),
    fs.existsSync(EXE) ? `${(fs.statSync(EXE).size / 1024 / 1024).toFixed(2)} MB` : EXE);
  check('卸载程序已生成', fs.existsSync(UNINST),
    fs.existsSync(UNINST) ? `${(fs.statSync(UNINST).size / 1024).toFixed(0)} KB` : UNINST);

  const binDir = path.join(INSTALL_DIR, 'resources', 'bin');
  const binFiles = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
  const need = ['adb.exe', 'scrcpy.exe', 'scrcpy-server', 'AdbWinApi.dll', 'SDL2.dll', 'avcodec-61.dll'];
  const missing = need.filter((f) => !binFiles.includes(f));
  check('随包二进制经 extraResources 就位', missing.length === 0,
    missing.length ? '缺失: ' + missing.join(', ') : `${binFiles.length} 个文件`);
  check('图标资源就位', binFiles.includes('icon.png'), '');

  // —— 从安装目录启动 ——
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // ★ 必须
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: require('os').tmpdir(), env,
  });
  child.unref();
  const pid = child.pid;
  console.log(`\n从安装目录启动，pid=${pid}...`);

  const target = await waitTarget();
  check('安装版可启动并开调试端点', !!target, target ? '端口已响应' : `${PORT} 无响应`);
  if (!target) { try { process.kill(pid); } catch { /* */ } summarize(); return; }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  // 轮询等首屏（CDP 就绪 ≠ 渲染完成）
  const snap = `(() => ({
    href: location.href,
    title: document.title,
    bridge: window.adbApi ? Object.keys(window.adbApi).length : 0,
    rootChild: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  }))()`;
  let info = null;
  for (let i = 0; i < 30; i++) {
    try { info = await cdp.eval(snap); } catch { info = null; }
    if (info && info.rootChild > 0) break;
    await sleep(400);
  }
  if (!info) info = { href: '', title: '', bridge: 0, rootChild: -1 };

  console.log(`  页面: ${info.href}`);
  console.log(`  标题: ${info.title}`);
  // 断言页面确实从【安装目录】加载（而非开发目录或 win-unpacked）
  const hrefDecoded = decodeURIComponent(info.href || '');
  const installedFrom = hrefDecoded.includes(INSTALL_DIR.replace(/\\/g, '/'))
    || hrefDecoded.includes(INSTALL_DIR);
  check('页面从安装目录 asar 加载', installedFrom, hrefDecoded.slice(0, 120));
  check('React 已挂载', info.rootChild > 0, `root 子节点 ${info.rootChild}`);
  check('preload 桥接就绪', info.bridge >= 30, `${info.bridge} 个方法`);

  // —— 用随包 adb 枚举设备 ——
  let devs = [];
  for (let i = 0; i < 3; i++) {
    const raw = await cdp.eval(`(async () => {
      try { return JSON.stringify(await window.adbApi.listDevices()); } catch (e) { return '[]'; }
    })()`);
    try {
      const p = JSON.parse(raw);
      devs = Array.isArray(p) ? p : (p && p.data) || [];
    } catch { devs = []; }
    if (devs.length) break;
    await sleep(1500);
  }
  const readyDevs = devs.filter((d) => (d.state || d.status) === 'device');
  check('随包 adb 可用并枚举到设备', devs.length > 0,
    `${devs.length} 台（就绪 ${readyDevs.length}）: ${devs.map((d) => d.serial).join(', ')}`);

  // —— 环境自检 ——
  const envRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.checkEnv()); } catch (e) { return '{}'; }
  })()`);
  let envOk = false, envDetail = '';
  try {
    const e = JSON.parse(envRaw);
    const d = e && (e.data || e);
    envOk = !!(d && d.allOk);
    envDetail = d && d.items ? `${d.items.length} 项 allOk=${d.allOk}` : String(envRaw).slice(0, 80);
  } catch { /* */ }
  check('安装版环境自检通过', envOk, envDetail);

  // —— 跑一次真实功能：读分辨率 ——
  const serial = (readyDevs[0] || devs[0] || {}).serial;
  if (serial) {
    const rdRaw = await cdp.eval(`(async () => {
      try { return JSON.stringify(await window.adbApi.getResolution(${JSON.stringify(serial)})); }
      catch (e) { return '{}'; }
    })()`);
    let ok = false, detail = '';
    try {
      const p = JSON.parse(rdRaw);
      const d = p && (p.data || p);
      ok = !!(d && (d.current || d.physical || d.size));
      detail = d ? `${d.current || d.physical || ''}${d.density ? ' / ' + d.density + 'dpi' : ''}` : '';
    } catch { detail = String(rdRaw).slice(0, 80); }
    check('安装版可执行真实 adb 功能（读分辨率）', ok, detail);
  } else {
    check('安装版可执行真实 adb 功能（读分辨率）', false, '无就绪设备，跳过');
  }

  // —— 正常退出 ——
  cdp.close();
  try { process.kill(pid); } catch { /* */ }
  await sleep(800);
  let dead = true;
  try { process.kill(pid, 0); dead = false; } catch { dead = true; }
  check('安装版可正常退出', dead, dead ? '已退出' : `pid ${pid} 仍存活`);

  summarize();

  function summarize() {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
    const fails = results.filter((r) => !r.ok);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(`  - ${f.name} :: ${f.detail}`);
    }
    const outFile = path.join(__dirname, '..', 'docs', 'test-packaged-stage4.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, [
      `生产包验收 Stage 4（NSIS 安装版）· ${new Date().toISOString()}`,
      `install: ${INSTALL_DIR}`,
      '',
      ...results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' :: ' + r.detail : ''}`),
      '',
      `合计：${pass}/${results.length} 通过`,
    ].join('\n'), 'utf8');
    console.log(`结果已写入 ${outFile}`);
    process.exit(fails.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('未捕获错误:', e);
  process.exit(1);
});
