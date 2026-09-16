/**
 * 探针 5：在真实 Electron 里测三种「间接拉起」方式能否活过 app.exit(0)。
 *
 *   X1  explorer.exe 打开 bootstrap.cmd（→ 由已运行的 shell 代为执行，天然在作业外）
 *   X2  cmd.exe /c start "" /b <ps> -File payload.ps1     （无新窗口）
 *   X3  cmd.exe /c start "" /min <ps> -File payload.ps1   （最小化新窗口）
 *   X4  spawn(ps, ['-File', payload], {stdio:'ignore'})   （对照：直连，应被连坐）
 *
 * 每个 payload 都是：写 <M>-start → 睡 6s → 写 <M>-done。
 * 宿主等到所有 -start 出现（或 20s 超时）后立刻退出；随后由外部收集 -done。
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(os.tmpdir(), '_escapefix3');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const SYS = process.env.SystemRoot || 'C:\\Windows';
const PS = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CMD = path.join(SYS, 'System32', 'cmd.exe');
const EXPLORER = path.join(SYS, 'explorer.exe');
const LOG = path.join(DIR, '_probe.log');
const say = (s) => fs.appendFileSync(LOG, s + '\n');

const TAGS = ['X1', 'X2', 'X3', 'X4'];

for (const t of TAGS) {
  const hit = (phase) => path.join(DIR, `${t}-${phase}.txt`);
  fs.writeFileSync(
    path.join(DIR, `${t}.ps1`),
    `[System.IO.File]::WriteAllText('${hit('start')}', '${t} start ' + (Get-Date -Format 'HH:mm:ss'))\r\n` +
      `Start-Sleep -Seconds 6\r\n` +
      `[System.IO.File]::WriteAllText('${hit('done')}', '${t} done ' + (Get-Date -Format 'HH:mm:ss'))\r\n`,
    'utf8',
  );
}
const psFile = (t) => path.join(DIR, `${t}.ps1`);
const psArgs = (t) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile(t)];

app.whenReady().then(() => {
  // X1：bootstrap.cmd 交给 explorer
  const boot = path.join(DIR, 'bootX1.cmd');
  fs.writeFileSync(boot, `@echo off\r\n"${PS}" ${psArgs('X1').join(' ')}\r\n`, 'ascii');
  try {
    const c = spawn(EXPLORER, [boot], { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    c.unref();
    say(`X1 spawn explorer pid=${c.pid}`);
  } catch (e) {
    say(`X1 threw ${e.message}`);
  }

  // X2 / X3 / X4
  try {
    const c = spawn(CMD, ['/c', 'start', '', '/b', PS, ...psArgs('X2')], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir(),
    });
    c.unref();
    say(`X2 spawn cmd pid=${c.pid}`);
  } catch (e) {
    say(`X2 threw ${e.message}`);
  }
  try {
    const c = spawn(CMD, ['/c', 'start', '', '/min', PS, ...psArgs('X3')], {
      stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir(),
    });
    c.unref();
    say(`X3 spawn cmd pid=${c.pid}`);
  } catch (e) {
    say(`X3 threw ${e.message}`);
  }
  try {
    const c = spawn(PS, psArgs('X4'), { stdio: 'ignore', cwd: os.tmpdir() });
    c.unref();
    say(`X4 spawn ps pid=${c.pid}`);
  } catch (e) {
    say(`X4 threw ${e.message}`);
  }

  const t0 = Date.now();
  const timer = setInterval(() => {
    const started = TAGS.filter((t) => fs.existsSync(path.join(DIR, `${t}-start.txt`)));
    if (started.length === TAGS.length || Date.now() - t0 > 20000) {
      clearInterval(timer);
      say(`started=[${started.join(',')}] after ${((Date.now() - t0) / 1000).toFixed(1)}s -> main exit`);
      setTimeout(() => app.exit(0), 500);
    }
  }, 200);
});
