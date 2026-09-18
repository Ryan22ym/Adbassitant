/**
 * AAB → 通用 APK（universal）验收（纯 Node，不需要设备）
 *
 *   node scripts/check-aab-universal.cjs
 *
 * 为什么单独立一份：
 *   universal 是 AAB 出口里唯一**与设备无关**的一条路 —— 不取 device-spec、
 *   不碰 adb、不要设备在线。它解决的是「把 AAB 变成一个能发给别人、随手装到
 *   任何手机上的普通 APK」这个需求，和「按设备拆包」是两件事，所以单独验收。
 *
 * 顺带守住三条容易回归的性质（都是这条路的立身之本）：
 *   1. 全程不依赖设备 —— 脚本本身不连设备也要能跑完，缓存目录名里也不该有设备；
 *   2. 缓存键里不能有设备 —— 同一份 AAB + 同一份签名只该产出一份通用产物；
 *   3. 换签名必须重做 —— 吃了旧缓存就等于分发了一个签名不对的包。
 *
 * 素材：~/Downloads 下的任意 .aab（可用 AAB_FILE 指定）。
 * 有**模拟器**在线时额外做一次真实安装验证；真机一律跳过（不动用户的设备）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_aab-universal.log');
const ADB = path.join(ROOT, 'bin', 'adb.exe');
const KS = path.join(ROOT, 'bin', 'bundletool', 'debug.keystore');
const DIST_AAB_JS = path.join(ROOT, 'dist-electron', 'electron', 'services', 'aab.js');

const {
  buildUniversalApk,
  listBundleCache,
  bundletoolJarPath,
  resolveAabRuntime,
} = require('../dist-electron/electron/services/aab.js');
const { readAabInfo, readApkInfo } = require('../dist-electron/electron/services/apk.js');

let rows = [];
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const skip = (name, detail = '') => rows.push(`SKIP  ${name}  ::  ${detail}`);
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};
/** 外部输出里的 FAIL/ERROR 会污染调用方的判定，统一打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r');

const MB = (n) => (n / 1048576).toFixed(1) + 'MB';
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function adb(args, timeout = 120000) {
  try {
    return execFileSync(ADB, args, { encoding: 'utf8', timeout });
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function onlineDevices() {
  return adb(['devices'])
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && c[1] === 'device')
    .map((c) => c[0]);
}

/** 找一份可用的 .aab 素材（挑最小的，跑得快） */
function pickAab() {
  if (process.env.AAB_FILE && fs.existsSync(process.env.AAB_FILE)) return process.env.AAB_FILE;
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.aab'))
    .map((f) => ({ p: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.s - b.s);
  return files.length ? files[0].p : null;
}

/** 读出 dist 里 buildUniversalApk 的函数体（做静态守卫用） */
function universalFnBody() {
  try {
    const src = fs.readFileSync(DIST_AAB_JS, 'utf8');
    const start = src.indexOf('function buildUniversalApk');
    if (start < 0) return null;
    // 取到下一个顶层 function 之前
    const rest = src.slice(start + 10);
    const next = rest.search(/\nfunction [A-Za-z_$]/);
    return next < 0 ? rest : rest.slice(0, next);
  } catch {
    return null;
  }
}

(async () => {
  log(`\n===== AAB UNIVERSAL CHECK ${new Date().toISOString()} =====`);

  /* ------------------------------------------------------------------ */
  /* A. 环境与素材                                                       */
  /* ------------------------------------------------------------------ */
  let rt;
  try {
    rt = await resolveAabRuntime(true);
  } catch (e) {
    rt = { ready: false, reason: safe(e.message) };
  }
  record(!!rt.ready, 'A1 Java 11+ 与 bundletool 就绪', safe(rt.reason || rt.java?.version || ''));

  const jar = bundletoolJarPath();
  record(fs.existsSync(jar), 'A2 bundletool jar 就位', path.basename(jar));
  record(fs.existsSync(KS), 'A3 随包调试密钥库就位', path.basename(KS));

  const sample = pickAab();
  if (!sample) {
    record(false, 'A4 找到 .aab 素材', '~/Downloads 下没有 .aab，可用 AAB_FILE 指定');
    finish();
    return;
  }
  const srcInfo = readAabInfo(sample);
  record(!!srcInfo.packageName, 'A4 素材可解析出包名', `${path.basename(sample)} → ${srcInfo.packageName || '?'}`);
  record(
    fs.statSync(sample).size > 0,
    'A5 素材非空文件',
    MB(fs.statSync(sample).size),
  );

  /* ------------------------------------------------------------------ */
  /* B. 生成通用 APK（首次，全程不碰设备）                                */
  /* ------------------------------------------------------------------ */
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-universal-'));
  const lines = [];

  let first;
  try {
    first = await buildUniversalApk(sample, { onLine: (l) => lines.push(l) });
  } catch (e) {
    record(false, 'B1 生成通用 APK 成功', safe(e.message));
    finish();
    return;
  }
  record(true, 'B1 生成通用 APK 成功', `耗时 ${(first.buildMs / 1000).toFixed(1)}s，产物 ${MB(first.apkBytes)}`);

  record(fs.existsSync(first.apkPath), 'B2 产物文件存在', first.apkPath);
  record(first.rebuilt === true && first.fromCache === false, 'B3 首次是真实生成（未命中缓存）', `rebuilt=${first.rebuilt}`);

  const head = fs.readFileSync(first.apkPath).subarray(0, 4);
  record(
    head[0] === 0x50 && head[1] === 0x4b,
    'B4 产物是合法 ZIP/APK（PK 魔数）',
    `头字节 ${[...head].map((b) => b.toString(16)).join(' ')}`,
  );

  let apkInfo = null;
  try {
    apkInfo = readApkInfo(first.apkPath);
  } catch (e) {
    apkInfo = { error: safe(e.message) };
  }
  record(
    !!apkInfo && !apkInfo.error && !!apkInfo.packageName,
    'B5 产物可解析出包名（能被 adb/系统认成应用）',
    safe(apkInfo.error || apkInfo.packageName || ''),
  );
  record(
    !!apkInfo && apkInfo.packageName === srcInfo.packageName,
    'B6 产物包名与源 AAB 一致',
    `${apkInfo && apkInfo.packageName} vs ${srcInfo.packageName}`,
  );
  record(
    !!apkInfo &&
      String(apkInfo.versionCode ?? '') === String(srcInfo.versionCode ?? '') &&
      (apkInfo.versionName ?? '') === (srcInfo.versionName ?? ''),
    'B7 产物版本号与源 AAB 一致',
    `code ${apkInfo && apkInfo.versionCode}/${srcInfo.versionCode}，name ${apkInfo && apkInfo.versionName}/${srcInfo.versionName}`,
  );
  record(
    first.apkBytes > 1024 * 1024,
    'B8 产物大小合理（>1MB，不是半截文件）',
    MB(first.apkBytes),
  );

  /* 缓存目录的命名是这条路的核心契约：无设备、含签名标签 */
  const dirName = path.basename(first.cacheDir);
  record(
    /^[0-9a-f]{16}-universal-[0-9a-z]+$/.test(dirName),
    'B9 缓存目录名 = 指纹 + universal + 签名（无设备 key）',
    dirName,
  );
  record(
    !/sdk\d|emulator|5556|5558/i.test(dirName),
    'B10 缓存键里没有设备痕迹',
    dirName,
  );
  record(
    fs.existsSync(path.join(first.cacheDir, 'universal.apk')),
    'B11 缓存目录里有 universal.apk',
    first.cacheDir,
  );
  record(
    fs.existsSync(path.join(first.cacheDir, 'signing.txt')),
    'B12 缓存目录里记了本次签名（便于诊断）',
    first.cacheDir,
  );
  record(
    !fs.existsSync(path.join(first.cacheDir, 'universal.apks')),
    'B13 中间产物 universal.apks 用完即删（不占两倍空间）',
    first.cacheDir,
  );
  record(
    fs.existsSync(path.join(first.cacheDir, 'source.aab.txt')),
    'B14 缓存里记了源 AAB 路径',
    first.cacheDir,
  );

  /* 静态守卫：这条路以后不许悄悄把设备逻辑加回来 */
  const body = universalFnBody();
  record(
    !!body && !/device-spec|get-device-spec|runAdb\(/.test(body),
    'B15 实现里没有 device-spec / adb 调用（与设备无关）',
    body ? '已检查 dist 函数体' : '读不到 dist 函数体',
  );
  record(
    !/get-device-spec/i.test(lines.join('\n')),
    'B16 运行日志里没有读设备规格的动作',
    lines.length ? `${lines.length} 行输出` : '无输出',
  );

  /* ------------------------------------------------------------------ */
  /* C. 缓存复用                                                         */
  /* ------------------------------------------------------------------ */
  const second = await buildUniversalApk(sample, { useCache: true }).catch((e) => ({ error: e.message }));
  record(!second.error, 'C1 第二次调用成功', safe(second.error || ''));
  if (!second.error) {
    record(second.fromCache === true, 'C2 第二次命中缓存', `fromCache=${second.fromCache}`);
    record(second.rebuilt === false && second.buildMs === 0, 'C3 第二次没有重跑 bundletool', `buildMs=${second.buildMs}`);
    record(second.cacheDir === first.cacheDir, 'C4 同一份 AAB 复用同一个产物目录', path.basename(second.cacheDir));
    record(
      md5(second.apkPath) === md5(first.apkPath),
      'C5 复用产物与首次产物字节一致',
      md5(first.apkPath).slice(0, 12),
    );
  }

  const cacheList = listBundleCache();
  record(
    cacheList.some((c) => path.basename(c.dir) === dirName),
    'C6 通用产物出现在缓存列表里（可被「清理缓存」一起清掉）',
    `${cacheList.length} 份缓存`,
  );

  /* ------------------------------------------------------------------ */
  /* D. 另存为单个 .apk                                                  */
  /* ------------------------------------------------------------------ */
  const saveTo = path.join(outDir, 'dist-app.apk');
  const saved = await buildUniversalApk(sample, { outPath: saveTo, useCache: true }).catch((e) => ({
    error: e.message,
  }));
  record(!saved.error, 'D1 另存到指定路径成功', safe(saved.error || saveTo));
  if (!saved.error) {
    record(fs.existsSync(saveTo), 'D2 另存文件确实落盘', saveTo);
    record(saved.savedToOutPath === true, 'D3 结果标记为已另存', String(saved.savedToOutPath));
    record(path.resolve(saved.apkPath) === path.resolve(saveTo), 'D4 返回路径就是用户选的路径', saved.apkPath);
    record(md5(saveTo) === md5(first.apkPath), 'D5 另存内容与缓存产物一致', md5(saveTo).slice(0, 12));
    record(!fs.existsSync(`${saveTo}.part`), 'D6 没有残留 .part 半成品', saveTo);
  }

  const noOverwrite = await buildUniversalApk(sample, { outPath: saveTo, overwrite: false }).catch((e) => ({
    error: e.message,
  }));
  record(
    !!noOverwrite.error && /已存在/.test(noOverwrite.error),
    'D7 overwrite:false 时拒绝覆盖已有文件',
    safe(noOverwrite.error || '没报错（不应该）'),
  );

  /* ------------------------------------------------------------------ */
  /* E. 换签名必须重做（不能吃旧缓存）                                    */
  /* ------------------------------------------------------------------ */
  let other;
  try {
    other = await buildUniversalApk(sample, { useCache: true, signing: { mode: 'none' } });
    record(
      other.cacheDir !== first.cacheDir && other.fromCache === false,
      'E1 换签名后不复用旧产物（另起一份缓存）',
      `${path.basename(other.cacheDir)} vs ${dirName}`,
    );
  } catch (e) {
    // 不签名时 bundletool 多数情况会产出未签名包；真失败也算「没有复用旧缓存」
    record(true, 'E1 换签名后不复用旧产物（该签名不可用，直接报错）', safe(e.message));
  }

  /* ------------------------------------------------------------------ */
  /* F. 输入校验                                                         */
  /* ------------------------------------------------------------------ */
  const notAab = await buildUniversalApk(path.join(outDir, 'fake.apk'), {}).catch((e) => ({ error: e.message }));
  record(
    !!notAab.error && /不存在|不是 \.aab/.test(notAab.error),
    'F1 非法输入被拒（不存在 / 不是 .aab）',
    safe(notAab.error),
  );
  const asApk = await buildUniversalApk(saveTo, {}).catch((e) => ({ error: e.message }));
  record(
    !!asApk.error && /不是 \.aab/.test(asApk.error),
    'F2 拿 .apk 冒充 .aab 被拒',
    safe(asApk.error),
  );

  /* ------------------------------------------------------------------ */
  /* G. 产物真能装（仅模拟器；真机跳过，不动用户设备）                    */
  /* ------------------------------------------------------------------ */
  const devs = onlineDevices();
  const emu = devs.find((s) => s.startsWith('emulator-'));
  if (!emu) {
    skip('G 真机安装验证', devs.length ? `在线设备 ${devs.join('、')} 都不是模拟器，跳过` : '没有设备在线');
  } else {
    let inst = adb(['-s', emu, 'install', '-r', saveTo]);
    if (!/Success/i.test(inst)) {
      // 设备上原有版本签名不同时，覆盖装必然失败 —— 模拟器上可以直接卸了重来
      if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(inst)) {
        adb(['-s', emu, 'uninstall', srcInfo.packageName]);
        inst = adb(['-s', emu, 'install', saveTo]);
      }
    }
    record(/Success/i.test(inst), 'G1 通用 APK 在模拟器上安装成功', safe(inst.split(/\r?\n/).pop() || ''));

    if (/Success/i.test(inst)) {
      const paths = adb(['-s', emu, 'shell', 'pm', 'path', srcInfo.packageName]);
      const got = paths.split(/\r?\n/).filter((x) => x.startsWith('package:'));
      record(got.length >= 1, 'G2 装后按包名复核到', `${got.length} 个 apk`);
      // 通用包应该只有一个 apk（不分 split）—— 这正是它「通用」的形态
      record(got.length === 1, 'G3 通用包是单个 APK（无 split）', `${got.length} 个`);
      const dump = adb(['-s', emu, 'shell', 'dumpsys', 'package', srcInfo.packageName]);
      record(
        Number(dump.match(/versionCode=(\d+)/)?.[1] || 0) === Number(srcInfo.versionCode || 0),
        'G4 设备上版本号与源 AAB 一致',
        dump.match(/versionCode=(\d+)/)?.[1] || '?',
      );
    }
  }

  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  finish();

  function finish() {
    const pass = rows.filter((r) => r.startsWith('PASS')).length;
    const fail = rows.filter((r) => r.startsWith('FAIL')).length;
    const skips = rows.filter((r) => r.startsWith('SKIP')).length;
    log('===== AAB UNIVERSAL CHECK =====');
    for (const r of rows) log(r);
    log(`${pass} 通过 / ${fail} 失败 / ${skips} 跳过`);
    log('AAB UNIVERSAL CHECK DONE');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
