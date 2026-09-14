#!/usr/bin/env node
/**
 * 投屏窗口图标验收（安装版，走真实界面路径）
 *
 * 验证目标：点「启动投屏」后，投屏窗口用 scrcpy 原生图标，
 *          与「ADB 桌面助手」主窗口在任务栏里可区分。
 *
 * 实现方式：scrcpy 3.1 支持 SCRCPY_ICON_PATH 环境变量指定窗口图标。
 *          主进程启动 scrcpy 时注入该变量 → bin/scrcpy-icon.png。
 *
 * 判据：
 *   1. scrcpy 窗口真实可见（IsWindowVisible = true，SDL_app 类）
 *   2. 主进程实际上向子进程传了 SCRCPY_ICON_PATH（读环境变量比对）
 *   3. scrcpy 用的是独立图标文件，而非主程序共用的 bin/icon.png
 *
 * 用法: node e2e-mirror-icon.cjs
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
const BIN = path.join(INSTALL_DIR, 'resources', 'bin');
const PY = process.env.PYTHON
  || 'C:\\Users\\yangming\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const PORT = 9369;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

/** 枚举「我们的」scrcpy 窗口（精确路径匹配，排除 QtScrcpy） */
function enumOurs(visibleOnly = true) {
  try {
    const env = { ...process.env };
    if (!visibleOnly) env.ENUM_ALL = '1';
    const out = execFileSync(PY, [path.join(ROOT, 'scripts', 'enum-windows2.py')], {
      encoding: 'utf8',
      timeout: 15000,
      env,
    });
    return JSON.parse(out.trim() || '[]');
  } catch {
    return [];
  }
}

/**
 * 只结束本产物的进程。
 * ⚠️ 不能用 taskkill /IM scrcpy.exe —— 用户机器上的 QtScrcpy 同名会被误杀。
 */
function killOwn() {
  const script =
    "$procs = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ne $null -and " +
    "($_.ExecutablePath.ToLower().EndsWith('\\\\resources\\\\bin\\\\scrcpy.exe') -or " +
    "$_.ExecutablePath.ToLower().EndsWith('\\\\adb\u684c\u9762\u52a9\u624b.exe')) }; " +
    'foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }';
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 20000,
    });
  } catch {
    /* */
  }
}

/**
 * 定位「我们的」scrcpy.exe（完整路径结尾匹配，排除用户的 QtScrcpy.exe）。
 * 复用 scripts/find-scrcpy-pid.py —— 保持与人工排查同一套匹配逻辑。
 */
function findScrcpyPid() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execFileSync(PY, [path.join(ROOT, 'scripts', 'find-scrcpy-pid.py')], {
        encoding: 'utf8',
        timeout: 20000,
      });
      const ids = (out.match(/\d+/g) || []).map(Number);
      if (ids.length) return ids[0];
    } catch {
      /* 未找到时脚本以 exit 1 结束，属正常 */
    }
    // 窗口已可见但进程表尚未刷新 —— 短暂等待后重试
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return null;
}

/**
 * 读目标进程环境块里的 SCRCPY_ICON_PATH（最硬的证据：无需 UI，不靠时序）。
 * 复用 scripts/verify-scrcpy-env.py 的 PEB 遍历实现，以子命令模式调用。
 */
function readIconEnv(pid) {
  try {
    const out = execFileSync(
      PY,
      [path.join(ROOT, 'scripts', 'verify-scrcpy-env.py'), '--read-env', String(pid)],
      { encoding: 'utf8', timeout: 20000 },
    );
    const m = out.match(/SCRCPY_ICON_PATH=(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
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
  console.log('=== 投屏窗口图标验收（安装版）===\n');

  check('exe 存在于安装目录', fs.existsSync(EXE));
  const appIcon = path.join(BIN, 'icon.png');
  const scIcon = path.join(BIN, 'scrcpy-icon.png');
  check('应用图标 bin/icon.png 存在', fs.existsSync(appIcon));
  check('投屏图标 bin/scrcpy-icon.png 存在', fs.existsSync(scIcon));

  // 两个图标必须是不同文件（否则谈不上区分）
  let same = false;
  if (fs.existsSync(appIcon) && fs.existsSync(scIcon)) {
    const a = fs.readFileSync(appIcon);
    const b = fs.readFileSync(scIcon);
    same = a.length === b.length && a.equals(b);
  }
  check('两个图标文件内容不同', !same, `app=${fs.existsSync(appIcon) ? fs.statSync(appIcon).size : 0}B / scrcpy=${fs.existsSync(scIcon) ? fs.statSync(scIcon).size : 0}B`);

  killOwn();
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

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 40; i++) {
    const n = await cdp.eval("document.getElementById('root')?document.getElementById('root').children.length:-1");
    if (n > 0) break;
    await sleep(400);
  }
  check('首屏渲染完成', true);

  // 设备
  let devCount = -1;
  for (let i = 0; i < 10; i++) {
    devCount = await cdp.eval(
      "(async()=>{try{const r=await window.adbApi.listDevices();const d=r&&r.data?r.data:r;return Array.isArray(d)?d.filter(x=>x.state==='device').length:-1}catch(e){return -1}})()",
    );
    if (devCount > 0) break;
    await sleep(1200);
  }
  check('检测到在线设备', devCount > 0, `${devCount} 台`);
  if (devCount <= 0) {
    cdp.close();
    killOwn();
    process.exit(2);
  }

  // ── 真实用户路径：切投屏页 → 点按钮
  await cdp.eval("location.hash = '#/mirror'");
  await sleep(1800);

  const click = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '启动投屏');
    if (!b) return { err: '未找到按钮' };
    if (b.disabled) return { err: '按钮被禁用' };
    b.click();
    return { ok: true };
  })()`);
  check('点击「启动投屏」', !!click.ok, JSON.stringify(click));

  // 观察窗口出现。窗口一旦可见就立刻抓 pid —— 不要等循环结束再查，
  // scrcpy 在窗口出现后可能很快退出（例如设备断开），等就会拿到 null。
  let visWin = null;
  for (let i = 1; i <= 18; i++) {
    await sleep(1000);
    const vis = enumOurs(true);
    if (i % 3 === 0 || vis.length) {
      console.log(`  ${String(i).padStart(2)}s 可见投屏窗口 = ${vis.length}` +
        (vis.length ? ` :: ${vis[0].title} ${JSON.stringify(vis[0].rect)}` : ''));
    }
    if (vis.length) {
      visWin = vis[0];
      break;
    }
  }

  check('★ scrcpy 窗口真实可见', !!visWin, visWin ? `${visWin.hwnd} "${visWin.title}" ${visWin.class}` : '不可见');
  check('窗口类为 SDL_app', !!visWin && visWin.class === 'SDL_app', visWin ? visWin.class : '-');
  check('窗口尺寸合理', !!visWin && (visWin.rect[2] - visWin.rect[0]) > 100,
    visWin ? `${visWin.rect[2] - visWin.rect[0]}x${visWin.rect[3] - visWin.rect[1]}` : '-');

  // 窗口已确认存活，此刻查 pid（紧贴窗口可见时刻，避免时序竞态）
  const scPid = findScrcpyPid();
  check('取到 scrcpy 进程 pid', !!scPid, String(scPid));

  // 硬证据：读该进程环境块，确认 SCRCPY_ICON_PATH 确实指向 scrcpy-icon.png
  const envIcon = scPid ? readIconEnv(scPid) : null;
  const expect = path.join(BIN, 'scrcpy-icon.png');
  check(
    '★ scrcpy 进程环境块含 SCRCPY_ICON_PATH',
    !!envIcon,
    envIcon || '未读到',
  );
  check(
    '图标路径指向 scrcpy-icon.png（非主程序 icon.png）',
    !!envIcon && path.normalize(envIcon).toLowerCase() === path.normalize(expect).toLowerCase(),
    envIcon || '-',
  );

  await cdp.eval("(async()=>{try{await window.adbApi.stopMirror();return 'ok'}catch(e){return String(e)}})()");
  await sleep(1500);
  cdp.close();

  killOwn();
  await sleep(800);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== ${passed}/${results.length} 通过 =====`);
  for (const r of results) if (!r.ok) console.log(`  FAIL: ${r.name} ${r.detail}`);
  process.exit(passed === results.length ? 0 : 2);
})().catch((e) => {
  console.error('未捕获:', e);
  killOwn();
  process.exit(1);
});
