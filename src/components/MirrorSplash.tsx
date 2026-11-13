/**
 * 「正在投屏」提示牌（v1.1.23）。
 *
 * 跑在 electron/services/mirror-splash.ts 建的透明小窗里，只在**等首帧**这段
 * 出现：scrcpy 的窗口这时还藏着（画面没上来，提前放出来就是个黑底空壳），
 * 屏幕不能空着，所以由它顶着。画面一上屏，主进程直接把窗销毁。
 *
 * 🔴 不许写功能说明、不许堆提示文案（小杨的 UI 约束）：一个转圈 + 四个字，够了。
 */
export default function MirrorSplash() {
  return (
    <div className="msp">
      <div className="msp-card">
        <span className="msp-spin" aria-hidden="true" />
        <span className="msp-text">正在投屏</span>
      </div>
    </div>
  );
}
