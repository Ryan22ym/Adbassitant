/**
 * 设备页「快速投屏」按钮验证（支持开发态 / 安装版两种目标）
 *
 * 开发态（默认）：在 Electron 里以被测应用方式加载 dist/index.html
 *   python scripts/run-electron.py scripts/check-quick-mirror.cjs \
 *       --watch ui-shots/_quickmirror.log --until "QUICK MIRROR CHECK DONE"
 *
 * 安装版：node 直接跑，脚本会启动安装目录里的 exe 并用 CDP 连过去
 *   node scripts/check-quick-mirror.cjs --installed
 *
 * 验证点：
 *  1. 每台就绪设备的行右侧都有「投屏」按钮（行本体是 div[role=button]，避免 button 嵌套）
 *  2. 点击后真的起投屏（主进程 mirrorStatus 显示 running + serial 匹配）
 *  3. 按钮随之变为「停止投屏」，再点能停掉
 *  4. 渲染层无错误（含 React 的嵌套 button 警告）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const INSTALLED = process.argv.includes('--installed');
const MODE = INSTALLED ? 'installed' : 'dev';
const LOG = path.join(OUT, INSTALLED ? '_quickmirror-installed.log' : '_quickmirror.log');

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);

/* ------------------------------------------------------------------ */
/* 两种后台：开发态用 webContents，安装版用 CDP                        */
/* ------------------------------------------------------------------ */

/** 启动安装版并用 CDP 连上，返回与开发态同形的 page 对象 */
async function openInstalled() {
  const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
  const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
  const PORT = 9347;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // ★ 必须：否则 Electron 退化成纯 Node
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: os.tmpdir(), env,
  });
  child.unref();

  const waitTarget = async (retries = 90, interval = 500) => {
    for (let i = 0; i < retries; i++) {
      const page = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              resolve(list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
            } catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });
      if (page) return page;
      await sleep(interval);
    }
    return null;
  };

  const target = await waitTarget();
  if (!target) throw new Error('安装版未能在预期时间内开出调试端点');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  return {
    evalJS: (expr) => cdp.eval(expr),
    screenshot: async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      if (r && r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return r && r.data ? Buffer.from(r.data, 'base64').length : 0;
    },
    close: () => {
      cdp.close();
      try { process.kill(child.pid); } catch { /* ignore */ }
    },
  };
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

/** 与页面交互的公共逻辑（两种后端共用） */
async function runChecks(page) {
  // 轮询等 React 挂载（加载完成 ≠ 首屏渲染完成）
  for (let i = 0; i < 30; i++) {
    const n = await page.evalJS(
      `document.getElementById('root') ? document.getElementById('root').children.length : 0`,
    ).catch(() => 0);
    if (n > 0) break;
    await sleep(400);
  }

  await page.evalJS(`window.location.hash = '#/'; undefined;`);
  await sleep(2500); // 等设备列表扫描 + 详情

  const struct = await page.evalJS(`
    (() => {
      const rows = [...document.querySelectorAll('.device-row')];
      return {
        count: rows.length,
        tags: rows.map((r) => r.tagName),
        roles: rows.map((r) => r.getAttribute('role')),
        hasBtn: rows.map((r) => !!r.querySelector('.device-actions .btn')),
        btnText: rows.map((r) => (r.querySelector('.device-actions .btn')?.textContent || '').trim()),
        disabled: rows.map((r) => r.getAttribute('aria-disabled') === 'true'),
        serials: rows.map((r) => r.querySelector('.device-serial')?.textContent?.trim() || ''),
        nestedButtons: rows.map((r) => r.querySelectorAll('button').length),
      };
    })()
  `);
  log('结构:', JSON.stringify(struct));

  record(struct.count > 0, '设备页有设备行', `${struct.count} 行`);
  record(struct.tags.every((t) => t === 'DIV'), '行本体是 div（不是 button，避免嵌套按钮）', struct.tags.join(','));
  record(struct.roles.every((r) => r === 'button'), '行保留 role=button 语义', struct.roles.join(','));
  record(struct.hasBtn.every(Boolean), '每行都有快速投屏按钮', `按钮文案 [${struct.btnText.join('|')}]`);
  record(struct.nestedButtons.every((n) => n === 1), '每行只含 1 个 button（即快投按钮本身）', struct.nestedButtons.join(','));

  const idx = struct.disabled.findIndex((x) => !x);
  const target = idx >= 0 ? struct.serials[idx] : null;
  if (!target) {
    record(false, '存在就绪设备可投屏', '无可用设备，跳过投屏动作');
    return;
  }
  log('选中设备:', target);

  const clicked = await page.evalJS(`
    (() => {
      const rows = [...document.querySelectorAll('.device-row')];
      const row = rows.find((r) => r.querySelector('.device-serial')?.textContent?.trim() === ${JSON.stringify(target)});
      const btn = row && row.querySelector('.device-actions .btn');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()
  `);
  record(clicked === 'clicked', '点击快速投屏按钮', String(clicked));

  let status = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const res = await page.evalJS(`window.adbApi.mirrorStatus()`);
    status = res && res.data ? res.data : res;
    if (status && status.running) break;
  }
  record(
    !!(status && status.running && status.serial === target),
    '投屏真的起来了（主进程状态 running + serial 匹配）',
    JSON.stringify(status),
  );

  await sleep(1200);
  const after = await page.evalJS(`
    (() => {
      const rows = [...document.querySelectorAll('.device-row')];
      const row = rows.find((r) => r.querySelector('.device-serial')?.textContent?.trim() === ${JSON.stringify(target)});
      const btn = row && row.querySelector('.device-actions .btn');
      return { text: (btn?.textContent || '').trim(), cls: btn?.className || '' };
    })()
  `);
  record(after.text.includes('停止'), '该行按钮变为「停止投屏」', JSON.stringify(after));

  await page.screenshot(path.join(OUT, `devices-quick-mirror-running-${MODE}.png`));

  await page.evalJS(`
    (() => {
      const rows = [...document.querySelectorAll('.device-row')];
      const row = rows.find((r) => r.querySelector('.device-serial')?.textContent?.trim() === ${JSON.stringify(target)});
      row?.querySelector('.device-actions .btn')?.click();
      return true;
    })()
  `);
  let stopped = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const res = await page.evalJS(`window.adbApi.mirrorStatus()`);
    stopped = res && res.data ? res.data : res;
    if (stopped && !stopped.running) break;
  }
  record(!!(stopped && !stopped.running), '再点一次可停止投屏', JSON.stringify(stopped));
}

async function finish(errors) {
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`===== QUICK MIRROR CHECK（${MODE}） =====`);
  for (const r of rows) log(r);
  if (errors.length) {
    log('===== RENDERER ERRORS =====');
    for (const e of errors) log(e);
  } else {
    log('渲染层无错误');
  }
  log(`${pass} 通过 / ${fail} 失败`);
  log('QUICK MIRROR CHECK DONE');
  return fail === 0 && errors.length === 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

if (INSTALLED) {
  (async () => {
    let page = null;
    try {
      page = await openInstalled();
      await runChecks(page);
      await sleep(800);
      await page.screenshot(path.join(OUT, 'devices-quick-mirror-installed.png'));
    } catch (e) {
      record(false, '启动安装版', e.message);
    } finally {
      if (page) page.close();
    }
    const ok = await finish([]);
    process.exit(ok ? 0 : 1);
  })();
} else {
  const electronMain = require('electron');
  if (typeof electronMain !== 'object' || !electronMain.app) {
    log('FATAL 未在 Electron 运行时中执行（开发态请用 run-electron.py 起）');
    process.exit(2);
  }
  const { app, BrowserWindow } = electronMain;

  app.whenReady().then(async () => {
    const { registerIpc } = require('../dist-electron/electron/ipc.js');
    registerIpc();

    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: {
        preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });

    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) errors.push(msg);
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));

    const page = {
      evalJS: (expr) => win.webContents.executeJavaScript(expr),
      screenshot: async (file) => {
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        fs.writeFileSync(file, png);
        return png.length;
      },
      close: () => {},
    };

    await runChecks(page);
    await sleep(800);
    await page.screenshot(path.join(OUT, 'devices-quick-mirror.png'));
    const ok = await finish(errors);
    app.exit(ok ? 0 : 1);
  });
}
