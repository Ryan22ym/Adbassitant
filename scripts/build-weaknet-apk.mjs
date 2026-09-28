/**
 * 构建弱网配套 App 的 APK，并放到随包位置 bin/weaknet-vpn.apk
 *
 * 用法：
 *   node scripts/build-weaknet-apk.mjs            # 出随包的弱网 App（:app，release）
 *   node scripts/build-weaknet-apk.mjs --probe    # 出**测试用**的流量探针（:probe，debug）
 *   node scripts/build-weaknet-apk.mjs --recorder # 出屏幕录制采集端（:recorder，release）
 *
 * --probe 那个是验证弱网用的：Android 不会把 uid 0/1000(system)/2000(shell) 的流量送进
 * VPN，所以 `adb shell curl` 测不出弱网效果，必须由普通应用发流量。探针包是独立
 * applicationId → 独立 uid → 在网段内，一次只发一个受控请求，指标才可比。
 * **它只是测试工具，不随主程序分发。**
 *
 * --recorder 是自动连点器的配套采集端（bin/screen-recorder.apk）：
 * 设备侧用 MediaProjection 采集本机屏幕画到自己的 SurfaceView 上，
 * 用户在画布上操作 → 触摸坐标被记录 → 电脑端拉取后转换成连点器脚本。
 * 之所以必须放在设备上做：Android 5.0+ 第三方 App 读不到别人的触摸事件。
 *
 * 为什么单独写一个脚本而不是写进 package.json 的 build：
 *   本机（开发机）没有 Android SDK / NDK / Gradle，这个步骤跑不起来。
 *   所以它必须是**可选的、独立的**，不能卡住主构建流程 ——
 *   否则谁 clone 下来 `npm run build` 都会失败。
 *
 * 这个脚本做的事很薄：找一个可用的 gradle，跑对应的 assemble 任务，
 * 把产物复制到位。真正的构建逻辑都在 android/ 里。
 */
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const androidDir = join(root, 'android');
// 🔴 刻意放 bin/ 根下、**不建子目录**：应用内增量更新不会新建目录，
//    老版本（v1.0.28 及以前）的更新助手连 mkdir 都没有，放在新的子目录里
//    会让「1.0.28 → 新版」这一步永远装不上。详见 electron/services/weaknet-vpn.ts。
const outDir = join(root, 'bin');
const outApk = join(outDir, 'weaknet-vpn.apk');

const APK_REL = join('app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const RECORDER_APK_REL = join('recorder', 'build', 'outputs', 'apk', 'release', 'recorder-release.apk');

/** `--probe` = 构建测试探针，而不是随包的弱网 App */
const isProbe = process.argv.includes('--probe');
/** `--recorder` = 构建屏幕录制采集端（自动连点器配套） */
const isRecorder = process.argv.includes('--recorder');

if (isProbe && isRecorder) {
  console.error('x --probe 与 --recorder 不能同时用');
  process.exit(1);
}

/**
 * 仓库外的本地工具链（可选）。
 *
 * 开发机上原本没有 JDK 17 / Gradle / Android SDK，工具链被装在仓库外一处固定目录，
 * 既不进 git 也不污染系统 PATH。这里探测它并拼出环境变量，这样在没配过 PATH 的开发机上
 * 也能一句 `npm run build:weaknet-apk` 直接构建。
 *
 * 🔴 路径**必须纯 ASCII**：AGP 会因为项目路径含中文而拒绝（可用
 * `-Pandroid.overridePathCheck=true` 绕过），但 aapt2 拿到非 ASCII 的 SDK 路径时
 * 会按非 UTF-8 处理，报「找不到 android.jar」且无法绕过。
 * 所以这里刻意放在工作区**外面**（`D:\WorkSpace\android-toolchain`），
 * 而不是 `D:\WorkSpace\手机助手\.toolchain` —— 后者曾经让构建卡在 aapt2。
 *
 * 探测不到就退回原逻辑（用 PATH 里的 gradle），行为跟以前完全一致。
 */
const LOCAL_TC = process.env.WEAKNET_TOOLCHAIN || 'D:\\WorkSpace\\android-toolchain';

function localToolchain() {
  if (!existsSync(LOCAL_TC)) return null;
  const pick = (re, must) => {
    let names = [];
    try { names = readdirSync(LOCAL_TC); } catch { return null; }
    const hit = names.find((n) => re.test(n));
    if (!hit) return null;
    const p = join(LOCAL_TC, hit);
    return !must || existsSync(join(p, must)) ? p : null;
  };
  const jdk = pick(/^jdk-1[78]/i, 'bin');
  const sdk = existsSync(join(LOCAL_TC, 'android-sdk')) ? join(LOCAL_TC, 'android-sdk') : null;
  const gradle = pick(/^gradle-/i, 'bin');
  if (!jdk || !sdk) return null;
  return { jdk, sdk, gradle, home: join(LOCAL_TC, 'gradle-home') };
}

const tc = localToolchain();
let useEnv = process.env;
if (tc) {
  console.log(`使用仓库外的本地工具链：${LOCAL_TC}`);
  console.log(`  JDK   ${tc.jdk}`);
  console.log(`  SDK   ${tc.sdk}`);
  if (tc.gradle) console.log(`  Gradle ${tc.gradle}`);
  useEnv = {
    ...process.env,
    JAVA_HOME: tc.jdk,
    ANDROID_HOME: tc.sdk,
    ANDROID_SDK_ROOT: tc.sdk,
    GRADLE_USER_HOME: tc.home,
    PATH: [
      tc.gradle ? join(tc.gradle, 'bin') : '',
      join(tc.jdk, 'bin'),
      join(tc.sdk, 'platform-tools'),
      join(tc.sdk, 'cmdline-tools', 'latest', 'bin'),
      process.env.PATH || '',
    ]
      .filter(Boolean)
      .join(delimiter),
  };
}

function fail(msg, hint) {
  console.error(`\nx  ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

/**
 * 打印「可手动执行」的构建命令。
 *
 * 存在的意义：环境不允许创建子进程时（见 main 里的 EBUSY 分支），
 * 脚本没法自己跑，但用户完全可以照着这行在终端里跑通。
 * 命令用的是本地工具链的绝对路径，所以不依赖 PATH 配置。
 */
function manualCmd() {
  const task = isProbe ? ':probe:assembleDebug'
    : isRecorder ? ':recorder:assembleRelease'
    : ':app:assembleRelease';
  const g = tc?.gradle
    ? join(tc.gradle, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
    : 'gradle';
  const envPrefix = tc
    ? `JAVA_HOME=${tc.jdk} ANDROID_HOME=${tc.sdk} ANDROID_SDK_ROOT=${tc.sdk} GRADLE_USER_HOME=${tc.home} `
    : '';
  return `  cd android && ${envPrefix}"${g}" ${task} -Pandroid.overridePathCheck=true`;
}

function main() {
  if (!existsSync(androidDir)) fail('找不到 android/ 目录');

  // 选 gradle：仓库里**没有** wrapper（拿不到完整的 gradle-wrapper.jar，
  // 见 android/README.md），所以直接用 PATH 里的 gradle。
  // 如果以后有人补上了 wrapper，这里会自动优先用它。
  const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const useWrapper = existsSync(gradlew);

  /** 实际要执行的 gradle 命令（wrapper 或找到的 gradle 可执行文件） */
  let gradleExe = gradlew;

  if (useWrapper) {
    console.log(`使用 gradle wrapper：${gradlew}`);
  } else {
    /*
     * Windows 上必须点名 `gradle.bat`，而且**不能走 shell:true**：
     *
     *   · Node 的 spawnSync(shell:true) 会拉起 cmd.exe，而在部分受限环境
     *     （含本项目的开发机）里这直接抛 `spawnSync cmd.exe EBUSY`，
     *     被上层误读成「PATH 里没有可用的 gradle」。
     *   · gradle 8 的 bin/ 同时放了 `gradle`（POSIX shell 脚本）和 `gradle.bat`，
     *     不点名扩展名时命中的可能是在 cmd 下跑不了的那个。
     *
     * 所以：优先用**本地工具链里的绝对路径**并直接 spawn（不带 shell），
     * 探测不到才退回 PATH（此时才需要 shell 去找可执行文件）。
     */
    const explicit = tc?.gradle
      ? join(tc.gradle, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
      : null;
    const hasExplicit = !!(explicit && existsSync(explicit));

    const probe = hasExplicit
      ? spawnSync(explicit, ['--version'], { encoding: 'utf8', env: useEnv })
      : spawnSync('gradle', ['--version'], { shell: true, encoding: 'utf8', env: useEnv });

    /*
     * 区分「找不到 gradle」与「环境不允许创建子进程」。
     *
     * 后者（EBUSY / EINVAL / EPERM）是**运行环境**的限制 ——
     * 某些受限沙箱会拦截所有进程创建，此时不是 gradle 的问题，
     * 拿「请安装 gradle」去糊弄人会让人白折腾半天（本脚本以前就是这么干的）。
     * 这种情形直接打印可手动执行的命令，让人能贴到终端里跑。
     */
    if (probe.error && ['EBUSY', 'EINVAL', 'EPERM', 'EACCES'].includes(probe.error.code)) {
      fail(
        `当前环境不允许创建子进程（${probe.error.code}），无法在这里跑构建`,
        '这是环境限制，不是 gradle 缺失。请手动执行下面的命令：\n' +
          manualCmd(),
      );
    }
    if (probe.status !== 0) {
      fail(
        '找不到可用的 gradle',
        '请安装 gradle 8.x 并确保在 PATH 中；或在 android/ 里执行 `gradle wrapper --gradle-version 8.7` 生成 wrapper',
      );
    }
    const ver = (probe.stdout || '').match(/Gradle\s+([\d.]+)/);
    console.log(`使用 gradle${ver ? ' ' + ver[1] : ''}${hasExplicit ? `（本地工具链：${explicit}）` : ''}`);
    gradleExe = hasExplicit ? explicit : 'gradle';
  }

  console.log('开始构建（首次会下载依赖，可能要几分钟）...\n');
  // 🔴 `-Pandroid.overridePathCheck=true` 是**必需**的：本项目工作区路径含中文
  // （`D:\WorkSpace\手机助手\...`），AGP 默认会直接拒绝构建。
  // 敢 override 的原因：真正会被非 ASCII 路径搞坏的是 aapt2 对 **SDK 路径**的处理，
  // 而 SDK 已经放在纯 ASCII 的 `D:\WorkSpace\android-toolchain`（见 LOCAL_TC 注释）。
  //
  // 注意这里点名 `:app:` / `:probe:` / `:recorder:` —— 不带前缀会构建所有模块，
  // 出随包 APK 时没必要把测试探针也编一遍。
  const task = isProbe ? ':probe:assembleDebug'
    : isRecorder ? ':recorder:assembleRelease'
    : ':app:assembleRelease';
  const args = [
    task,
    '-Pandroid.overridePathCheck=true',
  ];
  // 同 probe：有显式路径就直接 spawn，不走 shell（避免 cmd.exe EBUSY）
  const useExplicit = !useWrapper && gradleExe !== 'gradle';
  const spawnOpts = { cwd: androidDir, stdio: 'inherit', env: useEnv };
  const res = useWrapper
    ? spawnSync(gradlew, args, { ...spawnOpts, shell: true })
    : useExplicit
      ? spawnSync(gradleExe, args, spawnOpts)
      : spawnSync('gradle', args, { ...spawnOpts, shell: true });

  if (res.error && ['EBUSY', 'EINVAL', 'EPERM', 'EACCES'].includes(res.error.code)) {
    fail(
      `当前环境不允许创建子进程（${res.error.code}），构建没有执行`,
      '请手动执行：\n' + manualCmd(),
    );
  }
  if (res.status !== 0) {
    fail(
      `gradle 构建失败（退出码 ${res.status}）`,
      '常见原因：没装 JDK 17 / 没配 Android SDK（可写 android/local.properties 指定 sdk.dir）',
    );
  }

  if (isProbe) {
    const builtProbe = join(androidDir, 'probe', 'build', 'outputs', 'apk', 'debug', 'probe-debug.apk');
    if (!existsSync(builtProbe)) fail(`构建成功但找不到探针产物：${builtProbe}`);
    const dstDir = join(root, 'e2e-tmp');
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, 'traffic-probe.apk');
    copyFileSync(builtProbe, dst);
    console.log(`\nOK  ${dst}  (${(statSync(dst).size / 1024).toFixed(0)} KB)`);
    console.log('\n安装：adb install -r -t e2e-tmp/traffic-probe.apk');
    console.log('跑一次：');
    console.log('  adb shell am start -n com.xiaoyang.trafficprobe/.ProbeActivity' +
      ' --es url "http://www.baidu.com/" --ei maxMs 30000 --ei maxBytes 200000 --es tag lat1');
    console.log('  adb shell "logcat -d -t 3000 | grep PROBE"');
    return;
  }

  if (isRecorder) {
    const built = join(androidDir, RECORDER_APK_REL);
    if (!existsSync(built)) {
      fail(`构建成功但找不到产物：${built}`);
    }
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const dst = join(outDir, 'screen-recorder.apk');
    copyFileSync(built, dst);
    const kb = (statSync(dst).size / 1024).toFixed(0);
    console.log(`\nOK  ${dst}  (${kb} KB)`);
    console.log('\n安装：adb install -r bin/screen-recorder.apk');
    console.log('启动：adb shell am start -n com.xiaoyang.screenrecorder/.RecorderActivity');
    console.log('电脑端会通过 adb forward tcp:18081 连它的控制端口。');
    return;
  }

  const builtApk = join(androidDir, APK_REL);
  if (!existsSync(builtApk)) {
    fail(`构建成功但找不到产物：${builtApk}`);
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  copyFileSync(builtApk, outApk);

  const mb = (statSync(outApk).size / 1024 / 1024).toFixed(2);
  console.log(`\nOK  ${outApk}  (${mb} MB)`);
  console.log('\n下一步：确认 bin/weaknet-vpn.apk 已随发布包一起分发，');
  console.log('主程序启动弱网时会自动把它装到设备上。');
}

main();
