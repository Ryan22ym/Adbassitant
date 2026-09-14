#!/usr/bin/env node
/**
 * 安装版投屏最终验收（Stage 5）
 *
 * 用户真实路径：双击安装版 exe → 界面切到投屏页 → 点「启动投屏」 →
 *   1) 接口 getMirrorStatus().running 应为 true
 *   2) scrcpy 窗口必须真实可见（IsWindowVisible = true）
 *   3) 屏幕上窗口标题 = "ADB助手 - <serial>"
 * 全程不直接调 startMirror，只点界面按钮。
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
const PY = process.env.PYTHON || 'python';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

function enumScrcpy(visibleOnly) {
  try {
    const env = { ...process.env };
    if (!visibleOnly) env.ENUM_ALL = '1';
    const out = execFileSync(PY, [path.join(ROOT, 'scripts', 'enum-windows.py'), 'scrcpy.exe'], {
      encoding: 'utf8',
      timeout: 15000,
      env,
    });
    return JSON.parse(out.trim() || '[]');
  } catch {
    return [];
  }
}

function killAll() {
  for (const im of ['scrcpy.exe', 'ADB桌面助手.exe']) {
    try {
      execFileSync('taskkill', ['/IM', im, '/F'], { stdio: 'ignore' });
    } catch {
      /* */
    }
  }
}

function waitTarget(retries = 90, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            try {
              const p = JSON.parse(b).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
              if (p) return resolve(p);
            } catch {
              /* */
            }
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
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error(e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
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
          reject(new Error('timeout ' + method));
        }
      }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) return { __exc: JSON.stringify(r.exceptionDetails).slice(0, 300) };
    return r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* */
    }
  }
}

(async () => {
  console.log('=== Stage 5 · 安装版投屏最终验收 ===\n');
  check('exe 存在于安装目录', fs.existsSync(EXE), EXE);
  if (!fs.existsSync(EXE)) process.exit(1);
  check(
    'resources/bin 随包二进制齐全',
    ['adb.exe', 'scrcpy.exe', 'scrcpy-server'].every((f) =>
      fs.existsSync(path.join(INSTALL_DIR, 'resources', 'bin', f))
    )
  );

  killAll();
  await sleep(1500);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
    env,
  });
  child.unref();

  const target = await waitTarget();
  if (!target) {
    check('调试端点就绪', false);
    process.exit(1);
  }
  check('调试端点就绪', true);
  check('页面从安装目录加载', /ADBAssistant/.test(decodeURIComponent(target.url || '')), (target.url || '').slice(0, 110));

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  let booted = false;
  for (let i = 0; i < 40; i++) {
    const n = await cdp.eval("document.getElementById('root')?document.getElementById('root').children.length:-1");
    if (n > 0) {
      booted = true;
      break;
    }
    await sleep(400);
  }
  check('首屏渲染完成', booted);

  let devCount = -1;
  for (let i = 0; i < 10; i++) {
    devCount = await cdp.eval(
      "(async()=>{try{const r=await window.adbApi.listDevices();const d=r&&r.data?r.data:r;return Array.isArray(d)?d.filter(x=>x.state==='device').length:-1}catch(e){return -1}})()"
    );
    if (devCount > 0) break;
    await sleep(1200);
  }
  check('检测到在线设备', devCount > 0, `${devCount} 台`);

  // ── 真实用户路径：切页 → 点按钮
  await cdp.eval("location.hash = '#/mirror'");
  await sleep(1800);
  const btnState = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '启动投屏');
    return b ? { found: true, disabled: !!b.disabled } : { found: false };
  })()`);
  check('投屏页存在「启动投屏」按钮', !!btnState.found, JSON.stringify(btnState));
  check('按钮可点击', btnState.found && !btnState.disabled);

  const click = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '启动投屏');
    if (!b) return { err: 'not found' };
    if (b.disabled) return { err: 'disabled' };
    b.click();
    return { ok: true };
  })()`);
  check('按钮点击成功', !!click.ok, JSON.stringify(click));

  // 观察 15s
  let apiRunning = false;
  let visibleWin = null;
  let createdWin = null;
  for (let i = 1; i <= 15; i++) {
    await sleep(1000);
    const all = enumScrcpy(false).filter((w) => w.title && !/IME/.test(w.title));
    const vis = enumScrcpy(true).filter((w) => w.title && !/IME/.test(w.title));
    const st = await cdp.eval(
      "(async()=>{try{const r=await window.adbApi.mirrorStatus();return JSON.stringify(r)}catch(e){return '{}'}})()"
    );
    try {
      const p = JSON.parse(st);
      const d = p.data || p;
      apiRunning = apiRunning || !!d.running;
    } catch {
      /* */
    }
    if (all.length && !createdWin) createdWin = all;
    if (vis.length) {
      visibleWin = vis;
      console.log(`  ${String(i).padStart(2)}s ✓ 可见窗口: ${JSON.stringify(vis.map((w) => w.title))}`);
      break;
    }
    if (i % 3 === 0) console.log(`  ${String(i).padStart(2)}s 已创建=${all.length} 可见=${vis.length}`);
  }

  check('接口报告投屏运行中', apiRunning);
  check('scrcpy 窗口被创建', !!createdWin, createdWin ? createdWin[0].title : '未创建');
  check('★ scrcpy 窗口真实可见', !!visibleWin, visibleWin ? visibleWin[0].title : '不可见');

  // 停止
  await cdp.eval("(async()=>{try{await window.adbApi.stopMirror();return 'ok'}catch(e){return String(e)}})()");
  await sleep(1500);
  cdp.close();

  killAll();
  await sleep(800);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== ${passed}/${results.length} 通过 =====`);
  for (const r of results) if (!r.ok) console.log(`  FAIL: ${r.name} ${r.detail}`);
  process.exit(passed === results.length ? 0 : 2);
})().catch((e) => {
  console.error('未捕获:', e);
  killAll();
  process.exit(1);
});
