/**
 * 功能实测：在主进程中真实调用各项服务，验证 adb 功能链路
 * 用法：electron scripts/e2e.cjs
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', 'e2e-output.txt');
fs.writeFileSync(LOG, '=== E2E start ===\n');
const out = (l) => {
  try {
    fs.appendFileSync(LOG, l + '\n');
  } catch {}
};

app.whenReady().then(async () => {
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  const adbSvc = require('../dist-electron/electron/services/adb.js');
  const ops = require('../dist-electron/electron/services/device-ops.js');
  const files = require('../dist-electron/electron/services/files.js');
  const logger = require('../dist-electron/electron/services/logger.js');

  registerIpc();
  logger.setLogPushSink(() => {});

  const results = [];
  const check = (name, ok, extra) => {
    results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' :: ' + extra : ''}`);
    out(`${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' :: ' + extra : ''}`);
  };

  // 取第一台在线设备
  const devices = await adbSvc.listDevices(true);
  const dev = devices.find((d) => d.state === 'device');
  if (!dev) {
    out('无在线设备，跳过功能测试');
    app.exit(0);
    return;
  }
  const serial = dev.serial;
  out(`目标设备: ${serial} (${dev.brand} ${dev.model})`);

  const tmpDir = path.join(__dirname, '..', 'e2e-tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  /* 1. 分辨率读取 */
  try {
    const r = await ops.getResolution(serial);
    check('读取分辨率', !!r.physical, `${r.current} / ${r.densityOverride ?? r.density}dpi`);
  } catch (e) {
    check('读取分辨率', false, e.message);
  }

  /* 2. 截图 */
  try {
    const r = await ops.captureScreen(serial, tmpDir);
    const isPng = fs.readFileSync(r.localPath).subarray(0, 4).toString('hex') === '89504e47';
    check('截图并保存 PNG', isPng && r.size > 1000, `${(r.size / 1024).toFixed(1)}KB, ${r.duration}ms, PNG头=${isPng}`);
  } catch (e) {
    check('截图并保存 PNG', false, e.message);
  }

  /* 3. 通用命令 */
  try {
    const r = await adbSvc.runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], {
      silent: true,
    });
    check('执行 adb 命令', r.ok && r.stdout.trim().length > 0, `model=${r.stdout.trim()}`);
  } catch (e) {
    check('执行 adb 命令', false, e.message);
  }

  /* 4. 应用列表 */
  try {
    const apps = await files.listPackages(serial, false);
    check('读取应用列表', apps.length > 0, `${apps.length} 个第三方应用`);
  } catch (e) {
    check('读取应用列表', false, e.message);
  }

  /* 5. push / pull 往返 */
  try {
    const srcFile = path.join(tmpDir, 'e2e-roundtrip.txt');
    fs.writeFileSync(srcFile, 'ADB assistant e2e test ' + Date.now());
    const remoteName = 'e2e-rt.txt';
    // 用不带尾斜杠的目录 + 校验实际落地文件名
    await files.pushFiles(serial, [srcFile], '/sdcard/Download');
    const pullDir = path.join(tmpDir, 'pulled');
    if (!fs.existsSync(pullDir)) fs.mkdirSync(pullDir, { recursive: true });

    // 先确认设备端文件真实存在（部分 adb 版本会截断长文件名）
    const listing = await adbSvc.runAdb(
      ['-s', serial, 'shell', 'ls', '/sdcard/Download/'],
      { silent: true },
    );
    const landed = (listing.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.startsWith('e2e-roundtrip'));

    if (!landed) {
      check('push/pull 往返一致性', false, '推送后设备端未找到文件');
    } else {
      await files.pullFiles(serial, [`/sdcard/Download/${landed}`], pullDir);
      const back = path.join(pullDir, landed);
      const same =
        fs.existsSync(back) && fs.readFileSync(back, 'utf8') === fs.readFileSync(srcFile, 'utf8');
      check('push/pull 往返一致性', same, same ? `内容一致(${landed})` : '内容不一致');
      await adbSvc.runAdb(['-s', serial, 'shell', 'rm', '-f', `/sdcard/Download/${landed}`], {
        silent: true,
      });
    }
  } catch (e) {
    check('push/pull 往返一致性', false, e.message);
  }

  /* 6. 日志记录与导出 */
  try {
    logger.addLog('info', 'E2E', '测试日志条目');
    const exp = logger.exportLogs(path.join(tmpDir, 'e2e-log.txt'));
    const content = fs.readFileSync(exp.path, 'utf8');
    check('日志记录与导出', content.includes('E2E') && exp.bytes > 0, `${exp.bytes}B / ${exp.lines} 行`);
  } catch (e) {
    check('日志记录与导出', false, e.message);
  }

  /* 7. 分辨率设置与恢复 */
  try {
    const before = await ops.getResolution(serial);
    await ops.setSize(serial, '720x1280', 320);
    const mid = await ops.getResolution(serial);
    await ops.resetSize(serial);
    const after = await ops.getResolution(serial);
    const changed = mid.current === '720x1280';
    const restored = !after.override;
    check('分辨率修改与恢复', changed && restored, `${before.current} → ${mid.current} → ${after.current}`);
  } catch (e) {
    check('分辨率修改与恢复', false, e.message);
  }

  /* 8. 投屏启动 / 停止（通过真实服务层） */
  try {
    const mirror = require('../dist-electron/electron/services/mirror.js');
    const st = await mirror.startMirror({
      serial,
      maxSize: 1080,
      bitRateMbps: 4,
      maxFps: 30,
      noAudio: true,
      keyboard: 'sdk',
    });
    // 等待 scrcpy 建立连接
    await new Promise((r) => setTimeout(r, 6000));
    const running = mirror.getMirrorStatus();
    // 进程真实存活才算通过
    let alive = false;
    try {
      process.kill(running.pid, 0);
      alive = true;
    } catch {}
    check(
      '投屏启动',
      st.running && running.running && !!running.pid && alive,
      `pid=${running.pid}, alive=${alive}`,
    );
    await mirror.stopMirror();
    await new Promise((r) => setTimeout(r, 1500));
    const stopped = mirror.getMirrorStatus();
    check('投屏停止', !stopped.running, '已停止');
  } catch (e) {
    check('投屏启动/停止', false, e.message);
  }

  const failed = results.filter((r) => r.startsWith('[FAIL]')).length;
  out('');
  out(`总计 ${results.length} 项，失败 ${failed} 项`);
  app.exit(failed > 0 ? 1 : 0);
});
