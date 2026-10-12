/**
 * 「插入手机自动投屏」的托盘与关窗行为回归（在 Electron 里跑真实主进程）
 *
 *   electron scripts/check-auto-mirror-tray.cjs
 *
 * 为什么非得真起一个应用：这块最坏的失败是**程序退不掉**。
 * close 拦截只要写宽一点（比如忘了看 appQuitting），用户点关闭就变成「收进托盘」，
 * 从托盘菜单退出时又走同一条 close 路径、再被拦一次 —— 程序彻底关不掉，
 * 只能去任务管理器杀。这种 bug 在代码上看着完全正常，只能真点一次关闭来验。
 *
 * 注意：会短暂弹出真实窗口，跑完自动退出。运行前请确认没有另一个实例在跑
 * （单实例锁会让本脚本启动的进程直接退出）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'production';

const OUT = path.join(__dirname, '..', 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_auto-mirror-tray.log');

const rows = [];
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

function finish(code) {
  rows.forEach((r) => {
    try {
      fs.appendFileSync(LOG, r + '\n');
    } catch {
      /* ignore */
    }
    console.log(r);
  });
  const failed = rows.filter((r) => r.startsWith('FAIL')).length;
  const tail = `\n共 ${rows.length} 项，失败 ${failed} 项`;
  try {
    fs.appendFileSync(LOG, tail + '\nAUTO MIRROR TRAY CHECK DONE\n');
  } catch {
    /* ignore */
  }
  console.log(tail);
  console.log('AUTO MIRROR TRAY CHECK DONE');
  process.exit(code);
}

/* 兜底：整个检查不许超过 25 秒，卡住就判失败，免得留一个僵尸 Electron */
const hardStop = setTimeout(() => {
  record(false, 'X 总时长', '超过 25 秒未结束（有东西卡住了）');
  finish(1);
}, 25000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  fs.writeFileSync(LOG, `\n===== auto mirror tray check @ ${new Date().toISOString()} =====\n`);
} catch {
  /* ignore */
}

/* 启动真实主进程（模块缓存保证下面 require 到的是同一份） */
require('../dist-electron/electron/main.js');
const MAIN = require('../dist-electron/electron/main.js');
const settings = require('../dist-electron/electron/services/settings.js');

app.whenReady().then(async () => {
  await sleep(2500); // 等窗口 ready-to-show

  const win = BrowserWindow.getAllWindows()[0];

  if (!win) {
    record(false, 'T0 主窗口已创建', '没拿到窗口 —— 可能有另一个实例占着单实例锁');
    clearTimeout(hardStop);
    return finish(1);
  }
  record(true, 'T0 主窗口已创建', `visible=${win.isVisible()}`);

  const before = settings.getSettings().autoMirrorOnConnect;
  record(before === false, 'T1 开关默认值为 false', `实际 ${before}`);

  /* ---- T2：开关打开 → 托盘出现 ---- */
  settings.saveSettings({ autoMirrorOnConnect: true });
  MAIN.syncTray();
  await sleep(300);
  record(MAIN.isTrayActive() === true, 'T2 开启开关 → 托盘常驻生效', `isTrayActive=${MAIN.isTrayActive()}`);

  /* ---- T3：点关闭 → 窗口不销毁、只是藏起来 ---- */
  win.close();
  await sleep(600);
  record(!win.isDestroyed(), 'T3a 点关闭后窗口未被销毁', `destroyed=${win.isDestroyed()}`);
  record(
    !win.isDestroyed() && !win.isVisible(),
    'T3b 点关闭后窗口隐藏（收进托盘，程序继续跑）',
    `visible=${win.isVisible()}`,
  );

  /* ---- T4：关掉开关 → 托盘撤离，窗口被放出来（否则用户找不到程序）---- */
  settings.saveSettings({ autoMirrorOnConnect: false });
  MAIN.syncTray();
  await sleep(400);
  record(MAIN.isTrayActive() === false, 'T4a 关闭开关 → 托盘撤离', `isTrayActive=${MAIN.isTrayActive()}`);
  record(
    !win.isDestroyed() && win.isVisible(),
    'T4b 关闭开关时把藏起来的窗口放出来',
    `visible=${win.isVisible()}`,
  );

  /* ---- T5：开关关着时点关闭 → 直接走退出（行为与 v1.1.8 一致）---- */
  settings.saveSettings({ autoMirrorOnConnect: true });
  MAIN.syncTray();
  await sleep(200);
  record(MAIN.isTrayActive() === true, 'T5a 再次开启 → 托盘回来', '');

  /*
   * T5b 是这一整套里最关键的一条：
   * 开关开着时退出，必须真的退得掉。若 close 拦截把 app.quit() 也拦住，
   * 下面这个 before-quit 之后进程会一直挂着，由 hardStop 判失败。
   */
  app.on('will-quit', () => {
    clearTimeout(hardStop);
    record(true, 'T5b 开关开启状态下也能正常退出（close 放行）', 'will-quit 已触发');
    finish(0);
  });

  await sleep(200);
  app.quit();
});
