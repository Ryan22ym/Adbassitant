/**
 * 真机回归：Logcat「切页回来日志还在」+「后台保持抓取」（v1.1.15）。
 *
 * check-v115.cjs 里那几条是**打桩**验的（历史行由 ipcMain 桩直接喂回来）。
 * 这一条走真实链路：真 adb logcat 子进程 → 主进程 recent 环形缓冲 → 页面回放，
 * 覆盖的正是「切到别的模块再回来，日志一片空白」这个原问题的全链路。
 *
 * 为什么必须另起一条：
 *   · 打桩测不出 services/logcat.ts 里 recent 缓冲到底有没有真的在攒；
 *   · 也测不出「停止后 recent 移交 orphanRecent」那段（桩不走 stop）。
 *
 * 需要一台在线真机/模拟器。没设备时直接跳过（返回 0），不阻塞流水线。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-logcat-live.cjs \
 *     --watch ui-shots/_logcat-live.log --until "LOGCAT LIVE CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_logcat-live.log');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-logcat-live-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 往设备日志里写一行，制造确定的输出（不依赖系统自己刷日志） */
function pokeDevice(tag) {
  try {
    execFileSync(ADB, ['shell', 'log', '-t', 'V115CHECK', `live-check ${tag}`], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  // 先确认有设备，没有就跳过（这条是「有设备才跑」的补充回归，不是必跑项）
  let devices = '';
  try {
    devices = execFileSync(ADB, ['devices'], { timeout: 8000 }).toString();
  } catch (e) {
    devices = '';
  }
  if (!/\tdevice\b/.test(devices)) {
    log('没有在线设备，跳过');
    log('LOGCAT LIVE CHECK DONE');
    app.exit(0);
    return;
  }
  log('devices:\n' + devices.trim());

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

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
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  const read = (expr) => win.webContents.executeJavaScript(expr);
  const click = (sel) =>
    read(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()`);
  /** 底部「N 行」里的 N（界面自己维护的行数，最直观的判据） */
  const lineCount = () =>
    read(`(() => {
      const t = document.querySelector('.logcat-foot')?.textContent || '';
      const m = t.match(/([\\d,]+)\\s*行/);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
    })()`);

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/logcat' });
  await win.show();

  /*
   * 等设备就绪：首屏的设备扫描是异步的（冷启动还要拉 adb server），
   * 固定 sleep 一段时间就点，会点在「按钮还是 disabled」上 —— 那就什么都没发生，
   * 后面的断言全是因为「压根没开始抓」而失败，看起来像功能坏了。
   */
  const startState = () =>
    read(`(() => {
      const b = document.querySelector('.logcat-foot .btn');
      return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
    })()`);
  let startBtn = null;
  for (let i = 0; i < 60; i++) {
    startBtn = await startState();
    if (startBtn && !startBtn.disabled) break;
    await sleep(500);
  }
  ok(
    startBtn && startBtn.text === '开始抓取' && !startBtn.disabled,
    'P1 设备就绪，「开始抓取」可点',
    JSON.stringify(startBtn),
  );

  await click('.logcat-foot .btn');
  // 抓取过程中有节奏地写几条日志，保证一定有输出
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    pokeDevice(i);
  }

  let n1 = -1;
  for (let i = 0; i < 20 && n1 <= 0; i++) {
    n1 = await lineCount();
    if (n1 > 0) break;
    await sleep(400);
  }
  ok(n1 > 0, 'P2 真实 adb logcat 抓到行（含刚才写进去的 V115CHECK）', `lines=${n1}`);

  /*
   * P3 不能去 DOM 里找那几行 —— 虚拟滚动只渲染视口那几十行，它们很可能不在其中
   * （这不是缺陷，正是 F1 要的效果）。改成用页面自带的关键字过滤去数：
   * 输入 V115CHECK 后底部会显示 "命中 / 总数 行"，命中数 > 0 就说明数据真在里面。
   */
  await read(`(() => {
    const el = document.querySelector('.log-toolbar input[placeholder^="关键字"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'V115CHECK');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const filtered = await read(
    `(() => {
      const t = document.querySelector('.logcat-foot')?.textContent || '';
      const m = t.match(/([\\d,]+)\\s*\\/\\s*([\\d,]+)\\s*行/);
      return m ? { hit: parseInt(m[1].replace(/,/g, ''), 10), total: parseInt(m[2].replace(/,/g, ''), 10) } : null;
    })()`,
  );
  ok(filtered && filtered.hit > 0, 'P3 自己写的那几行确实在数据里（按关键字过滤能命中）', JSON.stringify(filtered));
  // 清掉过滤，后面的断言要按总行数看
  await read(`(() => {
    const el = document.querySelector('.log-toolbar input[placeholder^="关键字"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);

  /* ★ 核心：切到别的模块再回来 */
  await click('.nav-item[href="#/"]');
  await sleep(400);
  // 在别的页面期间继续产生日志：主进程那边还在抓
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    pokeDevice('away-' + i);
  }
  await click('.nav-item[href="#/logcat"]');
  await sleep(1200);

  const n2 = await lineCount();
  ok(n2 > 0, '🔴 P4 切回 Logcat 页，日志还在（不再一片空白）', `lines=${n2}`);
  const stillRunning = await read(
    `!!document.querySelector('.logcat-page, .logcat-view') &&
     /抓取中/.test(document.querySelector('.card-extra, .card-head')?.textContent || '')`,
  );
  ok(!!stillRunning, 'P5 回来后仍是「抓取中」（后台抓取没被打断）', `running=${stillRunning}`);

  /* ★ 停止后切页再回来：内容不该消失 */
  await click('.logcat-foot .btn'); // 停止抓取
  await sleep(800);
  const n3 = await lineCount();
  await click('.nav-item[href="#/settings"]');
  await sleep(400);
  await click('.nav-item[href="#/logcat"]');
  await sleep(1000);
  const n4 = await lineCount();
  ok(n3 > 0 && n4 > 0, 'P6 停止抓取后切页回来，已抓到的内容仍保留', `before=${n3} after=${n4}`);

  win.hide();
  log('=== LOGCAT LIVE CHECK ===');
  for (const r of rows) log(r);
  log(errors.length ? `=== 渲染层错误 ===\n${errors.join('\n')}` : '渲染层无错误');
  log('LOGCAT LIVE CHECK DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
