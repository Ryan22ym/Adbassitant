#!/usr/bin/env node
/**
 * 生产包验收 · Stage 3 —— portable 便携版
 *
 * 验证 ADB桌面助手-v0.9.0-portable.exe 能正常自解压并启动。
 *
 * 背景：曾误判 portable 版"因产品名含中文而自解压失败（退出码 9）"。
 * 真实原因是两个环境/配置问题：
 *   1) ELECTRON_RUN_AS_NODE=1 使 Electron 二进制退化为纯 Node
 *   2) signAndEditExecutable:false 使 exe 版本资源未改写
 * 两者修复后 portable 可正常启动。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'out-v1', 'ADB桌面助手-v0.9.0-portable.exe');
const PORT = 9335;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitTarget(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const page = JSON.parse(body).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return resolve(page);
          } catch { /* ignore */ }
          if (Date.now() > deadline) return resolve(null);
          setTimeout(tick, 700);
        });
      }).on('error', () => {
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 700);
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
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws: ' + (e.message || 'err'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  console.log('=== 生产包验收 · Stage 3：portable 便携版 ===\n');

  check('portable 产物存在', fs.existsSync(EXE),
    fs.existsSync(EXE) ? `${(fs.statSync(EXE).size / 1024 / 1024).toFixed(2)} MB` : EXE);
  if (!fs.existsSync(EXE)) { summarize(); return; }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: os.tmpdir(), env,
  });
  child.unref();
  const pid = child.pid;
  console.log(`启动 portable，pid=${pid}（自解压到 %TEMP%，稍慢）...`);

  // 早期探活：确认不是立刻退出（旧版退出码 9 就死在这里）
  await sleep(2500);
  let early = true;
  try { process.kill(pid, 0); } catch { early = false; }
  check('portable 自解压未被拒绝', early, early ? '进程存活' : `pid ${pid} 已退出（历史症状：退出码 9）`);

  const target = await waitTarget();
  check('调试端点就绪', !!target, target ? target.url.slice(0, 130) : '超时');
  if (!target) {
    try { process.kill(pid); } catch { /* ignore */ }
    summarize();
    return;
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const snapshot = `(() => ({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    bridge: window.adbApi ? Object.keys(window.adbApi).length : 0,
    rootChild: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    text: (document.body.innerText || '').slice(0, 60),
  }))()`;

  // 重要：CDP 端点就绪 ≠ 首屏渲染完成。portable 首启还需解压 + 冷启动，
  //       React 挂载可能滞后数百毫秒到数秒，必须轮询等待。
  //       一次性求值会产生假失败（曾误报 "root 子节点 0"）。
  let info = null;
  for (let i = 0; i < 30; i++) {
    try { info = await cdp.eval(snapshot); } catch { info = null; }
    if (info && info.rootChild > 0) break;
    await sleep(400);
  }
  if (!info) info = { href: '', readyState: '', title: '', bridge: 0, rootChild: -1 };

  console.log(`  页面: ${info.href}`);
  console.log(`  标题: ${info.title}`);
  check('从 %TEMP% 解压目录加载页面', /AppData[\\/]Local[\\/]Temp/i.test(decodeURIComponent(info.href)), decodeURIComponent(info.href).slice(0, 110));
  check('React 已挂载', info.rootChild > 0, `root 子节点 ${info.rootChild}`);
  check('preload 桥接就绪', info.bridge >= 30, `${info.bridge} 个方法`);

  const envRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.checkEnv()); } catch (e) { return '{}'; }
  })()`);
  let envOk = false;
  let envDetail = '';
  try {
    const e = JSON.parse(envRaw);
    const d = e && (e.data || e);
    envOk = !!(d && d.allOk);
    envDetail = d && d.items ? `${d.items.length} 项 allOk=${d.allOk}` : '';
  } catch { /* ignore */ }
  check('便携版环境自检通过', envOk, envDetail || String(envRaw).slice(0, 120));

  cdp.close();
  try { process.kill(pid); } catch { /* ignore */ }
  await sleep(1000);
  summarize();

  function summarize() {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
    const fails = results.filter((r) => !r.ok);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(`  - ${f.name} :: ${f.detail}`);
    }
    const out = path.join(ROOT, 'docs', 'test-packaged-stage3.txt');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, [
      `生产包验收 Stage 3（portable）· ${new Date().toISOString()}`,
      `exe: ${EXE}`,
      '',
      ...results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' :: ' + r.detail : ''}`),
      '',
      `合计：${pass}/${results.length} 通过`,
    ].join('\n'), 'utf8');
    console.log(`结果已写入 ${out}`);
    process.exit(fails.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(1);
});
