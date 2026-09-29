/**
 * 真机验证：触摸节点探测链路
 *
 * 只验证「电脑侧能不能读到设备的触摸节点 + 量程标定」这一段 ——
 * 这是新方案的地基。真实触摸数据需要人在设备上摸（无法自动化）。
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', 'ui-shots', '_touchcap.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '=== touch capture device check ===\n');
const out = (l) => {
  fs.appendFileSync(LOG, l + '\n');
  console.log(l);
};
process.on('uncaughtException', (e) => out('UNCAUGHT: ' + e.stack));

app.whenReady().then(async () => {
  const adbSvc = require('../dist-electron/electron/services/adb.js');
  const tc = require('../dist-electron/electron/services/touch-capture.js');

  const results = [];
  const check = (n, ok, extra) => {
    results.push(`${ok ? '[PASS]' : '[FAIL]'} ${n}${extra ? ' :: ' + extra : ''}`);
    out(results[results.length - 1]);
  };

  const devices = await adbSvc.listDevices(true);
  const dev = devices.find((d) => d.state === 'device' && !/^emulator-/.test(d.serial));
  if (!dev) {
    out('没有在线真机，跳过');
    out('\nTOUCH CAP CHECK DONE');
    app.exit(0);
    return;
  }
  const serial = dev.serial;
  out(`设备：${serial} (${dev.model || ''})`);

  /* 1. 节点枚举 */
  try {
    const nodes = await tc.listTouchNodes(serial);
    check('A1 能列出触摸节点', nodes.length > 0, `${nodes.length} 个：${nodes.map((n) => n.name).join(', ')}`);
    const node = tc.pickNode(nodes);
    check('A2 能选出主触摸屏', !!node, node ? `${node.path} "${node.name}"` : 'none');
    if (node) {
      check(
        'A3 量程已读到（非 0）',
        node.maxX > 0 && node.maxY > 0,
        `X ${node.minX}~${node.maxX} / Y ${node.minY}~${node.maxY}`,
      );
      check('A4 节点路径形如 /dev/input/eventN', /^\/dev\/input\/event\d+$/.test(node.path), node.path);
    }
  } catch (e) {
    check('A1 能列出触摸节点', false, e.message);
  }

  /* 2. prepare 接口 */
  try {
    const prep = await tc.prepare(serial);
    check('B1 prepare 返回可用', prep.ok, prep.note);
  } catch (e) {
    check('B1 prepare 返回可用', false, e.message);
  }

  /* 3. 起采集 → 等 2 秒 → 停（没人碰屏幕时应为 0 条，但不能报错） */
  try {
    const st = await tc.startCapture(serial, { screenWidth: 720, screenHeight: 1612 });
    check('C1 startCapture 返回 running', st.running === true, `note=${st.note}`);
    await new Promise((r) => setTimeout(r, 2000));
    const got = await tc.stopCapture();
    check('C2 stopCapture 干净返回（没人摸屏时 0 条属正常）', Array.isArray(got), `${got.length} 条`);
    const st2 = tc.captureState();
    check('C3 停止后状态为未运行', st2.running === false, `running=${st2.running}`);
  } catch (e) {
    check('C1 startCapture 返回 running', false, e.message);
  }

  /* 4. 备份屏应无残留 getevent 进程 */
  try {
    const r = await adbSvc.runAdb(['-s', serial, 'shell', 'pgrep', '-f', 'getevent'], {
      source: '触摸采集', silent: true, timeout: 8000,
    });
    const leftover = (r.stdout || '').trim();
    check('D1 停止后设备上没有残留 getevent 进程', leftover === '', leftover || '(无)');
  } catch (e) {
    check('D1 停止后设备上没有残留 getevent 进程', false, e.message);
  }

  const failed = results.filter((r) => r.startsWith('[FAIL]')).length;
  out('');
  out(`总计 ${results.length} 项，失败 ${failed} 项`);
  out('TOUCH CAP CHECK DONE');
  app.exit(failed > 0 ? 1 : 0);
});
