/*
 * 「导航增强」验收脚本（v1.1.27）。
 *
 * 验的是四件事，全部按**真实交互路径**走（合成 pointer 事件 / 真点按钮）：
 *
 *   1. 双源开关：设置页开关 → 两边（settings.json 与 Conf/features.json）一致；
 *      改文件 → 重启后接管，并反写设置；**改完必须重启才生效**；
 *   2. 拖拽排序：拖动后顺序变了、落库到 settings.navOrder、重载后保持；
 *   3. 浮动小窗：入口开窗 → 外部点击关闭；pin 后外部点击不关；缩放 / 拖动改几何；
 *   4. 关闭态：没有拖拽形态、没有小窗入口、宿主不渲染。
 *
 * 用法（不需要真机）：
 *   python scripts/run-electron.py scripts/check-nav-advanced.cjs --watch ui-shots/_nav-adv.log --until "NAV ADVANCED CHECK DONE" --timeout 300
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
const LOG = path.join(OUT, '_nav-adv.log');
const CONF = path.join(ROOT, 'Conf', 'features.json');
const DIST = path.join(ROOT, 'dist-electron', 'electron');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

let pass = 0;
let fail = 0;
function record(ok, name, detail) {
  if (ok) pass++;
  else fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail || ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const originalConf = fs.readFileSync(CONF, 'utf8');

function readConf() {
  try {
    return JSON.parse(fs.readFileSync(CONF, 'utf8'));
  } catch {
    return null;
  }
}

/** 以原文件为底改 `features.ui.navAdvanced`（与用户手改文件的方式一致，保留其它键） */
function setFileSwitch(value) {
  const raw = readConf() || {};
  raw._enabled = true;
  raw.features = raw.features || {};
  raw.features.ui = { ...(raw.features.ui || {}), navAdvanced: value };
  fs.writeFileSync(CONF, JSON.stringify(raw, null, 2), 'utf8');
}

function fileSwitch() {
  const raw = readConf();
  const v = raw && raw.features && raw.features.ui && raw.features.ui.navAdvanced;
  return typeof v === 'boolean' ? v : null;
}

/** 读界面状态 */
const READ = `
  (() => {
    const nav = document.querySelector('.sidebar-nav');
    const wins = [...document.querySelectorAll('.mini-window')].map((w) => ({
      id: w.dataset.miniId,
      pinned: w.dataset.miniPinned === '1',
      left: Math.round(w.getBoundingClientRect().left),
      top: Math.round(w.getBoundingClientRect().top),
      w: Math.round(w.getBoundingClientRect().width),
      h: Math.round(w.getBoundingClientRect().height),
    }));
    let sw = null;
    const line = document.querySelector('[data-nav-adv-switch]');
    if (line) {
      const el = line.querySelector('.switch');
      sw = el ? el.getAttribute('aria-checked') === 'true' : null;
    }
    return {
      enhanced: nav ? nav.dataset.navEnhanced : null,
      order: [...document.querySelectorAll('[data-nav-item]')].map((e) => e.dataset.navItem),
      popCount: document.querySelectorAll('.nav-pop').length,
      tear: document.querySelector('.nav-tear')?.dataset.navTear || null,
      barRight: Math.round(document.querySelector('.sidebar').getBoundingClientRect().right),
      wins,
      switchOn: sw,
      effective: document.querySelector('[data-nav-adv-effective]')?.dataset.navAdvEffective,
      cardExists: [...document.querySelectorAll('.card-title')].some((t) =>
        t.textContent.includes('导航增强'),
      ),
    };
  })()
`;

app.whenReady().then(async () => {
  const { registerIpc } = require(path.join(DIST, 'ipc.js'));
  const { resetUiConfCache } = require(path.join(DIST, 'services', 'ui-conf.js'));
  const { resetNavAdvancedCache } = require(path.join(DIST, 'services', 'nav-advanced.js'));
  const { getSettings, saveSettings } = require(path.join(DIST, 'services', 'settings.js'));
  registerIpc();

  /* 设置快照：脚本会改 navOrder / navAdvanced，跑完必须原样还回去 */
  const settingsSnapshot = { ...getSettings() };

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(DIST, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) log('渲染错误:', msg);
  });

  const js = (code) => win.webContents.executeJavaScript(code);

  /** 模拟「重启一次」：丢掉两份缓存 + 重新加载窗口 */
  const reload = async (hash = '/settings') => {
    resetUiConfCache();
    resetNavAdvancedCache();
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash });
    await sleep(1500);
    return js(READ);
  };

  /* ================= 阶段 1：关闭态 ================= */
  saveSettings({ navAdvanced: false, navOrder: [] });
  setFileSwitch(false);
  const s0 = await reload('/settings');
  log('关闭态:', JSON.stringify(s0));

  record(s0.enhanced === '0', 'N1 关闭时侧栏没有拖拽形态', `enhanced=${s0.enhanced}`);
  record(s0.popCount === 0, 'N2 关闭时没有小窗入口按钮', `${s0.popCount} 个`);
  record(s0.wins.length === 0, 'N3 关闭时小窗宿主不渲染', `${s0.wins.length} 扇`);
  record(s0.cardExists, 'N4 设置页有「导航增强」卡片', '');
  record(s0.switchOn === false, 'N5 卡片开关显示为关', `switch=${s0.switchOn}`);
  record(fileSwitch() === false, 'N6 文件里 navAdvanced=false', String(fileSwitch()));

  /* ================= 阶段 2：设置页开开关（应重启后生效） ================= */
  await js(`document.querySelector('[data-nav-adv-switch] .switch').click()`);
  await sleep(900);
  const s1 = await js(READ);
  const setAfterClick = getSettings();
  log('点开关后:', JSON.stringify(s1), 'settings.navAdvanced=', setAfterClick.navAdvanced);

  record(setAfterClick.navAdvanced === true, 'N7 开关落盘到 settings.json', String(setAfterClick.navAdvanced));
  record(fileSwitch() === true, 'N8 同一份值写回 Conf/features.json（两处一致）', String(fileSwitch()));
  record(s1.enhanced === '0', 'N9 未重启时侧栏仍不可拖（重启生效）', `enhanced=${s1.enhanced}`);
  record(s1.effective === '0', 'N10 未重启时「当前状态」仍是关闭', `effective=${s1.effective}`);
  record(s1.switchOn === true, 'N11 卡片开关已经是开（落盘值）', `switch=${s1.switchOn}`);

  /* ================= 阶段 3：重启后生效 ================= */
  const s2 = await reload('/settings');
  log('重启后:', JSON.stringify(s2));

  record(s2.enhanced === '1', 'N12 重启后侧栏进入可拖形态', `enhanced=${s2.enhanced}`);
  record(
    s2.popCount === 0,
    'N13 侧栏没有任何小窗入口按钮（改成拖出去才开窗）',
    `${s2.popCount} 个`,
  );
  record(s2.effective === '1', 'N14 「当前状态」显示已开启', `effective=${s2.effective}`);

  /* ================= 阶段 4：拖拽排序 ================= */
  /*
   * 合成一次真实拖拽：在「投屏」那格按下 → 往下拖两格 → 松手。
   * 三条 pointer 事件的 pointerId 必须一致，否则会被 onPointerMove 的
   * `ev.pointerId !== d.pointerId` 判掉（这也是真机上的正常行为）。
   */
  const orderBefore = s2.order;
  const fromId = orderBefore[1];
  await js(`
    (() => {
      const slot = document.querySelector('[data-nav-item="${fromId}"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opt = (cy) => ({ bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: cy });
      slot.dispatchEvent(new PointerEvent('pointerdown', opt(y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(y + 40)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(y + 80)));
      window.dispatchEvent(new PointerEvent('pointerup', opt(y + 80)));
      return true;
    })()
  `);
  await sleep(600);
  const s3 = await js(READ);
  const savedOrder = getSettings().navOrder;
  log('拖拽后:', JSON.stringify({ order: s3.order, saved: savedOrder }));

  const movedIndex = s3.order.indexOf(fromId);
  record(movedIndex > 1, 'N15 拖拽后顺序发生变化', `${fromId} → 第 ${movedIndex + 1} 位`);
  record(
    Array.isArray(savedOrder) && savedOrder[0] === s3.order[0] && savedOrder[1] === s3.order[1],
    'N16 新顺序落库到 settings.navOrder',
    JSON.stringify(savedOrder),
  );

  const s4 = await reload('/settings');
  record(
    s4.order.join('|') === s3.order.join('|'),
    'N17 重启后顺序保持（持久化生效）',
    s4.order.join('/'),
  );

  /* ================= 阶段 5：拖到功能栏外 = 开小窗 ================= */
  const targetId = s4.order[0];
  const orderBeforeTear = s4.order;
  const barRight = s4.barRight;
  const dropX = barRight + 320;
  const grabY = await js(
    `(() => { const r = document.querySelector('[data-nav-item="${targetId}"]').getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`,
  );

  /* 先按下 + 往外拖，停在功能栏外面（松手前） */
  await js(`
    (() => {
      const slot = document.querySelector('[data-nav-item="${targetId}"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 5, button: 0, clientX: cx, clientY: cy });
      slot.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x + 60, y + 8)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(${dropX}, ${grabY})));
      return true;
    })()
  `);
  await sleep(350);
  const mid = await js(READ);
  log('拖出栏外（未松手）:', JSON.stringify({ tear: mid.tear, order: mid.order }));

  record(mid.tear === targetId, 'N18 拖到功能栏外出现「松手开小窗」拖影', String(mid.tear));
  record(
    mid.order.join('|') === orderBeforeTear.join('|'),
    'N19 拖出功能栏期间不改顺序',
    mid.order.join('/'),
  );

  /* 松手 → 开小窗 */
  await js(`
    (() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 5, button: 0, clientX: ${dropX}, clientY: ${grabY} }));
      return true;
    })()
  `);
  await sleep(600);
  const s5 = await js(READ);
  log('松手后:', JSON.stringify(s5.wins));

  record(
    s5.wins.length === 1 && s5.wins[0].id === targetId,
    'N20 拖出功能栏松手 → 打开该页面的浮动小窗',
    JSON.stringify(s5.wins),
  );
  record(
    s5.wins.length === 1 && Math.abs(s5.wins[0].left - (dropX - 60)) <= 30,
    'N21 小窗落在松手的位置附近',
    s5.wins.length ? `left=${s5.wins[0].left}（期望 ≈ ${dropX - 60}）` : '—',
  );
  record(s5.tear === null, 'N22 松手后拖影消失', String(s5.tear));
  record(
    s5.order.join('|') === orderBeforeTear.join('|'),
    'N23 开窗后顺序仍未变',
    s5.order.join('/'),
  );

  /* 未 pin：点外部（正文区）应关闭 */
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(400);
  const s6 = await js(READ);
  record(s6.wins.length === 0, 'N24 未固定时点外部自动关闭', `${s6.wins.length} 扇`);

  /* pin 之后点外部不关：重新拖一扇出来 */
  await js(`
    (() => {
      const slot = document.querySelector('[data-nav-item="${targetId}"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 6, button: 0, clientX: cx, clientY: cy });
      slot.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x + 60, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(${dropX}, ${grabY})));
      window.dispatchEvent(new PointerEvent('pointerup', opt(${dropX}, ${grabY})));
      return true;
    })()
  `);
  await sleep(600);
  await js(`document.querySelector('[data-mini-pin]').click()`);
  await sleep(300);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(400);
  const s7 = await js(READ);
  record(
    s7.wins.length === 1 && s7.wins[0].pinned === true,
    'N25 固定后点外部保持显示',
    JSON.stringify(s7.wins),
  );

  /* 缩放：右下角手柄往右下拖 120×90 */
  const before = s7.wins[0];
  await js(`
    (() => {
      const h = document.querySelector('[data-mini-resize="se"]');
      const r = h.getBoundingClientRect();
      const x = r.left + 2;
      const y = r.top + 2;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: cx, clientY: cy });
      h.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x + 120, y + 90)));
      window.dispatchEvent(new PointerEvent('pointerup', opt(x + 120, y + 90)));
      return true;
    })()
  `);
  await sleep(500);
  const s8 = await js(READ);
  const after = s8.wins[0];
  record(
    after && after.w > before.w + 60 && after.h > before.h + 40,
    'N26 拖右下角能放大窗口',
    `${before.w}×${before.h} → ${after ? `${after.w}×${after.h}` : '—'}`,
  );

  /* 拖动：拖标题栏，位置应变化 */
  await js(`
    (() => {
      const head = document.querySelector('.mini-head');
      const r = head.getBoundingClientRect();
      const x = r.left + 60;
      const y = r.top + 12;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 11, button: 0, clientX: cx, clientY: cy });
      head.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x - 80, y + 60)));
      window.dispatchEvent(new PointerEvent('pointerup', opt(x - 80, y + 60)));
      return true;
    })()
  `);
  await sleep(500);
  const s9 = await js(READ);
  const moved = s9.wins[0];
  record(
    moved && (moved.left !== after.left || moved.top !== after.top),
    'N27 拖标题栏能移动窗口',
    `${after.left},${after.top} → ${moved ? `${moved.left},${moved.top}` : '—'}`,
  );

  /* 关闭按钮 */
  await js(`document.querySelector('[data-mini-close]').click()`);
  await sleep(300);
  const s10 = await js(READ);
  record(s10.wins.length === 0, 'N28 关闭按钮能关掉小窗', `${s10.wins.length} 扇`);

  /* ================= 阶段 6：文件开关接管 ================= */
  setFileSwitch(false); // settings 仍是 true → 文件优先
  const s11 = await reload('/settings');
  const afterFile = getSettings();
  log('文件改 false 后:', JSON.stringify(s11), 'settings.navAdvanced=', afterFile.navAdvanced);

  record(s11.enhanced === '0', 'N29 文件改 false 重启后功能关闭', `enhanced=${s11.enhanced}`);
  record(
    afterFile.navAdvanced === false,
    'N30 文件优先并把 settings 反向同步（两处一致）',
    String(afterFile.navAdvanced),
  );

  /* 关闭态下拖不出去 */
  record(s11.tear === null, 'N31 关闭态没有拖影', String(s11.tear));

  log(`合计 ${pass} 通过 / ${fail} 失败`);
  log('NAV ADVANCED CHECK DONE');
  setTimeout(() => app.exit(fail ? 1 : 0), 300);
})
  .catch((e) => {
    log('CRASH:', (e && e.stack) || String(e));
    log('NAV ADVANCED CHECK DONE');
    setTimeout(() => app.exit(1), 300);
  })
  .finally(() => {
    /* 无论如何都把仓库里的配置与用户设置还原 */
    try {
      fs.writeFileSync(CONF, originalConf, 'utf8');
    } catch (e) {
      console.error('restore conf failed', e);
    }
    try {
      const { saveSettings } = require(path.join(DIST, 'services', 'settings.js'));
      saveSettings(settingsSnapshot);
    } catch (e) {
      console.error('restore settings failed', e);
    }
  });
