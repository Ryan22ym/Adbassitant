/**
 * 界面配置（Conf/ 目录）生效校验。
 *
 * 用户手改 Conf/*.json → 重启 → 界面跟着变，这是这一版的主打能力，
 * 所以必须有脚本盯着，不然「改完没反应」只能靠人肉试。
 *
 * 三阶段在同一次进程里跑（主进程有个「启动读一次」的缓存，
 * 靠 services/ui-conf.ts 导出的 resetUiConfCache() 手动清掉才能连验三种状态）：
 *
 *   0. 出厂形态 —— 仓库根 Conf/ 就是出厂内容，导航 9 项、工具页 7 个标签，
 *      顺序必须与 v1.1.11 写死的顺序逐字一致（Conf 被删掉时界面不能变样）。
 *   1. 自定义生效 —— 把三份文件改成「投屏提前、关掉三个入口、反转两块折叠」，
 *      断言顺序 / 显隐 / 折叠**三条链路**都真的接到了渲染层。
 *   2. 容错 —— 把 layout.json 写成坏 JSON、features.json 置 _enabled:false，
 *      断言程序照常起来、整份回落出厂默认、且渲染层不报错。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-ui-conf.cjs \
 *     --watch ui-shots/_ui-conf.log --until "UI CONF CHECK DONE" --timeout 300
 *
 * 🔴 脚本会**改写仓库根的 Conf/*.json**，结束时原样写回（finally + 进程退出双保险）。
 *    中途强杀进程有可能留下测试内容 —— 那三份文件的正确内容在
 *    shared/ui-conf.ts 的 DEFAULT_* 里，照着改回来即可。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
/**
 * 日志文件。**两种后端各写一个** —— package.json 里的 `check:ui-conf` 与
 * `check:ui-conf:installed` 分别 watch 其中一个；写错了会表现为
 * 「子进程退出码 0，但 run-electron 说日志没内容」的假失败。
 */
const LOG = path.join(
  OUT,
  process.argv.includes('--installed') ? '_ui-conf-installed.log' : '_ui-conf.log',
);
/** 开发期生效的配置目录就是仓库根的 Conf/（见 services/ui-conf.ts 的 activeConfDir） */
const CONF = path.join(ROOT, 'Conf');
const FILES = ['layout.json', 'panels.json', 'features.json'];

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 配置文件读写（带原样备份）                                            */
/* ------------------------------------------------------------------ */

/** 原始内容，进程退出时无条件写回 */
const ORIGINAL = {};
for (const name of FILES) {
  const p = path.join(CONF, name);
  ORIGINAL[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

let restored = false;
function restoreConf() {
  if (restored) return;
  restored = true;
  for (const name of FILES) {
    const p = path.join(CONF, name);
    try {
      if (ORIGINAL[name] === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else {
        fs.writeFileSync(p, ORIGINAL[name]);
      }
    } catch (e) {
      /* 恢复失败也不能让脚本挂掉，最后会打日志 */
      process.stderr.write(`restore ${name} failed: ${e.message}\n`);
    }
  }
}
process.on('exit', restoreConf);

/** 写一份配置（对象 → JSON；字符串 → 原样写，用来构造坏 JSON） */
function writeConf(name, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(CONF, name), text);
}

/* ------------------------------------------------------------------ */
/* 渲染层读取辅助                                                       */
/* ------------------------------------------------------------------ */

/** 轮询到一个 truthy 结果为止（配置经 IPC 异步到位，不能只 sleep 一次就断言） */
async function waitFor(win, expr, timeout = 5000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await win.webContents.executeJavaScript(expr);
    } catch {
      last = undefined;
    }
    if (last && (!Array.isArray(last) || last.length > 0)) return last;
    await sleep(120);
  }
  return last;
}

const READ_NAV = `[...document.querySelectorAll('.nav-item .nav-label')].map(e => e.textContent.trim())`;
const READ_TABS = `[...document.querySelectorAll('.tabs .tab')].map(e => e.textContent.trim())`;

/*
 * 下面三段表达式**两套后端共用**：开发态走 webContents.executeJavaScript，
 * 安装版走 CDP 的 Runtime.evaluate。用例代码只有一份，避免两边断言漂移。
 */

/** 按标题前缀找一块 Card，读它的折叠形态 */
const CARD_EXPR = (title) => `
    (() => {
      const el = [...document.querySelectorAll('.card')].find((c) => {
        const h = c.querySelector('.card-title');
        return h && h.textContent.trim().startsWith(${JSON.stringify(title)});
      });
      if (!el) return null;
      const body = el.querySelector(':scope > div');
      return {
        collapsed: el.classList.contains('is-collapsed'),
        collapsible: el.classList.contains('card-collapsible'),
        bodyCollapsedClass: body ? body.classList.contains('card-body-collapsed') : null,
        ariaHidden: body ? body.getAttribute('aria-hidden') : null,
      };
    })()
  `;

/** 点某个工具页标签 */
const CLICK_TAB_EXPR = (label) => `
    (() => {
      const b = [...document.querySelectorAll('.tabs .tab')]
        .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()
  `;

/** 切换路由（HashRouter） */
const GOTO_EXPR = (hash) => `window.location.hash = ${JSON.stringify(hash)}`;

function readCard(win, title) {
  return win.webContents.executeJavaScript(CARD_EXPR(title));
}

function clickTab(win, label) {
  return win.webContents.executeJavaScript(CLICK_TAB_EXPR(label));
}

/** 切页（HashRouter，直接改 hash 即可） */
async function goto(win, hash) {
  await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(hash)}`);
  await sleep(320);
}

/** 重新载入窗口，并等界面骨架挂上来 */
async function reload(win, hash = '/tools') {
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash });
  await sleep(700);
  await waitFor(win, `document.querySelectorAll('.nav-item').length > 0`);
  return sleep(180);
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

const rows = [];
const ok = (cond, name, detail) =>
  rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
const eq = (actual, name, expect) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expect),
    name,
    `\n      got    = ${JSON.stringify(actual)}\n      expect = ${JSON.stringify(expect)}`,
  );

/** 出厂导航顺序（与 shared/ui-conf.ts 的 DEFAULT_LAYOUT.sidebar.order 对应） */
const FACTORY_NAV = [
  '设备',
  '投屏',
  '常用工具',
  '应用管理',
  '实时 Logcat',
  '弱网模拟',
  '自动连点器',
  '命令终端',
  '设置',
];
/**
 * 出厂工具页**标签**顺序。
 * ⚠️ 标签名与内容块的 Card 标题不是一回事：标签叫「Monkey 测试」，
 *    切过去以后那块 Card 的标题是「Monkey 稳定性测试」。
 */
const FACTORY_TABS = ['截图', '录屏', '分辨率', 'Monkey 测试', '安装安装包', '文件传输', 'Logcat 导出'];

/** 工具页里「Monkey」的：标签名 / Card 标题（两处写法不同，见上） */
const MONKEY_TAB = 'Monkey 测试';
const MONKEY_CARD = 'Monkey 稳定性测试';

/* ------------------------------------------------------------------ */
/* 安装版后端（CDP）                                                    */
/* ------------------------------------------------------------------ */

/*
 * 为什么必须单独验一遍安装版：
 *   开发态读的是**仓库根的 Conf/**，安装版读的是 **exe 同级的 Conf/** ——
 *   这是两条不同的路径分支（services/ui-conf.ts 的 activeConfDir）。
 *   用户手改的、以及「首次启动从 resources/Conf 铺一份过来」的那份，
 *   都是 exe 同级那个。开发态全绿完全不能证明这条链路通。
 */
const INSTALLED_EXE = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'ADBAssistant',
  'ADB桌面助手.exe',
);
const INSTALLED_CONF = path.join(path.dirname(INSTALLED_EXE), 'Conf');
const CDP_PORT = 9352;

/** 安装版那份配置的原样备份（改动前先存，结束时写回） */
const INSTALLED_ORIGINAL = {};
let installedRestored = false;

function backupInstalledConf() {
  for (const name of FILES) {
    const p = path.join(INSTALLED_CONF, name);
    INSTALLED_ORIGINAL[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
}

function restoreInstalledConf() {
  if (installedRestored) return;
  if (Object.keys(INSTALLED_ORIGINAL).length === 0) return;
  installedRestored = true;
  for (const name of FILES) {
    const p = path.join(INSTALLED_CONF, name);
    try {
      if (INSTALLED_ORIGINAL[name] === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else {
        fs.writeFileSync(p, INSTALLED_ORIGINAL[name]);
      }
    } catch (e) {
      process.stderr.write(`restore installed ${name} failed: ${e.message}\n`);
    }
  }
}
process.on('exit', restoreInstalledConf);

function writeInstalledConf(name, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(INSTALLED_CONF, name), text);
}

class Cdp {
  constructor(url, errors) {
    this.id = 0;
    this.pending = new Map();
    this.errors = errors || [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) =>
        reject(new Error('CDP 连接失败: ' + (e.message || 'unknown'))),
      );
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      /*
       * 渲染层的 error 级日志：Log.entryAdded 与 console.error 走两条路。
       * 安装版看不到 webContents 的 console-message 事件，只能从这里收。
       */
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push(
          (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '),
        );
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    }
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

/** 拉起安装版并连上它的调试端点；返回 { page, pid } */
async function launchInstalled() {
  const { spawn } = require('child_process');
  const os = require('os');
  const env = { ...process.env };
  /* 被宿主设成 1 时 Electron 会退化成纯 Node，无参数静默退出 */
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    INSTALLED_EXE,
    [`--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'],
    { env, detached: true, stdio: 'ignore', cwd: os.tmpdir() },
  );
  const pid = child.pid;
  child.unref();

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    target = await new Promise((resolve) => {
      const req = require('http').get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).find((t) => t.type === 'page' && t.webSocketDebuggerUrl));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(null);
      });
    });
    if (target) break;
  }
  if (!target) throw new Error('安装版未能在 60s 内开出调试端点');

  const errors = [];
  const cdp = new Cdp(target.webSocketDebuggerUrl, errors);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  return { pid, errors, cdp, page: { evalJS: (e) => cdp.eval(e) } };
}

/** 结束安装版（含托盘常驻，关窗口不退出 → 必须按 pid 杀进程树） */
async function killInstalled(pid) {
  const { spawnSync } = require('child_process');
  if (pid) {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  /* 等端口释放，否则下一次连到的还是刚退出的那个进程 */
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const alive = await new Promise((resolve) => {
      const req = require('http').get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (!alive) return;
  }
}

/** 轮询一个表达式，直到拿到非空结果（安装版首屏比开发态慢） */
async function waitForPage(page, expr, timeout = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await page.evalJS(expr);
    } catch {
      last = undefined;
    }
    if (last && (!Array.isArray(last) || last.length > 0)) return last;
    await sleep(300);
  }
  return last;
}

async function gotoPage(page, hash) {
  await page.evalJS(GOTO_EXPR(hash));
  await sleep(400);
}

/**
 * 安装版主线：验「读的是 exe 同级 Conf/」+「改配置重启后界面真的变」。
 *
 * 折叠 / 显隐的三阶段矩阵在开发态已经验透了（那部分与目录无关），
 * 这里只钉安装版**独有**的两件事，控制单次跑测时间 —— 安装版每次重启要十几秒。
 */
async function runInstalled() {
  ok(fs.existsSync(INSTALLED_EXE), '安装版 exe 存在', INSTALLED_EXE);
  const seeded = fs.existsSync(path.join(INSTALLED_CONF, 'features.json'));
  ok(
    seeded,
    '🔴 exe 同级 Conf/ 已生成（首次启动从 resources/Conf 铺一份，用户改的就是这份）',
    INSTALLED_CONF,
  );
  if (!seeded) return;

  backupInstalledConf();

  /* ---- 1. 出厂形态：安装版读 exe 同级那三份（此刻内容是出厂模板） ---- */
  let s = await launchInstalled();
  try {
    const nav = await waitForPage(s.page, READ_NAV);
    eq(nav, '安装版 出厂导航顺序 = 9 项', FACTORY_NAV);

    await gotoPage(s.page, '/tools');
    const tabs = await waitForPage(s.page, READ_TABS);
    eq(tabs, '安装版 出厂「常用工具」标签顺序 = 7 项', FACTORY_TABS);
  } finally {
    s.cdp.close();
    await killInstalled(s.pid);
  }

  /* ---- 2. 改 exe 同级 Conf/，重启后必须跟着变 ---- */
  writeInstalledConf('layout.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    sidebar: { order: ['mirror', 'zzz-not-exist', 'clicker'], defaultCollapsed: false, rememberCollapsed: true },
    toolTabs: { order: ['monkey'] },
  });
  writeInstalledConf('features.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    features: { nav: { weaknet: false } },
  });
  writeInstalledConf('panels.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    panels: { tools: { monkey: true } },
  });

  s = await launchInstalled();
  try {
    const nav = await waitForPage(s.page, READ_NAV);
    eq(
      nav,
      '🔴 安装版 改 exe 同级 Conf/layout.json + features.json 后重启 → 顺序与显隐都变了',
      ['投屏', '自动连点器', '设备', '常用工具', '应用管理', '实时 Logcat', '命令终端', '设置'],
    );

    await gotoPage(s.page, '/tools');
    const tabs = await waitForPage(s.page, READ_TABS);
    /* toolTabs.order 只写了 monkey → 它排首位，其余按出厂顺序接在后面 */
    eq(tabs, '安装版 工具页标签按 toolTabs.order 把 Monkey 提到首位', [
      'Monkey 测试',
      '截图',
      '录屏',
      '分辨率',
      '安装安装包',
      '文件传输',
      'Logcat 导出',
    ]);

    await s.page.evalJS(CLICK_TAB_EXPR(MONKEY_TAB));
    await sleep(400);
    const card = await s.page.evalJS(CARD_EXPR(MONKEY_CARD));
    ok(
      card && card.collapsible && !card.collapsed,
      '🔴 安装版 改 Conf/panels.json 后该块默认展开（出厂是收起）',
      JSON.stringify(card),
    );

    ok(
      s.errors.length === 0,
      '安装版渲染层无 error 级日志',
      s.errors.slice(0, 3).join(' | ') || '(空)',
    );
  } finally {
    s.cdp.close();
    await killInstalled(s.pid);
  }

  restoreInstalledConf();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let win = null;

const INSTALLED = process.argv.includes('--installed');

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  /*
   * 安装版分支跑在 Electron 主进程里，而主进程没有全局 WebSocket
   * （见 scripts/_ws-shim.cjs）；不打这个垫片，CDP 客户端会抛
   * "WebSocket is not defined" —— 变成假失败。
   */
  if (INSTALLED) {
    const patched = require('./_ws-shim.cjs').install();
    log(`ws-shim: ${patched ? '已挂载' : '已存在（未覆盖）'}`);
  }

  try {
    if (INSTALLED) await runInstalled();
    else await run();
  } catch (e) {
    log('=== 脚本异常 ===');
    log(String((e && e.stack) || e));
    restoreConf();
    restoreInstalledConf();
    finish(1);
    return;
  }

  restoreConf();
  restoreInstalledConf();
  finish();
});

function finish(forceFail) {
  log('=== UI CONF CHECK ===');
  for (const r of rows) log(r);
  log(errorsLine(rendererErrors));
  log('UI CONF CHECK DONE');
  if (win) win.hide();
  app.exit(forceFail || rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
}

const rendererErrors = [];

async function run() {
  const ipc = require('../dist-electron/electron/ipc.js');
  const uiConfSvc = require('../dist-electron/electron/services/ui-conf.js');
  ipc.registerIpc();

  /* 生效目录就是仓库根的 Conf/ —— 与脚本改写的是同一处，先确认这点 */
  const activeDir = uiConfSvc.resolveUiConfDir();
  ok(
    path.resolve(activeDir) === path.resolve(CONF),
    '开发期生效的配置目录 = 仓库根 Conf/（脚本改写的就是它）',
    activeDir,
  );

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* 配置到位要走 IPC + React 渲染，隐藏窗口别节流 */
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  /* ---------------------------------------------------------------- */
  /* 阶段 0：出厂形态                                                  */
  /* ---------------------------------------------------------------- */
  await reload(win, '/tools');

  const nav0 = await waitFor(win, READ_NAV);
  eq(nav0, '阶段0 出厂导航顺序 = 9 项且与旧版写死顺序一致', FACTORY_NAV);

  const tabs0 = await waitFor(win, READ_TABS);
  eq(tabs0, '阶段0 出厂「常用工具」标签顺序 = 7 项', FACTORY_TABS);

  /* 出厂 panels：mirror.hotkeys=false / tools.monkey=false 是刻意收起的 */
  await goto(win, '/mirror');
  const hot0 = await readCard(win, '快捷键');
  ok(
    hot0 && hot0.collapsible && hot0.collapsed,
    '阶段0 投屏页「快捷键」默认收起（panels.mirror.hotkeys=false）',
    JSON.stringify(hot0),
  );

  await goto(win, '/tools');
  await clickTab(win, MONKEY_TAB);
  await sleep(260);
  const mon0 = await readCard(win, MONKEY_CARD);
  ok(
    mon0 && mon0.collapsible && mon0.collapsed,
    '阶段0 工具页「Monkey 测试」默认收起（panels.tools.monkey=false）',
    JSON.stringify(mon0),
  );

  /* ---------------------------------------------------------------- */
  /* 阶段 1：自定义配置生效                                            */
  /* ---------------------------------------------------------------- */
  writeConf('layout.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    sidebar: {
      /* 只列两项 + 一个不存在的 id：未知 id 必须被丢掉，其余按出厂顺序补在后面 */
      order: ['mirror', 'zzz-not-exist', 'clicker'],
      defaultCollapsed: false,
      rememberCollapsed: true,
    },
    toolTabs: { order: ['monkey'] },
  });
  writeConf('features.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    features: {
      /* 只关 weaknet / command —— clicker 留着，才能看出 order 把它排到了第二位 */
      nav: { weaknet: false, command: false },
      tools: { record: false, screenshot: false },
    },
  });
  writeConf('panels.json', {
    _说明: '自检脚本临时写入',
    _enabled: true,
    panels: {
      /* 出厂收起的改成展开、出厂展开的改成收起 —— 正反都验一遍 */
      mirror: { hotkeys: true },
      tools: { monkey: true, apk: false },
    },
  });

  uiConfSvc.resetUiConfCache();
  await reload(win, '/tools');

  /* 顺序：用户列的在前，其余按出厂顺序补后面（zzz-not-exist 应被丢掉） */
  const nav1List = await waitFor(win, READ_NAV);
  eq(
    nav1List,
    '阶段1 导航顺序 = 自定义的排前 + 其余按出厂补后（未知 id 已丢弃）',
    ['投屏', '自动连点器', '设备', '常用工具', '应用管理', '实时 Logcat', '设置'],
  );
  ok(
    nav1List[0] === '投屏',
    '阶段1 首个导航项 = 自定义 order 的第一项（投屏）',
    `first=${nav1List[0]}`,
  );
  ok(
    !nav1List.includes('弱网模拟') && !nav1List.includes('命令终端'),
    '阶段1 features.nav=false 的两个入口已从导航摘掉',
    JSON.stringify(nav1List),
  );
  ok(
    (await win.webContents.executeJavaScript(`document.querySelectorAll('.nav-item').length`)) ===
      nav1List.length,
    '阶段1 导航条目数与标签数一致（没有因为未知 id 多出空白项）',
    `items=${nav1List.length}`,
  );

  /* 工具页标签：顺序 + 显隐 */
  const tabs1 = await waitFor(win, READ_TABS);
  eq(
    tabs1,
    '阶段1 工具页标签 = monkey 提前 + 关掉 screenshot/record',
    ['Monkey 测试', '分辨率', '安装安装包', '文件传输', 'Logcat 导出'],
  );

  /* 折叠：出厂收起 → 展开 */
  await goto(win, '/mirror');
  const hot1 = await readCard(win, '快捷键');
  ok(
    hot1 && !hot1.collapsed && hot1.ariaHidden === 'false',
    '阶段1 投屏页「快捷键」改为展开（panels.mirror.hotkeys=true）',
    JSON.stringify(hot1),
  );

  /* 折叠：出厂展开 → 收起（正反都验） */
  await goto(win, '/tools');
  await clickTab(win, '安装安装包');
  await sleep(260);
  const apk1 = await readCard(win, '安装安装包');
  ok(
    apk1 && apk1.collapsible && apk1.collapsed && apk1.bodyCollapsedClass === true,
    '阶段1 工具页「安装安装包」改为收起（panels.tools.apk=false）',
    JSON.stringify(apk1),
  );

  await clickTab(win, MONKEY_TAB);
  await sleep(260);
  const mon1 = await readCard(win, MONKEY_CARD);
  ok(
    mon1 && mon1.collapsible && !mon1.collapsed,
    '阶段1 工具页「Monkey 测试」改为展开（panels.tools.monkey=true）',
    JSON.stringify(mon1),
  );

  /* ---------------------------------------------------------------- */
  /* 阶段 2：容错 —— 坏 JSON + 整份关掉                                 */
  /* ---------------------------------------------------------------- */
  writeConf('layout.json', '{ "sidebar": { "order": [ "mirror" '); // 故意截断
  writeConf('features.json', { _说明: '自检脚本临时写入', _enabled: false, features: {} });
  writeConf('panels.json', { _说明: '自检脚本临时写入', _enabled: false, panels: {} });

  uiConfSvc.resetUiConfCache();
  await reload(win, '/tools');

  const nav2 = await waitFor(win, READ_NAV);
  eq(nav2, '阶段2 layout.json 写坏 + features 整份关掉 → 全部回落出厂形态', FACTORY_NAV);

  const tabs2 = await waitFor(win, READ_TABS);
  eq(tabs2, '阶段2 工具页标签也回落出厂 7 项', FACTORY_TABS);

  await goto(win, '/mirror');
  const hot2 = await readCard(win, '快捷键');
  ok(
    hot2 && hot2.collapsed,
    '阶段2 panels 整份关掉 → 回到出厂默认折叠（快捷键收起）',
    JSON.stringify(hot2),
  );

  /* ---------------------------------------------------------------- */
  /* 阶段 3：恢复原文件并确认回到出厂                                    */
  /* ---------------------------------------------------------------- */
  restoreConf();
  uiConfSvc.resetUiConfCache();
  await reload(win, '/tools');

  const nav3 = await waitFor(win, READ_NAV);
  eq(nav3, '阶段3 原文件写回后恢复出厂导航顺序', FACTORY_NAV);
  ok(
    ORIGINAL['layout.json'] !== null &&
      fs.readFileSync(path.join(CONF, 'layout.json'), 'utf8') === ORIGINAL['layout.json'],
    '阶段3 layout.json 已逐字还原（没把测试内容留在仓库里）',
  );
}

function errorsLine(errors) {
  return errors.length ? `=== 渲染层错误 ===\n${errors.join('\n')}` : '渲染层无错误';
}
