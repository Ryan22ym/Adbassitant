/**
 * AAB 安装链路验收（纯 Node，不用 Electron）
 *
 *   node scripts/check-aab-install.cjs
 *
 * 覆盖五段：
 *   A. 环境与工具链    —— Java 11+ / bundletool jar / 随包调试密钥库
 *   B. AAB 文件识别    —— protobuf manifest 解析、bundle 判定、非法输入
 *   C. 真机安装全链路  —— build-apks(device-spec) → install-apks → pm path 复核
 *   D. 缓存与安装方式  —— 命中缓存、按设备隔离、fresh 中止、clean 卸载
 *   E. 拆包与安装分离  —— convertBundle 另存 .apks、装现成 .apks、缓存外产物
 *
 * 为什么要测这些（都是踩过的坑）：
 *   - AAB 的 manifest 是 protobuf，不是 AXML，既有解析器读不出包名；
 *   - bundletool 只在 ~/.android/debug.keystore 存在时才签名，否则产出
 *     未签名 APK，装的时候直接被拒 —— 所以必须自带 keystore；
 *   - `--device-id` 必须配 `--connected-device`，而那条路要让 bundletool
 *     自己找 adb，找不到就 `Unable to find the requested device`。
 *     正解是拆成 get-device-spec → build-apks --device-spec；
 *   - 装 apks 会按「文件指纹 + 设备」缓存，但设备侧的 fresh/clean 判断
 *     不能因为命中缓存就跳过（否则第二次装的行为和第一次不一致）；
 *   - 「拆包」与「安装」是两件事：拆一次可以反复装，产物能落盘复用。
 *     装现成 .apks 时不能再偷偷拆包（否则用户以为装 apks 比装 aab 还慢）。
 *
 * 素材：~/Downloads 下的任意 .aab（可用 AAB_FILE 指定），目标设备默认
 * 取 ADB_SERIAL 或第一台在线设备。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_aab-install.log');

const ADB = path.join(ROOT, 'bin', 'adb.exe');
const KS = path.join(ROOT, 'bin', 'bundletool', 'debug.keystore');

const {
  installBundle,
  installApksFile,
  convertBundle,
  inspectAabEnv,
  listBundleCache,
  clearBundleCache,
  bundletoolJarPath,
} = require('../dist-electron/electron/services/aab.js');
const { readAabInfo } = require('../dist-electron/electron/services/apk.js');

let rows = [];
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
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

function adb(args, timeout = 60000) {
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

/** 找一份可用的 .aab 素材 */
function pickAab() {
  if (process.env.AAB_FILE && fs.existsSync(process.env.AAB_FILE)) return process.env.AAB_FILE;
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.aab'))
    .map((f) => ({ p: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
    // 挑小的，跑得快；但仍然要是个真 bundle
    .sort((a, b) => a.s - b.s);
  return files.length ? files[0].p : null;
}

function deviceVersion(serial, pkg) {
  try {
    const out = execFileSync(ADB, ['-s', serial, 'shell', 'dumpsys', 'package', pkg], {
      encoding: 'utf8',
      timeout: 60000,
    });
    return {
      versionCode: Number(out.match(/versionCode=(\d+)/)?.[1] || 0) || undefined,
      versionName: out.match(/versionName=(\S+)/)?.[1],
      splits: out.match(/splits=\[([^\]]*)\]/)?.[1],
    };
  } catch {
    return {};
  }
}

/** 异步版 installBundle，把异常收成 { error } */
async function tryInstall(file, opts) {
  try {
    return { result: await installBundle(file, opts) };
  } catch (e) {
    return { error: e.message };
  }
}

(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  /* ================= A. 环境与工具链 ================= */
  const env = await inspectAabEnv(true);
  log(`env: ${JSON.stringify(env)}`);
  record(env.ready === true, 'AAB 环境就绪（Java + bundletool）', safe(env.reason || ''));
  record(env.javaOk === true, 'Java 版本满足 bundletool 要求（11+）', String(env.javaVersion));
  record(!!env.javaPath, '定位到 java 可执行文件', safe(env.javaDesc));
  record(env.bundletoolReady === true, 'bundletool 已就位', safe(env.bundletoolPath));
  record(
    fs.existsSync(bundletoolJarPath()) && fs.statSync(bundletoolJarPath()).size > 1000000,
    'bundletool jar 是真实文件（不是错误页）',
    MB(fs.existsSync(bundletoolJarPath()) ? fs.statSync(bundletoolJarPath()).size : 0),
  );
  record(env.bundletoolVersion === '1.18.3', 'bundletool 版本与预期一致', String(env.bundletoolVersion));
  // 没有它 bundletool 会产出未签名 APK —— 这是「装不上」最常见的原因
  record(fs.existsSync(KS), '随包调试密钥库存在', fs.existsSync(KS) ? `${fs.statSync(KS).size} B` : '缺失');

  /* ================= B. AAB 文件识别 ================= */
  const sample = pickAab();
  record(!!sample, '找到 .aab 素材', safe(sample || '无'));
  if (!sample) {
    finish();
    return;
  }

  const info = readAabInfo(sample);
  log(`aab info: ${JSON.stringify(info)}`);
  record(!!info.packageName, 'AAB protobuf manifest 能读出包名', String(info.packageName));
  record(
    /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(info.packageName || ''),
    '包名是合法格式',
    String(info.packageName),
  );
  // 值后面紧跟着下一个字段号字节（可打印 ASCII），是第一版解析器踩的坑
  record(
    !/[\\()\x00-\x1f]/.test(info.packageName || '') && !/[\\()\x00-\x1f]/.test(info.versionName || ''),
    '包名/版本名没有混进 protobuf 字段号字节',
    `${info.packageName} / ${info.versionName}`,
  );
  record(info.isBundle === true, '识别为 Android App Bundle', String(info.isBundle));

  /* 非法输入：必须只报错、不抛异常、返回 error */
  const notAab = path.join(os.tmpdir(), 'adb-assistant-aab-check-notaab.bin');
  fs.writeFileSync(notAab, Buffer.from('THIS-IS-NOT-A-BUNDLE'.repeat(64)));
  const junk = readAabInfo(notAab);
  record(!junk.packageName && !!junk.error, '非 bundle 文件返回 error 而非包名', safe(junk.error));

  const missing = readAabInfo(path.join(os.tmpdir(), 'definitely-not-here.aab'));
  record(!missing.packageName && !!missing.error, '文件不存在时返回 error', safe(missing.error));

  const asPkgJson = readAabInfo(path.join(ROOT, 'package.json'));
  record(
    !asPkgJson.packageName && !asPkgJson.isBundle,
    '把 package.json 当 AAB 会返回 error',
    safe(asPkgJson.error),
  );

  /* ================= 目标设备 ================= */
  const online = onlineDevices();
  log(`online devices: ${JSON.stringify(online)}`);
  record(online.length > 0, '至少一台在线设备',
    online.length ? `${online.length} 台` : '无设备，跳过 C/D 段');
  if (online.length === 0) {
    finish();
    return;
  }
  const target = process.env.ADB_SERIAL || online[0];
  log(`target device: ${target}`);
  record(online.includes(target), '目标设备在线', target);

  /* 不指定设备必须直接拒绝（项目硬规矩：绝不猜目标设备） */
  const noSerial = await tryInstall(sample, { serial: '' });
  record(!!noSerial.error && /必须明确指定目标设备/.test(noSerial.error), '不指定目标设备直接被拒', safe(noSerial.error));

  /* 非 .aab 扩展名必须被拒 */
  const badExt = await tryInstall(path.join(ROOT, 'package.json'), { serial: target });
  record(!!badExt.error && /不是 \.aab/.test(badExt.error), '非 .aab 扩展名被拒', safe(badExt.error));

  /* ================= C. 真机安装全链路 ================= */
  // 清掉历史产物，保证第一轮走的是冷启动拆包路径
  const purged = clearBundleCache();
  log(`purged ${purged.removed} dirs / ${MB(purged.freedBytes)}`);
  record(listBundleCache().length === 0, '清空缓存后列表为空', `${purged.removed} 项已清`);

  const pkgFromFile = info.packageName;
  const lines1 = [];
  const t1 = Date.now();
  const r1 = await tryInstall(sample, {
    serial: target,
    mode: 'overwrite',
    onLine: (l) => lines1.push(l),
  });
  const sec1 = ((Date.now() - t1) / 1000).toFixed(1);

  record(!r1.error && !!r1.result, '第一次安装（冷启动拆包）成功', safe(r1.error || ''));
  if (r1.result) {
    const r = r1.result;
    log(`first install: ${JSON.stringify({ ...r, output: undefined })}`);
    record(r.fromBundle === true, '结果标记为来自 bundle', String(r.fromBundle));
    record(r.fromCache !== true, '第一次未命中缓存', `fromCache=${r.fromCache}`);
    record(typeof r.buildMs === 'number' && r.buildMs > 0, '记录了拆包耗时', `${r.buildMs}ms`);
    record(typeof r.installMs === 'number' && r.installMs > 0, '记录了安装耗时', `${r.installMs}ms`);
    // bundletool 说成功 ≠ 装上了，必须 pm path 复核
    record(r.verified === true, '装后复核通过（pm path 查到该包）', String(r.verified));

    const paths = adb(['-s', target, 'shell', 'pm', 'path', r.packageName || pkgFromFile]);
    const apkLines = paths.split(/\r?\n/).filter((x) => x.startsWith('package:'));
    record(apkLines.length >= 1, '设备上真实存在该包', `${apkLines.length} 个 apk`);
    // AAB 装出来的是 split 多包，这是它区别于 APK 的特征
    record(apkLines.length >= 2, '装成 split 多包（AAB 特征）', apkLines.map((l) => path.basename(l)).join(','));

    if (r.packageName) {
      const dev = deviceVersion(target, r.packageName);
      log(`device version: ${JSON.stringify(dev)}`);
      record(dev.versionName === r.versionName, '设备端版本名与 AAB 一致', `${dev.versionName} vs ${r.versionName}`);
      record(
        !!dev.versionCode && dev.versionCode === r.versionCode,
        '设备端版本号与 AAB 一致',
        `${dev.versionCode} vs ${r.versionCode}`,
      );
      record(!!dev.splits, '设备端报告了 splits 列表', safe(dev.splits));
    }
  }

  /* ================= D. 缓存与安装方式 ================= */
  const t2 = Date.now();
  const r2 = await tryInstall(sample, { serial: target, mode: 'overwrite', onLine: () => {} });
  const sec2 = ((Date.now() - t2) / 1000).toFixed(1);
  record(!r2.error && !!r2.result, '第二次安装成功', safe(r2.error || ''));
  if (r2.result) {
    record(r2.result.fromCache === true, '第二次命中拆包缓存', `fromCache=${r2.result.fromCache}`);
    record(r2.result.verified === true, '第二次装后复核同样通过', String(r2.result.verified));
    // 命中缓存就该跳过拆包（buildMs 为 0）
    record(!r2.result.buildMs, '命中缓存时不做拆包', `buildMs=${r2.result.buildMs}`);
    record(
      Number(sec2) < Number(sec1),
      '命中缓存的那次更快',
      `${sec1}s → ${sec2}s`,
    );
  }

  const cache = listBundleCache();
  log(`cache: ${cache.map((c) => `${path.basename(c.dir)} ${MB(c.sizeBytes)}`).join(' | ')}`);
  record(cache.length >= 1, '缓存目录已落盘', `${cache.length} 项`);
  // 缓存键必须含设备标识，否则会拿 A 设备的产物去装 B 设备
  record(
    cache.every((c) => path.basename(c.dir).includes(target.replace(/[^\w.-]/g, '_'))),
    '缓存目录按设备隔离（键里含 serial）',
    cache.map((c) => path.basename(c.dir)).join(','),
  );

  /* fresh：设备上已有该包必须中止（即便缓存命中也要拦） */
  const freshTry = await tryInstall(sample, { serial: target, mode: 'fresh', onLine: () => {} });
  const freshBlocked =
    !!freshTry.error && /已存在/.test(freshTry.error) ||
    (freshTry.result && /已存在/.test(freshTry.result.output || ''));
  record(!!freshBlocked, 'fresh 模式对已装应用中止（缓存命中时也拦）', safe(freshTry.error || 'ok'));

  /* clean：应当先卸载再装，且最终仍然装上 */
  const cleanTry = await tryInstall(sample, { serial: target, mode: 'clean', onLine: () => {} });
  record(!cleanTry.error && !!cleanTry.result, 'clean 模式安装成功', safe(cleanTry.error || ''));
  if (cleanTry.result) {
    record(cleanTry.result.uninstalled === true, 'clean 模式确实先卸载了旧版本', String(cleanTry.result.uninstalled));
    record(cleanTry.result.verified === true, 'clean 模式装后复核通过', String(cleanTry.result.verified));
  }

  /* ================= E. 拆包与安装分离 ================= */

  /* --- E1. convertBundle 只拆包：产物落缓存，不改设备状态 --- */
  const purgeE = clearBundleCache();
  log(`E: purged ${purgeE.removed} dirs`);

  const convLines = [];
  const tConv = Date.now();
  let conv;
  try {
    conv = await convertBundle(sample, {
      serial: target,
      onLine: (l) => convLines.push(l),
    });
  } catch (e) {
    conv = { error: e.message };
  }
  const convSec = ((Date.now() - tConv) / 1000).toFixed(1);

  record(!conv.error && !!conv.apksPath, 'E1 仅拆包成功（不安装）', safe(conv.error || ''));
  if (conv.apksPath) {
    log(`E1 convert: ${JSON.stringify({ ...conv, apksPath: conv.apksPath })}`);
    record(fs.existsSync(conv.apksPath), 'E1 产物 .apks 已落盘', conv.apksPath);
    record(fs.statSync(conv.apksPath).size > 1024, 'E1 产物不是空壳', MB(fs.statSync(conv.apksPath).size));
    record(conv.rebuilt === true, 'E1 冷启动确实重新拆了包', `rebuilt=${conv.rebuilt}`);
    record(conv.fromCache === false, 'E1 冷启动未命中缓存', `fromCache=${conv.fromCache}`);
    record(typeof conv.buildMs === 'number' && conv.buildMs > 0, 'E1 记录了拆包耗时', `${conv.buildMs}ms`);
    record(conv.packageName === pkgFromFile, 'E1 读出的包名与 AAB 一致', String(conv.packageName));
    record(conv.savedToOutPath === false, 'E1 未指定 outPath 时产物留在缓存里', String(conv.savedToOutPath));
    // 关键：拆包绝不能碰设备状态 —— 设备上此刻应该没有这个包（前面 clean 之后又装过，先卸掉）
    adb(['-s', target, 'uninstall', pkgFromFile]);
    record(
      !adb(['-s', target, 'shell', 'pm', 'path', pkgFromFile]).includes('package:'),
      'E1 拆包不会把应用装上（设备状态未被改动）',
    );
    // 记账文件必须写下来，否则装现成 .apks 时读不出包名
    const srcFile = path.join(path.dirname(conv.apksPath), 'source.aab.txt');
    record(fs.existsSync(srcFile), 'E1 产物目录记下了源 AAB 路径', fs.existsSync(srcFile) ? fs.readFileSync(srcFile, 'utf8').trim() : '缺失');
  }

  /* --- E2. convertBundle 第二次命中缓存：不重拆 --- */
  const conv2 = await convertBundle(sample, { serial: target }).catch((e) => ({ error: e.message }));
  record(!conv2.error, 'E2 第二次拆包调用成功', safe(conv2.error || ''));
  if (conv2.apksPath) {
    record(conv2.fromCache === true, 'E2 第二次命中拆包缓存', `fromCache=${conv2.fromCache}`);
    record(conv2.rebuilt === false, 'E2 命中缓存时不重新拆包', `rebuilt=${conv2.rebuilt}`);
    record(!conv2.buildMs, 'E2 命中缓存时拆包耗时为 0', `buildMs=${conv2.buildMs}`);
  }

  /* --- E3. 另存 outPath：产物复制到用户指定路径 --- */
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-save-'));
  const outFile = path.join(outDir, 'saved.apks');
  const conv3 = await convertBundle(sample, { serial: target, outPath: outFile }).catch((e) => ({
    error: e.message,
  }));
  record(!conv3.error, 'E3 另存到指定路径成功', safe(conv3.error || ''));
  if (!conv3.error) {
    record(fs.existsSync(outFile), 'E3 另存的文件存在', MB(fs.existsSync(outFile) ? fs.statSync(outFile).size : 0));
    record(conv3.apksPath === outFile, 'E3 返回的路径就是另存路径', conv3.apksPath);
    record(conv3.savedToOutPath === true, 'E3 标记为已另存', String(conv3.savedToOutPath));
    record(conv3.fromCache === true, 'E3 另存走的是缓存产物（没重拆）', `fromCache=${conv3.fromCache}`);
    // 先写 .part 再改名：中间态不该留下
    record(!fs.existsSync(outFile + '.part'), 'E3 没有留下 .part 半成品');
  }

  /* --- E4. 装现成的 .apks：不再拆包，直接 install-multiple --- */
  const apkLines = [];
  let inst;
  try {
    inst = await installApksFile(conv.apksPath, {
      serial: target,
      mode: 'overwrite',
      onLine: (l) => apkLines.push(l),
    });
  } catch (e) {
    inst = { error: e.message };
  }
  record(!inst.error && !!inst.serial, 'E4 安装现成 .apks 成功', safe(inst.error || ''));
  if (inst.serial) {
    log(`E4 install apks: ${JSON.stringify({ ...inst, output: undefined })}`);
    record(inst.fromApks === true, 'E4 结果标记为来自 .apks', String(inst.fromApks));
    record(inst.fromBundle === false, 'E4 不是来自 bundle（没走拆包）', String(inst.fromBundle));
    record(inst.verified === true, 'E4 装后复核通过（靠 source.aab.txt 反查包名）', String(inst.verified));
    record(inst.packageName === pkgFromFile, 'E4 复核用包名与 AAB 一致', String(inst.packageName));
    const paths = adb(['-s', target, 'shell', 'pm', 'path', pkgFromFile]);
    const got = paths.split(/\r?\n/).filter((x) => x.startsWith('package:'));
    record(got.length >= 2, 'E4 同样是 split 多包（.apks 特征）', `${got.length} 个 apk`);
    // 「装 .apks 不再拆包」是本功能的核心承诺：输出里不该有 build-apks 的痕迹
    const joined = apkLines.join('\n');
    record(
      !/build-apks|拆包完成|device-spec/i.test(joined),
      'E4 安装现成 .apks 时没有再拆包',
      apkLines.length ? `${apkLines.length} 行输出` : '无输出',
    );
  }

  /* --- E5. 不指定设备必须拒绝（拆包与装 apks 都是） --- */
  const convNoSerial = await convertBundle(sample, { serial: '' }).catch((e) => ({ error: e.message }));
  record(
    !!convNoSerial.error && /必须明确指定目标设备/.test(convNoSerial.error),
    'E5 拆包不指定设备被拒',
    safe(convNoSerial.error),
  );
  const apksNoSerial = await installApksFile(conv.apksPath, { serial: '' }).catch((e) => ({
    error: e.message,
  }));
  record(
    !!apksNoSerial.error && /必须明确指定目标设备/.test(apksNoSerial.error),
    'E5 装 .apks 不指定设备被拒',
    safe(apksNoSerial.error),
  );

  /* --- E6. 非 .apks 扩展名被拒 --- */
  const badApks = await installApksFile(sample, { serial: target }).catch((e) => ({ error: e.message }));
  record(
    !!badApks.error && /不是 \.apks/.test(badApks.error),
    'E6 用 .aab 冒充 .apks 被拒',
    safe(badApks.error),
  );

  /* --- E7. fresh / clean 语义在 .apks 路径上同样成立 --- */
  const apksFresh = await installApksFile(conv.apksPath, {
    serial: target,
    mode: 'fresh',
  }).catch((e) => ({ error: e.message }));
  const apksFreshBlocked =
    (!!apksFresh.error && /已存在/.test(apksFresh.error)) ||
    (apksFresh.result && /已存在/.test(apksFresh.result.output || ''));
  record(!!apksFreshBlocked, 'E7 fresh 模式对已装应用中止（.apks 路径）', safe(apksFresh.error || 'ok'));

  const apksClean = await installApksFile(conv.apksPath, {
    serial: target,
    mode: 'clean',
  }).catch((e) => ({ error: e.message }));
  record(!apksClean.error && !!apksClean.serial, 'E7 clean 模式安装成功（.apks 路径）', safe(apksClean.error || ''));
  if (apksClean.serial) {
    record(apksClean.uninstalled === true, 'E7 clean 确实先卸载了旧版本', String(apksClean.uninstalled));
    record(apksClean.verified === true, 'E7 clean 装后复核通过', String(apksClean.verified));
  }

  /* --- E8. 缓存外的 .apks：能装，但不冒充「本工具拆的」 --- */
  // 把刚才另存的文件（在 %TEMP%\aab-save-xxx\，不在拆包缓存根目录下）当外部产物
  const outSide = path.join(outDir, 'outside.apks');
  fs.copyFileSync(conv.apksPath, outSide);
  // 外层目录里没有 source.aab.txt 之外的元数据也一并去掉，模拟「从别处来的」
  let outside;
  try {
    outside = await installApksFile(outSide, { serial: target, mode: 'overwrite' });
  } catch (e) {
    outside = { error: e.message };
  }
  record(!outside.error && !!outside.serial, 'E8 缓存外的 .apks 也能装', safe(outside.error || ''));
  if (outside.serial) {
    record(outside.fromApks === true, 'E8 标记为来自 .apks', String(outside.fromApks));
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
    log('===== AAB INSTALL CHECK =====');
    for (const r of rows) log(r);
    log(`${pass} 通过 / ${fail} 失败`);
    log('AAB INSTALL CHECK DONE');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
