/**
 * 录屏 + 截图存储 + 日志导出 补充验证
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', 'e2e-record-output.txt');
fs.writeFileSync(LOG, '=== record e2e ===\n');
const out = (l) => fs.appendFileSync(LOG, l + '\n');
process.on('uncaughtException', (e) => out('UNCAUGHT: ' + e.stack));

app.whenReady().then(async () => {
  const adbSvc = require('../dist-electron/electron/services/adb.js');
  const ops = require('../dist-electron/electron/services/device-ops.js');
  const mirror = require('../dist-electron/electron/services/mirror.js');
  const settings = require('../dist-electron/electron/services/settings.js');

  const devices = await adbSvc.listDevices(true);
  const dev = devices.find((d) => d.state === 'device');
  if (!dev) {
    out('无设备');
    app.exit(0);
    return;
  }
  const serial = dev.serial;
  const results = [];
  const check = (n, ok, extra) => {
    results.push(`${ok ? '[PASS]' : '[FAIL]'} ${n}${extra ? ' :: ' + extra : ''}`);
    out(results[results.length - 1]);
  };

  const tmp = path.join(__dirname, '..', 'e2e-tmp');
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });

  /* 1. 投屏录屏（--no-playback 路径） */
  try {
    const recPath = path.join(tmp, 'mirror-rec.mp4');
    if (fs.existsSync(recPath)) fs.unlinkSync(recPath);
    await mirror.recordMirror(serial, recPath, 4, 4);
    const size = fs.existsSync(recPath) ? fs.statSync(recPath).size : 0;
    check('投屏录制 MP4', size > 10000, `${(size / 1024).toFixed(1)}KB`);
  } catch (e) {
    check('投屏录制 MP4', false, e.message);
  }

  /* 2. 设备录屏（自动选择 screenrecord / scrcpy 通道） + 本地落地 */
  try {
    const h = await ops.startRecord(serial, tmp, 4, 4);
    check('启动设备录屏', !!h.id, `id=${h.id.slice(0, 8)}`);
    await new Promise((r) => setTimeout(r, 12000));
    await h.stop();
    const size = fs.existsSync(h.localPath) ? fs.statSync(h.localPath).size : 0;
    check('设备录屏完成并本地落地', size > 10000, `${(size / 1024).toFixed(1)}KB -> ${path.basename(h.localPath)}`);
  } catch (e) {
    check('设备录屏', false, e.message);
  }

  /* 3. 截图默认目录 */
  try {
    const dir = settings.resolveDir('screenshot');
    const r = await ops.captureScreen(serial, dir);
    const ok = fs.existsSync(r.localPath) && fs.statSync(r.localPath).size > 1000;
    check('截图落地默认目录', ok, r.localPath);
  } catch (e) {
    check('截图默认目录', false, e.message);
  }

  /* 4. 设置读写持久化 */
  try {
    const before = settings.getSettings();
    settings.saveSettings({ ...before, theme: 'dark' });
    const after = settings.getSettings();
    settings.saveSettings(before);
    check('设置持久化', after.theme === 'dark', `theme=${after.theme}`);
  } catch (e) {
    check('设置持久化', false, e.message);
  }

  const failed = results.filter((r) => r.startsWith('[FAIL]')).length;
  out('');
  out(`总计 ${results.length} 项，失败 ${failed} 项`);
  app.exit(failed > 0 ? 1 : 0);
});
