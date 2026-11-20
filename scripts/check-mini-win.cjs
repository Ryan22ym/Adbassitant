/**
 * v1.1.28 校验：页面保活 + 浮动小窗（独立窗口）。
 *
 * 这次改动的两个核心行为都盖不住类型检查，必须真起来验：
 *
 *   A. 页面保活（主窗口内）
 *      A1 首屏只有 1 个 .page
 *      A2 切到 /weaknet 后，.page 仍只有 2 个（旧的没被卸载）
 *      A3 再切回 /，/weaknet 那个 .page **还在 DOM 里**，只是 is-idle
 *        —— 这就是「弱网参数切走再回来还在」的实现基础
 *      A4 活动页同一时刻只有一个
 *
 *   B. 浮动小窗（独立 BrowserWindow）
 *      B1 openMiniWin 之后窗口数 +1，URL 里带 #/mini/weaknet
 *      B2 小窗可以被移到主窗口矩形**之外**（屏幕坐标），位置真的生效
 *      B3 位置写回了 settings.json 的 miniWinBounds
 *      B4 重复 open 同一页只是聚焦，不会开出第二扇
 *      B5 close 之后窗口销毁、列表清空
 *
 * 🔴 不碰真机、不联网；独立 userData 临时目录（带 pid）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-mini-win.cjs \
 *     --watch ui-shots/_miniwin.log --until "MINI WIN CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_miniwin.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
}

let pass = 0;
let fail = 0;
function check(ok, name, detail) {
  if (ok) {
    pass += 1;
    log(`PASS ${name}${detail ? ' · ' + detail : ''}`);
  } else {
    fail += 1;
    log(`FAIL ${name}${detail ? ' · ' + detail : ''}`);
  }
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-miniwin-check-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  await app.whenReady();

  const svc = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'mini-win.js'));
  const indexHtml = path.join(ROOT, 'dist', 'index.html');

  /* ---------------- 主窗口 ---------------- */
  const mainWin = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  svc.setMiniWinMainWindowProvider(() => mainWin);

  await mainWin.loadFile(indexHtml);
  await sleep(2500); // 等初始化 IPC（设备扫描 / 设置 / uiConf）跑完

  const js = (code) => mainWin.webContents.executeJavaScript(code, true);

  /* ---------------- A. 页面保活 ---------------- */
  const a1 = await js(`document.querySelectorAll('.page').length`);
  check(a1 === 1, 'A1 首屏只挂载当前页', `pages=${a1}`);

  await js(`location.hash = '#/weaknet'`);
  await sleep(800);
  const a2 = await js(`document.querySelectorAll('.page').length`);
  check(a2 === 2, 'A2 切到弱网页后旧页仍挂载', `pages=${a2}`);

  const weakActive = await js(
    `(document.querySelector('.page[data-page="/weaknet"]')||{}).className || ''`,
  );
  check(weakActive.includes('is-active'), 'A2b 弱网页是活动页', weakActive);

  await js(`location.hash = '#/'`);
  await sleep(800);
  const a3 = await js(
    `!!document.querySelector('.page[data-page="/weaknet"].is-idle')`,
  );
  check(a3 === true, 'A3 切走后弱网页仍在 DOM 且被隐藏（keep-alive）');

  const a4 = await js(`document.querySelectorAll('.page.is-active').length`);
  check(a4 === 1, 'A4 同一时刻只有一个活动页', `active=${a4}`);

  /* ---------------- B. 浮动小窗 ---------------- */
  const before = BrowserWindow.getAllWindows().length;
  svc.openMiniWin('weaknet');
  await sleep(2600);

  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  check(all.length === before + 1, 'B1 小窗是独立的 BrowserWindow', `windows=${all.length}`);

  const mini = all.find((w) => w.webContents.getURL().includes('#/mini/weaknet'));
  check(!!mini, 'B1b 小窗加载的是 #/mini/weaknet');
  if (!mini) {
    log('MINI WIN CHECK DONE');
    app.exit(fail ? 1 : 0);
    return;
  }

  /* B2：移到主窗口矩形之外（右侧 600px 处），验证「不限在软件页内」 */
  const mb = mainWin.getBounds();
  const target = { x: mb.x + mb.width + 600, y: mb.y + 120, width: 420, height: 540 };
  mini.setBounds(target);
  /*
   * 等 2.8s：位置落盘有两条路径 —— moved 事件（500ms 防抖）与 2s 兜底轮询。
   * 程序化 setBounds 在 Windows 上不一定触发 moved，所以这里按最慢的那条等。
   */
  await sleep(2800);
  const got = mini.getBounds();
  check(
    Math.abs(got.x - target.x) <= 2 && Math.abs(got.y - target.y) <= 2,
    'B2 小窗可以移到主窗口之外',
    `${got.x},${got.y} vs ${target.x},${target.y}`,
  );

  /* B3：位置写盘（防抖 500ms，上面已经等了 900ms） */
  const saved = readSettings();
  const rec = (saved.miniWinBounds || {}).weaknet;
  check(
    !!rec && Math.abs(rec.x - target.x) <= 2 && Math.abs(rec.width - target.width) <= 2,
    'B3 位置尺寸写回 settings.miniWinBounds',
    JSON.stringify(rec || null),
  );

  /* B4：重复 open 不新开 */
  svc.openMiniWin('weaknet');
  await sleep(400);
  const afterReopen = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
  check(afterReopen === all.length, 'B4 重复打开只是聚焦', `windows=${afterReopen}`);

  /* B5：关闭 */
  svc.closeMiniWin('weaknet');
  await sleep(500);
  const left = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
  const list = svc.listMiniWins();
  check(left === before && list.length === 0, 'B5 关闭后窗口销毁、列表清空', `windows=${left}`);

  log(`RESULT pass=${pass} fail=${fail}`);
  log('MINI WIN CHECK DONE');
  app.exit(fail ? 1 : 0);
}

main().catch((e) => {
  log('ERROR ' + (e && e.stack ? e.stack : String(e)));
  log('MINI WIN CHECK DONE');
  app.exit(1);
});
