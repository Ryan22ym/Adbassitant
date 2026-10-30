/**
 * 落盘相关的小工具（v1.1.20 抽出）
 * ============================================================
 * 只有一件事：**不覆盖已有文件地取一个可用路径**。
 *
 * 为什么从 ai-export.ts 抽出来单独放：
 *   「手动导出」和「回复自动落盘」都要这套改名规则，而两边分属两个模块
 *   （ai-export.ts / ai-artifact.ts）。留在其中一边让另一边 import 会绕成
 *   `ai-artifact → ai-export → ai → ai-artifact` 的环，CJS 下这种环最容易
 *   在启动阶段拿到半初始化的导出对象（表现为「某个函数不是函数」，且只在
 *   冷启动时偶发）。抽成不依赖任何业务的独立文件，环就断在这里。
 */

import { existsSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

/**
 * 目标已存在时不覆盖，改成 `名字 (1).md`。
 *
 * 🔴 绝不覆盖是有意的：产物是「顺手存一份」，覆盖掉用户上一版就找不回来了。
 *    同一个标题连着问两次是很常见的事（「再写一版」），靠序号区分正好。
 */
export function uniquePath(p: string): { path: string; renamed: boolean } {
  if (!existsSync(p)) return { path: p, renamed: false };
  const dir = dirname(p);
  const ext = extname(p);
  const base = basename(p, ext);
  for (let i = 1; i < 1000; i++) {
    const cand = join(dir, `${base} (${i})${ext}`);
    if (!existsSync(cand)) return { path: cand, renamed: true };
  }
  throw new Error(`同名文件太多，请先清理一下：${dir}`);
}

/**
 * 把配置里写的目录解析成「这台机器上确实能写」的目录。
 *
 * 出厂配置写的是 `D:\adbdocs`（与 D:\adbcrash / D:\adblogs 同一套约定），
 * 但机器上可能根本没有 D 盘 —— 那种情况下拼出来的路径写不进去，
 * 用户会看到「导出失败：ENOENT」，而真正的原因跟导出没关系。
 * 盘符不存在时一律退到 `fallback`，保证**永远有一个能写进去的目录**。
 */
export function resolveWritableDir(raw: string, fallback: string): string {
  const m = /^([a-zA-Z]):/.exec(raw || '');
  if (m && !existsSync(`${m[1]}:\\`)) return fallback;
  return raw;
}
