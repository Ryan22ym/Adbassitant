/*
 * 「投屏画面真的上屏了吗」的判定信号（v1.1.23）。
 *
 * 🔴 为什么不能再用 `INFO: Texture: WxH`（v1.1.15 的老判据）：
 *    scrcpy 3.1 里这两行几乎是同一毫秒打出来的 ——
 *      INFO: Renderer: direct3d
 *      INFO: Texture: 640x1440
 *    它们表示「渲染器建好、纹理按分辨率分配好」，**不等于第一帧已经画到窗口里**。
 *    实测（真机，2026-11-05）：Texture 2.50s → 窗口 resize 2.68s → 画面真的出现 ~2.9s；
 *    设备忙 / 首帧 I 帧晚到时这段会拉到 2~3s，用户看到的就是那个「黑底 + 一条浅灰」的
 *    scrcpy 空窗口（见 MEMORY 里 11-05 那条排查记录）。
 *
 * ✅ 换成 `--print-fps`：scrcpy 每秒打一行 `<n> fps` / `<n> fps (+m frames skipped)`，
 *    n 是**上一秒真正渲染上屏的帧数**。n>0 就说明画面已经在窗口里了。
 *    静止画面会打 `0 fps` —— 这不是缺陷，正好说明它是真实测量而不是"建了个纹理"就当数。
 *
 * ⚠️ 代价：计数器每秒才吐一次，所以首帧之后最多再晚 1s 才放行（实测 2.9s 出画 → 3.51s
 *    才见 `3 fps`）。这段延迟由 mirror-splash 那个「正在投屏」小窗兜住，用户看不到黑窗。
 */

/** `<n> fps`，含 `3 fps (+7 frames skipped)` 这种后缀形式 */
const FPS_RE = /(\d+)\s*fps/gi;

/** 取文本里**最后一条** fps 读数；没有则 null（用来对付分片到达的输出） */
export function latestFps(text: string): number | null {
  let last: number | null = null;
  let m: RegExpExecArray | null;
  FPS_RE.lastIndex = 0;
  while ((m = FPS_RE.exec(text)) !== null) last = Number(m[1]);
  return last;
}

/**
 * 首帧是否已上屏。
 *
 * 🔴 只认「最后一条 fps > 0」：分片里可能先有旧的 `0 fps` 再有新的 `30 fps`，
 *    取最后一条才不会误判；反过来画面卡住时最后一条是 0，也不会一直判真。
 */
export function firstFramePainted(text: string): boolean {
  const fps = latestFps(text);
  return fps !== null && fps > 0;
}

/** 纹理就绪（诊断用：只知道分辨率，不代表有画面） */
export function textureReady(text: string): boolean {
  return /Texture:\s*\d+x\d+/.test(text);
}
