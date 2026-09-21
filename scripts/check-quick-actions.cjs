/**
 * 设备页「快捷动作」验证（开发态为主）
 *
 *   python scripts/run-electron.py scripts/check-quick-actions.cjs \
 *       --watch ui-shots/_quickactions.log --until "QUICK ACTION CHECK DONE"
 *
 * 覆盖三层：
 *   A 契约层 —— quickAction:* 通道的增删改查与清洗规则（不依赖界面）
 *   B 界面层 —— 设备行行内 chip / ⚡ 菜单 / 配置弹层 / 保存后即时生效
 *   C 执行层 —— 真的把动作发到设备上跑一次（只用无副作用的自定义命令）
 *
 * 脚本结束时会把配置恢复成默认，不给用户留测试残留。
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
const LOG = path.join(OUT, INSTALLED ? '_quickactions-installed.log' : '_quickactions.log');

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

/* ------------------------------------------------------------------ */
/* 安装版：CDP 连接（与 check-quick-mirror 一致）                       */
/* ------------------------------------------------------------------ */

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
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function openInstalled() {
  const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
  const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
  const PORT = 9351;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
    env,
  });
  child.unref();

  const waitTarget = async (retries = 90, interval = 500) => {
    for (let i = 0; i < retries; i++) {
      const page = await new Promise((resolve) => {
        http
          .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const list = JSON.parse(body);
                resolve(list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
              } catch {
                resolve(null);
              }
            });
          })
          .on('error', () => resolve(null));
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
    reload: async () => {
      await cdp.send('Page.navigate', { url: target.url });
      await sleep(2500);
    },
    screenshot: async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      if (r && r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return 0;
    },
    close: () => {
      cdp.close();
      try {
        process.kill(child.pid);
      } catch {
        /* ignore */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

/** 直接调 IPC，返回 data（失败返回 { __error }） */
async function callApi(page, expr) {
  const r = await page.evalJS(`(async () => { const r = await ${expr}; return r; })()`);
  if (r && typeof r === 'object' && 'ok' in r) {
    return r.ok ? r.data : { __error: r.error };
  }
  return r;
}

/** 等设备行出现（最多 30s），返回就绪行的 serial 列表 */
async function waitDeviceRows(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evalJS(`
      (() => {
        const rows = [...document.querySelectorAll('.device-row')];
        return {
          total: rows.length,
          ready: rows.filter((r) => r.getAttribute('aria-disabled') !== 'true')
                      .map((r) => r.querySelector('.device-serial')?.textContent?.trim() || ''),
        };
      })()
    `).catch(() => null);
    if (info && info.total > 0) return info;
    await sleep(1000);
  }
  return { total: 0, ready: [] };
}

async function saveActions(page, list) {
  return callApi(
    page,
    `window.adbApi.saveQuickActions(${JSON.stringify(list)})`,
  );
}

const DEFAULT_KINDS = ['clearData', 'homeReturn', 'restart'];

async function runChecks(page) {
  /* ---------- 0. 等 React 挂载 ---------- */
  for (let i = 0; i < 30; i++) {
    const n = await page
      .evalJS(`document.getElementById('root') ? document.getElementById('root').children.length : 0`)
      .catch(() => 0);
    if (n > 0) break;
    await sleep(400);
  }

  await page.evalJS(`window.location.hash = '#/'; undefined;`);
  await sleep(2500);

  // 测试期间会反复改配置，先备份用户原配置，跑完恢复
  const backup = await callApi(page, `window.adbApi.quickActions()`);
  log('原配置备份:', JSON.stringify(Array.isArray(backup) ? backup.map((a) => a.label) : backup));

  // 无头窗口里 window.confirm 会直接挡住流程，统一放行（测试里只跑无副作用动作）
  const stubConfirm = () => page.evalJS(`window.confirm = () => true; undefined;`);
  await stubConfirm();

  /* ============ A. 契约层 ============ */
  log('---- A. 契约层 ----');

  const def = await callApi(page, `window.adbApi.resetQuickActions()`);
  record(
    Array.isArray(def) && def.length === 3,
    'A1 默认配置是 3 条动作',
    JSON.stringify(def && def.map ? def.map((a) => a.kind) : def),
  );
  record(
    Array.isArray(def) && def.map((a) => a.kind).join(',') === DEFAULT_KINDS.join(','),
    'A2 默认动作 = 清数据 / 桌面重进 / 杀进程重进',
    Array.isArray(def) ? def.map((a) => a.label).join(' | ') : '',
  );
  record(
    Array.isArray(def) && def.filter((a) => a.inline).length === 2,
    'A3 默认有 2 条行内直显（第三个收进菜单，避免撑爆设备行）',
    Array.isArray(def) ? String(def.filter((a) => a.inline).length) : '',
  );

  const listed = await callApi(page, `window.adbApi.quickActions()`);
  record(
    Array.isArray(listed) && listed.length === 3,
    'A4 list 能读回默认配置',
    `${Array.isArray(listed) ? listed.length : listed}`,
  );

  // 4 条都标 inline —— 应被清洗成最多 3 条
  const manyInline = [
    { id: 'x1', label: '一', kind: 'clearData', target: 'foreground', inline: true, enabled: true },
    { id: 'x2', label: '二', kind: 'homeReturn', target: 'foreground', inline: true, enabled: true },
    { id: 'x3', label: '三', kind: 'restart', target: 'foreground', inline: true, enabled: true },
    { id: 'x4', label: '四', kind: 'launch', target: 'foreground', inline: true, enabled: true },
    { id: 'x5', label: '五', kind: 'home', inline: false, enabled: true },
  ];
  const saved = await saveActions(page, manyInline);
  record(
    Array.isArray(saved) && saved.filter((a) => a.inline).length === 3,
    'A5 行内直显超过 3 条会被自动降级',
    JSON.stringify(Array.isArray(saved) ? saved.map((a) => `${a.label}:${!!a.inline}`) : saved),
  );
  record(
    Array.isArray(saved) && saved.some((a) => a.kind === 'home') && saved.length === 5,
    'A6 与包名无关的动作（回桌面）也能保存',
    `${Array.isArray(saved) ? saved.length : '?'} 条`,
  );

  const reread = await callApi(page, `window.adbApi.quickActions()`);
  record(
    Array.isArray(reread) && reread.length === 5 && reread[0].id === 'x1',
    'A7 保存后落盘，读取顺序一致',
    JSON.stringify(Array.isArray(reread) ? reread.map((a) => a.id) : reread),
  );

  const dirty = await saveActions(page, [
    { id: 'bad', label: '坏数据', kind: 'not-a-kind', enabled: true },
  ]);
  record(
    Array.isArray(dirty) && dirty.length === 3 && dirty[0].kind === 'clearData',
    'A8 非法 kind 被丢弃，全部非法时回退默认',
    JSON.stringify(Array.isArray(dirty) ? dirty.map((a) => a.kind) : dirty),
  );

  const back = await callApi(page, `window.adbApi.resetQuickActions()`);
  record(
    Array.isArray(back) && back.length === 3,
    'A9 reset 回到默认',
    `${Array.isArray(back) ? back.length : '?'} 条`,
  );

  // 页面只在挂载时读一次配置，改完磁盘得刷一次页面界面才会跟上
  await page.reload();
  await stubConfirm();

  /* ============ B. 界面层 ============ */
  log('---- B. 界面层 ----');

  const dev = await waitDeviceRows(page);
  record(dev.total > 0, 'B0 设备页有设备行', `${dev.total} 行`);

  const ui = await page.evalJS(`
    (() => {
      const rows = [...document.querySelectorAll('.device-row')]
        .filter((r) => r.getAttribute('aria-disabled') !== 'true');
      return {
        readyRows: rows.length,
        bar: rows.map((r) => !!r.querySelector('.qa-bar')),
        chips: rows.map((r) => r.querySelectorAll('.qa-chip').length),
        chipText: rows.map((r) => [...r.querySelectorAll('.qa-chip')].map((c) => c.textContent.trim())),
        more: rows.map((r) => !!r.querySelector('[data-qa-more]')),
        nested: rows.map((r) => r.querySelectorAll('.device-row button button').length),
      };
    })()
  `);
  log('行结构:', JSON.stringify(ui));

  if (ui.readyRows === 0) {
    record(false, 'B1 有就绪设备可验证界面', '无就绪设备，界面用例跳过');
  } else {
    record(ui.bar.every(Boolean), 'B1 每个就绪行都有快捷动作区 .qa-bar', ui.bar.join(','));
    record(
      ui.chips.every((n) => n === 2),
      'B2 行内直显 2 个动作按钮（默认配置）',
      ui.chipText.map((t) => `[${t.join('|')}]`).join(' '),
    );
    record(ui.more.every(Boolean), 'B3 每行都有 ⚡ 菜单按钮', ui.more.join(','));
    record(ui.nested.every((n) => n === 0), 'B4 行内没有 button 嵌套', ui.nested.join(','));

    // 打开 ⚡ 菜单
    await page.evalJS(`
      (() => {
        const row = [...document.querySelectorAll('.device-row')]
          .find((r) => r.getAttribute('aria-disabled') !== 'true');
        row.querySelector('[data-qa-more]').click();
        return true;
      })()
    `);
    await sleep(900);

    const menu = await page.evalJS(`
      (() => {
        const m = document.querySelector('.qa-menu');
        if (!m) return { open: false };
        return {
          open: true,
          items: [...m.querySelectorAll('.qa-menu-item')].map((x) => x.querySelector('.qa-mi-label').textContent.trim()),
          hasFg: !!m.querySelector('[data-qa-fg]'),
          fgText: (m.querySelector('[data-qa-fg]')?.textContent || '').trim(),
          hasConfigure: !!m.querySelector('[data-qa-configure]'),
        };
      })()
    `);
    log('菜单:', JSON.stringify(menu));
    record(menu.open === true, 'B5 点击 ⚡ 弹出动作菜单', JSON.stringify(menu.open));
    record(
      menu.open && menu.items && menu.items.length === 3,
      'B6 菜单里列出全部 3 条启用动作',
      JSON.stringify(menu.items),
    );
    record(menu.open && menu.hasFg, 'B7 菜单显示当前前台应用', menu.fgText || '');
    record(menu.open && menu.hasConfigure, 'B8 菜单里有「配置」入口', '');

    // capturePage 在离屏窗口上会拿到稍早的帧，等久一点再拍，否则拍到菜单还没出现的样子
    await sleep(2200);
    await page.screenshot(path.join(OUT, `devices-quick-actions-menu-${MODE}.png`));

    // 打开配置弹层
    await page.evalJS(`
      (() => { document.querySelector('.qa-menu [data-qa-configure]').click(); return true; })()
    `);
    await sleep(1600);

    const dlg = await page.evalJS(`
      (() => {
        const d = document.querySelector('[data-qa-dialog]');
        if (!d) return { open: false };
        return {
          open: true,
          rows: d.querySelectorAll('.qa-cfg-row').length,
          addBtns: d.querySelectorAll('.qa-add-btn').length,
          title: (d.querySelector('.qa-dialog-title')?.textContent || '').trim(),
        };
      })()
    `);
    log('弹层:', JSON.stringify(dlg));
    record(dlg.open === true, 'B9 点「配置」打开配置弹层', JSON.stringify(dlg.open));
    record(dlg.open && dlg.rows === 3, 'B10 弹层里列出 3 条动作', String(dlg.rows));
    record(dlg.open && dlg.addBtns >= 10, 'B11 提供内置动作清单可添加', String(dlg.addBtns));

    // 添加一个动作并保存
    const added = await page.evalJS(`
      (() => {
        const d = document.querySelector('[data-qa-dialog]');
        const before = d.querySelectorAll('.qa-cfg-row').length;
        // 添加「截图到电脑」
        const btn = [...d.querySelectorAll('.qa-add-btn')]
          .find((b) => b.textContent.includes('截图'));
        if (!btn) return { ok: false, before };
        btn.click();
        return { ok: true, before };
      })()
    `);
    await sleep(500);
    const afterAdd = await page.evalJS(
      `document.querySelectorAll('[data-qa-dialog] .qa-cfg-row').length`,
    );
    record(
      added.ok && afterAdd === added.before + 1,
      'B12 弹层里能添加动作',
      `${added.before} → ${afterAdd}`,
    );

    await sleep(1500);
    await page.screenshot(path.join(OUT, `devices-quick-actions-dialog-${MODE}.png`));

    // 点「保存」
    await page.evalJS(`
      (() => {
        const btns = [...document.querySelectorAll('[data-qa-dialog] .btn')];
        const save = btns.find((b) => b.textContent.trim() === '保存');
        save.click();
        return true;
      })()
    `);
    await sleep(1500);

    const afterSave = await page.evalJS(`
      (() => ({
        dialogClosed: !document.querySelector('[data-qa-dialog]'),
        menuClosed: !document.querySelector('.qa-menu'),
      }))()
    `);
    record(afterSave.dialogClosed, 'B13 保存后弹层关闭', JSON.stringify(afterSave));

    const persisted = await callApi(page, `window.adbApi.quickActions()`);
    record(
      Array.isArray(persisted) && persisted.length === 4,
      'B14 保存真的落盘（4 条）',
      `${Array.isArray(persisted) ? persisted.length : '?'} 条`,
    );
    record(
      Array.isArray(persisted) && persisted.some((a) => a.kind === 'screenshot'),
      'B15 新增的「截图到电脑」在内',
      JSON.stringify(Array.isArray(persisted) ? persisted.map((a) => a.kind) : persisted),
    );

    // 恢复到默认，界面立即反映
    await page.evalJS(`
      (() => {
        const row = [...document.querySelectorAll('.device-row')]
          .find((r) => r.getAttribute('aria-disabled') !== 'true');
        row.querySelector('[data-qa-more]').click();
        return true;
      })()
    `);
    await sleep(500);
    await page.evalJS(`
      (() => { document.querySelector('.qa-menu [data-qa-configure]').click(); return true; })()
    `);
    await sleep(500);
    await page.evalJS(`
      (() => {
        const d = document.querySelector('[data-qa-dialog]');
        const btns = [...d.querySelectorAll('.btn')];
        btns.find((b) => b.textContent.trim() === '恢复默认').click();
        return true;
      })()
    `);
    await sleep(600);
    // confirm 对话框在 Electron 里同步返回 —— 预置一个自动确认
    await sleep(300);
    const rowsAfterReset = await page.evalJS(
      `document.querySelectorAll('[data-qa-dialog] .qa-cfg-row').length`,
    );
    record(rowsAfterReset === 3, 'B16 「恢复默认」把弹层重置成 3 条', String(rowsAfterReset));
    await page.evalJS(`
      (() => {
        const d = document.querySelector('[data-qa-dialog]');
        [...d.querySelectorAll('.btn')].find((b) => b.textContent.trim() === '取消')?.click();
        return true;
      })()
    `);
    await sleep(400);
  }

  /* ============ C. 执行层 ============ */
  log('---- C. 执行层 ----');

  const dev2 = await waitDeviceRows(page);
  const target = dev2.ready[0];
  if (!target) {
    record(false, 'C0 有就绪设备可执行动作', '无就绪设备，执行用例跳过');
  } else {
    const fg = await callApi(page, `window.adbApi.foregroundApp(${JSON.stringify(target)})`);
    record(
      !!(fg && fg.serial === target),
      'C1 前台应用探测通道可用',
      JSON.stringify(fg),
    );

    // 只跑无副作用的动作：自定义命令 echo
    await saveActions(page, [
      {
        id: 'qa-echo',
        label: '自检',
        kind: 'shell',
        target: 'android',
        command: 'echo quick-action-ok',
        inline: true,
        enabled: true,
      },
    ]);
    await page.reload();
    await sleep(2800);
    await stubConfirm();

    const runRes = await page.evalJS(`
      (async () => {
        const r = await window.adbApi.runQuickAction(${JSON.stringify(target)}, {
          id: 'qa-echo', label: '自检', kind: 'shell', target: 'android',
          command: 'echo quick-action-ok', inline: true, enabled: true,
        });
        return r;
      })()
    `);
    const data = runRes && runRes.data ? runRes.data : runRes;
    log('执行结果:', JSON.stringify(data));
    record(
      !!(runRes && runRes.ok) && Array.isArray(data.steps) && data.steps.join(' ').includes('echo'),
      'C2 自定义命令动作真的在设备上跑通（echo 自检）',
      JSON.stringify(data && data.steps),
    );

    // 从界面点一次行内 chip（同样的无副作用动作）
    const chip = await waitDeviceRows(page);
    if (chip.ready.length > 0) {
      const clicked = await page.evalJS(`
        (() => {
          const row = [...document.querySelectorAll('.device-row')]
            .find((r) => r.getAttribute('aria-disabled') !== 'true');
          const btn = row.querySelector('.qa-chip');
          if (!btn) return 'no-chip';
          btn.click();
          return 'clicked';
        })()
      `);
      await sleep(2500);
      const toastText = await page.evalJS(`
        (() => {
          const t = document.querySelector('.toast');
          return t ? t.textContent.trim() : '';
        })()
      `);
      record(
        clicked === 'clicked' && /自检|完成/.test(toastText),
        'C3 点行内 chip 能执行并给出结果提示',
        `${clicked} / toast=${JSON.stringify(toastText)}`,
      );
    }

    // 内置「回桌面」动作（无参数、无副作用）
    const homeRes = await page.evalJS(`
      (async () => window.adbApi.runQuickAction(${JSON.stringify(target)}, {
        id: 'qa-home', label: '回桌面', kind: 'home', inline: false, enabled: true,
      }))()
    `);
    const homeData = homeRes && homeRes.data ? homeRes.data : homeRes;
    record(
      !!(homeRes && homeRes.ok) && Array.isArray(homeData.steps),
      'C4 内置动作（回桌面）执行成功',
      JSON.stringify(homeData && homeData.steps),
    );

    // 清掉测试配置，把用户原配置还原回去
    if (Array.isArray(backup) && backup.length > 0) {
      const chk = await saveActions(page, backup);
      record(
        Array.isArray(chk) && chk.length === backup.length,
        'C5 用户原配置已还原',
        `${Array.isArray(chk) ? chk.length : '?'} 条`,
      );
    } else {
      const restored = await callApi(page, `window.adbApi.resetQuickActions()`);
      record(Array.isArray(restored) && restored.length === 3, 'C5 测试配置已清理，恢复默认', '');
    }
  }

  await page.screenshot(path.join(OUT, `devices-quick-actions-${MODE}.png`));
}

async function finish(errors) {
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`===== QUICK ACTION CHECK（${MODE}） =====`);
  for (const r of rows) log(r);
  if (errors.length) {
    log('===== RENDERER ERRORS =====');
    for (const e of errors) log(e);
  } else {
    log('渲染层无错误');
  }
  log(`${pass} 通过 / ${fail} 失败`);
  log('QUICK ACTION CHECK DONE');
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
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) errors.push(msg);
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));

    const page = {
      evalJS: (expr) => win.webContents.executeJavaScript(expr),
      reload: async () => {
        win.webContents.reload();
        await sleep(2800);
      },
      screenshot: async (file) => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(file, img.toPNG());
        return 0;
      },
      close: () => {},
    };

    try {
      await runChecks(page);
    } catch (e) {
      record(false, '用例执行异常', e.message);
      log('STACK', e.stack || '');
    }
    const ok = await finish(errors);
    app.exit(ok ? 0 : 1);
  });
}
