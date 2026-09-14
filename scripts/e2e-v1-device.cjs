/**
 * v1.0 真机功能验证：直接调用主进程 service，对已连接设备做只读测试。
 * 只做「读」操作，不做卸载/清数据等破坏性动作。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_device.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 0))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;

app.whenReady().then(async () => {
  const adb = require('../dist-electron/electron/services/adb.js');
  const files = require('../dist-electron/electron/services/files.js');
  const weaknet = require('../dist-electron/electron/services/weaknet.js');
  const logcat = require('../dist-electron/electron/services/logcat.js');

  const rows = [];
  const ok = (n, d) => rows.push(`PASS  ${n}  ::  ${d}`);
  const bad = (n, e) => rows.push(`FAIL  ${n}  ::  ${e}`);

  /* ---- 1. 设备列表 ---- */
  let serial = null;
  try {
    const ds = await adb.listDevices(true);
    const online = ds.filter((d) => d.state === 'device');
    serial = online[0]?.serial;
    ok('设备列表', `${ds.length} 台，在线 ${online.length} 台，选用 ${serial || '无'}`);
  } catch (e) {
    bad('设备列表', e.message);
  }

  if (!serial) {
    log('=== 无在线设备，跳过后续设备相关测试 ===');
    for (const r of rows) log(r);
    app.exit(0);
    return;
  }

  /* ---- 2. 应用列表（详细） ---- */
  try {
    const apps = await files.listAppsDetailed(serial, true);
    const user = apps.filter((a) => !a.system);
    ok('应用列表', `共 ${apps.length}，用户 ${user.length}，样例 ${apps[0]?.packageName}`);
  } catch (e) {
    bad('应用列表', e.message);
  }

  /* ---- 3. 应用详情 ---- */
  try {
    const apps = await files.listAppsDetailed(serial, false);
    const pkg = apps.find((a) => /^com\.colou?ros|^com\.android\.settings/.test(a.packageName))
      ?.packageName || apps[0]?.packageName;
    if (!pkg) throw new Error('无第三方应用可测');
    const d = await files.getAppDetail(serial, pkg);
    ok('应用详情', `${pkg} versionName=${d.versionName} targetSdk=${d.targetSdk} perms=${d.permissions?.length || 0}`);
  } catch (e) {
    bad('应用详情', e.message);
  }

  /* ---- 4. 弱网能力探测（只读） ---- */
  try {
    const p = await weaknet.probeDevice(serial);
    ok('弱网探测', `rooted=${p.rooted} hasTc=${p.hasTc} hasIfb=${p.hasIfb} iface=${p.iface} ifaces=[${p.ifaces.join(',')}]`);
  } catch (e) {
    bad('弱网探测', e.message);
  }

  /* ---- 5. 弱网预设读写 ---- */
  try {
    const before = weaknet.listPresets();
    const after = weaknet.savePreset('__e2e_tmp__', {
      up: { bandwidthMbps: 2, delayMs: 100, jitterMs: 20, lossPercent: 1 },
      down: { bandwidthMbps: 3, delayMs: 120, jitterMs: 25, lossPercent: 2 },
      durationSec: 45,
    });
    const saved = after.find((p) => p.name === '__e2e_tmp__');
    if (!saved) throw new Error('保存后未找到预设');
    const cleaned = weaknet.deletePreset(saved.id);
    const gone = !cleaned.some((p) => p.name === '__e2e_tmp__');
    ok('弱网预设读写', `原有 ${before.length} 个，保存成功(id=${saved.id.slice(0, 8)}…)，删除后 ${gone ? '已清理' : '仍残留!'}`);
  } catch (e) {
    bad('弱网预设读写', e.message);
  }

  /* ---- 6. 进程列表（logcat 过滤用） ---- */
  try {
    const procs = await logcat.listProcesses(serial);
    ok('进程列表', `${procs.length} 个进程，样例 ${procs.slice(0, 3).map((p) => p.name).join(',')}`);
  } catch (e) {
    bad('进程列表', e.message);
  }

  /* ---- 7. logcat 抓取（3 秒后停止） ---- */
  try {
    const lines = [];
    logcat.setLogcatLinesSink((b) => lines.push(...b));
    logcat.setLogcatStatusSink(() => {});
    const st = await logcat.startLogcat(serial, { minLevel: 'V', buffers: ['main', 'system', 'crash'] });
    await new Promise((r) => setTimeout(r, 3000));
    const after = logcat.getLogcatStatus();
    await logcat.stopLogcat();
    const parsed = lines.filter((l) => l.level).length;
    ok('Logcat 抓取', `3s 收到 ${lines.length} 行（可解析 ${parsed} 行），启动状态 running=${st.running}`);
  } catch (e) {
    bad('Logcat 抓取', e.message);
  }

  /* ---- 8. Logcat 过滤（只看 E） ---- */
  try {
    const lines = [];
    logcat.setLogcatLinesSink((b) => lines.push(...b));
    await logcat.startLogcat(serial, { minLevel: 'E', buffers: ['main', 'system', 'crash'] });
    await new Promise((r) => setTimeout(r, 2500));
    await logcat.stopLogcat();
    const bad = lines.filter((l) => l.level && !['E', 'F'].includes(l.level));
    ok('Logcat 级别过滤', `${lines.length} 行，非 E/F 级别 ${bad.length} 行 ${bad.length === 0 ? '(过滤正确)' : '(过滤异常!)'}`);
  } catch (e) {
    bad('Logcat 级别过滤', e.message);
  }

  log('=== v1.0 DEVICE E2E (device=' + serial + ') ===');
  for (const r of rows) log(r);
  log(`\n${rows.filter((r) => r.startsWith('PASS')).length}/${rows.length} 通过`);

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
