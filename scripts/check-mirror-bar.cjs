/**
 * 真机回归：投屏窗口功能栏 + pin（v1.1.22，2026-11-04）。
 *
 * 守的是这一串事（全部是「看不见的窗口行为」，只能靠 Win32 查证）：
 *   ① 投屏起来后，功能栏小窗出现在 scrcpy 窗口**右侧**、垂直居中、宽 56
 *   ② 静置时它是隐藏的（opacity 0），拖动窗口后要露出来（opacity 1）
 *   ③ pin：scrcpy 窗口变成置顶（WS_EX_TOPMOST）；**样式与客户区一概不动**
 *      （v1.1.22 早期版本会抠掉 WS_THICKFRAME「禁止拉伸」，代价是标题栏变矮、
 *      客户区长高 → 点 pin 的瞬间整个窗口抖一下。见 step 5 的两条断言）
 *   ④ pin 期间把窗口强行挪走 → 会被按回锁定位置
 *   ⑤ 解除 pin：置顶撤掉、矩形回到 pin 之前的样子
 *   ⑥ 竖屏 pin → 转横屏 → 解除 pin：**必须还是横屏**（不许被 `_origRect` 拽回竖屏）
 *   ⑦ 记录按「机型#方向」落盘，停止投屏后仍在
 *   ⑧ 关掉设置开关 → 记录被清空
 *
 * 需要一台在线设备；没有就跳过（返回 0）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-mirror-bar.cjs \
 *     --watch ui-shots/_mirror-bar.log --until "MIRROR BAR CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_mirror-bar.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(...a) {
  const line = a
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ');
  fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${line}\n`);
}

let failed = 0;
function ok(name, pass, detail) {
  if (pass) log(`  PASS  ${name}`);
  else {
    failed += 1;
    log(`  FAIL  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-mirror-bar-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/*
 * 🔴 必须挡掉「窗口全关就自动退出」的默认行为：
 *    第 9 步会 destroy 功能栏小窗，那时进程里一个窗口都不剩，
 *    Electron 默认直接 quit —— 脚本会在最后几步之前静悄悄消失（退出码还是 0）。
 */
app.on('window-all-closed', () => {
  /* 什么都不做 */
});

const ADB = path.join(ROOT, 'bin', 'adb.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Win32 小工具（一次性 PowerShell 调用） ---------------- */

const CS = `
using System;
using System.Runtime.InteropServices;
public static class Wq {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static IntPtr Find(int pid) {
    IntPtr best = IntPtr.Zero; long area = -1;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RC r; GetWindowRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string Info(int pid) {
    IntPtr h = Find(pid);
    if (h == IntPtr.Zero) return "0";
    RC r; GetWindowRect(h, out r);
    int st = GetWindowLongW(h, -16);
    int ex = GetWindowLongW(h, -20);
    return h.ToInt64() + "|" + r.L + "|" + r.T + "|" + r.R + "|" + r.B + "|" + st + "|" + ex;
  }
  public static void MoveTo(int pid, int x, int y, int w, int h) {
    IntPtr target = Find(pid);
    if (target == IntPtr.Zero) return;
    SetWindowPos(target, IntPtr.Zero, x, y, w, h, 0x0004 | 0x0010);
  }
  /** 客户区（屏幕坐标）：pin 前后必须一模一样，差一点就是「抖了一下」 */
  public static string Client(int pid) {
    IntPtr h = Find(pid);
    if (h == IntPtr.Zero) return "0";
    RC r; GetClientRect(h, out r);
    PT p; p.X = 0; p.Y = 0; ClientToScreen(h, ref p);
    return p.X + "|" + p.Y + "|" + (r.R - r.L) + "|" + (r.B - r.T);
  }
}
`;

function ps(body) {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@
[Wq]::SetProcessDPIAware() | Out-Null
${body}
`;
  const tmp = path.join(os.tmpdir(), `adb-mbar-${process.pid}.ps1`);
  fs.writeFileSync(tmp, '\uFEFF' + script, 'utf8');
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  ).trim();
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return out;
}

function winInfo(pid) {
  const raw = ps(`[Wq]::Info(${pid})`);
  if (!raw || raw === '0') return null;
  const [h, L, T, R, B, st, ex] = raw.split('|').map((v) => Number(v));
  return {
    hwnd: h,
    x: L,
    y: T,
    width: R - L,
    height: B - T,
    style: st,
    exStyle: ex,
    thickFrame: (st & 0x00040000) !== 0,
    topmost: (ex & 0x00000008) !== 0,
  };
}

/** 客户区（屏幕坐标）——pin 前后逐像素比对，用来守「点 pin 不许抖」 */
function clientInfo(pid) {
  const raw = ps(`[Wq]::Client(${pid})`);
  if (!raw || raw === '0') return null;
  const [x, y, w, h] = raw.split('|').map((v) => Number(v));
  return { x, y, width: w, height: h };
}

/* ---------------- 主流程 ---------------- */
app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    failed += 1;
    log(`  FAIL  异常：${e && e.message}`);
  }
  log(`MIRROR BAR CHECK DONE  failed=${failed}`);
  await sleep(200);
  app.exit(failed ? 1 : 0);
});

async function run() {
  const mirror = require('../dist-electron/electron/services/mirror.js');
  const bar = require('../dist-electron/electron/services/mirror-bar.js');
  const adbSvc = require('../dist-electron/electron/services/adb.js');
  const settings = require('../dist-electron/electron/services/settings.js');
  // 功能栏那个小窗要靠 IPC 拿状态（不注册的话它渲染出来是空的）
  require('../dist-electron/electron/ipc.js').registerIpc();

  adbSvc.setLogSink(() => {
    /* 静音：这里只关心窗口行为 */
  });

  const devs = await adbSvc.listDevices();
  const dev = (devs || []).find((d) => d.state === 'device' && !/emulator-/.test(d.serial));
  if (!dev) {
    log('  没有在线真机，跳过');
    return;
  }
  log(`设备：${dev.serial} ${dev.model || ''}`);

  log('[1] 启动投屏');
  await mirror.startMirror({
    serial: dev.serial,
    maxSize: 720,
    bitRateMbps: 4,
    maxFps: 30,
    noAudio: true,
    keyboard: 'uhid',
    wakeOnDoubleClick: false,
    /* 🔴 设备中途自动锁屏 → scrcpy 拿不到首帧 → 窗口卡在 274×303 占位尺寸，
       第 10 步「自动还原」必然假失败（2026-11-05 实测踩过） */
    stayAwake: true,
  });

  // 等 scrcpy 窗口建出来 + 代理上报
  let info = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const st = mirror.getMirrorStatus();
    if (!st.running || !st.pid) continue;
    const wi = winInfo(st.pid);
    if (wi && wi.width > 100) {
      info = wi;
      break;
    }
  }
  if (!info || !mirror.getMirrorStatus().pid) {
    log('  FAIL  scrcpy 窗口没出来');
    failed += 1;
    try {
      await mirror.stopMirror();
    } catch {
      /* ignore */
    }
    return;
  }
  const pid = mirror.getMirrorStatus().pid;
  log(`  scrcpy hwnd=${info.hwnd} rect=${info.x},${info.y} ${info.width}x${info.height}`);

  const barState = () => bar.getMirrorBarState();
  const barWin = () => BrowserWindow.getAllWindows().find((w) => bar.isMirrorBarWindow(w)) || null;
  /**
   * 等窗口尺寸连续两次读数一致再量。
   * 🔴 scrcpy 改窗口尺寸是「连着改好几下」的（旋转时尤其明显），读早了量到的是
   *    过渡尺寸（实测见过 338×767 → 335×188 → 738×367），断言会假失败。
   */
  const settleWin = async (ms = 6000) => {
    const t0 = Date.now();
    let prev = null;
    let stable = 0;
    while (Date.now() - t0 < ms) {
      const w = winInfo(pid);
      if (
        w &&
        prev &&
        w.x === prev.x &&
        w.y === prev.y &&
        w.width === prev.width &&
        w.height === prev.height
      ) {
        stable += 1;
        if (stable >= 2) return w;
      } else {
        stable = 0;
      }
      prev = w;
      await sleep(250);
    }
    return prev;
  };

  log('[2] 功能栏小窗出现并贴右侧');
  let bw = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    bw = barWin();
    if (bw && !bw.isDestroyed() && bw.getBounds().width > 0) break;
  }
  ok('功能栏窗口已创建', !!bw && !bw.isDestroyed());
  if (!bw) {
    // 排障用：分清是「没挂上代理」还是「挂上了但拿不到窗口矩形」
    const winState = require('../dist-electron/electron/services/mirror-win.js').getMirrorWinState();
    log(
      `  · barState=${JSON.stringify(barState())} winState=${JSON.stringify(winState)} windows=${BrowserWindow.getAllWindows().length}`,
    );
    return;
  }

  await sleep(600);
  // 首帧到达后 scrcpy 会把占位窗口换成正片尺寸，等它稳定再量
  await sleep(1200);
  info = winInfo(pid);
  const b = bw.getBounds();
  const scale = 1.25;
  const expectX = Math.round(info.x / scale + info.width / scale);
  ok('宽度 56 DIP（允许 1px 边框误差）', Math.abs(b.width - 56) <= 1, b);
  ok('贴在窗口右侧', Math.abs(b.x - expectX) <= 3, { got: b.x, want: expectX });
  ok(
    '垂直居中',
    Math.abs(b.y + b.height / 2 - (info.y / scale + info.height / scale / 2)) <= 4,
    b,
  );

  log('[2b] 功能栏渲染出 pin 按钮');
  let hasBtn = false;
  for (let i = 0; i < 25; i += 1) {
    hasBtn = await bw.webContents.executeJavaScript(
      "!!document.querySelector('[data-mbar-pin]')",
    );
    if (hasBtn) break;
    await sleep(200);
  }
  ok('pin 按钮已在 DOM 里', hasBtn === true);
  if (hasBtn) {
    const shot = await bw.webContents.capturePage();
    if (shot && !shot.isEmpty()) {
      fs.writeFileSync(path.join(OUT, '_mirror-bar.png'), shot.toPNG());
      log('  截图已存 ui-shots/_mirror-bar.png');
    }
  }

  log('[3] 静置时应隐藏');
  await sleep(2600); // 首次「露一脸」1.4s 之后
  ok('静置后 opacity=0', bw.getOpacity() === 0, bw.getOpacity());

  log('[4] 拖动窗口 → 功能栏露出');
  ps(`[Wq]::MoveTo(${pid}, 400, 260, ${info.width}, ${info.height})`);
  await sleep(700);
  ok('拖动后 opacity=1', bw.getOpacity() === 1, bw.getOpacity());
  const afterDrag = winInfo(pid);
  ok('窗口确实被挪走了', Math.abs(afterDrag.x - 400) <= 2, afterDrag);

  /*
   * [4b] 未 pin 时功能栏**不许**待在最上层（小杨 2026-11-06）。
   *      以前建窗就 setAlwaysOnTop(true)，结果没钉住的时候那条悬浮栏也压在所有
   *      应用上面。现在层级跟着 pin 走，这里守「没钉住 = 普通窗口」。
   */
  log('[4b] 未 pin 时功能栏不该置顶');
  await sleep(400);
  ok('未 pin → isAlwaysOnTop=false', bw.isAlwaysOnTop() === false, bw.isAlwaysOnTop());

  log('[5] pin：点功能栏上的按钮 → 置顶，且样式/客户区一概不动');
  const before = (await settleWin()) || winInfo(pid);
  const beforeClient = clientInfo(pid);
  // 走真实点击链路：渲染层 → preload → ipc → mirror-bar → Win32 代理
  await bw.webContents.executeJavaScript("document.querySelector('[data-mbar-pin]').click()");
  /*
   * 点完当场就要是可见的（点一下 = 刷新「露脸」时间戳）。
   * 只等 400ms：REVEAL_MS 是 1400ms，等太久光标又不在条子上，它已经淡出了 ——
   * 那条「静置就隐藏」的行为本来就被第 3 步守着。
   */
  await sleep(400);
  let pinned = bar.getMirrorBarState();
  ok('点完功能栏仍可见', bw.getOpacity() === 1, bw.getOpacity());
  await sleep(800);
  if (!pinned.pinned) {
    log('  · 按钮点击没生效，改用直接调用（记录下这条，说明 UI 链路断了）');
    ok('按钮点击能钉住', false, pinned);
    pinned = bar.setMirrorPin(true);
  } else {
    ok('按钮点击能钉住', true);
  }
  ok('状态 pinned=true', pinned.pinned === true, pinned);
  await sleep(900);
  const pinInfo = winInfo(pid);
  const pinClient = clientInfo(pid);
  ok('窗口已置顶', pinInfo.topmost === true, pinInfo);
  /*
   * 🔴 这两条守的是「点 pin 抖一下」（小杨 2026-11-05）：
   *    早期版本 pin 时把 WS_THICKFRAME 抠掉「禁止拉伸」，WS_THICKFRAME 参与
   *    非客户区计算 → 标题栏变矮 ~13px、客户区长高 ~13px，外框却不变 →
   *    scrcpy 收到 WM_SIZE 又缩一次画面。所以现在样式一个字都不许改，
   *    客户区也必须原地不动。
   */
  ok('窗口样式未改动（改样式会让标题栏变矮）', pinInfo.style === before.style, {
    before: before.style,
    now: pinInfo.style,
  });
  ok(
    '客户区位置尺寸未变（无抖动）',
    !!beforeClient &&
      !!pinClient &&
      Math.abs(pinClient.x - beforeClient.x) <= 1 &&
      Math.abs(pinClient.y - beforeClient.y) <= 1 &&
      Math.abs(pinClient.width - beforeClient.width) <= 2 &&
      Math.abs(pinClient.height - beforeClient.height) <= 2,
    { before: beforeClient, now: pinClient },
  );
  ok('几何未变', Math.abs(pinInfo.width - before.width) <= 2, { before, pinInfo });
  /* 钉住了 → 功能栏也要跟着浮到最上层（不然投屏窗口置顶、条子被压在下面点不到） */
  ok('pin 后功能栏跟着置顶', bw.isAlwaysOnTop() === true, bw.isAlwaysOnTop());

  log('[6] pin 期间强行挪窗口 → 被按回原位');
  ps(`[Wq]::MoveTo(${pid}, ${before.x + 140}, ${before.y + 90}, ${before.width}, ${before.height})`);
  await sleep(900);
  const snap = winInfo(pid);
  ok(
    '位置被按回锁定处',
    Math.abs(snap.x - before.x) <= 3 && Math.abs(snap.y - before.y) <= 3,
    { locked: { x: before.x, y: before.y }, now: { x: snap.x, y: snap.y } },
  );

  log('[7] 记录按「机型#方向」落盘');
  const rec = settings.getSettings().mirrorPinRecords || {};
  const keys = Object.keys(rec);
  const st = barState();
  const wantKey = `${st.model || dev.serial}#${st.orientation}`;
  ok('有一条记录', keys.length >= 1, keys);
  ok(`记录 key = ${wantKey}`, keys.includes(wantKey), keys);
  ok('记录 pinned=true', rec[wantKey] && rec[wantKey].pinned === true, rec[wantKey]);
  ok('记录方向合法', st.orientation === 'portrait' || st.orientation === 'landscape', st);

  log('[8] 解除 pin：再点一次按钮 → 还原原状');
  await bw.webContents.executeJavaScript("document.querySelector('[data-mbar-pin]').click()");
  await sleep(1200);
  let unpinned = bar.getMirrorBarState();
  if (unpinned.pinned) {
    log('  · 第二次点击没生效，改用直接调用');
    ok('按钮点击能解除', false, unpinned);
    unpinned = bar.setMirrorPin(false);
  } else {
    ok('按钮点击能解除', true);
  }
  ok('状态 pinned=false', unpinned.pinned === false, unpinned);
  await sleep(1000);
  const back = winInfo(pid);
  ok('置顶已撤掉', back.topmost === false, back);
  ok('解除 pin 后功能栏回到普通层级', bw.isAlwaysOnTop() === false, bw.isAlwaysOnTop());
  ok('样式全程未改动（不靠改样式锁大小）', back.style === before.style, {
    before: before.style,
    now: back.style,
  });
  ok(
    '矩形回到 pin 之前',
    Math.abs(back.x - before.x) <= 3 && Math.abs(back.width - before.width) <= 3,
    { before, back },
  );
  ok(
    '记录改为 pinned=false',
    (settings.getSettings().mirrorPinRecords || {})[wantKey]?.pinned === false,
    (settings.getSettings().mirrorPinRecords || {})[wantKey],
  );

  /* ------------------------------------------------------------------ *
   * [8b] 竖屏 pin → 变横屏 → 解除 pin：必须还是横屏
   *
   * 🔴 守的是小杨 2026-11-05 报的第二个 bug：代理在 pin 那一刻把 _origRect
   *    记成**竖屏**矩形，解除时无条件还原 → 用户刚转好的横屏被硬塞回一个
   *    竖屏窗口。
   *
   * 为什么不真转设备：这台机器的前台是横屏锁定的游戏（com.higgs.domino），
   * `settings put system user_rotation` 根本不生效，测出来只会「跳过」。
   * 所以直接在 Win32 层模拟 scrcpy 旋转后干的事 —— pin 着把窗口换成另一类
   * 宽高比。要守的逻辑（旋转后 _origRect 过期）完全是同一条。
   * ------------------------------------------------------------------ */
  log('[8b] 竖屏 pin → 变横屏 → 解除 pin 应保持横屏');
  // 先清空记录：否则「旋转分支套用已有记录」会把窗口挪到记录的几何上，干扰这一步
  settings.saveSettings({ mirrorPinRecords: {} });
  const base = winInfo(pid);
  const portraitW = 320;
  const portraitH = 720;
  ps(`[Wq]::MoveTo(${pid}, ${base.x}, ${base.y}, ${portraitW}, ${portraitH})`);
  await sleep(600);
  const portraitRect = (await settleWin()) || winInfo(pid);
  ok('先把窗口摆成竖屏', portraitRect.height > portraitRect.width, portraitRect);

  bar.setMirrorPin(true);
  await sleep(900);
  ok('竖屏下能钉住', barState().pinned === true, barState());

  // 模拟旋转：scrcpy 拿到新方向的画面后把窗口换成横向尺寸
  ps(`[Wq]::MoveTo(${pid}, ${base.x}, ${base.y}, ${portraitH}, ${portraitW})`);
  await sleep(900);
  const landRect = (await settleWin()) || winInfo(pid);
  ok('pin 期间允许旋转改尺寸（没被按回竖屏）', landRect.width > landRect.height, landRect);

  bar.setMirrorPin(false);
  await sleep(800);
  const afterUnpin = (await settleWin()) || winInfo(pid);
  ok('解除 pin 后仍是横屏（不许被拽回竖屏）', afterUnpin.width > afterUnpin.height, {
    portraitRect,
    afterUnpin,
  });
  ok(
    '解除 pin 后尺寸原地不动',
    Math.abs(afterUnpin.width - landRect.width) <= 4 &&
      Math.abs(afterUnpin.height - landRect.height) <= 4,
    { landRect, afterUnpin },
  );
  ok('置顶已撤掉', afterUnpin.topmost === false, afterUnpin);

  /*
   * 收尾：把窗口摆回 [8b] 之前的样子。
   * 不还原的话，[9] 会把「模拟出来的横屏几何」当成这个方向的记录落盘，
   * 而设备本身是另一个方向 → 第 10 步重启投屏后 scrcpy 按真实画面把窗口
   * 改回去，断言「还原的位置尺寸」必然对不上（2026-11-05 实测踩过）。
   */
  ps(`[Wq]::MoveTo(${pid}, ${base.x}, ${base.y}, ${base.width}, ${base.height})`);
  await sleep(700);
  await settleWin();

  log('[9] 再钉一次 → 停投屏 → 功能栏随投屏一起收掉，记录保留');
  bar.setMirrorPin(true);
  await sleep(900);
  const pinRect = winInfo(pid);
  // [8b] 转过方向，key 里带着方向，必须按此刻的状态重新算（别沿用 [7] 的）
  const st9 = barState();
  const key9 = `${st9.model || dev.serial}#${st9.orientation}`;
  await mirror.stopMirror();
  await sleep(1600);
  const left = barWin();
  ok('功能栏窗口已销毁', !left || left.isDestroyed(), !!left);
  ok('状态 running=false', barState().running === false, barState());
  const kept = (settings.getSettings().mirrorPinRecords || {})[key9];
  ok('停止投屏后记录仍在', !!kept, kept);
  ok('记录 pinned=true（下次投屏要还原）', kept && kept.pinned === true, kept);
  ok(
    '记录的几何与实测一致',
    kept && Math.abs(kept.x - pinRect.x) <= 3 && Math.abs(kept.width - pinRect.width) <= 3,
    { kept, pinRect },
  );

  log('[10] 再投一次 → 自动还原上次钉住的位置尺寸');
  // 再唤醒一次：上面刚停过投屏，设备可能已经息屏
  try {
    execFileSync(ADB, ['-s', dev.serial, 'shell', 'input', 'keyevent', '224'], {
      windowsHide: true,
      timeout: 10000,
    });
  } catch {
    /* ignore */
  }
  await mirror.startMirror({
    serial: dev.serial,
    maxSize: 720,
    bitRateMbps: 4,
    maxFps: 30,
    noAudio: true,
    keyboard: 'uhid',
    wakeOnDoubleClick: false,
    /* 🔴 设备中途自动锁屏 → scrcpy 拿不到首帧 → 窗口卡在 274×303 占位尺寸，
       第 10 步「自动还原」必然假失败（2026-11-05 实测踩过） */
    stayAwake: true,
  });
  let restored = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    if (barState().pinned) {
      restored = true;
      break;
    }
  }
  ok('自动回到 pinned 状态', restored, barState());
  await sleep(600);
  // 🔴 重启投屏会换一个 scrcpy 进程，pid 必须重新取（沿用旧 pid 只会查到 null）
  const pid2 = mirror.getMirrorStatus().pid;
  const again = pid2 ? winInfo(pid2) : null;
  if (!again) {
    ok('重启后能找到投屏窗口', false, { pid2 });
    await mirror.stopMirror();
    await sleep(1200);
    return;
  }
  ok(
    '位置尺寸与上次钉住的一致',
    Math.abs(again.x - pinRect.x) <= 4 && Math.abs(again.width - pinRect.width) <= 4,
    { want: { x: pinRect.x, w: pinRect.width }, got: { x: again.x, w: again.width } },
  );
  await mirror.stopMirror();
  await sleep(1200);

  log('[11] 关掉开关 → 记录清空');
  settings.saveSettings({ mirrorBarEnabled: false });
  bar.syncMirrorBarSetting(false);
  await sleep(300);
  ok('记录已清空', Object.keys(settings.getSettings().mirrorPinRecords || {}).length === 0, settings.getSettings().mirrorPinRecords);
  settings.saveSettings({ mirrorBarEnabled: true });
}
