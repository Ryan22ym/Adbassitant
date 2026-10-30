/**
 * AI 回复「自动落盘」（v1.1.20）
 * ============================================================
 * 一条回复里凡是**能变成文件**的东西，在这里一次性写出去：
 *
 *   整篇文档 → `.md`（原文，标题层级 / 列表 / 代码块都保留）
 *   代码块   → 按语言给扩展名（`.py` / `.ts` / `.java` …），内容一个字不改
 *   表格     → `.csv`（带 BOM，Excel 双击打开不乱码）
 *
 * 落点：`<exportDir>\产出\<会话标题>\<内容块名><扩展名>`
 *   —— 一次对话一个目录，用户打开 `D:\adbdocs\产出\` 就能看见「那次问的是什么」。
 *
 * 🔴 三条设计约束（改之前先读）：
 *
 *  ① **宁可少存，不能乱存。** 一个「好的，已经执行了」也存成 md，产出目录几天就成垃圾场，
 *     用户点开「产出内容」看到一排没用的文件，这个功能就废了。所以每类内容都有门槛
 *     （见 `shouldSave`）：文档要够长且有结构、代码要够多行、表格要有数据行。
 *
 *  ② **绝不覆盖。** 重名一律走 `uniquePath` 加 `(1)`。产物是「顺手存一份」，
 *     覆盖掉上一版就找不回来了；而「再写一版」恰恰是最常见的追问。
 *
 *  ③ **单个文件失败不影响其它。** 写盘会遇上杀毒软件占用、路径过长、磁盘满，
 *     任何一个都应该只丢那一份，不能让整轮对话失败 —— 对话内容远比文件重要。
 *
 * 🔴 与「手动导出」的分工：导出是用户明确指定格式和目录（可能是 docx / pdf），
 *    自动落盘只产生**最原始的那份**（md / 源码 / csv）。想要排版版本，点卡片旁边的「导出」。
 */

import { mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { detectDocParts, extOfFormat, safeFileName } from '../../shared/ai-export';
import type { AiDocPart } from '../../shared/ai-export';
import type { AiArtifact } from '../../shared/types';
import { uniquePath } from './path-util';
import { log } from './adb';

/**
 * 一条回复最多落几个文件。
 *
 * 模型偶尔会一口气给七八个代码块（每个文件一段），全存下来气泡底下就是一堵墙。
 * 取前 8 个 —— 正常回复不会超过这个数，超了就说明它在贴整个项目，那种情况
 * 用户自己会去点「导出」，不需要界面替他决定。
 */
const MAX_ARTIFACTS = 8;

/** CSV 的 BOM：不加的话 Excel 打开是乱码（与日志导出同一套处理） */
const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * 「为了回答去执行」的语言标记 —— 这些块不是产出，是过程。
 *
 * `adb` / `logcat` 两个是工具协议里用来下指令的（见 services/ai-adb.ts），
 * 主进程会把它们跑掉再把结果回传给模型；把这种块也存成 .txt 纯属噪音。
 * 注意**不**排除 shell / bash：那两种通常是用户真要的脚本。
 */
const COMMAND_LANGS = new Set(['adb', 'logcat']);

/**
 * 这一块值不值得落盘。
 *
 * 门槛都定得比较宽松，但足以挡住「一句话回答」和「两行示例」：
 *   文档：≥ 200 字符，且至少有一个标题 / 列表 / 代码块（否则就是一段普通回答）
 *   代码：≥ 2 行且 ≥ 40 字符
 *   表格：表头 + 至少 2 行数据
 */
function shouldSave(part: AiDocPart): boolean {
  if (part.kind === 'doc') {
    if (part.chars < 200) return false;
    return (
      /^\s{0,3}#{1,6}\s+/m.test(part.content) ||
      /^\s*```/m.test(part.content) ||
      /^\s*[-*+]\s+/m.test(part.content)
    );
  }
  if (part.kind === 'code') {
    if (part.chars < 40) return false;
    if (part.content.split(/\r?\n/).length < 2) return false;
    return !COMMAND_LANGS.has(String(part.lang || '').toLowerCase());
  }
  // table：CSV 是「表头 + 数据行」，只有表头的空表没有意义
  return part.content.split(/\r?\n/).filter(Boolean).length >= 3;
}

/** 这块内容落盘后该叫什么扩展名 */
function extOfPart(part: AiDocPart): string {
  if (part.kind === 'doc') return '.md';
  return extOfFormat(part, part.format);
}

/** 这块内容落盘后该写什么字节 */
function bodyOfPart(part: AiDocPart, ext: string): Buffer {
  const buf = Buffer.from(part.content, 'utf8');
  return ext === '.csv' ? Buffer.concat([CSV_BOM, buf]) : buf;
}

export interface SaveArtifactsOptions {
  /** 回复正文（Markdown 原文） */
  content: string;
  /** 落盘根目录（已解析过、确定可写的目录，通常是 exportDir） */
  rootDir: string;
  /** 会话标题，用来分目录（空则落到「未命名对话」） */
  sessionTitle: string;
}

/**
 * 把一条回复的产出写成文件，返回清单（没产出就是空数组）。
 *
 * 调用方（services/ai.ts）在**回复已确定、还没落进会话**的位置调它，
 * 这样清单可以随助手消息一起持久化，回看历史时卡片照样能点开。
 */
export function saveReplyArtifacts(opts: SaveArtifactsOptions): AiArtifact[] {
  const content = String(opts.content || '');
  if (!content.trim()) return [];

  const root = (opts.rootDir || '').trim();
  if (!root) return [];

  let parts: AiDocPart[];
  try {
    parts = detectDocParts(content).filter(shouldSave).slice(0, MAX_ARTIFACTS);
  } catch (e) {
    log('warn', 'AI', `解析回复产出失败：${(e as Error).message}`);
    return [];
  }
  if (parts.length === 0) return [];

  const dir = join(root, '产出', safeFileName(opts.sessionTitle, '未命名对话'));
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    log('warn', 'AI', `产出目录建不出来（${dir}）：${(e as Error).message}`);
    return [];
  }

  const out: AiArtifact[] = [];
  for (const part of parts) {
    try {
      const ext = extOfPart(part);
      const base = safeFileName(part.baseName, part.kind === 'doc' ? 'AI文档' : 'AI产出');
      const picked = uniquePath(join(dir, `${base}${ext}`));
      writeFileSync(picked.path, bodyOfPart(part, ext));
      out.push({
        id: randomUUID(),
        kind: part.kind,
        title: part.title,
        path: picked.path,
        dir: dirname(picked.path),
        ext,
        bytes: statSync(picked.path).size,
        partId: part.id,
        at: Date.now(),
      });
    } catch (e) {
      // 一份写不出去就跳过它，别把整轮对话拖下水
      log('warn', 'AI', `产出落盘失败（${part.baseName}）：${(e as Error).message}`);
    }
  }

  if (out.length) {
    log('info', 'AI', `自动落盘 ${out.length} 个产出 → ${dir}`);
  }
  return out;
}
