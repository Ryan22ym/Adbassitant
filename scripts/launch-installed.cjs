/**
 * 启动「已安装」的 ADB 桌面助手（v1.1.12）。
 *
 * 🔴 为什么需要这个脚本，而不是直接双击 exe？
 *
 * WorkBuddy 宿主会往环境里注入两个变量：
 *   ELECTRON_RUN_AS_NODE=1
 *   NODE_OPTIONS=--require=".../node-language-shim.cjs"
 *
 * 前者会让 Electron **退化成纯 Node**：`require('electron')` 返回一个路径字符串，
 * 主进程第一句 `app.requestSingleInstanceLock()` 就抛异常，而此时
 * uncaughtException 处理器还没注册 —— 表现是**进程秒退、退出码 0、一个字都不写**，
 * 看起来像「装坏了 / 被杀软拦了」，其实是环境变量在作祟。
 *
 * 从「开始菜单 / 桌面快捷方式 / explorer 双击」启动时没有这两个变量，
 * 所以那条路一直是好的 —— 只有从 WorkBuddy 的 shell 里拉起来才会中招。
 *
 * 用法：node scripts/launch-installed.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'ADBAssistant',
  'ADB桌面助手.exe',
);

if (!fs.existsSync(EXE)) {
  console.error('未找到安装版：' + EXE);
  console.error('先跑 python scripts/install-local.py --version <ver> --out out-v<ver>-local');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(EXE, [], { env, detached: true, stdio: 'ignore' });
child.unref();
console.log('已启动：' + EXE + '（pid ' + child.pid + '，已剥离 ELECTRON_RUN_AS_NODE）');
