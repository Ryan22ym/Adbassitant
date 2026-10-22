/**
 * v1.1.15 校验：左下角更新提示 + 非设置页的定期检测 + Logcat 回放/虚拟滚动。
 *
 * 这一版改的都是「跨页面的行为」，纯类型检查盖不住，必须真跑一次：
 *
 *   A. 侧栏左下角有没有「检测到新版本」卡片；两个按钮的类型对不对
 *      （取消 = 浅色空白 btn-default，更新 = 主题色实心 btn-primary）；
 *   B. 点「取消」→ 卡片消失并按版本记住（localStorage）；
 *   C. 点「更新」→ 跳到设置页 + 更新卡片自动展开 + 直接开始下载；
 *   D. 自动检测是「启动一次 + 按间隔轮询」，间隔在设置页可改；
 *   E. Logcat 回放：主进程有 3000 行时，页面重新挂载要能把内容铺回来；
 *   F. 虚拟滚动：3000 行只渲染视口那几十个 DOM 节点（这条是「日志一多就卡死」的回归项）；
 *   G. 「后台保持抓取」开关存在、默认勾选、取消勾选会落盘。
 *
 * 🔴 全部走**打桩**：更新检查 / 下载 / logcat 历史都用 ipcMain 桩替换，
 *    不联网、不需要真机，结果可重复。
 * 🔴 独立 userData 临时目录（带 pid，不做「先删再建」，理由见 check-ai-page.cjs）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-v115.cjs \
 *     --watch ui-shots/_v115.log --until "V115 CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_v115.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, ipcMain } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-v115-check-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/* ------------------------------------------------------------------ */
/* 打桩数据                                                            */
/* ------------------------------------------------------------------ */

/** 假的新版本信息：版本号取一个明显不属于当前构建的值，便于在界面上断言 */
const FAKE_VERSION = '9.9.9';
const FAKE_NOTES = [
  '· 左下角新增「检测到新版本」提示，可直接前往更新',
  '· 实时 Logcat 改为虚拟滚动，日志再多也不卡',
  '· 切换到其他模块再回来，已抓取的日志不会消失',
  '· 新增「后台保持抓取」开关，默认开启',
  '· 启动后自动检查更新，之后每 10 分钟一次（可配置）',
  '· 修复部分场景下更新栏默认收起的问题',
  '· 修复真机 adb 掉线后设备列表不刷新的问题',
].join('\n');

/*
 * 线上真实格式：发版脚本把说明塞成**一整段**（v1.1.14 线上那条 500 多字、没有换行）。
 * 用来验卡片的拆条逻辑。这里刻意只留 4 句，方便数条目。
 */
const FAKE_PARAGRAPH =
  '新增「AI 助手」：模型接口写在程序目录的 Conf 里，填上自己的 Key 即可用；' +
  '对话支持图片、文件与网页链接三种附件。' +
  '设置页新增开关，开启后一发生闪退就自动导出日志并生成报告。' +
  '新增两套主题色与自定义主题色，整套界面配色自动派生。';
const FAKE_PARAGRAPH_SENTENCES = 4;

const FAKE_CHECK = {
  ok: true,
  configured: true,
  sourceDesc: '打桩更新源（check-v115）',
  hasUpdate: true,
  currentVersion: '1.1.15',
  checkedAt: '2026-10-20 13:44:00',
  latest: {
    version: FAKE_VERSION,
    publishedAt: '2026-10-20',
    notes: FAKE_NOTES,
    critical: true,
    pkg: { url: 'https://example.invalid/fake.zip', sha256: 'deadbeef', size: 1048576 },
  },
};

/** 3000 行假日志：足够触发虚拟滚动，又远小于 MAX_LINES */
const FAKE_LINES = Array.from({ length: 3000 }, (_, i) => ({
  seq: i + 1,
  raw: `10-20 13:44:00.000  1000  1000 I TestTag: line ${i + 1}`,
  time: '10-20 13:44:00.000',
  pid: 1000,
  tid: 1000,
  level: ['V', 'D', 'I', 'W', 'E'][i % 5],
  tag: 'TestTag',
  message: `line ${i + 1}`,
}));

const downloadCalls = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expr, timeout = 5000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await win.webContents.executeJavaScript(expr).catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return false;
}

function read(win, expr) {
  return win.webContents.executeJavaScript(expr);
}

function click(win, sel) {
  return win.webContents.executeJavaScript(`
    (() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()
  `);
}

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  log('userData = ' + DATA);
  log('registerIpc …');

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  /*
   * 打桩：把三条会碰网络 / 碰真机的通道换掉。
   * 桩的返回必须是 renderer 认得的信封 {ok, data}（见 ipc.ts 的 wrap）。
   */
  ipcMain.removeHandler('update:check');
  ipcMain.handle('update:check', () => ({ ok: true, data: FAKE_CHECK }));

  ipcMain.removeHandler('update:download');
  ipcMain.handle('update:download', (_e, url) => {
    downloadCalls.push(url);
    // 故意失败：本脚本只验「有没有真的发起下载」，不想在这里落盘或替换文件
    return { ok: false, error: '打桩：下载被拦下（check-v115）' };
  });

  ipcMain.removeHandler('logcat:history');
  ipcMain.handle('logcat:history', () => ({
    ok: true,
    data: {
      status: { running: true, serial: 'stub-serial', lines: FAKE_LINES.length },
      lines: FAKE_LINES,
      buffered: FAKE_LINES.length,
    },
  }));

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const rendererErrors = [];

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
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

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await win.show();
  await sleep(1200);

  /* ================================================================ */
  /* A. 左下角更新卡片                                                 */
  /* ================================================================ */

  log('等自动检测把卡片点亮（启动后延迟 8s）…');
  const tipShown = await waitFor(win, `!!document.querySelector('.update-tip')`, 20000);
  ok(tipShown, 'A1 自动检测把「检测到新版本」卡片点亮（非设置页也会检测）');

  const tip = tipShown
    ? await read(
        win,
        `(() => {
          const el = document.querySelector('.update-tip');
          const cancel = el.querySelector('[data-update-tip-cancel]');
          const go = el.querySelector('[data-update-tip-go]');
          const foot = document.querySelector('.sidebar-foot');
          const nav = document.querySelector('.sidebar-nav');
          const notesEl = el.querySelector('[data-update-tip-notes]');
          return {
            title: (el.querySelector('.update-tip-title')?.textContent || '').trim(),
            ver: (el.querySelector('.update-tip-ver')?.textContent || '').trim(),
            cancelText: (cancel?.textContent || '').trim(),
            goText: (go?.textContent || '').trim(),
            cancelClass: cancel?.className || '',
            goClass: go?.className || '',
            attr: el.getAttribute('data-update-tip'),
            label: (el.querySelector('.update-tip-label')?.textContent || '').trim(),
            notes: (notesEl?.textContent || '').trim(),
            items: [...el.querySelectorAll('.update-tip-item')].map((e) =>
              (e.textContent || '').trim(),
            ),
            notesClientH: notesEl ? notesEl.clientHeight : 0,
            notesScrollH: notesEl ? notesEl.scrollHeight : 0,
            tipW: Math.round(el.getBoundingClientRect().width),
            /* 位置：卡片必须在导航之后、底栏之前 */
            afterNav: !!(nav && nav.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
            beforeFoot: !!(
              foot && el.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
          };
        })()`,
      )
    : {};

  if (tipShown) {
    ok(tip.title === '检测到新版本', 'A2 标题文案 = 检测到新版本', `title=${tip.title}`);
    ok(tip.ver === `v${FAKE_VERSION}`, 'A3 带上新版本号', `ver=${tip.ver}`);
    ok(tip.cancelText === '取消' && tip.goText === '更新', 'A4 两个按钮：取消 / 更新', `${tip.cancelText}/${tip.goText}`);
    ok(
      tip.cancelClass.includes('btn-default'),
      '🔴 A5 取消 = 浅色空白按钮（btn-default）',
      `class=${tip.cancelClass}`,
    );
    ok(
      tip.goClass.includes('btn-primary'),
      '🔴 A6 更新 = 主题色实心按钮（btn-primary）',
      `class=${tip.goClass}`,
    );
    ok(tip.afterNav && tip.beforeFoot, 'A7 卡片在左下角（导航之下、状态栏之上）');

    /* 卡片正文 = 真实更新说明（v1.1.15 第二轮：要能看到「更新了什么」） */
    ok(tip.label.startsWith('更新内容'), 'A8 正文小标题 = 更新内容', `label=${tip.label}`);
    ok(
      tip.items.length === FAKE_NOTES.split('\n').length,
      '🔴 A9 卡片正文按条列出更新说明（版本号 + 更新内容）',
      `items=${tip.items.length}/${FAKE_NOTES.split('\n').length}`,
    );
    ok(
      tip.items.every((s, i) => s === FAKE_NOTES.split('\n')[i]),
      'A10 条目内容与更新源逐字一致（不改写、不丢行）',
      `first=${(tip.items[0] || '').slice(0, 24)}…`,
    );
    /*
     * 长说明不能把卡片撑爆：正文限高 + 内部滚动（高度必须是行高整数倍，否则最后一行会被劈半）。
     * 判据取「滚动高度 > 可视高度」—— 直接等价于「没被裁掉，滚一下能看全」。
     */
    ok(
      tip.notesClientH > 0 && tip.notesClientH <= 104 && tip.notesScrollH > tip.notesClientH,
      'A11 长说明限高 + 内部滚动（滚一下能看全，不截断成省略号）',
      `client=${tip.notesClientH} scroll=${tip.notesScrollH}`,
    );
    ok(tip.tipW > 150 && tip.tipW < 240, 'A12 卡片宽度适配侧栏（不被撑破）', `w=${tip.tipW}`);
  }

  // 截图留档：肉眼复核配色与位置
  // ⚠️ 先等一下：卡片带 .fade-in（0.22s，from opacity:0），并且 capturePage 拿到的是
  //    「上一次合成好的帧」—— 拿到 DOM 就立刻截图，大概率截到一张还没画的图。
  await sleep(500);
  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '_v115-tip.png'), img.toPNG());
  } catch {
    /* 截图失败不影响判据 */
  }

  /* ================================================================ */
  /* B. 取消：卡片消失 + 按版本记住                                     */
  /* ================================================================ */

  await click(win, '[data-update-tip-cancel]');
  const goneAfterCancel = await waitFor(win, `!document.querySelector('.update-tip')`, 2000);
  const remembered = await read(win, `localStorage.getItem('adb-update-tip-dismissed')`);
  ok(goneAfterCancel, 'B1 点取消后卡片消失');
  ok(remembered === FAKE_VERSION, 'B2 取消结果按版本记住（换版本还会再提示）', `stored=${remembered}`);

  /* ================================================================ */
  /* C. 更新：跳设置页 + 展开更新卡片 + 开始下载                        */
  /* ================================================================ */

  /*
   * 卡片已被「取消」记住，得让它再出现一次。
   * 直接 reload：watcher 会重新跑一遍「启动 8 秒后检查」，是最接近真实路径的做法
   * （把 localStorage 一并清掉，模拟「用户没取消过」）。
   */
  await read(win, `localStorage.removeItem('adb-update-tip-dismissed')`);
  /*
   * 顺带覆盖**线上真实格式**：发版脚本塞进 notes 的是一整段没有换行的长文
   * （线上 v1.1.14 就是 500 多字一整段）。换成整段再 reload，验自动拆条。
   */
  FAKE_CHECK.latest.notes = FAKE_PARAGRAPH;
  await win.webContents.reload();
  await sleep(1200);
  const tipAgain = await waitFor(win, `!!document.querySelector('.update-tip')`, 20000);
  ok(tipAgain, 'C1 reload 后再次检测到新版本（清掉取消记录就能重新提醒）');

  const paraItems = await read(
    win,
    `[...document.querySelectorAll('.update-tip-item')].map((e) => (e.textContent || '').trim())`,
  );
  ok(
    Array.isArray(paraItems) && paraItems.length === FAKE_PARAGRAPH_SENTENCES,
    '🔴 C2 整段说明按句自动拆条（线上真实格式，不是一坨文字墙）',
    `items=${Array.isArray(paraItems) ? paraItems.length : paraItems}=${FAKE_PARAGRAPH_SENTENCES} first=${(paraItems?.[0] || '').slice(0, 18)}…`,
  );

  // 整段格式的卡片也留一张图（这是线上真实的样子）
  await sleep(500);
  try {
    const img2 = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '_v115-tip-para.png'), img2.toPNG());
  } catch {
    /* 截图失败不影响判据 */
  }

  await click(win, '[data-update-tip-go]');
  const onSettings = await waitFor(win, `location.hash === '#/settings'`, 3000);  ok(onSettings, 'C3 点「更新」跳到设置页', `hash=${await read(win, 'location.hash')}`);

  const panelOpen = await waitFor(
    win,
    `(() => {
       const p = document.querySelector('[data-update-panel]');
       const c = p && p.querySelector('.card');
       return !!c && !c.classList.contains('is-collapsed');
     })()`,
    4000,
  );
  ok(panelOpen, '🔴 C4 更新卡片自动展开（不用用户再点一下）');

  // downloadCalls 在主进程里，轮询等它被调用（下载请求已经发出去了）
  const t0 = Date.now();
  while (downloadCalls.length === 0 && Date.now() - t0 < 6000) await sleep(150);
  ok(downloadCalls.length > 0, '🔴 C5 点「更新」后直接发起下载', `url=${downloadCalls[0] || '-'}`);

  const autoRow = await read(
    win,
    `(() => {
       const input = document.querySelector('[data-update-interval]');
       /* Switch 是 <span role="switch" aria-checked>，不是 input（见 components/ui.tsx） */
       const sw = document.querySelector('[data-update-auto] .switch');
       return { interval: input?.value ?? null, auto: sw?.getAttribute('aria-checked') === 'true' };
     })()`,
  );
  ok(autoRow.interval === '10', 'D1 设置页有「检查间隔」且默认 10 分钟', `interval=${autoRow.interval}`);
  ok(autoRow.auto === true, 'D2 自动检查开关默认开', `auto=${autoRow.auto}`);

  /* ================================================================ */
  /* E/F/G. Logcat：回放 + 虚拟滚动 + 后台保持抓取                     */
  /* ================================================================ */

  await click(win, '.nav-item[href="#/logcat"]');
  await waitFor(win, `!!document.querySelector('.logcat-view')`, 5000);
  await sleep(600);

  const lc = await read(
    win,
    `(() => {
      const view = document.querySelector('.logcat-view');
      const rows = [...document.querySelectorAll('.logcat-line')];
      const spacer = document.querySelector('.log-spacer');
      const foot = document.querySelector('.logcat-foot')?.textContent || '';
      const keep = document.querySelector('[data-logcat-keep] input[type=checkbox]');
      const last = rows.length ? rows[rows.length - 1].textContent : '';
      return {
        domRows: rows.length,
        spacerH: spacer ? parseFloat(getComputedStyle(spacer).height) : 0,
        scrollTop: view ? view.scrollTop : 0,
        foot: foot.replace(/\\s+/g, ' ').trim(),
        keepExists: !!keep,
        keepChecked: !!keep?.checked,
        last,
      };
    })()`,
  );

  ok(lc.foot.includes('3000 行'), 'E1 切进 Logcat 页就把主进程缓冲的行回放出来了', `foot=${lc.foot}`);
  ok(
    lc.domRows > 0 && lc.domRows < 120,
    '🔴 F1 虚拟滚动：3000 行只渲染视口那几十个 DOM 节点',
    `domRows=${lc.domRows}`,
  );
  ok(
    Math.abs(lc.spacerH - 3000 * 22) < 2,
    'F2 撑高的占位层 = 行数 × 行高（滚动条长度才对）',
    `h=${lc.spacerH}`,
  );
  ok(lc.scrollTop > 0 && /line 3000/.test(lc.last || ''), 'F3 自动滚动到底：最后一行是第 3000 行', `last=${(lc.last || '').slice(-24)}`);

  /* E2. 切走再回来：日志还在（本次改动的核心问题） */
  await click(win, '.nav-item[href="#/settings"]');
  await sleep(500);
  await click(win, '.nav-item[href="#/logcat"]');
  await waitFor(win, `!!document.querySelector('.logcat-view')`, 5000);
  await sleep(500);
  const back = await read(
    win,
    `(() => ({
       foot: (document.querySelector('.logcat-foot')?.textContent || '').replace(/\\s+/g, ' ').trim(),
       domRows: document.querySelectorAll('.logcat-line').length,
     }))()`,
  );
  ok(back.foot.includes('3000 行'), '🔴 E2 切到别的模块再回来，日志内容还在（不再一片空白）', `foot=${back.foot}`);
  ok(back.domRows > 0 && back.domRows < 120, 'E3 回来后仍然是虚拟滚动', `domRows=${back.domRows}`);

  /* G. 后台保持抓取开关 */
  ok(lc.keepExists, 'G1 有「后台保持抓取」勾选项');
  ok(lc.keepChecked, 'G2 默认勾选（切页继续抓）', `checked=${lc.keepChecked}`);
  await click(win, '[data-logcat-keep] input[type=checkbox]');
  await sleep(400);
  const saved = await read(
    win,
    `window.adbApi.getSettings().then((r) => (r && r.ok && r.data ? r.data.logcatKeepBackground : null))`,
  );
  ok(saved === false, 'G3 取消勾选会落盘（settings.json 的 logcatKeepBackground）', `value=${saved}`);

  /* ================================================================ */

  try {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, '_v115-logcat.png'), img.toPNG());
  } catch {
    /* ignore */
  }

  win.hide();

  log('=== V115 CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('V115 CHECK DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
