/*
 * 侧栏入口开关的验收脚本（v1.1.19，配置文件驱动）。
 *
 * 入口开关**只认 Conf/features.json**，界面上没有对应的开关面板。
 * 所以这里验的不是「点一下开关」，而是「改文件 → 重启 → 侧栏跟着变」：
 *
 *   1. 出厂形态：`nav.clicker: false` → 左侧导航里**没有**「自动连点器」；
 *   2. 设置页**不再**有「左侧导航入口」卡片（这个 UI 是被明确要求去掉的）；
 *   3. 把文件改成 `true` → 重新加载后侧栏出现「自动连点器」；
 *   4. 改回 `false` → 重新加载后侧栏消失；
 *   5. 全程不碰用户手写的 `_说明` 等键，验完把文件还原。
 *
 * 用法（不需要真机，脚本只读 Conf 与渲染层 DOM）：
 *   python scripts/run-electron.py scripts/check-nav-toggles.cjs --watch ui-shots/_nav-toggles.log --until "NAV TOGGLE CHECK DONE" --timeout 240
 */
const path = require('path');
const fs = require('fs');

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  console.error('must run under electron');
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_nav-toggles.log');
const CONF = path.join(ROOT, 'Conf', 'features.json');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

let pass = 0;
let fail = 0;
function record(ok, name, detail) {
  if (ok) pass++;
  else fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail || ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const original = fs.readFileSync(CONF, 'utf8');

function readConf() {
  try {
    return JSON.parse(fs.readFileSync(CONF, 'utf8'));
  } catch {
    return null;
  }
}

/** 以原文件为底改一个 nav 开关 —— 与用户手改文件的方式一致（保留 _说明 等键） */
function setNavClicker(on) {
  const raw = readConf() || {};
  raw._enabled = true;
  raw.features = raw.features || {};
  raw.features.nav = { ...(raw.features.nav || {}), clicker: on };
  fs.writeFileSync(CONF, JSON.stringify(raw, null, 2), 'utf8');
}

/** 读界面状态：设置页里有没有那张卡片 + 侧栏标签 */
const READ = `
  (() => {
    const cardTitles = [...document.querySelectorAll('.card-title')].map((e) => e.textContent.trim());
    return {
      cardExists: cardTitles.some((t) => t.includes('左侧导航入口')),
      entryRows: document.querySelectorAll('[data-nav-entry]').length,
      nav: [...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent.trim()),
      settingsNav: document.querySelectorAll('.nav-item .nav-label').length > 0,
    };
  })()
`;

app.whenReady().then(async () => {
  const { registerIpc } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
  const { resetUiConfCache } = require(path.join(
    ROOT,
    'dist-electron',
    'electron',
    'services',
    'ui-conf.js',
  ));
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) log('渲染错误:', msg);
  });

  /** 重新加载设置页（配置缓存也要一起丢，模拟「重启一次」） */
  const reload = async () => {
    resetUiConfCache();
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });
    await sleep(1800);
    return win.webContents.executeJavaScript(READ);
  };

  /* ---- 阶段 1：出厂形态 ---- */
  setNavClicker(false);
  const a = await reload();
  log('出厂:', JSON.stringify(a));

  record(!a.cardExists, 'N1 设置页没有「左侧导航入口」卡片（UI 已移除）', '');
  record(a.entryRows === 0, 'N2 页面里没有任何入口开关行', `${a.entryRows} 行`);
  record(a.settingsNav, 'N3 侧栏本身正常渲染', `${a.nav.length} 项`);
  record(!a.nav.includes('自动连点器'), 'N4 出厂（clicker=false）导航里没有「自动连点器」', a.nav.join('/'));

  const conf0 = readConf();
  record(
    !!conf0 && conf0.features.nav.clicker === false,
    'N5 出厂 features.json 里 clicker=false',
    JSON.stringify(conf0 && conf0.features && conf0.features.nav),
  );

  /* ---- 阶段 2：改文件打开 ---- */
  setNavClicker(true);
  const b = await reload();
  log('改 true 后:', JSON.stringify(b));

  record(b.nav.includes('自动连点器'), 'N6 文件改 true 后导航里出现「自动连点器」', b.nav.join('/'));
  record(!b.cardExists, 'N7 侧栏变了但设置页仍然没有那张卡片', '');

  /* ---- 阶段 3：改文件关回去 ---- */
  setNavClicker(false);
  const c = await reload();
  log('改回 false:', JSON.stringify(c));

  record(!c.nav.includes('自动连点器'), 'N8 改回 false 后导航项消失', c.nav.join('/'));

  /* ---- 阶段 4：文件损坏时不崩 ---- */
  fs.writeFileSync(CONF, '{ 这不是 JSON', 'utf8');
  const d = await reload();
  log('文件写坏:', JSON.stringify(d));

  record(d.settingsNav, 'N9 features.json 写坏时侧栏仍正常（回落出厂默认）', d.nav.join('/'));
  record(!d.nav.includes('自动连点器'), 'N10 写坏时按出厂默认处理（连点器不显示）', '');

  log(`合计 ${pass} 通过 / ${fail} 失败`);
  log('NAV TOGGLE CHECK DONE');
  setTimeout(() => app.exit(fail ? 1 : 0), 300);
}).catch((e) => {
  // 未捕获异常必须留痕并退出：否则 run-electron 只能等兜底超时，看起来像「卡死」
  log('CRASH:', (e && e.stack) || String(e));
  log('NAV TOGGLE CHECK DONE');
  setTimeout(() => app.exit(1), 300);
}).finally(() => {
  /* 无论如何都把仓库里那份配置还原（它是要提交的文件） */
  try {
    fs.writeFileSync(CONF, original, 'utf8');
  } catch (e) {
    console.error('restore failed', e);
  }
});
