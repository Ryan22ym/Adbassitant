/**
 * 弱网启动链路验收（回归：启动即被自己误杀）
 * ============================================================
 *
 * 为什么要有这个脚本
 * ------------------------------------------------------------
 * 之前所有弱网验收都是「脚本自己 adb forward + POST /start」，
 * **绕开了客户端的 startVpn()**，于是漏掉了这条真实链路里的竞态：
 *
 *   /start 下发后设备侧 establish() 是异步的（实测数百 ms ~ 数秒），
 *   而客户端紧接着 `await tickVpn()` 查 /status，拿到 vpnActive=false
 *   → 误判「设备侧已停止」→ 反手发 /stop + 撤 forward
 *   → 刚建好的隧道被关掉，UI 转成「控制通道失联」。
 *
 *   用户看到的就是「点了启动，手机上 VPN 一闪即逝，弱网完全没效果」。
 *
 * 所以这个脚本**必须走真实 IPC**（preload → ipc → services/weaknet.ts），
 * 并断言「启动之后一段时间内通道一直在线、设备侧一直说自己在跑」。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/check-weaknet-start.cjs \
 *     --watch ui-shots/_weaknet-start.log --until "WEAKNET START CHECK DONE" --timeout 300
 *
 * 环境变量 WN_SERIAL 可指定设备；不指定则自动挑一台非模拟器设备。
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  console.error('FATAL 未在 Electron 运行时中执行');
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_weaknet-start.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function log(s) {
  try {
    fs.appendFileSync(LOG, s + '\n');
  } catch {}
}
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    log('PASS  ' + label + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    log('FAIL  ' + label + (extra ? '  (' + extra + ')' : ''));
  }
}
function unwrap(r) {
  if (r && typeof r === 'object' && 'ok' in r && 'data' in r) return r.data;
  return r;
}

/** 采样次数与间隔：要足够覆盖「设备侧建隧道」的窗口（实测可达数秒） */
const SAMPLES = 8;
const SAMPLE_MS = 1000;

app.whenReady().then(async () => {
  try { fs.writeFileSync(LOG, ''); } catch {}
  log('=== 弱网启动链路验收 ' + new Date().toISOString() + ' ===');
  log('electron ' + process.versions.electron);

  const { registerIpc } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
  registerIpc();
  const logger = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'logger.js'));

  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const renderErrs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) renderErrs.push(String(msg).slice(0, 160));
  });
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2200);

  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);

  ok((await win.webContents.executeJavaScript('typeof window.adbApi')) === 'object',
    '渲染层拿到 adbApi（preload 链路正常）');
  ok(renderErrs.length === 0, '渲染层无 error 级日志', renderErrs.join(' | ') || '干净');

  /* ---------- 0) 挑设备 ---------- */
  const devs = unwrap(await js('return await window.adbApi.listDevices();')) || [];
  const list = Array.isArray(devs) ? devs : [];
  log('在线设备: ' + list.map((d) => d.serial).join(', '));
  const wanted = process.env.WN_SERIAL;
  const picked =
    (wanted && list.find((d) => d.serial === wanted)) ||
    list.find((d) => !/^emulator-/.test(d.serial || '')) ||
    list[0];
  if (!picked) {
    ok(false, '至少一台设备在线', '没找到可用设备');
    log('\nWEAKNET START CHECK DONE');
    app.exit(1);
    return;
  }
  const S = picked.serial;
  log('使用设备: ' + S);

  /* ---------- 1) 清理上一轮残留 ---------- */
  try { await js(`return await window.adbApi.weaknetStop();`); } catch {}
  await sleep(1500);

  /* ---------- 2) 启动前的探测 ---------- */
  const probe = unwrap(await js(`return await window.adbApi.weaknetProbe(${JSON.stringify(S)});`));
  ok(!!probe, 'weaknetProbe 返回结果');
  ok(probe && probe.hasVpnApp === true, '设备已装弱网配套 App',
    probe ? 'hasVpnApp=' + probe.hasVpnApp : '');
  ok(probe && probe.rooted === false, '设备未 Root（走 VPN 免 Root 路线）',
    probe ? 'rooted=' + probe.rooted : '');

  /* ---------- 3) 启动（= 用户点「启动弱网模拟」）---------- */
  const params = {
    up: { bandwidthMbps: 0, delayMs: 0, jitterMs: 0, lossPercent: 0, corruptPercent: 0, reorderPercent: 0, duplicatePercent: 0 },
    down: { bandwidthMbps: 1, delayMs: 300, jitterMs: 80, lossPercent: 1, corruptPercent: 0, reorderPercent: 0, duplicatePercent: 0 },
    durationSec: 90,
    blockNetwork: false,
    engine: 'auto',
  };
  const t0 = Date.now();
  const started = await js(
    `try { return { ok:true, r: await window.adbApi.weaknetStart(${JSON.stringify(S)}, ${JSON.stringify(params)}) }; }
     catch (e) { return { ok:false, err: String(e && e.message || e) }; }`,
  );
  const startMs = Date.now() - t0;
  const st0 = unwrap(started.r) || {};
  log('启动返回(' + startMs + 'ms): ' + JSON.stringify({ mode: st0.mode, note: st0.note, vpn: st0.vpn }));
  ok(started.ok === true, 'weaknetStart 未抛异常', started.err || '');
  ok(st0.mode === 'vpn', '选择了 VPN 引擎', 'mode=' + st0.mode);
  ok(!!st0.vpn && st0.vpn.reachable === true, '启动返回时通道可达（vpn.reachable=true）',
    'reachable=' + (st0.vpn && st0.vpn.reachable));
  ok(startMs < 15000, '启动在 15s 内完成', startMs + 'ms（含等待隧道就绪）');

  /* ---------- 4) 关键回归：之后一段时间不许掉线 / 不许被误关 ---------- */
  log('\n-- 连续 ' + SAMPLES + ' 次采样（每秒一次）--');
  let allReachable = true;
  let allVpn = true;
  let anyStopLog = false;
  let sawActive = false;
  const notes = [];
  for (let i = 1; i <= SAMPLES; i++) {
    await sleep(SAMPLE_MS);
    const s = unwrap(await js(`return await window.adbApi.weaknetStatus();`)) || {};
    const reachable = !!(s.vpn && s.vpn.reachable);
    const isVpn = s.mode === 'vpn';
    const note = String(s.note || '');
    notes.push(note);
    if (!reachable) allReachable = false;
    if (!isVpn) allVpn = false;
    if (/失联|已停止/.test(note)) sawActive = true;
    log(`  t+${i}s mode=${s.mode} reachable=${reachable} note=${JSON.stringify(note)}`);
  }

  const logs = logger.getLogs() || [];
  const wnLogs = logs.filter((e) => /弱网/.test(e.source || ''));
  anyStopLog = wnLogs.some((e) => /设备侧已停止 VPN/.test(e.message || ''));
  const stoppedLog = wnLogs.some((e) => /已关闭 VPN/.test(e.message || ''));

  ok(allReachable, '★ 启动后每一秒控制通道都在线（不再「失联」）');
  ok(allVpn, '★ 启动后每一秒都是 VPN 模式（没被自己关掉）');
  ok(!anyStopLog, '★ 日志里没有「设备侧已停止 VPN」误判', anyStopLog ? '出现误判日志' : '无');
  ok(!stoppedLog, '★ 日志里没有启动阶段的「已关闭 VPN」', stoppedLog ? '出现关闭日志' : '无');
  ok(!sawActive, '★ 状态文案里没有「失联 / 已停止」', sawActive ? notes.join(' / ') : '无');

  /* ---------- 5) 运行时授权态不许误报 ---------- */
  const probe2 = unwrap(await js(`return await window.adbApi.weaknetProbe(${JSON.stringify(S)});`));
  ok(probe2 && probe2.vpnAuthorized !== false,
    '★ 运行中不误报「尚未授权 VPN」', probe2 ? 'vpnAuthorized=' + probe2.vpnAuthorized : '');
  ok(probe2 && probe2.note && !/尚未授权/.test(probe2.note),
    '★ 探测文案不含「尚未授权」', probe2 ? probe2.note.slice(0, 60) : '');

  /* ---------- 6) 设备侧确有 VPN 隧道 ---------- */
  // 用 probe 的 ifaces（它读的是设备实际的网卡列表）：VPN 生效时这里会多出 tun0
  const ifaces = (probe2 && probe2.ifaces) || [];
  const hasTun = Array.isArray(ifaces) && ifaces.some((n) => /^tun\d+/.test(String(n)));
  log('设备网卡: ' + JSON.stringify(ifaces));
  ok(hasTun, '★ 设备侧存在 tun 接口（VPN 真的建起来了）', JSON.stringify(ifaces));

  /* ---------- 7) 收尾：停止并确认恢复 ---------- */
  const stopped = unwrap(await js(`return await window.adbApi.weaknetStop();`)) || {};
  await sleep(2000);
  const after = unwrap(await js(`return await window.adbApi.weaknetStatus();`)) || {};
  ok(after.mode !== 'vpn', '停止后不再是 VPN 模式', 'mode=' + after.mode);

  log('\n===== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
  log('WEAKNET START CHECK DONE');
  app.exit(fail ? 1 : 0);
});
