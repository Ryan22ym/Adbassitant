/**
 * 子进程捕获输出的兜底实现（避免这个环境下的 EBUSY）。
 *
 * 🔴 不要用 `execFileSync` / `spawnSync` 的默认 `stdio: 'pipe'`。
 *
 * WorkBuddy 宿主里跑的 node 创建子进程**管道**会直接失败：
 *   spawnSync D:\...\bin\adb.exe EBUSY
 * 症状极具误导性 —— 命令自己手跑完全正常，但在脚本里一律 EBUSY，
 * 而且 stdout / stderr 都是空的，看起来像「工具坏了」。
 *
 * 走已经打开的**文件描述符**（不新建管道）就没有这个问题，
 * 普通环境与受限环境行为一致。
 *
 * 用法：
 *   const { runCapture, execCapture } = require('./_spawn-capture.cjs');
 *   const out = execCapture(ADB, ['devices']);          // 等价 execFileSync（失败抛错）
 *   const r = runCapture(ADB, ['devices']);             // 不抛错，自己看 status/output
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** 起进程并把 stdout+stderr 收进临时文件，返回 { status, error, output } */
function runCapture(exe, args, opts = {}) {
  const safe = path.basename(exe).replace(/[^\w.-]/g, '_');
  const logFile = path.join(os.tmpdir(), `capture-${safe}-${process.pid}.log`);
  const fd = fs.openSync(logFile, 'w');
  let r;
  try {
    // encoding 由我们统一处理（读回来就是字符串），不要传给 spawnSync 免得它去建管道
    const { encoding: _ignored, ...rest } = opts;
    r = spawnSync(exe, args, { ...rest, stdio: ['ignore', fd, fd] });
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  let output = '';
  try { output = fs.readFileSync(logFile, 'utf8'); } catch { /* ignore */ }
  return { status: r.status, error: r.error, output };
}

/** execFileSync 的替代：成功返回输出，失败抛错（错误里带真实输出，别让人瞎猜） */
function execCapture(exe, args, opts = {}) {
  const r = runCapture(exe, args, opts);
  if (r.error) {
    throw new Error(`无法启动 ${path.basename(exe)}：${r.error.code || r.error.message}（${exe}）`);
  }
  if (r.status !== 0) {
    const e = new Error(`命令失败（退出码 ${r.status}）：${String(r.output).trim() || '(无输出)'}`);
    e.status = r.status;
    e.stdout = r.output;
    e.stderr = r.output;
    throw e;
  }
  return r.output;
}

module.exports = { runCapture, execCapture };
