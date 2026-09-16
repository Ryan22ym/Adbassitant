/**
 * APK 包名解析自测（纯 Node，不用 Electron）
 *
 *   node scripts/check-apk-parse.cjs
 *
 * 为什么要单独测：`electron/services/apk.ts` 是自己手写的 ZIP + 二进制
 * AndroidManifest.xml(AXML) 解析器，没有第三方依赖可依赖。它有两个已知的坑：
 *   1. 字符串池的字节序不固定（aapt1 出 UTF-16BE、aapt2 有出 LE），只能靠
 *      「ASCII 可读字符」投票判别，判错了整池会变成汉字区乱码；
 *   2. 属性数组的起点是 attrExt + attributeStart，少加/多加 8 字节就会读到
 *      attributeCount 上去，属性名直接错位。
 * 所以包名、版本号都必须和**设备端的 dumpsys 值**对上才算通过。
 *
 * 素材：真 APK 从设备上 `pm path` + `adb pull` 拉一个已装应用的 base.apk
 * （默认 emulator-5556 / com.zidongdianji，可用 ADB_SERIAL / PULL_PKG 覆盖）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_apkparse.log');

const DND = path.join(os.tmpdir(), 'adb-assistant-dnd');
const REAL_APK = path.join(DND, 'real-app.apk');
const FAKE_APK = path.join(DND, 'fake-broken.apk');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

const SERIAL = process.env.ADB_SERIAL || 'emulator-5556';
const PULL_PKG = process.env.PULL_PKG || 'com.zidongdianji';

const { readApkInfo } = require('../dist-electron/electron/services/apk.js');

let rows = [];
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};

/** 外部输出里带 FAIL/ERROR 会污染调用方的判定，统一打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r');

function ensureFixtures() {
  fs.mkdirSync(DND, { recursive: true });
  fs.writeFileSync(FAKE_APK, Buffer.from('NOT-A-REAL-APK'.repeat(64)));
  if (fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0) return true;

  const adb = (args) => execFileSync(ADB, args, { encoding: 'utf8', timeout: 180000 });
  let remote = '';
  try {
    const out = adb(['-s', SERIAL, 'shell', 'pm', 'path', PULL_PKG]);
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
    adb(['-s', SERIAL, 'pull', remote, REAL_APK]);
  } catch (e) {
    log(`FATAL 拉取真 APK 失败：${safe(e.message)}`);
    return false;
  }
  return fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0;
}

/** 从设备上读回同一个包的版本号，用来交叉验证解析结果 */
function deviceVersion(pkg) {
  try {
    const out = execFileSync(ADB, ['-s', SERIAL, 'shell', 'dumpsys', 'package', pkg], {
      encoding: 'utf8',
      timeout: 40000,
    });
    const pick = (re) => out.match(re)?.[1]?.trim();
    return {
      versionCode: Number(pick(/versionCode=(\d+)/) || 0) || undefined,
      versionName: pick(/versionName=(\S+)/),
    };
  } catch {
    return {};
  }
}

(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  if (!ensureFixtures()) {
    log('APK PARSE CHECK DONE');
    process.exit(1);
  }

  /* ---------- 1. 真 APK：包名 ---------- */
  const real = readApkInfo(REAL_APK);
  log(`真 APK 解析: ${JSON.stringify(real)}`);

  record(!!real.packageName, '真 APK 能读出包名', String(real.packageName));
  record(
    /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(real.packageName || ''),
    '包名是合法格式',
    String(real.packageName),
  );
  record(
    real.packageName === PULL_PKG,
    '包名与设备上拉取时用的包一致',
    `${real.packageName} vs ${PULL_PKG}`,
  );

  /* ---------- 2. 版本号与设备端交叉验证 ---------- */
  const dev = deviceVersion(PULL_PKG);
  log(`设备端版本: ${JSON.stringify(dev)}`);
  record(
    !!real.versionCode && real.versionCode === dev.versionCode,
    'versionCode 与设备端一致',
    `${real.versionCode} vs ${dev.versionCode}`,
  );
  record(
    !!real.versionName && real.versionName === dev.versionName,
    'versionName 与设备端一致',
    `${real.versionName} vs ${dev.versionName}`,
  );

  /* ---------- 3. 假 APK / 异常输入必须只报错、不抛异常 ---------- */
  let threw = null;
  let fake = null;
  try {
    fake = readApkInfo(FAKE_APK);
  } catch (e) {
    threw = e.message;
  }
  record(threw === null, '假 APK 不抛异常', threw ? safe(threw) : 'ok');
  record(!!fake && !fake.packageName && !!fake.error, '假 APK 返回 error 而不是包名', safe(fake?.error));

  const missing = readApkInfo(path.join(DND, 'definitely-not-here.apk'));
  record(!missing.packageName && !!missing.error, '文件不存在时返回 error', safe(missing.error));

  const dir = readApkInfo(DND);
  record(!dir.packageName && !!dir.error, '传目录时返回 error 而不是崩溃', safe(dir.error));

  /* ---------- 汇总 ---------- */
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;

  log('===== APK 解析 CHECK =====');
  for (const r of rows) log(r);
  log(`${pass} 通过 / ${fail} 失败`);
  log('APK PARSE CHECK DONE');

  process.exit(fail === 0 ? 0 : 1);
})();
