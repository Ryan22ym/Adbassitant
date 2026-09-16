/**
 * 探针 6：严格验证 `cmd /c start "" /b` 拉起的进程能长活（真助手要跑 60s 量级）。
 *
 * 宿主 spawn 后 800ms 就 app.exit(0)；payload 每 2 秒写一个 tick，共写 10 个（约 20 秒）。
 * 判据：tick 文件数量 + 最后一个 tick 是否远晚于「宿主退出时刻」。
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(os.tmpdir(), '_escapefix4');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const SYS = process.env.SystemRoot || 'C:\\Windows';
const PS = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const LOG = path.join(DIR, '_probe.log');
const say = (s) => fs.appendFileSync(LOG, s + '\n');

// payload：每 2 秒一个 tick，共 10 个
const payload = path.join(DIR, 'payload.ps1');
fs.writeFileSync(
  payload,
  `for ($i = 1; $i -le 10; $i++) {\r\n` +
    `  [System.IO.File]::WriteAllText('${DIR}\\tick-' + $i + '.txt', 'tick ' + $i + ' ' + (Get-Date -Format 'HH:mm:ss'))\r\n` +
    `  Start-Sleep -Seconds 2\r\n}\r\n` +
    `[System.IO.File]::WriteAllText('${DIR}\\payload-done.txt', 'done ' + (Get-Date -Format 'HH:mm:ss'))\r\n`,
  'utf8',
);

app.whenReady().then(() => {
  const c = spawn(
    path.join(SYS, 'System32', 'cmd.exe'),
    ['/c', 'start', '', '/b', PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', payload],
    { stdio: 'ignore', cwd: os.tmpdir() },
  );
  c.unref();
  say(`spawn cmd pid=${c.pid} at ${new Date().toISOString()}`);
  setTimeout(() => {
    say(`main exit at ${new Date().toISOString()}`);
    app.exit(0);
  }, 800);
});
