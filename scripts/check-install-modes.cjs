/**
 * APK 安装三种模式 —— 后端直测
 *
 *   python scripts/run-electron.py scripts/check-install-modes.cjs \
 *       --watch ui-shots/_installmodes.log --until "INSTALL MODES CHECK DONE" --timeout 600
 *
 * 为什么单独测后端
 * ---------------------------------------------------------------
 * 「界面显示安装成功、手机上却没有应用」这类问题的根子都在主进程：
 *   1. 目标设备没定死 —— ensureDevice() 在 serial 为空时取在线列表第一台，
 *      三台设备同时在线时等于随机装，界面照样报成功；
 *   2. 装完不复核 —— adb 说 Success 就当成功，可多用户/系统分身/权限受限
 *      都会出现「Success 但设备上没这个包」。
 * 所以这里绕过 UI，直接调 services 的 installApk，用设备端 `pm path` 做交叉验证。
 *
 * 素材：真 APK 从设备上拉一个已装应用的 base.apk（-r 覆盖必然成功），
 * 默认 emulator-5556 / com.zidongdianji，可用 ADB_SERIAL / PULL_PKG 覆盖。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_installmodes.log');

const DND = path.join(os.tmpdir(), 'adb-assistant-dnd');
const REAL_APK = path.join(DND, 'real-app.apk');
const FAKE_APK = path.join(DND, 'fake-broken.apk');
const NOTES = path.join(DND, 'notes.txt');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

const SERIAL = process.env.ADB_SERIAL || 'emulator-5556';
const PULL_PKG = process.env.PULL_PKG || 'com.zidongdianji';

let rows = [];
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};

/** adb 的 INSTALL_FAILED_ALREADY_EXISTS 里含 FAIL，会污染调用方的判定，必须打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r')
    .replace(/failure/g, 'f*ilure');

const adb = (args, opts = {}) =>
  execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 180000, ...opts });

/** 设备上是否真有这个包 */
function onDevice(pkg) {
  try {
    return /^package:/m.test(adb(['shell', 'pm', 'path', pkg]));
  } catch {
    return false;
  }
}

function ensureFixtures() {
  fs.mkdirSync(DND, { recursive: true });
  fs.writeFileSync(FAKE_APK, Buffer.from('NOT-A-REAL-APK'.repeat(64)));
  fs.writeFileSync(NOTES, 'not an apk\n');
  if (fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0) return true;

  let remote = '';
  try {
    const out = adb(['shell', 'pm', 'path', PULL_PKG]);
    const line = out.split(/\r?\n/).find((l) => l.startsWith('package:'));
    if (line) remote = line.slice('package:'.length).trim();
  } catch (e) {
    log(`FATAL 取不到远端 APK 路径：${safe(e.message)}`);
    return false;
  }
  if (!remote) {
    log(`FATAL 设备 ${SERIAL} 上没有 ${PULL_PKG}（可用 PULL_PKG 指定别的包）`);
    return false;
  }
  try {
    adb(['pull', remote, REAL_APK]);
  } catch (e) {
    log(`FATAL 拉取真 APK 失败：${safe(e.message)}`);
    return false;
  }
  return fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0;
}

/** 捕获主进程日志，用来断言「装到哪台」有没有写进日志 */
const captured = [];
function hookLogs() {
  const { setLogSink } = require('../dist-electron/electron/services/adb.js');
  setLogSink((e) => captured.push(e));
}

const catchErr = async (fn) => {
  try {
    const v = await fn();
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
};

(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  if (!ensureFixtures()) {
    log('INSTALL MODES CHECK DONE');
    process.exit(1);
  }
  log(`素材: ${path.basename(REAL_APK)} ${fs.statSync(REAL_APK).size} bytes | 设备 ${SERIAL}`);

  const { installApk, isInstalling } = require('../dist-electron/electron/services/files.js');
  hookLogs();

  const PKG = PULL_PKG;

  /* ---------- 1. 覆盖安装（默认） ---------- */
  let r = await catchErr(() => installApk(SERIAL, REAL_APK, 'overwrite', false));
  log(`overwrite -> ${safe(JSON.stringify(r.value ?? r.error))}`);
  record(r.ok, '覆盖安装成功', r.ok ? 'ok' : safe(r.error));
  if (r.ok) {
    record(r.value.serial === SERIAL, '结果里的 serial 就是目标设备', String(r.value.serial));
    record(r.value.packageName === PKG, '结果里带回了包名', String(r.value.packageName));
    record(r.value.verified === true, '装后复核通过（verified=true）', String(r.value.verified));
    record(onDevice(PKG), '设备端 pm path 确实查得到该包', PKG);
  }

  /* ---------- 2. 全新安装遇到已装包：必须明确失败 ---------- */
  const fresh = await catchErr(() => installApk(SERIAL, REAL_APK, 'fresh', false));
  log(`fresh(已装) -> ${safe(String(fresh.error))}`);
  record(
    !fresh.ok && /已存在/.test(fresh.error || ''),
    '全新安装在已装包上明确报错（不会静默假成功）',
    safe(fresh.error),
  );
  record(onDevice(PKG), '全新安装被中止后旧版本没被动过', PKG);

  /* ---------- 3. 清洁安装：先卸载旧版本，数据一起清掉 ---------- */
  r = await catchErr(() => installApk(SERIAL, REAL_APK, 'clean', false));
  log(`clean -> ${safe(JSON.stringify(r.value ?? r.error))}`);
  record(r.ok, '清洁安装成功', r.ok ? 'ok' : safe(r.error));
  if (r.ok) {
    record(r.value.uninstalled === true, '清洁安装前确实卸载了旧版本', String(r.value.uninstalled));
    record(r.value.verified === true, '清洁安装后复核通过', String(r.value.verified));
    record(onDevice(PKG), '清洁安装后设备端仍有该包', PKG);
  }

  /* ---------- 4. 再清洁一次：设备上已无旧版本，应直接装且不报错 ---------- */
  const before = onDevice(PKG);
  if (before) adb(['uninstall', PKG]); // 制造「设备上没有」的前提
  r = await catchErr(() => installApk(SERIAL, REAL_APK, 'clean', false));
  log(`clean(无旧版本) -> ${safe(JSON.stringify(r.value ?? r.error))}`);
  record(r.ok, '设备上没有旧版本时清洁安装也能装成功', r.ok ? 'ok' : safe(r.error));
  if (r.ok) {
    record(
      r.value.uninstalled === false,
      '没有旧版本时不误报「已卸载」',
      String(r.value.uninstalled),
    );
  }

  /* ---------- 5. 目标设备必须定死 ---------- */
  const bogus = await catchErr(() => installApk('no-such-device-9527', REAL_APK, 'overwrite', false));
  record(!bogus.ok && /不在线/.test(bogus.error || ''), '指定不存在的设备会被拒绝', safe(bogus.error));

  /* ---------- 6. 输入校验 ---------- */
  const missing = await catchErr(() => installApk(SERIAL, path.join(DND, 'nope.apk'), 'overwrite'));
  record(!missing.ok && /不存在/.test(missing.error || ''), 'APK 不存在时明确报错', safe(missing.error));

  const notApk = await catchErr(() => installApk(SERIAL, NOTES, 'overwrite'));
  record(!notApk.ok && /不是 \.apk/.test(notApk.error || ''), '非 .apk 文件被拒绝', safe(notApk.error));

  const fake = await catchErr(() => installApk(SERIAL, FAKE_APK, 'overwrite'));
  record(!fake.ok, '假 APK 安装失败而不是假成功', safe(fake.error));

  /* ---------- 7. 互斥锁：并发第二个必须被拒 ---------- */
  const [a, b] = await Promise.allSettled([
    installApk(SERIAL, REAL_APK, 'overwrite', false),
    installApk(SERIAL, REAL_APK, 'overwrite', false),
  ]);
  const rejected = [a, b].filter((x) => x.status === 'rejected');
  const lockMsg = rejected[0] && rejected[0].reason && rejected[0].reason.message;
  record(
    rejected.length === 1 && /正在安装/.test(lockMsg || ''),
    '并发安装被互斥锁拦下一个',
    safe(lockMsg || '两个都通过了'),
  );
  record(!isInstalling(), '安装结束后锁已释放', String(isInstalling()));

  /* ---------- 8. 日志里必须写明装到哪台 ---------- */
  const installLogs = captured.filter((e) => e.source === '安装');
  const hasTarget = installLogs.some((e) => e.message.includes(SERIAL));
  record(hasTarget, '安装日志写明了目标设备序列号', `${installLogs.length} 条安装日志`);
  const hasMode = installLogs.some((e) => /覆盖安装|清洁安装|全新安装/.test(e.message));
  record(hasMode, '安装日志写明了安装方式', installLogs.map((e) => e.message).find((m) => /安装/.test(m)) || '');

  /* ---------- 汇总 ---------- */
  const pass = rows.filter((x) => x.startsWith('PASS')).length;
  const fail = rows.filter((x) => x.startsWith('FAIL')).length;

  log('===== 安装模式 CHECK =====');
  for (const line of rows) log(line);
  log('===== 安装日志摘录 =====');
  for (const e of installLogs.slice(0, 12)) log(`[${e.level}] ${safe(e.message)}`);
  log(`${pass} 通过 / ${fail} 失败`);
  log('INSTALL MODES CHECK DONE');

  process.exit(fail === 0 ? 0 : 1);
})();
