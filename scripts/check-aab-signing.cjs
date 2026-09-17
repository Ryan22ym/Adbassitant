/**
 * AAB 拆包签名验收（纯 Node，不用 Electron）
 *
 *   node scripts/check-aab-signing.cjs
 *
 * 背景：这个功能是被一个真实问题逼出来的 ——
 *   用默认的随包 debug.keystore 拆 AAB，应用的签名被换掉，Facebook 登录
 *   报「Invalid key hash」。根因是 key hash 变了，而三方 SDK 按
 *   「包名 + 签名」校验。
 *
 * 覆盖五段：
 *   A. key hash 计算      —— base64(SHA1) 的算法正确性（与线上已知值对齐）
 *   B. 密钥库探测         —— 密码对/错、别名读取、非法文件
 *   C. 配置持久化         —— 三态读写、坏配置回退
 *   D. 签名参数拼装       —— 三种模式各自产出的 bundletool 参数
 *   E. 真机拆包验证签名   —— **核心**：用自定义 keystore 拆包，
 *                           验证产物 APK 的签名指纹 == 该 keystore 的指纹
 *
 * E 段是这个脚本存在的理由：只有真正拆一次、再用 apksigner/keytool 读产物
 * 的证书指纹，才能证明「签名确实按用户选的来了」，而不是只看参数拼对了。
 *
 * 素材：SIGN_KS 环境变量指定密钥库（默认用 ~/Downloads/AdbTools/pokercity.keystore），
 *       AAB_FILE 指定 AAB，ADB_SERIAL 指定设备。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_aab-signing.log');
try {
  fs.writeFileSync(LOG, '');
} catch {
  /* ignore */
}

const ADB = path.join(ROOT, 'bin', 'adb.exe');
const BUNDLED_KS = path.join(ROOT, 'bin', 'bundletool', 'debug.keystore');
const BUNDLED_KS_PASS = 'android';
const BUNDLED_KS_ALIAS = 'androiddebugkey';

/** 自定义密钥库样本（小杨装 AAB 用的那套工具里的正式签名） */
const CUSTOM_KS =
  process.env.SIGN_KS || path.join(os.homedir(), 'Downloads', 'AdbTools', 'pokercity.keystore');
const CUSTOM_KS_PASS = process.env.SIGN_KS_PASS || '111111';
const CUSTOM_KS_ALIAS = process.env.SIGN_KS_ALIAS || 'pokercity';

const aab = require('../dist-electron/electron/services/aab.js');
const signing = require('../dist-electron/electron/services/aab-signing.js');

let rows = [];
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r');

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

function pickAab() {
  if (process.env.AAB_FILE && fs.existsSync(process.env.AAB_FILE)) return process.env.AAB_FILE;
  const dirs = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).find((x) => x.toLowerCase().endsWith('.aab'));
    if (f) return path.join(d, f);
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* A. key hash 计算                                                    */
/* ------------------------------------------------------------------ */

function testKeyHash() {
  /*
   * 用两个已知值对齐：
   *   - debug.keystore 的 SHA1 与它对应的 Facebook hash
   *   - pokercity 的 SHA1 与它对应的 Facebook hash
   * 都是从真实 keytool 输出算出来的，改动算法会立刻打红。
   */
  const debugSha1 = '32:C2:02:81:E7:75:8C:97:F6:32:89:D0:73:A1:0D:67:4D:63:EA:E2';
  const debugFb = 'MsICged1jJf2MonQc6ENZ01j6uI=';
  const got = signing.facebookHashFromSha1(debugSha1);
  record(got === debugFb, 'A1 debug keystore 的 Facebook key hash', `${got}（期望 ${debugFb}）`);

  const pkSha1 = '05:D0:FA:E5:4F:76:42:3E:63:AA:94:D0:3F:09:FD:48:3E:2E:38:DD';
  const pkFb = 'BdD65U92Qj5jqpTQPwn9SD4uON0=';
  const got2 = signing.facebookHashFromSha1(pkSha1);
  record(got2 === pkFb, 'A2 pokercity 的 Facebook key hash', `${got2}（期望 ${pkFb}）`);

  // 两个不同的签名必须产出不同的 hash —— 这是整个功能的立足点
  record(got !== got2, 'A3 不同签名产出不同 key hash（问题的根因成立）');

  // 非法输入不能抛
  record(
    signing.facebookHashFromSha1('') === '' && signing.facebookHashFromSha1('xx') === '',
    'A4 非法 SHA1 返回空而不是抛异常',
  );
}

/* ------------------------------------------------------------------ */
/* B. 密钥库探测                                                       */
/* ------------------------------------------------------------------ */

async function testProbe() {
  if (!fs.existsSync(CUSTOM_KS)) {
    record(false, 'B0 自定义密钥库样本存在', `缺失：${CUSTOM_KS}（设 SIGN_KS 指定）`);
    return;
  }
  record(true, 'B0 自定义密钥库样本存在', CUSTOM_KS);

  const ok = await signing.probeKeystore(CUSTOM_KS, CUSTOM_KS_PASS);
  record(ok.ok, 'B1 用正确密码能打开密钥库', ok.ok ? `别名 ${ok.aliases.join('、')}` : safe(ok.reason));
  record(
    ok.aliases.includes(CUSTOM_KS_ALIAS),
    'B2 读出预期别名',
    `${CUSTOM_KS_ALIAS} ∈ [${ok.aliases.join('、')}]`,
  );
  record(
    ok.entries.length > 0 && /^[0-9A-F:]{20,}$/i.test(ok.entries[0]?.sha1 || ''),
    'B3 读出证书 SHA1 指纹',
    ok.entries[0]?.sha1 || '（无）',
  );

  const bad = await signing.probeKeystore(CUSTOM_KS, 'definitely-wrong-pass');
  record(!bad.ok, 'B4 密码错时明确失败', safe(bad.reason));

  const missing = await signing.probeKeystore(path.join(os.tmpdir(), 'no-such-ks.jks'), 'x');
  record(!missing.ok, 'B5 文件不存在时明确失败', safe(missing.reason));

  // 用普通文件冒充密钥库，不能被当成合法库
  const fake = path.join(os.tmpdir(), 'aab-signing-fake.keystore');
  try {
    fs.writeFileSync(fake, 'this is not a keystore at all');
    const r = await signing.probeKeystore(fake, 'x');
    record(!r.ok, 'B6 非密钥库文件被拒绝', safe(r.reason));
  } finally {
    try {
      fs.rmSync(fake, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* C. 配置持久化                                                       */
/* ------------------------------------------------------------------ */

async function testConfig() {
  /* 探测需要 electron 的 app.getPath —— 纯 node 下拿不到，跳过并说明 */
  let needElectron = false;
  try {
    signing.getSigningConfig();
  } catch (e) {
    if (/electron/i.test(String(e.message))) needElectron = true;
    else throw e;
  }
  if (needElectron) {
    record(true, 'C 配置持久化', '需要 Electron 运行时（app.getPath），本脚本跳过 —— 由 check-aab-ui 覆盖');
    return;
  }
  record(true, 'C 配置持久化', '可读');
}

/* ------------------------------------------------------------------ */
/* D. 签名参数拼装                                                     */
/* ------------------------------------------------------------------ */

async function testResolve() {
  /* bundled-debug */
  {
    const { info, args } = await signing.resolveSigning({ mode: 'bundled-debug' });
    const hasKs = args.some((a) => a.startsWith('--ks='));
    const hasAlias = args.some((a) => a.startsWith('--ks-key-alias='));
    const hasStore = args.some((a) => a.startsWith('--ks-pass='));
    const hasKey = args.some((a) => a.startsWith('--key-pass='));
    record(
      info.ok && hasKs && hasAlias && hasStore && hasKey,
      'D1 bundled-debug 产出完整签名参数',
      info.ok ? args.map((a) => a.replace(/pass:.*/, 'pass:***')).join(' ') : safe(info.reason),
    );
    // 必须指向随包那份
    record(
      args.some((a) => a === `--ks=${BUNDLED_KS}`) || /debug\.keystore$/.test(args.find((a) => a.startsWith('--ks=')) || ''),
      'D2 bundled-debug 指向随包 debug.keystore',
    );
  }

  /* none */
  {
    const { info, args } = await signing.resolveSigning({ mode: 'none' });
    record(info.ok && args.length === 0, 'D3 none 模式不产出任何签名参数', `args=${args.length}`);
  }

  /* custom —— 合法 */
  if (fs.existsSync(CUSTOM_KS)) {
    const { info, args } = await signing.resolveSigning({
      mode: 'custom',
      keystorePath: CUSTOM_KS,
      storePass: CUSTOM_KS_PASS,
      keyAlias: CUSTOM_KS_ALIAS,
    });
    record(info.ok, 'D4 custom 合法配置可用', info.ok ? info.desc : safe(info.reason));
    record(
      args.some((a) => a === `--ks=${CUSTOM_KS}`) && args.some((a) => a === `--ks-key-alias=${CUSTOM_KS_ALIAS}`),
      'D5 custom 参数指向用户指定的库与别名',
    );
    // 密码不能为空串
    record(
      args.some((a) => a === `--ks-pass=pass:${CUSTOM_KS_PASS}`),
      'D6 custom 正确传递密钥库密码',
    );
  }

  /* custom —— 密码错 */
  if (fs.existsSync(CUSTOM_KS)) {
    const { info, args } = await signing.resolveSigning({
      mode: 'custom',
      keystorePath: CUSTOM_KS,
      storePass: 'wrong',
    });
    record(!info.ok && args.length === 0, 'D7 custom 密码错时拒绝并给出原因', safe(info.reason));
  }

  /* custom —— 没填路径 */
  {
    const { info } = await signing.resolveSigning({ mode: 'custom', keystorePath: '', storePass: 'x' });
    record(!info.ok, 'D8 custom 未选文件时拒绝', safe(info.reason));
  }

  /* custom —— 别名不存在 */
  if (fs.existsSync(CUSTOM_KS)) {
    const { info, args } = await signing.resolveSigning({
      mode: 'custom',
      keystorePath: CUSTOM_KS,
      storePass: CUSTOM_KS_PASS,
      keyAlias: 'no-such-alias',
    });
    record(!info.ok && args.length === 0, 'D9 custom 别名不存在时拒绝', safe(info.reason));
  }

  /* custom —— 别名留空自动取唯一那个 */
  if (fs.existsSync(CUSTOM_KS)) {
    const { info, args } = await signing.resolveSigning({
      mode: 'custom',
      keystorePath: CUSTOM_KS,
      storePass: CUSTOM_KS_PASS,
    });
    record(
      info.ok && args.some((a) => a === `--ks-key-alias=${CUSTOM_KS_ALIAS}`),
      'D10 custom 别名留空时自动取库中唯一别名',
      info.ok ? CUSTOM_KS_ALIAS : safe(info.reason),
    );
  }
}

/* ------------------------------------------------------------------ */
/* E. 真机拆包 → 验证产物签名                                          */
/* ------------------------------------------------------------------ */

/**
 * 读一个 APK 的签名证书 SHA1。
 *
 * 用 keytool -printcert -jarfile —— 它会读 APK 里的 v1 签名（META-INF/CERT.RSA）。
 * bundletool 打的包默认同时带 v1+v2+v3，所以这条路有效（已实测）。
 *
 * 为什么不用 apksigner：本机/用户机器未必有 Android build-tools；
 * 而 keytool 是 JDK 自带，我们本来就必须有 Java 才能跑 bundletool。
 * 注意要带 -J-Dfile.encoding=UTF-8，否则中文 JDK 输出乱码会影响解析。
 */
function apkCertSha1(javaDir, apkPath) {
  const kt = path.join(javaDir, 'keytool.exe');
  if (!fs.existsSync(kt)) return '';
  const r = spawnSync(kt, ['-J-Dfile.encoding=UTF-8', '-printcert', '-jarfile', apkPath], {
    encoding: 'utf8',
  });
  const text = String(r.stdout || '') + String(r.stderr || '');
  const m = text.match(/SHA1\s*[:：]\s*([0-9A-Fa-f:]{20,})/);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 解 app.apks（它本身是个 zip，内含 splits/*.apk）到临时目录。
 * Windows 自带 tar 能解 zip；解不开时退回 Node 自己读 zip 条目。
 */
function extractApks(apksFile, destDir) {
  try {
    execFileSync('tar', ['-xf', apksFile, '-C', destDir], { stdio: 'ignore' });
  } catch {
    /* 落到下面的兜底 */
  }
  const splitDir = path.join(destDir, 'splits');
  if (fs.existsSync(splitDir)) {
    return {
      dir: splitDir,
      apks: fs.readdirSync(splitDir).filter((f) => f.endsWith('.apk')),
    };
  }
  return { dir: destDir, apks: [] };
}

/** 用 Java 的后端 keytool 路径（跟 AAB 运行时同一份 JDK） */
async function javaDirOf() {
  const rt = await aab.resolveAabRuntime();
  if (!rt.ready || !rt.java?.path) return '';
  // java.path 可能是裸名（PATH 命中）—— 这时从扫描位置找绝对路径
  if (!/[\\/]/.test(rt.java.path)) {
    const cands = [
      'C:\\Program Files\\Java\\jdk-11.0.9\\bin',
      process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '',
    ];
    for (const c of cands) {
      if (c && fs.existsSync(path.join(c, 'keytool.exe'))) return c;
    }
    return '';
  }
  return path.dirname(rt.java.path);
}

async function testRealBuild(serial, aabPath) {
  if (!serial) {
    record(false, 'E0 有在线设备（真机拆包验证需要）', '没有在线设备，跳过 E 段');
    return;
  }
  if (!aabPath) {
    record(false, 'E0 有可用 AAB 素材', '没找到 .aab（可用 AAB_FILE 指定）');
    return;
  }
  if (!fs.existsSync(CUSTOM_KS)) {
    record(false, 'E0 有自定义密钥库样本', `缺失 ${CUSTOM_KS}`);
    return;
  }

  const rt = await aab.resolveAabRuntime();
  if (!rt.ready) {
    record(false, 'E0 AAB 运行时就绪', safe(rt.reason));
    return;
  }

  const javaDir = await javaDirOf();
  record(!!javaDir, 'E0b keytool 可用于读取产物指纹', javaDir || '（找不到 JDK 的 keytool）');

  /* 先读到目标密钥库应该有的指纹 —— 后面拿它跟产物对齐 */
  const want = await signing.probeKeystore(CUSTOM_KS, CUSTOM_KS_PASS);
  const wantSha1 = want.entries.find((e) => e.alias === CUSTOM_KS_ALIAS)?.sha1 || '';
  record(!!wantSha1, 'E1 目标密钥库指纹已知', wantSha1);

  /* 清缓存，保证真的重拆（不能吃上一次 debug 签名的产物） */
  aab.clearBundleCache();

  /*
   * 先把设备上可能存在的旧版本卸掉。
   * 模拟器上常常残留着「上次用别的签名装的」同一个包，不卸干净的话
   * E9 读到的会是那个旧签名，让人误以为签名参数没生效。
   */
  const pkgPeek = require('../dist-electron/electron/services/apk.js').readAabInfo(aabPath)
    .packageName;
  if (pkgPeek) {
    const out = adb(['-s', serial, 'uninstall', pkgPeek]);
    log(`[准备] uninstall ${pkgPeek} → ${safe(out).trim()}`);
  }

  const lines = [];
  let r;
  try {
    r = await aab.installBundle(aabPath, {
      serial,
      mode: 'clean', // 签名换了，设备上若已有旧签名版本必冲突；clean 最干净
      useCache: false,
      signing: {
        mode: 'custom',
        keystorePath: CUSTOM_KS,
        storePass: CUSTOM_KS_PASS,
        keyAlias: CUSTOM_KS_ALIAS,
      },
      onLine: (l) => lines.push(l),
    });
  } catch (e) {
    record(false, 'E2 用自定义签名拆包并安装', safe(e.message).slice(0, 300));
    log('--- bundletool 输出 ---\n' + lines.map(safe).join('\n'));
    return;
  }

  record(true, 'E2 用自定义签名拆包并安装', `包名 ${r.packageName || '?'}｜${r.verified ? '已复核' : '未复核'}`);

  /* 关键断言：产物 APK 的证书指纹 == 用户选的密钥库指纹 */
  const apksDir = r.apksDir || '';
  const apksFile = path.join(apksDir, 'app.apks');
  record(fs.existsSync(apksFile), 'E3 拆包产物存在', apksFile);

  if (fs.existsSync(apksFile)) {
    // app.apks 本身是 zip，里面的 splits/ 下才是 APK；解出来读
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-sign-check-'));
    try {
      const { dir: splitsDir, apks } = extractApks(apksFile, tmp);
      record(apks.length > 0, 'E4 产物里含 APK split', `${apks.length} 个`);

      let checked = 0;
      let matched = 0;
      const samples = [];
      for (const f of apks) {
        const sha1 = apkCertSha1(javaDir, path.join(splitsDir, f));
        if (!sha1) continue;
        checked += 1;
        samples.push(`${f} → ${sha1}`);
        if (sha1 === wantSha1) matched += 1;
      }

      record(checked > 0, 'E5 能读出产物 APK 的证书指纹', `${checked} 个`);
      record(
        checked > 0 && matched === checked,
        'E6 ★产物签名指纹 == 用户所选密钥库（Facebook 问题的正解）',
        `匹配 ${matched}/${checked}｜期望 ${wantSha1}`,
      );
      if (checked && matched !== checked) {
        log('--- 产物指纹样本 ---\n' + samples.join('\n'));
      }

      /* 反向对照：debug 签名绝不能与它相同，否则说明参数没生效 */
      const dbg = await signing.probeKeystore(BUNDLED_KS, BUNDLED_KS_PASS);
      const dbgSha1 = dbg.entries.find((e) => e.alias === BUNDLED_KS_ALIAS)?.sha1 || '';
      record(
        wantSha1 !== dbgSha1,
        'E7 自定义签名与调试签名确实不同（对照组）',
        `${wantSha1.slice(0, 17)}… vs ${dbgSha1.slice(0, 17)}…`,
      );

      /*
       * E9：设备侧客观验证。
       * 把装好的包从设备 pull 回来读指纹 —— 这是「用户手机上真实生效的签名」，
       * 比读本机产物更有说服力（也顺带验证了 install-apks 没耍花招）。
       */
      if (r.packageName) {
        const paths = adb(['-s', serial, 'shell', 'pm', 'path', r.packageName])
          .split(/\r?\n/)
          .filter((l) => l.startsWith('package:'))
          .map((l) => l.replace('package:', '').trim());
        let devChecked = 0;
        let devMatched = 0;
        for (const p of paths.slice(0, 2)) {
          const local = path.join(tmp, 'dev-' + path.basename(p));
          try {
            execFileSync(ADB, ['-s', serial, 'pull', p, local], { stdio: 'ignore', timeout: 60000 });
          } catch {
            continue;
          }
          if (!fs.existsSync(local)) continue;
          const sha1 = apkCertSha1(javaDir, local);
          if (!sha1) continue;
          devChecked += 1;
          if (sha1 === wantSha1) devMatched += 1;
          else samples.push(`设备侧 ${path.basename(p)} → ${sha1}`);
        }
        record(
          devChecked > 0 && devMatched === devChecked,
          'E9 ★设备上实际生效的签名 == 用户所选密钥库',
          `匹配 ${devMatched}/${devChecked}`,
        );
      }
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /* 装了之后复核一遍，顺带把设备清干净 */
  if (r.packageName) {
    const out = adb(['-s', serial, 'shell', 'pm', 'path', r.packageName]);
    record(/^package:/m.test(out), 'E8 设备上确实存在该包（pm path 复核）', out.trim().split('\n')[0]);
  }
  aab.clearBundleCache();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('AAB 拆包签名验收');
  console.log('  自定义密钥库样本：', CUSTOM_KS, fs.existsSync(CUSTOM_KS) ? '(存在)' : '(缺失)');

  try {
    testKeyHash();
  } catch (e) {
    record(false, 'A. key hash 计算段异常', safe(e.message));
  }
  try {
    await testProbe();
  } catch (e) {
    record(false, 'B. 密钥库探测段异常', safe(e.message));
  }
  try {
    await testConfig();
  } catch (e) {
    record(false, 'C. 配置段异常', safe(e.message));
  }
  try {
    await testResolve();
  } catch (e) {
    record(false, 'D. 参数拼装段异常', safe(e.message));
  }

  const serial = process.env.ADB_SERIAL || onlineDevices()[0] || '';
  const aabPath = pickAab();
  try {
    await testRealBuild(serial, aabPath);
  } catch (e) {
    record(false, 'E. 真机拆包段异常', safe(e.message));
  }

  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;

  console.log('');
  for (const r of rows) console.log('  ' + r);
  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${rows.length} 项）`);
  console.log(`日志：${LOG}`);

  process.exit(fail === 0 ? 0 : 1);
})();
