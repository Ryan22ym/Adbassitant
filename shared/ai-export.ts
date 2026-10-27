/**
 * AI 回复「转存成文件」的公共逻辑（v1.1.17）
 * ============================================================
 * 三件事，全部是纯字符串处理，渲染层和主进程共用同一份：
 *   ① `detectDocParts()` —— 从一条回复里认出「可以导出成什么」
 *   ② `partToText()`     —— 按目标格式把某一块转成文本（md / txt / csv / 代码）
 *   ③ `mdToHtml()`       —— md → 自包含 HTML（html 导出与 pdf 打印共用）
 *
 * 🔴 为什么放在 shared/ 而不是主进程：
 *    导出对话框要**先告诉用户「识别到哪些内容、各能导成什么格式」**，
 *    这一步必须在界面里同步算完（不能每敲一个字符就 IPC 一次）。
 *    而真正落盘（docx / pdf）只有主进程能做。两边共用同一套探测结果，
 *    才不会出现「界面说能导 docx、主进程却认不出这块内容」的错位。
 *
 * 🔴 探测刻意保守：**只认明确的结构**（带语言标记的围栏块、标准 Markdown 表格、
 *    整条回复本身）。宁可少给两个选项，也不要把一段普通回答硬塞成「代码文件」——
 *    导出按钮点下去弹出一堆莫名其妙的名字，比没有这个按钮更烦人。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 能做成的文件格式。`code` = 保持原样（用 code 块自己的扩展名） */
export type AiDocFormat = 'md' | 'txt' | 'html' | 'docx' | 'pdf' | 'csv' | 'code';

/** 从回复里识别出的一块可导出内容 */
export interface AiDocPart {
  /** 稳定 id：`doc` / `code-<n>` / `table-<n>` */
  id: string;
  kind: 'doc' | 'code' | 'table';
  /** 界面上显示的名字 */
  title: string;
  /** 建议文件名（不含扩展名） */
  baseName: string;
  /** doc = 整条回复的 md 原文；code = 代码块原文；table = 已转好的 CSV */
  content: string;
  /** 默认格式（打开对话框时预选它） */
  format: AiDocFormat;
  /** code 块的语言标记（原样保留，给导出文件名与高亮提示用） */
  lang?: string;
  /** code 块建议的扩展名（不含点）；doc/table 为空 */
  ext?: string;
  /** 字符数（界面上给个「大概多长」的参考） */
  chars: number;
}

/** 一种内容块可选的导出格式 */
export interface AiFormatOption {
  value: AiDocFormat;
  label: string;
  /** 扩展名（含点）。`code` 按块自身扩展名填 */
  ext: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* 语言 → 扩展名                                                        */
/* ------------------------------------------------------------------ */

/**
 * 围栏块的语言标记 → 扩展名。
 *
 * 只收「写代码/写文档时真会出现的那些」。认不出的语言标记一律当 txt ——
 * 硬猜扩展名（比如把 `log` 写成 `.log` 之外的什么）会让用户双击打不开。
 */
const LANG_EXT: Record<string, string> = {
  js: 'js',
  javascript: 'js',
  mjs: 'mjs',
  cjs: 'cjs',
  jsx: 'jsx',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  java: 'java',
  kotlin: 'kt',
  kt: 'kt',
  gradle: 'gradle',
  groovy: 'groovy',
  xml: 'xml',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  ps1: 'ps1',
  powershell: 'ps1',
  bat: 'bat',
  cmd: 'bat',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'hpp',
  cs: 'cs',
  csharp: 'cs',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  php: 'php',
  ruby: 'rb',
  rb: 'rb',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  md: 'md',
  markdown: 'md',
  diff: 'diff',
  patch: 'patch',
  log: 'log',
  txt: 'txt',
  text: 'txt',
  plaintext: 'txt',
  csv: 'csv',
  properties: 'properties',
};

/** 语言在界面上的中文名（认不出就原样显示） */
const LANG_LABEL: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript/TSX',
  py: 'Python',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  kt: 'Kotlin',
  xml: 'XML',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  ps1: 'PowerShell',
  bat: '批处理',
  md: 'Markdown',
  markdown: 'Markdown',
  log: '日志',
  txt: '文本',
  text: '文本',
  csv: 'CSV',
  gradle: 'Gradle',
  diff: 'Diff',
  html: 'HTML',
  css: 'CSS',
};

function extOfLang(lang: string): string {
  const k = String(lang || '').toLowerCase().trim();
  return LANG_EXT[k] || 'txt';
}

function labelOfLang(lang: string): string {
  const k = String(lang || '').toLowerCase().trim();
  return LANG_LABEL[k] || (k ? k.toUpperCase() : '文本');
}

/* ------------------------------------------------------------------ */
/* 文件名净化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把「模型起的标题」净化成 Windows 能存的文件名。
 *
 * 🔴 三条都踩过：
 *   ① 标题里带 `:` `/` 这类字符（模型很爱写「第一步：准备环境」）—— 冒号在 Windows
 *      上是非法字符，直接写盘会 ENOENT/EINVAL；
 *   ② 结尾的点和空格会被系统悄悄吃掉，导致「拼出来的路径」与「实际落盘的名字」不一致；
 *   ③ 名字过长（中文按字算，路径总长有上限）→ 这里截到 60 字，够用且不会截断扩展名。
 */
export function safeFileName(raw: string, fallback = 'AI文档'): string {
  let s = String(raw || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[. ]+$/g, '');
  if (s.length > 60) s = s.slice(0, 60).trim().replace(/[. ]+$/g, '');
  if (!s) return fallback;
  // Windows 保留设备名（CON / NUL / COM1…）不能当文件名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) return fallback;
  return s;
}

/* ------------------------------------------------------------------ */
/* 探测：这条回复能导出成什么                                          */
/* ------------------------------------------------------------------ */

/** 去掉行内的 markdown 标记，用来生成文件名与纯文本 */
function stripInline(s: string): string {
  return String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .trim();
}

/** 从回复里取一个像样的标题：优先一级标题，其次第一句非空内容 */
export function titleOf(content: string): string {
  const lines = String(content || '').split(/\r?\n/);
  for (const l of lines) {
    const m = /^#{1,3}\s+(.+)$/.exec(l.trim());
    if (m && m[1].trim()) return stripInline(m[1]).slice(0, 60);
  }
  for (const l of lines) {
    const t = stripInline(l);
    if (t) return t.slice(0, 40);
  }
  return 'AI 回复';
}

/** 一行是不是表格分隔行（|---|---|） */
function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
}

/** 拆一行表格 → 单元格数组（处理 `\|` 转义与首尾竖线） */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (c === '|') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** 单元格 → CSV 字段（含逗号 / 引号 / 换行就加引号并转义） */
function csvCell(s: string): string {
  const v = String(s ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * 从 `lines[start]` 开始读一张 Markdown 表格。
 *
 * 表格的判定与拆分只有这一份实现 —— 导出（`detectDocParts`）和界面渲染
 * （AiPage 的 MdView）都用它，否则「界面没认成表格、导出却认了」这种错位迟早出现。
 * 不是表格时返回 null，调用方原样按普通文本处理。
 */
export function readMdTable(
  lines: string[],
  start: number,
): { head: string[]; rows: string[][]; next: number } | null {
  if (start < 0 || start >= lines.length) return null;
  if (!/^\s*\|.*\|\s*$/.test(lines[start])) return null;
  if (start + 1 >= lines.length || !isTableSep(lines[start + 1])) return null;

  const head = splitTableRow(lines[start]);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  return { head, rows, next: i };
}

/**
 * 从一条 AI 回复里识别可导出的内容块。
 *
 * 顺序 = 界面上的显示顺序：先「整篇回复」，再按出现顺序排代码块与表格。
 * 整篇回复一定会有一项（只要不是空内容），这样「我只想把这段回答存下来」
 * 永远有落点，不用先去找代码块。
 */
export function detectDocParts(content: string): AiDocPart[] {
  const text = String(content || '').replace(/^\ufeff/, '');
  if (!text.trim()) return [];

  const parts: AiDocPart[] = [];
  const docTitle = titleOf(text);
  parts.push({
    id: 'doc',
    kind: 'doc',
    title: `整篇回复（${docTitle}）`,
    baseName: safeFileName(docTitle),
    content: text,
    format: 'md',
    chars: text.length,
  });

  const lines = text.split(/\r?\n/);
  let fenceLang = '';
  let fenceNameHint = '';
  let fence: string[] | null = null;
  let codeNo = 0;
  let tableNo = 0;

  const flushFence = () => {
    if (!fence) return;
    const body = fence.join('\n');
    fence = null;
    if (!body.trim()) return;
    codeNo += 1;
    const ext = extOfLang(fenceLang);
    const base =
      safeFileName(fenceNameHint) ||
      safeFileName(`${docTitle} · ${labelOfLang(fenceLang)}${codeNo > 1 ? ` ${codeNo}` : ''}`);
    parts.push({
      id: `code-${codeNo}`,
      kind: 'code',
      title: `${labelOfLang(fenceLang)} 代码块${body.split('\n').length > 6 ? `（${body.split('\n').length} 行）` : ''}`,
      baseName: base.replace(new RegExp(`\\.${ext}$`, 'i'), '') || base,
      content: body,
      format: 'code',
      lang: fenceLang || 'text',
      ext,
      chars: body.length,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceOpen = /^\s*```(.*)$/.exec(raw);
    if (fenceOpen) {
      if (fence) {
        flushFence();
        continue;
      }
      // ```lang 之后可能跟 `title=xxx` / `path=xxx` / 裸文件名 —— 有就当建议文件名
      const rest = (fenceOpen[1] || '').trim();
      const toks = rest.split(/\s+/).filter(Boolean);
      fenceLang = (toks[0] || '').replace(/^[{.]|}$/g, '');
      fenceNameHint = '';
      for (const t of toks.slice(1)) {
        const m = /^(?:title|file|name|filename|path)=(.*)$/i.exec(t);
        if (m) {
          fenceNameHint = m[1].replace(/^["']|["']$/g, '');
          break;
        }
      }
      fence = [];
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }

    // 表格：判定与拆分统一走 readMdTable（与界面渲染同一份实现）
    const tbl = readMdTable(lines, i);
    if (tbl) {
      i = tbl.next - 1; // 回退一格：外层 for 还会 +1
      tableNo += 1;
      const rows = [tbl.head, ...tbl.rows];
      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
      const head = (tbl.head[0] || '').trim();
      const base = safeFileName(
        `${docTitle}${head ? ` · ${head}` : ''}${tableNo > 1 ? ` 表${tableNo}` : ''}`,
      );
      parts.push({
        id: `table-${tableNo}`,
        kind: 'table',
        title: `表格（${tbl.head.length} 列 · ${tbl.rows.length} 行数据）`,
        baseName: base,
        content: csv,
        format: 'csv',
        ext: 'csv',
        chars: csv.length,
      });
    }
  }
  flushFence();

  return parts;
}

/** 某一块支持的导出格式（界面按它渲染下拉/按钮） */
export function formatsOf(part: AiDocPart): AiFormatOption[] {
  if (part.kind === 'code') {
    return [
      { value: 'code', label: `.${part.ext || 'txt'}（原样）`, ext: `.${part.ext || 'txt'}`, hint: '内容一个字不改' },
      { value: 'txt', label: '.txt（纯文本）', ext: '.txt' },
    ];
  }
  if (part.kind === 'table') {
    return [
      { value: 'csv', label: '.csv（Excel 可直接打开）', ext: '.csv', hint: '逗号分隔，UTF-8 带 BOM' },
      { value: 'txt', label: '.txt（纯文本）', ext: '.txt' },
    ];
  }
  return [
    { value: 'md', label: '.md（Markdown）', ext: '.md', hint: '保留标题/列表/代码块' },
    { value: 'docx', label: '.docx（Word 文档）', ext: '.docx', hint: '带标题层级、表格、代码段' },
    { value: 'pdf', label: '.pdf（打印版）', ext: '.pdf', hint: 'A4 排版，适合直接发出去' },
    { value: 'html', label: '.html（网页）', ext: '.html', hint: '单文件，样式内嵌' },
    { value: 'txt', label: '.txt（纯文本）', ext: '.txt', hint: '去掉所有标记' },
  ];
}

/* ------------------------------------------------------------------ */
/* md → 纯文本                                                         */
/* ------------------------------------------------------------------ */

/**
 * md → 纯文本。
 *
 * 目标不是「无损」，而是「用记事本打开还能读」：
 * 标题去 #、列表换成 ·、围栏去掉 ```、表格按制表符对齐成一行。
 */
export function mdToPlain(md: string): string {
  const lines = String(md || '').replace(/^\ufeff/, '').split(/\r?\n/);
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(l);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      out.push(splitTableRow(l).join('\t'));
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        out.push(splitTableRow(lines[i]).join('\t'));
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push('———');
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push(stripInline(h[2]));
      out.push('');
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      out.push(`· ${stripInline(li[2])}`);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) {
      out.push(`| ${stripInline(q[1])}`);
      continue;
    }
    out.push(stripInline(l));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------------------------------------------ */
/* md → HTML                                                           */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内标记：**粗体** / `行内码` / [文字](链接) */
function inline(s: string): string {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_m, t, u) => `<a href="${u}" rel="noreferrer">${t}</a>`,
  );
  return h;
}

/**
 * md → 一份自包含的 HTML（样式内嵌，不引外部资源）。
 *
 * 🔴 同一份产物给两个出口：`.html` 导出直接就是它，`.pdf` 导出拿它去 `printToPDF`。
 *    所以样式必须按「白纸黑字」写 —— 界面是深色主题，但打印到 PDF 时
 *    深底会把整页墨耗光、也没人这么发文档。
 *
 * 🔴 全部走 esc()：内容里可能有一整段设备日志 / 用户贴进来的 HTML，
 *    原样塞进标签就等于让它执行（与报告正文禁用 dangerouslySetInnerHTML 同一个理由）。
 */
export function mdToHtml(md: string, title = 'AI 文档'): string {
  const lines = String(md || '').replace(/^\ufeff/, '').split(/\r?\n/);
  const body: string[] = [];
  let fence: string[] | null = null;
  let fenceLang = '';
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    body.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    body.push(`<${list.type}>${list.items.map((t) => `<li>${inline(t)}</li>`).join('')}</${list.type}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceOpen = /^\s*```(.*)$/.exec(raw);
    if (fenceOpen) {
      if (fence) {
        body.push(
          `<pre><code${fenceLang ? ` class="lang-${esc(fenceLang)}"` : ''}>${esc(fence.join('\n'))}</code></pre>`,
        );
        fence = null;
        fenceLang = '';
      } else {
        flushPara();
        flushList();
        fenceLang = (fenceOpen[1] || '').trim().split(/\s+/)[0] || '';
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }

    if (!raw.trim()) {
      flushPara();
      flushList();
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      flushList();
      const head = splitTableRow(raw);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      body.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      );
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,})\s*$/.test(raw)) {
      flushPara();
      flushList();
      body.push('<hr>');
      continue;
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      flushPara();
      flushList();
      const lv = Math.min(4, h[1].length);
      body.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(raw);
    if (q) {
      flushPara();
      flushList();
      body.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((ul ? ul[1] : ol![1]) || '');
      continue;
    }

    flushList();
    para.push(raw);
  }
  flushPara();
  flushList();
  if (fence) body.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 32px 40px 56px; max-width: 860px;
    font: 15px/1.75 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    color: #1b1f24; background: #fff;
  }
  h1 { font-size: 24px; margin: 22px 0 12px; line-height: 1.35; }
  h2 { font-size: 19px; margin: 20px 0 10px; line-height: 1.4; }
  h3 { font-size: 16.5px; margin: 18px 0 8px; }
  h4 { font-size: 15px; margin: 14px 0 6px; color: #33383f; }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 24px; }
  li { margin: 3px 0; }
  code {
    font: 13px/1.6 "Cascadia Mono", Consolas, monospace;
    background: #f2f4f7; border: 1px solid #e3e7ee; border-radius: 4px;
    padding: 1px 4px;
  }
  pre {
    background: #f7f8fa; border: 1px solid #e3e7ee; border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; margin: 10px 0;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 12.5px; }
  blockquote {
    margin: 10px 0; padding: 6px 14px; color: #4a5058;
    border-left: 3px solid #c9d2de; background: #fafbfc;
  }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
  th, td { border: 1px solid #d9dfe8; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f2f5f9; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #e3e7ee; margin: 18px 0; }
  a { color: #1271b8; }
  @media print {
    body { padding: 0; max-width: none; font-size: 12.5pt; }
    pre, table, blockquote { page-break-inside: avoid; }
  }
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 按格式取文本                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把某一块转成目标格式的**文本**（docx / pdf 不走这里，那两个由主进程从
 * `part.content`（md）与 `mdToHtml()` 另做）。
 */
export function partToText(part: AiDocPart, format: AiDocFormat): string {
  switch (format) {
    case 'txt':
      return part.kind === 'doc' ? mdToPlain(part.content) : part.content;
    case 'csv':
      return part.content;
    case 'html':
      return mdToHtml(part.content, part.baseName);
    case 'md':
    case 'code':
    default:
      if (part.kind === 'code' && format === 'md') {
        return '```' + (part.lang || '') + '\n' + part.content + '\n```\n';
      }
      return part.content;
  }
}

/** 目标格式对应的扩展名（含点）；code 用块自身扩展名 */
export function extOfFormat(part: AiDocPart, format: AiDocFormat): string {
  const opt = formatsOf(part).find((o) => o.value === format);
  if (opt) return opt.ext;
  if (format === 'code') return `.${part.ext || 'txt'}`;
  return `.${format}`;
}
