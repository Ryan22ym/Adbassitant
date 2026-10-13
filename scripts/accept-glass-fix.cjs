/**
 * 对**已安装版**（%LOCALAPPDATA%\Programs\ADBAssistant\resources\app.asar）
 * 做验收（2026-10-14 起圆角改方角模式）。
 *
 * 为什么必须测安装版而不是构建目录：
 *   真实用户跑的是 asar 里的代码 + preload + 主进程；
 *   构建目录测通了、asar 里没进去（或少打一个文件）是发生过的坑。
 *
 * 三件事：
 *   ① 圆角：**方角模式**（2026-10-14 小杨决定不要圆角）—— syncGlassCorners
 *      之后 GetWindowRgn 必须为 0（无区域），且 resize/连拽后依然无残留；
 *   ② 标题栏：.titlebar 与 .main 的 computed 底色是否一致（不再深黑）；
 *   ③ 交通灯：.window-lights 三个点是否在、可见、颜色对不对、位置是否在窗口内。
 *
 * 用法：
 *   python scripts/run-electron.py scripts/accept-glass-fix.cjs \
 *     --watch ui-shots/_agf.log --until "AGF DONE" --timeout 200
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, '_agf.log');
function log(s) {
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

/** 已安装的 asar 路径 */
const ASAR = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'ADBAssistant',
  'resources',
  'app.asar',
);

function ps(code) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', code],
      { windowsHide: true, timeout: 15000, encoding: 'utf8' },
      (err, stdout) => resolve(err ? 'ERR:' + err.message : String(stdout).trim()),
    );
  });
}
/*
 * 读窗口的圆角区域信息。
 *
 * 🔴 本轮新增 `rgnBox` / `winRect` / `dpi` 三个指标：
 *    只断言 "regionType != 0" 是**不够**的 —— 2026-10-13 小杨第二次反馈
 *    「下边两个角还是没处理」时，regionType 一直是 3（设置的），
 *    但 region 的**尺寸不对**（用了逻辑像素而不是物理像素）：
 *      · rgnBox 960x640  vs  winRect 960x640  → 看起来相等，实则都被 DPI 虚拟化
 *      · 真实的物理窗口是 1200x800
 *    ⇒ 判据必须落在「**物理** rgnBox == **物理** winRect」上：
 *      两者在同一个 PS 进程里读，都被同样虚拟化，所以「相等」是可靠的判据；
 *      同时打印 dpi，便于人工复核（本机应为 120）。
 */
function regionInfo(hwnd) {
  return ps(`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WA {
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr r, out RB b);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RB b);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RB b);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RB { public int Left,Top,Right,Bottom; }
}
"@
$h=[IntPtr]::new([int64]${hwnd})
$r=[WA]::CreateRectRgn(0,0,1,1)
$t=[WA]::GetWindowRgn($h,$r)
$rb=New-Object WA+RB
[void][WA]::GetRgnBox($r,[ref]$rb)
$wr=New-Object WA+RB
[void][WA]::GetWindowRect($h,[ref]$wr)
$cr=New-Object WA+RB
[void][WA]::GetClientRect($h,[ref]$cr)
$dpi=[WA]::GetDpiForWindow($h)
Write-Output ('type={0} rgnBox={1}x{2} winRect={3}x{4} client={5}x{6} dpi={7}' -f $t,($rb.Right-$rb.Left),($rb.Bottom-$rb.Top),($wr.Right-$wr.Left),($wr.Bottom-$wr.Top),($cr.Right-$cr.Left),($cr.Bottom-$cr.Top),$dpi)
`);
}

function seedSettings() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    if (fs.existsSync(file)) cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(
    file,
    JSON.stringify({ ...cur, theme: 'glass', glassOpacity: 20, glassRoughness: 45 }, null, 2),
  );
}

const WALL = `<div id="__fake_desktop" style="position:fixed;inset:0;z-index:-1;background:
   radial-gradient(900px 600px at 12% 18%, #ffd166 0%, transparent 62%),
   radial-gradient(900px 700px at 88% 22%, #ef476f 0%, transparent 60%),
   radial-gradient(1000px 800px at 76% 88%, #118ab2 0%, transparent 62%),
   radial-gradient(900px 700px at 16% 86%, #06d6a0 0%, transparent 60%),
   linear-gradient(135deg,#1b2a4a 0%, #0f172b 55%, #241b3a 100%)"></div>`;

app.whenReady().then(async () => {
  if (!fs.existsSync(ASAR)) {
    log('AGF FAIL 找不到已安装的 asar: ' + ASAR);
    log('AGF DONE');
    app.exit(1);
    return;
  }
  log('  asar = ' + ASAR + '  bytes=' + fs.statSync(ASAR).size);

  seedSettings();

  // 从 asar 里加载已安装版的主进程 ipc + 渲染页
  const ipcPath = path.join(ASAR, 'dist-electron', 'electron', 'ipc.js');
  const preloadPath = path.join(ASAR, 'dist-electron', 'electron', 'preload.js');
  const indexPath = path.join(ASAR, 'dist', 'index.html');
  const { registerIpc } = require(ipcPath);
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    x: 100,
    y: 60,
    show: true,
    frame: false,
    backgroundColor: '#101319',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(indexPath);
  await wait(4500);

  await win.webContents.executeJavaScript(`(function(){
    var d=document.createElement('div');
    d.innerHTML=${JSON.stringify(WALL)};
    document.body.insertBefore(d.firstElementChild, document.body.firstChild);
    return document.getElementById('__fake_desktop') ? 'WALL SET' : 'WALL FAIL';
  })()`).then((r) => log('  ' + r));

  // 进设置页
  await win.webContents.executeJavaScript(`(function(){
    var el=document.querySelector('.nav-item[data-nav="settings"]')
      || [...document.querySelectorAll('.nav-item')].find(n=>/设置/.test(n.textContent));
    if(el) el.click();
    return !!el;})()`).then((r) => log('  settings clicked=' + r));
  await wait(1800);

  /* ---- ② 标题栏 vs 内容区 ---- */
  const bar = await win.webContents.executeJavaScript(`(function(){
    function pick(sel){var el=document.querySelector(sel);if(!el)return null;
      var cs=getComputedStyle(el);var r=el.getBoundingClientRect();
      return {bg:cs.backgroundColor,h:Math.round(r.height),top:Math.round(r.top)};}
    return JSON.stringify({titlebar:pick('.titlebar'),main:pick('.main'),
      appbody:pick('.app-body'),header:pick('.header')});})()`);
  log('BAR ' + bar);

  /* ---- ③ 交通灯 ---- */
  const lights = await win.webContents.executeJavaScript(`(function(){
    var wrap=document.querySelector('.window-lights');
    var out={wrapExists:!!wrap, vw:window.innerWidth, vh:window.innerHeight};
    if(wrap){
      var cs=getComputedStyle(wrap); var r=wrap.getBoundingClientRect();
      out.wrap={rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
                display:cs.display, position:cs.position, zIndex:cs.zIndex, opacity:cs.opacity,
                color:cs.color, pointerEvents:cs.pointerEvents};
      out.buttons=[...wrap.querySelectorAll('.window-light')].map(function(b){
        var bs=getComputedStyle(b); var br=b.getBoundingClientRect();
        return {cls:b.className, rect:[Math.round(br.left),Math.round(br.top),Math.round(br.width),Math.round(br.height)],
                color:bs.color, bg:bs.backgroundColor, opacity:bs.opacity, visibility:bs.visibility,
                display:bs.display,
                inView: br.right<=window.innerWidth && br.bottom<=window.innerHeight && br.left>=0};});
    }
    out.theme=document.documentElement.getAttribute('data-theme');
    return JSON.stringify(out);})()`);
  log('LIGHTS ' + lights);

  /* ---- ① 圆角（方角模式：主进程侧 win-corners 应**不设**区域） ---- */
  /*
   * ⚠️ 本脚本自己建窗，走不到 main.ts 的建窗流程，所以要**手动**触发一次
   *    安装版 asar 里的圆角逻辑 —— 这恰恰是我们要验的东西
   *    （asar 里到底有没有这个模块、能不能真的设上区域）。
   */
  const hwndBuf = win.getNativeWindowHandle();
  const hwnd =
    hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0).toString() : String(hwndBuf.readUInt32LE(0));
  log('  hwnd=' + hwnd + ' bounds=' + JSON.stringify(win.getBounds()));

  const WC = require(path.join(ASAR, 'dist-electron', 'electron', 'services', 'win-corners.js'));
  const before = await regionInfo(hwnd);
  WC.resetGlassCornerCache();
  WC.syncGlassCorners(win, true);
  await wait(3000);
  const after = await regionInfo(hwnd);
  log(`  CORNERS before: ${before}`);
  log(`  CORNERS after : ${after}`);

  /*
   * ---- ①b 「resize 之后不能留下残留区域」 ----
   * （方角模式下判据反转：曾经这里是「region 要跟着变大」的回归项，
   *  2026-10-14 改方角后变成「任何尺寸变化后都不得有 region」。）
   *
   * ⚠️ 本脚本自己建窗，**不走 main.ts 的事件接线**，所以这里必须
   *    「改尺寸 → 显式再调一次 syncGlassCorners」来模拟一次 resize 事件。
   */
  const oldB = win.getBounds();
  const bigB = { ...oldB, width: oldB.width + 240, height: oldB.height + 160 };
  win.setBounds(bigB);
  await wait(1200);
  /* 模拟 resize 事件（main.ts 里由 resize/resized 触发） */
  WC.syncGlassCorners(win, true);
  await wait(3000);
  const grown = await regionInfo(hwnd);
  log(`  GROWN bounds=${JSON.stringify(win.getBounds())} region: ${grown}`);

  win.setBounds(oldB);
  await wait(1200);
  WC.syncGlassCorners(win, true);
  await wait(2500);
  const shrunk = await regionInfo(hwnd);
  log(`  SHRUNK region: ${shrunk}`);

  /*
   * ---- ①c 「连续快速 resize 后依然无区域」 ----
   *      （方角模式：并发队列曾经是「边界卡住」的根因，现在验的是
   *       乱序完成后也不会莫名其妙落上一个 region。）
   */
  const b0 = win.getBounds();
  /* 一串快速变化的尺寸（模拟拖动边框），每次都立刻调一次 sync —— 不等 */
  const steps = [
    { width: b0.width + 60, height: b0.height + 30 },
    { width: b0.width + 180, height: b0.height + 90 },
    { width: b0.width + 90, height: b0.height + 150 },
    { width: b0.width + 300, height: b0.height + 200 },
  ];
  for (const st of steps) {
    win.setBounds({ ...b0, ...st });
    /* ⚠️ 不 wait：故意制造并发请求，这是本用例要验的东西 */
    WC.syncGlassCorners(win, true);
  }
  const finalB = { ...b0, width: b0.width + 420, height: b0.height + 260 };
  win.setBounds(finalB);
  WC.syncGlassCorners(win, true);
  /* 串行队列要跑完最后两轮：每轮 ~150ms，留足余量 */
  await wait(6000);
  const burst = await regionInfo(hwnd);
  log(`  BURST final=${finalB.width}x${finalB.height} region: ${burst}`);

  /* 回到初始尺寸，别把截图拍成拉大后的样子 */
  win.setBounds(b0);
  await wait(1000);
  WC.syncGlassCorners(win, true);
  await wait(2500);

  /* ---- 截图 ---- */
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'accept-glass-fix.png'), img.toPNG());
  log('AGF OK accept-glass-fix.png bytes=' + fs.statSync(path.join(OUT, 'accept-glass-fix.png')).size);

  /*
   * 判定（2026-10-14 起改为**方角模式**，小杨决定不要圆角）：
   *   ① 同步后 **region 必须为空**（type=0）—— 方角，窗口是完整矩形；
   *   ② resize 变大/还原/连拽之后**依然没有 region** —— 不能留下
   *      上个尺寸的残留区域（那会把窗口裁缺一块）。
   * ③ dpi 能读到（本机 120）
   */
  const parse = (s) => {
    const m = /type=(\d+) rgnBox=(\d+)x(\d+) winRect=(\d+)x(\d+) client=(\d+)x(\d+) dpi=(\d+)/.exec(s);
    if (!m) return null;
    const [, ty, rw, rh, ww, wh, cw, ch, dpi] = m.map(Number);
    return { ty, rw, rh, ww, wh, cw, ch, dpi };
  };
  const A = parse(after);
  const G = parse(grown);
  const S = parse(shrunk);
  const Bu = parse(burst);

  let ok = false;
  if (!A || !G || !S || !Bu) {
    log('AGF FAIL 解析 region 信息失败');
    log('  after=' + after);
    log('  grown=' + grown);
    log('  shrunk=' + shrunk);
    log('  burst=' + burst);
  } else {
    const square = A.ty === 0;
    const staysSquare = G.ty === 0 && S.ty === 0 && Bu.ty === 0;
    log(`  初始  type=${A.ty} rgn=${A.rw}x${A.rh} client=${A.cw}x${A.ch} win=${A.ww}x${A.wh}`);
    log(`  拉大  type=${G.ty} rgn=${G.rw}x${G.rh} client=${G.cw}x${G.ch} win=${G.ww}x${G.wh}`);
    log(`  还原  type=${S.ty} rgn=${S.rw}x${S.rh} client=${S.cw}x${S.ch} win=${S.ww}x${S.wh}`);
    log(`  连拽  type=${Bu.ty} rgn=${Bu.rw}x${Bu.rh} client=${Bu.cw}x${Bu.ch} win=${Bu.ww}x${Bu.wh}`);
    log(`  chek 同步后方角(无region) : ${square ? 'OK' : 'NO  ← 同步后仍带着区域，角会被裁'}`);
    log(`  chek resize后仍无region  : ${staysSquare ? 'OK' : 'NO  ← 尺寸变化后留下残留区域'}`);
    ok = square && staysSquare;
  }
  log(ok ? 'AGF PASS 方角模式：窗口未设任何圆角区域' : 'AGF FAIL 方角模式异常');
  log('AGF DONE');
  app.exit(ok ? 0 : 1);
});
