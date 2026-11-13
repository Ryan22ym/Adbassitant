import type { MirrorOptions } from './types';

/**
 * 投屏参数默认值 —— 投屏页、设备行「快速投屏」、以及「插入自动投屏」共用同一份。
 *
 * 放在 shared/ 而不是 src/lib/ 是因为它现在有两个消费者：
 *   · 渲染层（src/lib/mirror.ts 转出，投屏页与快速投屏用）
 *   · 主进程（services/auto-connect.ts 在自动投屏时直接用）
 *
 * 分两份写迟早会漂移 —— 「手动投屏 1440p、插上线自动变成 1920p」这种割裂很难查。
 * 改动这里，三处同时生效。
 */
export const MIRROR_DEFAULTS: Omit<MirrorOptions, 'serial'> = {
  maxSize: 1440,
  bitRateMbps: 8,
  maxFps: 60,
  noAudio: true,
  stayAwake: true,
  /*
   * 双击投屏窗口 = 点亮手机屏幕。
   * 手机熄屏后 scrcpy 是一块黑板（熄屏状态 Android 会丢掉注入的 touch），
   * 这个开关省掉"伸手按电源键"。默认开：keyevent 224 是幂等的，亮屏时无副作用。
   */
  wakeOnDoubleClick: true,
  alwaysOnTop: false,
  /*
   * 默认 sdk（此前的默认是 uhid）。
   *
   * 🔴 换掉 uhid 的原因**不是**输入法，是黑屏：
   *    uhid 会往设备上注册一个虚拟**硬件键盘**（dumpsys input 里能看到
   *    `Device NN: scrcpy  KeyboardType: 2`）。设备侧随即发生
   *    `Config changes=30`（0x10 CONFIG_KEYBOARD + 0x20 CONFIG_KEYBOARD_HIDDEN），
   *    窗口配置从 `-keyb/h/h` 变成 `qwerty/v/v`。前台应用只要没声明
   *    `android:configChanges="keyboard"`（游戏大厅、OPPO launcher 都没声明），
   *    就会被系统判定「必须重启」→ destroySurface → 重建 ~0.5s → **黑屏**。
   *    实测 2026-11-10 11:52 拔插一次：11:52:54 拉起 scrcpy，11:52:56.098 配置变更，
   *    11:52:56.233 `Checking to restart ActivityRecord{...domino}: changed=0x=30`，
   *    11:52:58 才恢复画面。拔掉 USB 时 UHID 键盘被移除，同样的配置变更再来一次，
   *    所以「插上也黑、拔下也黑」。
   *    sdk 模式只走 InputManager 注入，不注册输入设备 → 没有配置变更 → 不黑。
   *
   * 代价（照实记着）：sdk 只能注入 ASCII，走不了设备中文输入法的 IME 组合，
   * 需要往手机里打中文的用户可在投屏页选回「UHID 虚拟」——本地会存进投屏偏好，
   * 之后手动投屏沿用；自动投屏永远用这份默认值，不受影响。
   */
  keyboard: 'sdk',
};
