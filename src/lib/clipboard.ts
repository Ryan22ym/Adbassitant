/**
 * 把一段文本放进剪贴板。
 *
 * 三级链，从最可靠的往下退：
 *   ① **主进程 clipboard** —— 不要求窗口焦点，自绘窗口里唯一稳的一条路；
 *   ② `navigator.clipboard.writeText()` —— 需要安全上下文 + 文档有焦点；
 *   ③ `execCommand('copy')` —— 最后的兜底。
 *
 * 🔴 把 ① 放最前面是有实测依据的：窗口被投屏窗口（scrcpy 原生窗口）抢走焦点时，
 *    ② 不会报错，而是**静默失败**（Promise resolve、剪贴板仍是空的）——
 *    界面显示「已复制」，粘出来什么都没有。只有 ① 没有这个前提。
 *
 * v1.1.25 从 pages/AiPage.tsx 挪到这里：工具箱也要复制，不能两份实现各自漂移。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const done = await window.adbApi.clipboardWrite(text);
    if (done) return true;
  } catch {
    /* IPC 不可用（理论上不会）→ 往下退 */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
