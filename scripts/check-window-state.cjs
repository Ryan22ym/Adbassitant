/**
 * v1.1.16 校验：记录窗口大小与位置。
 *
 * 这一版的核心行为全在**主进程**（窗口事件 → 写盘 → 下次建窗读回），
 * 纯类型检查盖不住，所以分两层验：
 *
 *   A. 服务层（services/window-state.ts）
 *      A1 出厂尺寸是 1280×860 且居中在可用区内
 *      A2 没有记录时 savedWindowState() 不返回 bounds（= 用出厂尺寸）
 *      A3 拖窗口（setBounds）之后 400ms 内落盘，尺寸/位置都对
 *      A4 最大化时记的是**还原尺寸**（getNormalBounds），不是一整屏
 *      A5 关掉「记住窗口大小」后不再写盘
 *      A6 屏幕外的记录被判失效（显示器拔了不能把窗口扔到看不见的地方）
 *      A7 「恢复默认尺寸」：退出最大化 → 1280×860 居中 → 记录同步
 *      A8 模拟重启：把记录读回来，就是建窗时会用的 bounds
 *
 *   B. 设置页 UI
 *      B1 有「窗口」卡片与说明
 *      B2 「记住窗口大小和位置」开关默认开
 *      B3 显示当前尺寸（数字 × 数字）
 *      B4 「恢复默认尺寸」按钮点了真的变 1280×860，且落盘
 *      B5 Conf/panels.json 的 settings.window 默认收起（低频设置不占主流程）
 *
 * 🔴 不碰真机、不联网。
 * 🔴 独立 userData 临时目录（带 pid，不做「先删再建」——理由见 check-ai-page.cjs）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-window-state.cjs \
 *     --watch ui-shots/_winstate.log --until "WINDOW STATE CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_winstate.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-winstate-check-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const SETTINGS_FILE = path.join(DATA, 'settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** 等 debounce（400ms）过去 + 写盘落地 */
const settle = () => sleep(900);

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  log('userData = ' + DATA);

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const ws = require('../dist-electron/electron/services/window-state.js');
  const { getSettings, saveSettings } = require('../dist-electron/electron/services/settings.js');

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const rendererErrors = [];

  /*
   * 测试窗口：故意不用 1280×860，这样「恢复默认尺寸」有没有真的执行一眼能看出来。
   * show:true 是必须的 —— 隐藏窗口在 Windows 上 maximize() 不一定生效（历史坑）。
   */
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  /* ================================================================ */
  /* A. 服务层                                                         */
  /* ================================================================ */

  /* A1. 出厂尺寸 */
  const def = ws.centeredDefaultBounds();
  const area = screen.getPrimaryDisplay().workArea;
  ok(
    def.width === 1280 && def.height === 860,
    'A1 出厂尺寸仍是 1280×860（不悄悄改基线）',
    `${def.width}×${def.height}`,
  );
  ok(
    def.x >= area.x && def.y >= area.y && def.x + def.width <= area.x + area.width,
    'A1b 出厂尺寸居中且落在可用区内',
    `x=${def.x} y=${def.y} area=${area.x},${area.y},${area.width}×${area.height}`,
  );

  /* A2. 没有记录 → 不给 bounds */
  const none = ws.savedWindowState();
  ok(
    !none.bounds && none.maximized === false,
    'A2 没有记录时不返回 bounds（启动用出厂尺寸）',
    JSON.stringify(none),
  );

  /* A3. 拖窗口 → 落盘 */
  ws.trackWindowState(win);
  win.setBounds({ x: 60, y: 40, width: 1160, height: 720 });
  await settle();
  let saved = readJson().windowBounds;
  const nearPx = (a, t) => Math.abs(a - t) <= 2;

  ok(
    !!saved && nearPx(saved.width, 1160) && nearPx(saved.height, 720),
    'A3 改变窗口大小后自动落盘（debounce 内只写一次）',
    JSON.stringify(saved),
  );
  ok(
    !!saved && nearPx(saved.x, 60) && nearPx(saved.y, 40) && saved.maximized === false,
    'A3b 位置与「未最大化」状态一起记下',
    JSON.stringify(saved),
  );

  /* A4. 最大化 → 记还原尺寸，不是一整屏 */
  win.maximize();
  await settle();
  saved = readJson().windowBounds;
  const fullW = screen.getPrimaryDisplay().workArea.width;
  ok(!!saved && saved.maximized === true, 'A4 最大化状态被记住', JSON.stringify(saved));
  ok(
    !!saved && saved.width === 1160 && saved.width < fullW,
    '🔴 A4b 最大化时记的是还原尺寸（getNormalBounds），不是一整屏',
    `saved=${saved && saved.width} full=${fullW}`,
  );

  /* A5. 关掉开关 → 不再写盘 */
  saveSettings({ rememberWindowBounds: false });
  const before = JSON.stringify(readJson().windowBounds);
  win.unmaximize();
  win.setBounds({ x: 100, y: 80, width: 1020, height: 680 });
  await settle();
  const after = JSON.stringify(readJson().windowBounds);
  const offState = ws.savedWindowState();
  ok(before === after, 'A5 关掉「记住窗口大小」后不再写盘', `before=${before} after=${after}`);
  ok(
    !offState.bounds,
    'A5b 开关关着时不使用已存记录（下次启动回默认尺寸）',
    JSON.stringify(offState),
  );
  ok(
    !!readJson().windowBounds,
    'A5c 关开关不清掉已有记录（重新打开还能回到原来的样子）',
    before,
  );

  /* A6. 屏幕外的记录判失效 */
  saveSettings({
    rememberWindowBounds: true,
    windowBounds: { x: 999999, y: 999999, width: 1200, height: 800, maximized: false },
  });
  ok(
    !ws.savedWindowState().bounds,
    '🔴 A6 记录落在屏幕外时判为无效（显示器拔了也不会把窗口扔到看不见的地方）',
    JSON.stringify(ws.savedWindowState()),
  );

  /* 脏数据同样不能崩 */
  saveSettings({ windowBounds: { x: NaN, y: 0, width: 1200, height: 800, maximized: false } });
  ok(!ws.savedWindowState().bounds, 'A6b 脏数据（NaN 坐标）同样判无效，不会崩', '');

  /* A7. 恢复默认尺寸 */
  saveSettings({ windowBounds: { x: 60, y: 40, width: 1160, height: 720, maximized: false } });
  win.maximize();
  await settle();
  const reset = ws.resetWindowSize(win);
  await settle();
  const afterReset = readJson().windowBounds;
  const b = win.getBounds();
  /*
   * ⚠️ 这里允许 ±2px：Windows 的 DWM 有一圈不可见的 resize 边框，
   *    setBounds 写 860、getBounds 读回来是 862（实测，见 window-state.ts 的 PX_TOLERANCE）。
   *    判据要验的是「窗口大致回到了出厂尺寸」，不是「像素级等于」——
   *    真正不能错的是**记录值**（A7c 严格判），那才是下次启动的依据。
   */
  ok(
    reset.width === 1280 && reset.height === 860 && reset.maximized === false,
    'A7 恢复默认尺寸：1280×860、非最大化',
    JSON.stringify(reset),
  );
  ok(
    !win.isMaximized() && nearPx(b.width, 1280) && nearPx(b.height, 860),
    'A7b 窗口真的变回 1280×860（先退出最大化再生效）',
    `max=${win.isMaximized()} ${b.width}×${b.height}`,
  );
  ok(
    !!afterReset && afterReset.width === 1280 && afterReset.height === 860,
    '🔴 A7c 恢复后记录仍是精确的 1280×860（不被边框误差写歪）',
    JSON.stringify(afterReset),
  );

  /* A7d. 容差：反复「读回再记录」不能把尺寸越记越大（本次实测到的真 bug） */
  const beforeDrift = JSON.stringify(readJson().windowBounds);
  for (let i = 0; i < 3; i++) {
    const rb = readJson().windowBounds;
    win.setBounds({ x: rb.x, y: rb.y, width: rb.width, height: rb.height });
    await settle();
  }
  const afterDrift = JSON.stringify(readJson().windowBounds);
  ok(
    beforeDrift === afterDrift,
    '🔴 A7d 连续 3 次「按记录恢复」后记录一字不变（不会每次启动长 2px）',
    `before=${beforeDrift} after=${afterDrift}`,
  );

  /* A8. 模拟重启：读回来的就是建窗要用的 bounds */
  win.setBounds({ x: 120, y: 90, width: 1240, height: 780 });
  await settle();
  const restored = ws.savedWindowState();
  /*
   * ±2px：这一轮是「用户真的换了尺寸」，记录取的是 getNormalBounds 的实际值，
   * 带着 DWM 边框误差（见 window-state.ts 的 PX_TOLERANCE）。
   * 用户拖拽本来就没有像素级目标，2px 不影响任何使用；
   * 不能有误差的是「按记录恢复」那条路径（A7c / A7d 严格判）。
   */
  ok(
    !!restored.bounds &&
      nearPx(restored.bounds.x, 120) &&
      nearPx(restored.bounds.y, 90) &&
      nearPx(restored.bounds.width, 1240) &&
      nearPx(restored.bounds.height, 780),
    '🔴 A8 重启时读回的就是上次的尺寸与位置（建窗参数直接用这份）',
    JSON.stringify(restored),
  );

  /* ================================================================ */
  /* B. 设置页 UI                                                      */
  /* ================================================================ */

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });
  await win.show();
  await sleep(1500);
  /* 进设置页后把尺寸摆成「非默认」，才能验按钮真的起作用 */
  win.setBounds({ x: 120, y: 90, width: 1240, height: 780 });
  await sleep(400);

  const card = await read(
    win,
    `(() => {
       const cards = [...document.querySelectorAll('.card')];
       const c = cards.find((x) => (x.querySelector('.card-title')?.textContent || '').trim() === '窗口');
       if (!c) return null;
       const sw = c.querySelector('.setting-line .switch');
       return {
         title: (c.querySelector('.card-title')?.textContent || '').trim(),
         subtitle: (c.querySelector('.card-subtitle')?.textContent || '').trim(),
         collapsed: c.classList.contains('is-collapsed'),
         switchOn: sw ? sw.getAttribute('aria-checked') === 'true' : null,
         size: (c.querySelector('[data-win-size]')?.textContent || '').trim(),
         hasReset: !!c.querySelector('[data-win-reset]'),
         note: (c.querySelector('.setting-note')?.textContent || '').replace(/\\s+/g, ' ').trim(),
       };
     })()`,
  );

  ok(!!card, 'B1 设置页有「窗口」卡片');
  if (card) {
    ok(card.title === '窗口' && /记住窗口大小/.test(card.subtitle), 'B1b 标题与副标题文案', `${card.title} / ${card.subtitle}`);
    ok(card.switchOn === true, 'B2 「记住窗口大小和位置」默认开', `aria-checked=${card.switchOn}`);
    ok(/\d+\s*×\s*\d+/.test(card.size), 'B3 显示当前窗口尺寸', `size=${card.size}`);
    ok(card.hasReset, 'B3b 有「恢复默认尺寸」按钮');
    ok(/1280\s*×\s*860/.test(card.note), 'B4 说明里点明了默认值 1280 × 860', '');
    ok(card.collapsed === true, 'B5 Conf 里 settings.window 默认收起（低频设置不占主流程）', `collapsed=${card.collapsed}`);
  }

  /* B4. 点按钮 → 窗口变 1280×860 + 落盘 + 界面数字跟着更新 */
  await read(win, `document.querySelector('[data-win-reset]')?.click()`);
  await sleep(900);
  const afterClick = win.getBounds();
  const savedAfterClick = readJson().windowBounds;
  const shownSize = await read(
    win,
    `(document.querySelector('[data-win-size]')?.textContent || '').trim()`,
  );
  ok(
    nearPx(afterClick.width, 1280) && nearPx(afterClick.height, 860),
    '🔴 B4b 点「恢复默认尺寸」窗口真的变成 1280×860（±2px 边框误差）',
    `${afterClick.width}×${afterClick.height}`,
  );
  ok(
    !!savedAfterClick && savedAfterClick.width === 1280 && savedAfterClick.height === 860,
    'B4c 点击后落盘（不是只改窗口不改记录），且记录是精确值',
    JSON.stringify(savedAfterClick),
  );
  const shownNums = (shownSize.match(/\d+/g) || []).map(Number);
  ok(
    shownNums.length >= 2 && nearPx(shownNums[0], 1280) && nearPx(shownNums[1], 860),
    'B4d 界面上的数字同步刷新（不用手动重进页面）',
    `shown=${shownSize}`,
  );

  /* 留一张图：窗口卡片长什么样 */
  await sleep(500);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '_winstate-settings.png'), img.toPNG());
  } catch {
    /* 截图失败不影响判据 */
  }

  /* ---------------- 收尾 ---------------- */

  win.hide();
  log('=== WINDOW STATE CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('WINDOW STATE CHECK DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});

/** 读渲染层表达式的简写 */
function read(win, expr) {
  return win.webContents.executeJavaScript(expr).catch(() => null);
}
