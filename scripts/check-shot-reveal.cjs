/*
 * 截图 / 录屏完成后「打开文件夹并选中文件」的验证脚本（v1.1.19）。
 *
 * 判据不是「有没有弹资源管理器」，而是**资源管理器里选中的就是刚存下的那个文件** ——
 * 用 Shell.Application 的 Document.FocusedItem.Path 读真实选中项，和截图返回的
 * localPath 逐字比对。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/check-shot-reveal.cjs --watch ui-shots/_shot-reveal.log --until "SHOT REVEAL DONE" --timeout 240
 *
 * ⚠️ 会真的弹出资源管理器窗口（这正是要验证的东西），验证完把它关掉。
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  console.error('must run under electron');
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_shot-reveal.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

let pass = 0;
let fail = 0;
function record(ok, name, detail) {
  if (ok) pass++;
  else fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail || ''}`);
}

/** 用 Shell.Application 找出「选中项路径」等于 target 的资源管理器窗口，并把它们关掉 */
function focusedItems(targetPath) {
  const target = targetPath.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
$hit = @()
foreach ($w in $sh.Windows()) {
  try {
    $item = $w.Document.FocusedItem
    if ($item -ne $null -and $item.Path -eq '${target}') {
      $hit += $item.Path
      # 验证完把这次弹出来的窗口关掉（只关选中项是本次文件的那些）
      $w.Quit()
    }
  } catch { }
}
$hit -join "\`n"
`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve({ ok: !err, out: (stdout || '').trim(), err: err && err.message }),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { registerIpc } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await sleep(1500);

  const devices = await win.webContents.executeJavaScript(
    `window.adbApi.listDevices().then(r => (r.ok ? r.data : []))`,
  );
  const serial = (devices || []).find((d) => d.state === 'device')?.serial;
  log('设备:', serial || '(无)');

  if (!serial) {
    record(false, 'S0 有就绪设备', '无设备');
  } else {
    /* ---------------- 截图 ---------------- */
    const shot = await win.webContents.executeJavaScript(
      `window.adbApi.captureScreenshot(${JSON.stringify(serial)}).then(r => r)`,
    );
    const shotPath = shot && shot.ok && shot.data ? shot.data.localPath : null;
    log('截图结果:', JSON.stringify(shot));
    record(!!shotPath && fs.existsSync(shotPath), 'S1 截图落盘成功', shotPath || JSON.stringify(shot));

    await sleep(2000);
    const hitShot = await focusedItems(shotPath || '');
    record(
      !!shotPath && hitShot.out === shotPath,
      'S2 截图后资源管理器自动打开并选中该文件',
      `focused=${JSON.stringify(hitShot.out)} ${hitShot.err || ''}`,
    );

    /* ---------------- 录屏（5 秒，最短） ---------------- */
    const rec = await win.webContents.executeJavaScript(
      `window.adbApi.startRecord(${JSON.stringify(serial)}, 5, 4, undefined, false).then(r => r)`,
    );
    record(rec && rec.ok && rec.data && !!rec.data.id, 'S3 开始录屏（5 秒）', JSON.stringify(rec && rec.data));
    // 等满时长再停，让设备端 screenrecord 自己收尾
    await sleep(8000);
    const stop = await win.webContents.executeJavaScript(
      `window.adbApi.stopRecord(${JSON.stringify(rec && rec.data && rec.data.id)}).then(r => r)`,
    );
    const recPath = stop && stop.ok && stop.data ? stop.data.localPath : null;
    record(!!recPath && fs.existsSync(recPath), 'S4 录屏文件已拉回本机', recPath || JSON.stringify(stop));

    await sleep(2000);
    const hitRec = await focusedItems(recPath || '');
    record(
      !!recPath && hitRec.out === recPath,
      'S5 录屏结束后资源管理器自动打开并选中该文件',
      `focused=${JSON.stringify(hitRec.out)} ${hitRec.err || ''}`,
    );
  }

  log(`合计 ${pass} 通过 / ${fail} 失败`);
  log('SHOT REVEAL DONE');
  setTimeout(() => app.exit(fail ? 1 : 0), 300);
}).catch((e) => {
  // 未捕获异常必须留痕并退出：否则 run-electron 只能等兜底超时，看起来像「卡死」
  log('CRASH:', (e && e.stack) || String(e));
  log('SHOT REVEAL DONE');
  setTimeout(() => app.exit(1), 300);
});
