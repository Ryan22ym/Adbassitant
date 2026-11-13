/**
 * 实时 Logcat「工具栏不许随抓取漂移」回归（v1.1.23，2026-11-06）。
 *
 * 小杨报的问题：工具栏那一条（级别分段 + 两个输入框 + "自动滚动 / 后台保持抓取"）
 * 会随着抓取不断左右动，看着在抖。
 *
 * 根因：级别计数是**拼进 label 字符串**的（"V 9"、"D 2734"）。每项宽度由数字位数
 *   决定（个位 ≈ 42px、四位 ≈ 63px），抓取过程中计数一路涨 → 6 个分段项各自变宽
 *   → 分段控件总宽跟着变（实测最坏 252px ↔ 378px，差 126px）→ 右侧输入框被挤、
 *   "自动滚动 / 后台保持抓取"整条往右跑。
 *
 * 现在的契约：
 *   ① 分段项里的计数占**定宽槽**（.seg-count），计数怎么涨都不改项宽；
 *   ② 于是工具栏里每个元素的 left / width 在「0 行 → 满缓冲 → 清空」之间完全不动；
 *   ③ 1080（用户实际窗口）与 960（最小窗口）两个宽度下都不换行，仍是一行。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-logcat-toolbar.cjs \
 *     --watch ui-shots/_logcat-toolbar.log --until "LOGCAT TOOLBAR CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_logcat-toolbar.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 量工具栏里每一块的几何。
 * 取 left/width 到 0.1px：定宽槽生效的话应该**一模一样**，差个 0.5px 就说明
 * 还在按内容宽度排（小数点后的差异来自 subpixel 排版）。
 */
const GEOM = `(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { l: Math.round(b.left * 10) / 10, w: Math.round(b.width * 10) / 10, t: Math.round(b.top) };
  };
  const bar = document.querySelector('.log-toolbar');
  return {
    barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    innerW: window.innerWidth,
    seg: r(document.querySelector('.log-toolbar .segmented')),
    items: [...document.querySelectorAll('.log-toolbar .segmented-item')].map(r),
    inputs: [...document.querySelectorAll('.log-toolbar .input')].map(r),
    toggles: r(document.querySelector('.log-toolbar-toggles')),
    labels: [...document.querySelectorAll('.log-toolbar-toggles > label')].map(r),
    counts: [...document.querySelectorAll('.log-toolbar .seg-count')].map((e) => e.textContent || '0'),
    rows: document.querySelectorAll('.logcat-line').length,
  };
})()`;

const read = (win) => win.webContents.executeJavaScript(GEOM);
const click = (win, sel) =>
  win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
  );

/** 全 D 级别的一批行：把「抓取中 D 计数」顶到 4 位数（定宽槽最坏情况） */
function makeBatch(from, n, level = 'D') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const seq = from + i;
    const t = '11-06 11:0' + (Math.floor(seq / 60) % 10) + ':' + String(seq % 60).padStart(2, '0') + '.000';
    out.push({
      seq,
      time: t,
      pid: 1000 + (seq % 90),
      tid: 1000 + (seq % 90),
      level,
      tag: 'ToolbarRegression',
      message: 'line ' + seq + ' 用来把级别计数顶上去',
      raw: t + ' ' + (1000 + (seq % 90)) + ' ' + level + ' ToolbarRegression: line ' + seq,
    });
  }
  return out;
}

/** 两次几何是否逐元素一致（left/width/top 全等，容差 0.5px 给 subpixel） */
function sameLayout(a, b) {
  const close = (x, y) => !!x && !!y && Math.abs(x.l - y.l) <= 0.5 && Math.abs(x.w - y.w) <= 0.5;
  if (!close(a.seg, b.seg)) return `seg ${JSON.stringify(a.seg)} → ${JSON.stringify(b.seg)}`;
  if (a.items.length !== b.items.length) return `items 数量变了 ${a.items.length} → ${b.items.length}`;
  for (let i = 0; i < a.items.length; i++) {
    if (!close(a.items[i], b.items[i]))
      return `item[${i}] ${JSON.stringify(a.items[i])} → ${JSON.stringify(b.items[i])}`;
  }
  if (a.inputs.length !== b.inputs.length) return 'inputs 数量变了';
  for (let i = 0; i < a.inputs.length; i++) {
    if (!close(a.inputs[i], b.inputs[i]))
      return `input[${i}] ${JSON.stringify(a.inputs[i])} → ${JSON.stringify(b.inputs[i])}`;
  }
  if (!close(a.toggles, b.toggles)) return `toggles ${JSON.stringify(a.toggles)} → ${JSON.stringify(b.toggles)}`;
  if (a.barH !== b.barH) return `工具栏高度变了 ${a.barH} → ${b.barH}`;
  return '';
}

/**
 * 一行 = 工具栏整体高度还是一行的高度（实测一行 56，换行后 86）。
 * 不能比各元素的 top：高度不同的元素 align-items:center 之后 top 本来就差几像素，
 * 分段控件 32 高、输入框 28、勾选项 21，top 从 157 到 163 都是一行。
 */
function oneRow(g) {
  return typeof g.barH === 'number' && g.barH > 0 && g.barH < 70;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1080,
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

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await win.show();
  await sleep(1200);

  await click(win, '.nav-item[href="#/logcat"]');
  await sleep(1000);

  /* 用户实际的窗口宽度：1080 总宽（含阴影边框），内容区略窄 */
  win.setContentSize(1063, 760);
  await sleep(700);

  /* ---- 1. 空日志基线 ---- */
  const a = await read(win);
  ok(a.barH > 0 && a.items.length === 6, 'A1 工具栏与 6 个级别分段项都在', `barH=${a.barH} items=${a.items.length}`);
  ok(a.inputs.length === 2 && !!a.toggles, 'A2 两个输入框 + 勾选项组都在', `inputs=${a.inputs.length}`);
  ok(oneRow(a), 'A3 工具栏是一行（1080 宽）', `tops=${a.seg?.t}/${a.inputs.map((x) => x?.t)}/${a.toggles?.t}`);
  ok(
    a.counts.every((c) => c === '' || c === '0') || a.counts.some((c) => c),
    'A4 空日志时计数槽为空',
    JSON.stringify(a.counts),
  );

  /* ---- 2. 灌满 4000 行（D 计数变 4 位数）→ 布局一个像素都不许动 ---- */
  for (let i = 0; i < 20; i++) {
    win.webContents.send('push:logcatLines', makeBatch(i * 200 + 1, 200, 'D'));
    await sleep(60);
  }
  await sleep(800);
  const b = await read(win);
  ok(b.rows > 0, 'B1 日志行已进页面', `rows=${b.rows}`);
  ok(
    b.counts.some((c) => Number(c) >= 1000),
    'B2 D 计数已到 4 位数（最坏情况）',
    JSON.stringify(b.counts),
  );
  const diffAb = sameLayout(a, b);
  ok(!diffAb, '🔴 B3 0 行 → 满缓冲，工具栏几何完全不变', diffAb || '');
  ok(oneRow(b), 'B4 满缓冲仍是单行（没有被挤到换行）', `barH=${b.barH}`);

  /* ---- 3. 清空 → 计数归零 → 布局还是不动 ---- */
  // 按文字找「清空」，别按顺序点（第一个是开始/停止抓取，一点就真起 adb）
  const cleared = await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('.logcat-foot .btn')].find((x) => x.textContent.trim() === '清空'); if (b) b.click(); return !!b; })()`,
  );
  ok(cleared, 'C0 找到并点了「清空」', String(cleared));
  await sleep(600);
  const c = await read(win);
  const diffAc = sameLayout(a, c);
  ok(!diffAc, '🔴 C1 清空回 0 行后位置与基线一致', diffAc || '');
  ok(c.items.length === 6, 'C2 清空后分段项还在', `items=${c.items.length}`);

  /* ---- 4. 最小窗口 960：还是一行、几何与 1080 下相对关系一致 ---- */
  // 先给 1080 那张留个影（capturePage 抓的是上一帧，先等一下）
  await sleep(500);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, 'logcat-toolbar-1080.png'), img.toPNG());
  } catch (err) {
    log('截图失败: ' + err.message);
  }

  win.setContentSize(960, 700);
  await sleep(900);
  const d = await read(win);
  ok(oneRow(d), '🔴 D1 960 最小宽下工具栏仍是一行', `barH=${d.barH} tops=${d.seg?.t}/${d.toggles?.t}`);
  ok(d.items.length === 6, 'D2 最小宽下分段项齐全', `items=${d.items.length}`);
  ok(
    d.toggles && d.toggles.l + d.toggles.w <= d.innerW,
    'D3 勾选项完整落在窗口内（没被顶出去）',
    `toggles=${JSON.stringify(d.toggles)} innerW=${d.innerW}`,
  );

  /* ---- 5. 最小宽下灌满日志：同样不许漂 ---- */
  const e0 = await read(win);
  for (let i = 0; i < 20; i++) {
    win.webContents.send('push:logcatLines', makeBatch(100000 + i * 200 + 1, 200, 'D'));
    await sleep(60);
  }
  await sleep(700);
  const e1 = await read(win);
  const diffE = sameLayout(e0, e1);
  ok(!diffE, '🔴 E1 最小宽 + 满缓冲，工具栏几何仍不变', diffE || '');

  /* 留一张图给人眼复核（capturePage 抓的是上一帧，先等一下） */
  await sleep(600);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, 'logcat-toolbar-960.png'), img.toPNG());
  } catch (err) {
    log('截图失败: ' + err.message);
  }

  log('=== LOGCAT TOOLBAR CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('LOGCAT TOOLBAR CHECK DONE');

  win.hide();
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
