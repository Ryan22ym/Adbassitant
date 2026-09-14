#!/usr/bin/env node
/**
 * 生产包验收 · Stage 2 —— 核心功能实测
 *
 * 在【真实生产构建】里跑一遍 v0.9 的核心能力：
 *   分辨率读取 / 截图落地 / 投屏启停 / adb 命令 / 日志导出 / 设置持久化
 *
 * 与 Stage 1 相同的 CDP 驱动方式，但聚焦"干活"而不是"能打开"。
 * 依赖：真机已连接（默认取第一台 state=device 的设备）。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'out-v1', 'win-unpacked', 'ADB桌面助手.exe');
const PORT = 9334;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchTargets(retries = 40, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
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
      }).on('error', () => {
        if (n >= retries) return resolve(null);
        setTimeout(tick, interval);
      });
    };
    tick();
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
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
      }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  console.log('=== 生产包验收 · Stage 2：核心功能 ===\n');

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: os.tmpdir(), env: childEnv,
  });
  child.unref();
  const pid = child.pid;
  console.log(`启动生产版 pid=${pid}，等待页面就绪...`);

  const target = await fetchTargets();
  if (!target) {
    console.log('!! 无法连接远程调试端点');
    try { process.kill(pid); } catch { /* ignore */ }
    process.exit(1);
  }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  check('生产版页面就绪', true, target.url.split('/').pop());

  // 取一台就绪设备
  let serial = null;
  for (let i = 0; i < 5 && !serial; i++) {
    const raw = await cdp.eval(`(async () => {
      try { return JSON.stringify(await window.adbApi.listDevices()); } catch (e) { return '[]'; }
    })()`);
    try {
      const d = JSON.parse(raw);
      const arr = Array.isArray(d) ? d : (d && d.data) || [];
      const dev = arr.find((x) => (x.state || x.status) === 'device');
      if (dev) serial = dev.serial || dev.id;
    } catch { /* ignore */ }
    if (!serial) await sleep(1500);
  }
  check('找到就绪设备', !!serial, serial || '无');
  if (!serial) {
    try { process.kill(pid); } catch { /* ignore */ }
    summarize();
  }

  const S = JSON.stringify(serial);

  // —— 分辨率读取 ——
  const resRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.getResolution(${S})); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  let res = null;
  try { res = JSON.parse(resRaw); } catch { /* ignore */ }
  const rd = res && (res.data || res);
  console.log('  分辨率返回:', JSON.stringify(rd));
  check('读取分辨率', !!(rd && (rd.width || rd.size || rd.physical)), rd ? `${rd.width || rd.size || JSON.stringify(rd).slice(0, 60)}` : String(resRaw).slice(0, 120));

  // —— 截图落地 ——
  const shotRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.captureScreenshot(${S})); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  let shot = null;
  try { shot = JSON.parse(shotRaw); } catch { /* ignore */ }
  const sd = shot && (shot.data || shot);
  const shotPath = sd && (sd.localPath || sd.path || sd.file || sd.filePath);
  if (shotPath && fs.existsSync(shotPath)) {
    const buf = fs.readFileSync(shotPath);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    check('截图落地为合法 PNG', isPng, `${path.basename(shotPath)}  ${(buf.length / 1024).toFixed(1)} KB`);
  } else {
    check('截图落地为合法 PNG', false, String(shotRaw).slice(0, 150));
  }

  // —— adb 命令 ——
  const cmdRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.runAdb(${S}, 'shell getprop ro.product.model')); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  let cmd = null;
  try { cmd = JSON.parse(cmdRaw); } catch { /* ignore */ }
  const cd = cmd && (cmd.data || cmd);
  const cmdOut = cd && (cd.stdout || cd.output || '');
  console.log('  adb 命令原始返回:', String(cmdRaw).slice(0, 300));
  check('执行 adb 命令', !!cmdOut && String(cmdOut).trim().length > 0, String(cmdOut).trim().slice(0, 60));

  // —— 投屏启停 ——
  const mStartRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.startMirror({ serial: ${S} })); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  await sleep(5000);
  const mStatRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.mirrorStatus()); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  let mstat = null;
  try { mstat = JSON.parse(mStatRaw); } catch { /* ignore */ }
  const ms = mstat && (mstat.data || mstat);
  let alive = false;
  if (ms && ms.running && ms.pid) {
    try { process.kill(ms.pid, 0); alive = true; } catch { alive = false; }
  }
  console.log('  投屏启动返回:', String(mStartRaw).slice(0, 120));
  console.log('  投屏状态:', JSON.stringify(ms));
  check('投屏启动且进程存活', !!(ms && ms.running && alive), ms ? `running=${ms.running} pid=${ms.pid} alive=${alive}` : String(mStatRaw).slice(0, 120));

  const mStopRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.stopMirror()); } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  await sleep(1200);
  const afterRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.mirrorStatus()); } catch (e) { return '{}'; }
  })()`);
  let after = null;
  try { after = JSON.parse(afterRaw); } catch { /* ignore */ }
  const ad = after && (after.data || after);
  check('投屏可正常停止', !!(ad && ad.running === false), `running=${ad && ad.running}`);

  // —— 日志导出（走 dialog 会阻塞，只验证数据通路）——
  const logsRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.getAllLogs()); } catch (e) { return '[]'; }
  })()`);
  let logs = [];
  try {
    const l = JSON.parse(logsRaw);
    logs = Array.isArray(l) ? l : (l && l.data) || [];
  } catch { /* ignore */ }
  check('运行日志可读取', logs.length > 0, `${logs.length} 条`);

  // —— 设置持久化 ——
  const setRaw = await cdp.eval(`(async () => {
    try {
      await window.adbApi.setSettings({ theme: 'dark' });
      const s = await window.adbApi.getSettings();
      return JSON.stringify(s);
    } catch (e) { return JSON.stringify({__err:String(e)}); }
  })()`);
  let st = null;
  try { st = JSON.parse(setRaw); } catch { /* ignore */ }
  const std = st && (st.data || st);
  check('设置可读写', !!(std && std.theme === 'dark'), std ? `theme=${std.theme}` : String(setRaw).slice(0, 120));

  cdp.close();
  try { process.kill(pid); } catch { /* ignore */ }
  await sleep(800);
  summarize();

  function summarize() {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
    const fails = results.filter((r) => !r.ok);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(`  - ${f.name} :: ${f.detail}`);
    }
    const outFile = path.join(ROOT, 'docs', 'test-packaged-stage2.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, [
      `生产包验收 Stage 2 · ${new Date().toISOString()}`,
      `exe: ${EXE}`,
      '',
      ...results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' :: ' + r.detail : ''}`),
      '',
      `合计：${pass}/${results.length} 通过`,
    ].join('\n'), 'utf8');
    console.log(`结果已写入 ${outFile}`);
    process.exit(fails.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(1);
});
