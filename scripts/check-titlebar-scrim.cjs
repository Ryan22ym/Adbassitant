/**
 * 标题栏右上角「遮罩时跟着压暗」校验（v1.1.8 修复）。
 *
 * 背景：右上角的窗口按钮是 titleBarOverlay 由主进程画的，**在渲染内容之外** ——
 * 页面上的 .install-mask / .qa-dialog-mask 盖不到它。弹窗一出整屏都暗、
 * 只有右上角保持原色，看着像贴了块白补丁（用户截图反馈的正是这个）。
 * 修法是反过来算：按遮罩的实际色与透明度求出「被盖住后」的颜色再回传。
 *
 * 这个脚本直接往页面里插入/移除遮罩元素，走完整链路验证：
 *   DOM 变化 → MutationObserver → setState → effect → IPC → 主进程 setTitleBarOverlay
 *
 * 🔴 这个 Electron 版本没有 `BrowserWindow#getTitleBarOverlay()`（实测 not a function），
 *    所以改为在脚本里给 `setTitleBarOverlay` 打桩，记录主进程**实际收到的**参数 ——
 *    要验的本来就是「回传了什么」，读回系统值反而绕远。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-titlebar-scrim.cjs \
 *     --watch ui-shots/_titlebar-scrim.log --until "TITLEBAR SCRIM CHECK DONE" --timeout 240
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_titlebar-scrim.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 主进程收到的每一次标题栏配色回传（按顺序） */
const seen = [];
const origSetOverlay = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function patched(opts) {
  try {
    seen.push({ ...opts });
  } catch {
    /* 记录失败不影响主流程 */
  }
  try {
    return origSetOverlay ? origSetOverlay.call(this, opts) : undefined;
  } catch {
    /* 环境不支持就跳过，本脚本只看参数 */
  }
};
const lastColor = () => String(seen.length ? seen[seen.length - 1].color || '' : '').toLowerCase();
const lastSymbol = () =>
  String(seen.length ? seen[seen.length - 1].symbolColor || '' : '').toLowerCase();

/**
 * 与两个遮罩的实际 CSS 对齐（改了 CSS 这里会 FAIL，正好当提醒）。
 * install.css 的 .install-mask / quick-actions.css 的 .qa-dialog-mask。
 */
const INSTALL_SCRIM = { color: '#10141c', alpha: 0.45 };
const QA_SCRIM = { color: '#0a0c10', alpha: 0.45 };

/** 与 src/lib/color.ts 的 dimOver 同一算法（脚本里独立实现一份，避免「测自己」） */
function mixHex(base, over, alpha) {
  const parse = (h) => {
    const n = parseInt(h.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const b = parse(base);
  const o = parse(over);
  const m = (x, y) => Math.round(x * (1 - alpha) + y * alpha);
  return (
    '#' +
    [m(b[0], o[0]), m(b[1], o[1]), m(b[2], o[2])]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * 等颜色变成期望值。
 *
 * 链路每跳都不在同一帧（MutationObserver → setState → effect → IPC），必须轮询；
 * 固定 sleep 一个值就断言会偶发假 FAIL（同 check-sidebar 里等宽度的道理）。
 */
async function waitColor(expect, timeout = 2500) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    last = lastColor();
    if (last === expect) return last;
    await sleep(100);
  }
  return last;
}

/** 等颜色不再等于 `from`（返回变化后的值；没变返回 from） */
async function waitColorChanged(from, timeout = 2500) {
  const t0 = Date.now();
  let last = from;
  while (Date.now() - t0 < timeout) {
    last = lastColor();
    if (last !== from) return last;
    await sleep(100);
  }
  return last;
}

/** 等渲染层第一次回传标题栏配色（首帧也可能已经回传过，那就立刻返回） */
async function waitFirstColor(timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (seen.length) return lastColor();
    await sleep(100);
  }
  return '';
}

const INSERT = (cls, id) => `
  (() => {
    const d = document.createElement('div');
    d.className = ${JSON.stringify(cls)};
    d.id = ${JSON.stringify(id)};
    document.body.appendChild(d);
    return true;
  })()
`;
const REMOVE = (id) => `
  (() => {
    document.getElementById(${JSON.stringify(id)})?.remove();
    return true;
  })()
`;

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 25 },
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
  await sleep(1400);

  const titlebarCss = await win.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector('.titlebar')).backgroundColor`,
  );
  const base = await waitFirstColor();
  ok(
    /^#[0-9a-f]{6}$/.test(base) && base !== '#000000',
    '渲染层已回传标题栏底色（不是初始占位色）',
    `回传=${base} / 页面 .titlebar=${titlebarCss}`,
  );
  const symbolBase = lastSymbol();

  if (!/^#[0-9a-f]{6}$/.test(base)) {
    /* 拿不到基准色，后面的压暗断言全无意义 —— 直接落盘退出，别给出误导性的 PASS */
    log('=== TITLEBAR SCRIM CHECK ===');
    for (const r of rows) log(r);
    log('拿不到基准标题栏色，后续断言跳过');
    log('TITLEBAR SCRIM CHECK DONE');
    app.exit(1);
    return;
  }

  /* ---- 1. 安装遮罩：插入 → 压暗 ---- */
  await win.webContents.executeJavaScript(INSERT('install-mask', '__probe_install'));
  const dim1 = await waitColorChanged(base);
  ok(dim1 !== base, '插入 .install-mask 后应把右上角压暗', `${base} → ${dim1}`);
  const want1 = mixHex(base, INSTALL_SCRIM.color, INSTALL_SCRIM.alpha);
  ok(dim1 === want1, '压暗后的色值 = 标题栏色叠遮罩色', `expect ${want1} got ${dim1}`);
  const sym1 = lastSymbol();
  ok(sym1 !== symbolBase, '窗口按钮符号色也一起压暗', `${symbolBase} → ${sym1}`);

  /* ---- 2. 移除遮罩 → 恢复 ---- */
  await win.webContents.executeJavaScript(REMOVE('__probe_install'));
  const back1 = await waitColor(base);
  ok(back1 === base, '遮罩移除后恢复原色', `→ ${back1}`);

  /* ---- 3. 快捷动作配置弹层：同一条链路、按它自己的遮罩色 ---- */
  await win.webContents.executeJavaScript(INSERT('qa-dialog-mask', '__probe_qa'));
  const dim2 = await waitColorChanged(base);
  const want2 = mixHex(base, QA_SCRIM.color, QA_SCRIM.alpha);
  ok(dim2 === want2, '.qa-dialog-mask 按它自己的遮罩色压暗', `expect ${want2} got ${dim2}`);
  await win.webContents.executeJavaScript(REMOVE('__probe_qa'));
  const back2 = await waitColor(base);
  ok(back2 === base, '第二个遮罩移除后同样恢复', `→ ${back2}`);

  /* ---- 4. 透明点击层（.qa-mask）不该被当成遮罩 ---- */
  await win.webContents.executeJavaScript(INSERT('qa-mask', '__probe_qa_mask'));
  await sleep(700);
  const afterQaMask = lastColor();
  ok(afterQaMask === base, '透明点击层 .qa-mask 不触发压暗', `color=${afterQaMask}`);
  await win.webContents.executeJavaScript(REMOVE('__probe_qa_mask'));

  /* ---- 5. 收尾：确认没有把颜色永久改坏 ---- */
  await sleep(500);
  ok(lastColor() === base, '全部撤掉后回到初始色', `→ ${lastColor()}`);

  log('=== TITLEBAR SCRIM CHECK ===');
  log(`回传记录 ${seen.length} 次`);
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('TITLEBAR SCRIM CHECK DONE');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
