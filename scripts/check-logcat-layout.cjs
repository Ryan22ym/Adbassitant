/**
 * 实时 Logcat「高度分配」回归。
 *
 * 用户报的问题：底栏那行按钮（开始抓取 / 暂停刷新 / 清空 / 保存为文件）
 * 会被日志内容挤到下面，要往下滚才看得见。
 *
 * 根因不是滚动条，而是**卡片高度是各种固定值叠加出来的**：
 *   .logcat-view 曾经写死 max-height: calc(100vh - 360px)，那个 360 只算了
 *   卡片头 + 工具栏 + 底栏，没算过滤面板 —— 一展开过滤，卡片总高就超过可视区，
 *   .page 开始滚动，而底栏是页面里最后一个元素，自然被推到屏幕外。
 *
 * 现在的契约（断言的依据）：
 *   1. 页面本身不滚（.page 无纵向溢出），高度自上而下分配；
 *   2. 底栏按钮始终完整落在视口内，日志区伸缩不改它的位置；
 *   3. 日志只让 .logcat-view 自己的 scrollHeight 变长，DOM 行数仍是视口量级。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-logcat-layout.cjs \
 *     --watch ui-shots/_logcat-layout.log --until "LOGCAT LAYOUT CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_logcat-layout.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次读全所有相关几何量（数值四舍五入到整像素） */
const GEOM = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
  };
  const page = q('.page');
  const view = q('.logcat-view');
  const spacer = q('.log-spacer');
  return {
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    pageScroll: page ? page.scrollHeight - page.clientHeight : null,
    card: rect(q('.logcat-card')),
    foot: rect(q('.logcat-foot')),
    view: rect(view),
    viewScroll: view ? view.scrollHeight - view.clientHeight : null,
    viewOverflowY: view ? getComputedStyle(view).overflowY : null,
    spacerH: spacer ? Math.round(parseFloat(getComputedStyle(spacer).height)) : null,
    rows: document.querySelectorAll('.logcat-line').length,
    filterOpen: !!q('.logcat-filter'),
    btns: [...document.querySelectorAll('.logcat-foot .btn')].map((b) => b.textContent.trim()),
  };
})()`;

const read = (win) => win.webContents.executeJavaScript(GEOM);
const click = (win, sel) =>
  win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
  );

/** 造一批日志行，直接当作主进程推送塞给渲染层（走真实订阅链路，不是改 DOM） */
function makeBatch(from, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const seq = from + i;
    const t = '10-26 20:0' + Math.floor(seq / 60) % 10 + ':' + String(seq % 60).padStart(2, '0') + '.000';
    out.push({
      seq,
      time: t,
      pid: 1000 + (seq % 90),
      tid: 1000 + (seq % 90),
      level: ['V', 'D', 'I', 'W', 'E'][seq % 5],
      tag: seq % 7 === 0 ? 'ActivityManager' : 'LayoutRegression',
      message: 'line ' + seq + ' 填充内容，用来把日志区撑长',
      raw: t + ' ' + (1000 + (seq % 90)) + ' ' + ['V', 'D', 'I', 'W', 'E'][seq % 5] + ' LayoutRegression: line ' + seq,
    });
  }
  return out;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');
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
      backgroundThrottling: false,
    },
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  /** 底栏是否完整落在视口里：底部不出视口、且高度正常（没被压扁） */
  const footInView = (g) => !!g.foot && g.foot.bottom <= g.innerH && g.foot.bottom > 0 && g.foot.h >= 30;

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await win.show();
  await sleep(1200);

  await click(win, '.nav-item[href="#/logcat"]');
  await sleep(1000);

  /* ---- 1. 基础形态：空日志 ---- */
  const a = await read(win);
  ok(a.card && a.card.h > 300, 'A1 Logcat 卡片吃满可视高度', `card=${JSON.stringify(a.card)} innerH=${a.innerH}`);
  ok(footInView(a), '🔴 A2 底栏按钮完整落在视口内（不用滚就能看到）', `foot=${JSON.stringify(a.foot)} innerH=${a.innerH}`);
  ok((a.pageScroll ?? 99) <= 1, '🔴 A3 页面本身不滚动（滚动条不会出现）', `pageScroll=${a.pageScroll}`);
  ok(a.viewOverflowY === 'auto', 'A4 日志区是独立的滚动容器', `overflowY=${a.viewOverflowY}`);
  ok(a.btns.length >= 3 && a.btns.some((t) => t.includes('开始抓取')), 'A5 底栏按钮齐全', a.btns.join(' | '));

  /* ---- 2. 过滤面板开合（曾经把底栏顶出去的那个最坏情况）---- */
  // 先确保是「收起」态，拿到干净的基线（配置里可能默认就是展开的）
  if (a.filterOpen) {
    await click(win, '.card-extra .btn');
    await sleep(500);
  }
  const closed = await read(win);
  ok(!closed.filterOpen, 'B0 过滤面板已收起（基线）', `filterOpen=${closed.filterOpen}`);
  await click(win, '.card-extra .btn');
  await sleep(600);
  const b = await read(win);
  ok(b.filterOpen, 'B1 过滤面板已展开（最坏情况）', `filterOpen=${b.filterOpen}`);
  ok(footInView(b), '🔴 B2 展开过滤后底栏仍在视口内', `foot=${JSON.stringify(b.foot)} innerH=${b.innerH}`);
  ok((b.pageScroll ?? 99) <= 1, '🔴 B3 展开过滤后页面仍不滚动', `pageScroll=${b.pageScroll}`);
  ok(
    b.view && closed.view && b.view.h < closed.view.h,
    'B4 过滤面板占走的高度是从日志区扣的（不是把卡片撑高）',
    `view ${closed.view?.h} → ${b.view?.h}`,
  );
  ok(
    !!b.foot && !!closed.foot && Math.abs(b.foot.top - closed.foot.top) <= 2,
    '🔴 B5 过滤面板开合不移动底栏（底栏钉在卡片底部）',
    `footTop ${closed.foot?.top} → ${b.foot?.top}`,
  );
  ok(
    !!b.card && !!closed.card && Math.abs(b.card.h - closed.card.h) <= 2,
    'B6 过滤面板开合不改卡片总高度',
    `cardH ${closed.card?.h} → ${b.card?.h}`,
  );

  /* ---- 3. 灌入 3000 行日志：内容变多不能推挤任何东西 ---- */
  const base = await read(win);
  for (let i = 0; i < 10; i++) {
    win.webContents.send('push:logcatLines', makeBatch(i * 300 + 1, 300));
    await sleep(90);
  }
  await sleep(700);
  const c = await read(win);

  ok(c.rows > 0, 'C1 日志行已进入页面', `rows=${c.rows}`);
  ok(c.rows > 0 && c.rows < 120, '🔴 C2 3000 行时 DOM 仍只有视口量级（虚拟滚动没被打回原形）', `rows=${c.rows}`);
  ok(Math.abs((c.spacerH ?? 0) - 3000 * 22) < 3, 'C3 占位层高度 = 行数 × 行高', `spacerH=${c.spacerH}`);
  ok(c.viewScroll > 500, 'C4 日志区自己变长了（有内部滚动）', `viewScroll=${c.viewScroll}`);
  ok(
    !!c.foot && !!base.foot && Math.abs(c.foot.top - base.foot.top) <= 2,
    '🔴 C5 3000 行日志没有推挤底栏（位置与空日志时一致）',
    `footTop ${base.foot?.top} → ${c.foot?.top}`,
  );
  ok(footInView(c), '🔴 C6 满屏日志下底栏依然完整可见', `foot=${JSON.stringify(c.foot)} innerH=${c.innerH}`);
  ok((c.pageScroll ?? 99) <= 1, '🔴 C7 满屏日志下页面仍不滚动', `pageScroll=${c.pageScroll}`);

  /* ---- 4. 日志区滚到顶/到底，底栏纹丝不动 ---- */
  await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.logcat-view'); v.scrollTop = 0; })()`);
  await sleep(300);
  const dTop = await read(win);
  await win.webContents.executeJavaScript(
    `(() => { const v = document.querySelector('.logcat-view'); v.scrollTop = v.scrollHeight; })()`,
  );
  await sleep(300);
  const dBot = await read(win);
  ok(
    Math.abs(dTop.foot.top - dBot.foot.top) <= 1 && Math.abs(dBot.foot.top - c.foot.top) <= 1,
    '🔴 D1 日志区滚动不带动底栏',
    `top: ${c.foot?.top} / ${dTop.foot?.top} / ${dBot.foot?.top}`,
  );

  /* 留一张图给人眼复核（capturePage 抓的是上一帧，先等一下） */
  await win.webContents.executeJavaScript(
    `(() => { const v = document.querySelector('.logcat-view'); v.scrollTop = v.scrollHeight; })()`,
  );
  await sleep(600);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, 'logcat-layout.png'), img.toPNG());
  } catch (e) {
    log('截图失败: ' + e.message);
  }

  /* ---- 5. 最小窗口（内容区 960×640）：按钮仍然不许被裁掉 ---- */
  const [origW, origH] = win.getContentSize();
  win.setContentSize(960, 640);
  await sleep(900);
  const e = await read(win);
  ok(footInView(e), '🔴 E1 最小窗口 + 过滤展开时底栏仍完整可见（没被卡片裁掉）', `foot=${JSON.stringify(e.foot)} innerH=${e.innerH}`);
  ok((e.pageScroll ?? 99) <= 1, 'E2 最小窗口下页面仍不滚动', `pageScroll=${e.pageScroll}`);
  ok(e.view && e.view.h >= 55, 'E3 最小窗口下日志区仍有可读高度（保住的是它，不是过滤面板）', `viewH=${e.view?.h}`);

  /* 还原窗口尺寸（必须是内容区尺寸，setContentSize 的入参就是内容区，别用窗口尺寸糊弄） */
  win.setContentSize(origW, origH);
  await sleep(900);

  /* ---- 6. 卡片收起：不该被拉成一整屏空白 ---- */
  await click(win, '.card-head');
  await sleep(500);
  const f = await read(win);
  ok(!!f.card && f.card.h < 200, 'F1 卡片收起态不被拉伸（不留一大片空白卡片）', `cardH=${f.card?.h}`);
  await click(win, '.card-head');
  await sleep(500);
  const g = await read(win);
  ok(!!g.card && g.card.h > 300, 'F2 再展开又吃满高度', `cardH=${g.card?.h}`);
  ok(footInView(g) && Math.abs(g.foot.top - c.foot.top) <= 2, 'F3 展开回来底栏位置复原', `footTop=${g.foot?.top}`);

  log('=== LOGCAT LAYOUT CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('LOGCAT LAYOUT CHECK DONE');

  win.hide();
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
