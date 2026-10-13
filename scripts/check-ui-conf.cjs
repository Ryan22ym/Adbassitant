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
const LOG = path.join(OUT, '_ui-conf.log');
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

/** 按标题前缀找一块 Card，读它的折叠形态 */
function readCard(win, title) {
  return win.webContents.executeJavaScript(`
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
  `);
}

/** 点某个工具页标签 */
function clickTab(win, label) {
  return win.webContents.executeJavaScript(`
    (() => {
      const b = [...document.querySelectorAll('.tabs .tab')]
        .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
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
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let win = null;

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  try {
    await run();
  } catch (e) {
    log('=== 脚本异常 ===');
    log(String((e && e.stack) || e));
    restoreConf();
    log('UI CONF CHECK DONE');
    app.exit(1);
    return;
  }

  restoreConf();
  log('=== UI CONF CHECK ===');
  for (const r of rows) log(r);
  log(errorsLine(rendererErrors));
  log('UI CONF CHECK DONE');

  if (win) win.hide();
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});

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
