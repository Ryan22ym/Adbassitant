/**
 * 真机回归：功能栏的飞行模式按钮（v1.1.28，2026-11-20）。
 *
 * 守的是一串「看不见的行为」：
 *   ① 功能栏窗口高度 = 2 个 slot（112 DIP），DOM 里真有两个按钮、
 *      飞机在上、pin 在下、竖排（flex-direction: column）
 *   ② 点一下开飞行模式：手机真的进了飞行模式（cmd connectivity 查询为准），
 *      状态推回按钮 → data-mbar-plane='1'
 *   ③ pin 的点亮不许串到飞机按钮上（v1.1.28 加按钮时差点踩到：
 *      CSS 原来写的是 `.mbar[data-pinned] .mbar-btn`，会把所有按钮都点亮）
 *   ④ 再点一下关回来：手机真退出飞行模式
 *   ⑤ 无线连接的 serial 必须被拦住（会断开投屏，主进程直接抛错）
 *
 * 🔴 会真的开关一次手机的飞行模式（短暂断网约 3 秒），跑完恢复原状。
 *    需要一台 **USB 在线**的真机；没有就跳过（返回 0）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-mirror-airplane.cjs \
 *     --watch ui-shots/_mirror-airplane.log --until "MIRROR AIRPLANE CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_mirror-airplane.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  const line = a
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ');
  fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${line}\n`);
}

let failed = 0;
function ok(name, pass, detail) {
  if (pass) log(`  PASS  ${name}`);
  else {
    failed += 1;
    log(`  FAIL  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-mirror-airplane-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/* 🔴 停投屏时会 destroy 功能栏小窗，进程里可能一个窗口都不剩 —— 别让 Electron 自动退出 */
app.on('window-all-closed', () => {
  /* 什么都不做 */
});

const ADB = path.join(ROOT, 'bin', 'adb.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 直接问手机（不信应用内部的缓存） */
function phoneAirplane(serial) {
  const run = (...args) => {
    try {
      return execFileSync(ADB, ['-s', serial, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      }).trim();
    } catch (e) {
      return `ERR:${e.message}`;
    }
  };
  const v = run('shell', 'cmd', 'connectivity', 'airplane-mode').toLowerCase();
  if (v === 'enabled') return true;
  if (v === 'disabled') return false;
  return run('shell', 'settings', 'get', 'global', 'airplane_mode_on') === '1';
}

function setPhoneAirplane(serial, on) {
  try {
    execFileSync(
      ADB,
      ['-s', serial, 'shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
  } catch {
    /* 老机型没有这个命令，交给 settings 兜底 */
    try {
      execFileSync(
        ADB,
        ['-s', serial, 'shell', 'settings', 'put', 'global', 'airplane_mode_on', on ? '1' : '0'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      );
    } catch {
      /* ignore */
    }
  }
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    failed += 1;
    log(`  FAIL  异常：${e && e.message}`);
  }
  log(`MIRROR AIRPLANE CHECK DONE  failed=${failed}`);
  await sleep(200);
  app.exit(failed ? 1 : 0);
});

async function run() {
  const mirror = require('../dist-electron/electron/services/mirror.js');
  const bar = require('../dist-electron/electron/services/mirror-bar.js');
  const adbSvc = require('../dist-electron/electron/services/adb.js');
  const settings = require('../dist-electron/electron/services/settings.js');
  require('../dist-electron/electron/ipc.js').registerIpc();
  adbSvc.setLogSink(() => {});

  settings.saveSettings({ mirrorBarEnabled: true });

  const devs = await adbSvc.listDevices();
  const dev = (devs || []).find((d) => d.state === 'device' && !/emulator-/.test(d.serial));
  if (!dev) {
    log('  没有在线真机，跳过');
    return;
  }

  const before = phoneAirplane(dev.serial);
  log(`设备：${dev.serial} ${dev.model || ''}  初始飞行模式=${before}`);

  log('[1] 启动投屏（建功能栏小窗）');
  await mirror.startMirror({
    serial: dev.serial,
    maxSize: 720,
    bitRateMbps: 4,
    maxFps: 30,
    noAudio: true,
    keyboard: 'sdk',
    wakeOnDoubleClick: false,
    stayAwake: true,
  });

  const barWin = () => BrowserWindow.getAllWindows().find((w) => bar.isMirrorBarWindow(w)) || null;
  let bw = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    bw = barWin();
    if (bw && !bw.isDestroyed()) break;
  }
  ok('功能栏窗口已创建', !!bw && !bw.isDestroyed());
  if (!bw) {
    await mirror.stopMirror();
    return;
  }

  // 等前端 bundle 载入完再问 DOM
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    const n = await bw.webContents
      .executeJavaScript(`document.querySelectorAll('.mbar-btn').length`)
      .catch(() => 0);
    if (n >= 2) break;
  }

  log('[2] DOM：两个按钮、竖排、飞机在上');
  const dom = await bw.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.mbar');
    const btns = [...document.querySelectorAll('.mbar-btn')];
    return {
      count: btns.length,
      dir: root ? getComputedStyle(root).flexDirection : '',
      gap: root ? getComputedStyle(root).gap : '',
      first: btns[0] ? btns[0].getAttribute('data-mbar-plane') : null,
      second: btns[1] ? btns[1].getAttribute('data-mbar-pin') : null,
    };
  })()`);
  ok('功能栏有 2 个按钮', dom.count === 2, dom);
  ok('竖排（flex-direction: column）', dom.dir === 'column', dom);
  ok('第一个是飞行模式、第二个是 pin', dom.first !== null && dom.second === '1', dom);

  const b = bw.getBounds();
  ok('窗口高度 112 DIP（2 × 56）', Math.abs(b.height - 112) <= 1, b);

  log('[3] 开飞行模式');
  const on = await bar.setMirrorAirplane(true);
  await sleep(800);
  ok('服务状态 airplane=true', on.airplane === true, on);
  ok('手机真的进了飞行模式', phoneAirplane(dev.serial) === true, phoneAirplane(dev.serial));
  const domOn = await bw.webContents.executeJavaScript(`(() => {
    const plane = document.querySelector('.mbar-btn[data-mbar-plane]');
    const root = document.querySelector('.mbar');
    return { plane: plane && plane.getAttribute('data-mbar-plane'), pinned: root && root.getAttribute('data-pinned') };
  })()`);
  ok('飞机按钮点亮（data-mbar-plane=1）', domOn.plane === '1', domOn);
  ok('pin 没被带着点亮（data-pinned 仍 0）', domOn.pinned === '0', domOn);

  log('[4] 关飞行模式');
  const off = await bar.setMirrorAirplane(false);
  await sleep(800);
  ok('服务状态 airplane=false', off.airplane === false, off);
  ok('手机真的退出飞行模式', phoneAirplane(dev.serial) === false, phoneAirplane(dev.serial));
  const domOff = await bw.webContents.executeJavaScript(
    `document.querySelector('.mbar-btn[data-mbar-plane]').getAttribute('data-mbar-plane')`,
  );
  ok('飞机按钮熄灭（data-mbar-plane=0）', domOff === '0', domOff);

  log('[5] 无线连接的设备必须被拦住');
  ok('USB serial 放行', bar.isWirelessSerial(dev.serial) === false, dev.serial);
  ok('192.168.x:5555 拦住', bar.isWirelessSerial('192.168.1.7:5555') === true);
  ok('adb-tls 拦住', bar.isWirelessSerial('adb-abc123._adb-tls-connect._tcp') === true);

  log('[6] 收尾：恢复初始状态 + 停投屏');
  if (phoneAirplane(dev.serial) !== before) {
    setPhoneAirplane(dev.serial, before);
    await sleep(800);
  }
  ok('已恢复跑之前的飞行模式状态', phoneAirplane(dev.serial) === before, {
    before,
    now: phoneAirplane(dev.serial),
  });

  await mirror.stopMirror();
  await sleep(1200);
  ok('停投屏后功能栏已销毁', !barWin() || barWin().isDestroyed());
}
