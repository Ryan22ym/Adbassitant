/**
 * 构建弱网配套 App 的 APK，并放到随包位置 bin/weaknet/weaknet-vpn.apk
 *
 * 用法：node scripts/build-weaknet-apk.mjs
 *
 * 为什么单独写一个脚本而不是写进 package.json 的 build：
 *   本机（开发机）没有 Android SDK / NDK / Gradle，这个步骤跑不起来。
 *   所以它必须是**可选的、独立的**，不能卡住主构建流程 ——
 *   否则谁 clone 下来 `npm run build` 都会失败。
 *
 * 这个脚本做的事很薄：找一个可用的 gradle，跑 assembleRelease，
 * 把产物复制到位。真正的构建逻辑都在 android/ 里。
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const androidDir = join(root, 'android');
const outDir = join(root, 'bin', 'weaknet');
const outApk = join(outDir, 'weaknet-vpn.apk');

const APK_REL = join('app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

function fail(msg, hint) {
  console.error(`\nx  ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
}

function main() {
  if (!existsSync(androidDir)) fail('找不到 android/ 目录');

  // 选 gradle：仓库里**没有** wrapper（拿不到完整的 gradle-wrapper.jar，
  // 见 android/README.md），所以直接用 PATH 里的 gradle。
  // 如果以后有人补上了 wrapper，这里会自动优先用它。
  const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const useWrapper = existsSync(gradlew);

  if (useWrapper) {
    console.log(`使用 gradle wrapper：${gradlew}`);
  } else {
    const probe = spawnSync('gradle', ['--version'], { shell: true, encoding: 'utf8' });
    if (probe.status !== 0) {
      fail(
        'PATH 里没有可用的 gradle',
        '请安装 gradle 8.x 并确保在 PATH 中；或在 android/ 里执行 `gradle wrapper --gradle-version 8.7` 生成 wrapper',
      );
    }
    const ver = (probe.stdout || '').match(/Gradle\s+([\d.]+)/);
    console.log(`使用 PATH 中的 gradle${ver ? ' ' + ver[1] : ''}`);
  }

  console.log('开始构建（首次会下载依赖，可能要几分钟）...\n');
  const args = ['assembleRelease'];
  const res = useWrapper
    ? spawnSync(gradlew, args, { cwd: androidDir, stdio: 'inherit', shell: true })
    : spawnSync('gradle', args, { cwd: androidDir, stdio: 'inherit', shell: true });

  if (res.status !== 0) {
    fail(
      `gradle 构建失败（退出码 ${res.status}）`,
      '常见原因：没装 JDK 17 / 没配 Android SDK（可写 android/local.properties 指定 sdk.dir）',
    );
  }

  const builtApk = join(androidDir, APK_REL);
  if (!existsSync(builtApk)) {
    fail(`构建成功但找不到产物：${builtApk}`);
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  copyFileSync(builtApk, outApk);

  const mb = (statSync(outApk).size / 1024 / 1024).toFixed(2);
  console.log(`\nOK  ${outApk}  (${mb} MB)`);
  console.log('\n下一步：确认 bin/weaknet/ 已随发布包一起分发，');
  console.log('主程序启动弱网时会自动把它装到设备上。');
}

main();
