/**
 * v1.0 冒烟验证：
 * 1. 主进程能加载新增 service（弱网 / logcat）
 * 2. IPC 通道常量与 preload 副本一致
 * 3. 新增 handler 全部注册成功
 *
 * 注意：直接在 Node 下运行（不要用 electron 作为运行时）——本脚本只做
 * 静态产物检查，不需要 Electron 运行时。用 electron 跑反而会因为
 * 主进程入口冲突导致 `require('electron')` 拿到的是路径字符串。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, detail: r || 'ok' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

function main() {
  const electronDir = path.join(ROOT, 'dist-electron', 'electron');

  check('shared/types 编译产物存在', () => {
    const t = require(path.join(ROOT, 'dist-electron', 'shared', 'types.js'));
    return `IPC 通道数 ${Object.keys(t.IPC).length}`;
  });

  check('weaknet service 可加载', () => {
    const w = require(path.join(electronDir, 'services', 'weaknet.js'));
    const fns = [
      'startWeakNet', 'stopWeakNet', 'getWeakNetStatus',
      'listPresets', 'savePreset', 'deletePreset', 'probeDevice',
      'setWeakNetStatusSink',
    ];
    const missing = fns.filter((f) => typeof w[f] !== 'function');
    if (missing.length) throw new Error('缺函数: ' + missing.join(','));
    const presets = w.listPresets();
    return `${fns.length} 个导出正常，内置预设 ${presets.filter(p => p.builtin).length} 个`;
  });

  check('logcat service 可加载', () => {
    const l = require(path.join(electronDir, 'services', 'logcat.js'));
    const fns = [
      'startLogcat', 'stopLogcat', 'getLogcatStatus',
      'clearLogcatBuffer', 'saveLogcat', 'listProcesses',
      'setLogcatLinesSink', 'setLogcatStatusSink',
    ];
    const missing = fns.filter((f) => typeof l[f] !== 'function');
    if (missing.length) throw new Error('缺函数: ' + missing.join(','));
    return `${fns.length} 个导出正常`;
  });

  check('files service 新增应用管理函数', () => {
    const f = require(path.join(electronDir, 'services', 'files.js'));
    const fns = [
      'listAppsDetailed', 'getAppDetail', 'uninstallApp',
      'forceStopApp', 'clearAppData', 'launchApp', 'setAppEnabled', 'extractApk',
    ];
    const missing = fns.filter((x) => typeof f[x] !== 'function');
    if (missing.length) throw new Error('缺函数: ' + missing.join(','));
    return `${fns.length} 个导出正常`;
  });

  check('preload 与 shared IPC 通道一致', () => {
    const fs = require('fs');
    const pre = fs.readFileSync(path.join(electronDir, 'preload.js'), 'utf8');
    const t = require(path.join(ROOT, 'dist-electron', 'shared', 'types.js'));
    const missing = [];
    for (const [k, v] of Object.entries(t.IPC)) {
      if (!pre.includes(`'${v}'`) && !pre.includes(`"${v}"`)) missing.push(k);
    }
    if (missing.length) throw new Error('preload 缺少通道: ' + missing.join(', '));
    return `${Object.keys(t.IPC).length} 个通道全部同步`;
  });

  check('ipc.ts 注册了全部新增 handler', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(electronDir, 'ipc.js'), 'utf8');
    const t = require(path.join(ROOT, 'dist-electron', 'shared', 'types.js'));
    // 编译后 handler 用的是 IPC.XXX 符号引用，因此检查 IPC 常量名
    const need = [
      'APP_DETAIL', 'APP_UNINSTALL', 'APP_FORCE_STOP', 'APP_CLEAR_DATA',
      'APP_LAUNCH', 'APP_EXTRACT_APK', 'APP_SET_ENABLED',
      'LOGCAT_START', 'LOGCAT_STOP', 'LOGCAT_STATUS', 'LOGCAT_CLEAR',
      'LOGCAT_SAVE', 'LOGCAT_PROCESSES',
      'WEAKNET_START', 'WEAKNET_STOP', 'WEAKNET_STATUS',
      'WEAKNET_PRESET_LIST', 'WEAKNET_PRESET_SAVE', 'WEAKNET_PRESET_DELETE',
      'WEAKNET_PROBE',
    ];
    const missing = need.filter((k) => !t.IPC[k] || !src.includes(`IPC.${k}`));
    if (missing.length) throw new Error('未注册: ' + missing.join(', '));
    return `${need.length} 个 handler 全部注册`;
  });

  check('渲染层产物包含新页面', () => {
    const fs = require('fs');
    const dir = path.join(ROOT, 'dist', 'assets');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    if (files.length === 0) throw new Error('dist/assets 无 js');
    const js = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const needles = ['弱网模拟', '实时 Logcat', '应用管理', '抖动延迟', '错报率'];
    const missing = needles.filter((n) => !js.includes(n));
    if (missing.length) throw new Error('产物缺少文案: ' + missing.join(', '));
    return `${js.length} 字节，关键字全部命中`;
  });

  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('\n===== v1.0 SMOKE =====');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ::  ${r.detail}`);
  }
  console.log(`\n${pass}/${total} 通过\n`);

  process.exit(pass === total ? 0 : 1);
}

main();
