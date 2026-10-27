/**
 * AI 回复「导出成文件」+「粘贴图片落盘」（v1.1.17）
 * ============================================================
 * 三个出口：
 *   `exportAiDoc()`     按格式写文件（md / txt / csv / 代码 / html / docx / pdf）
 *   `pickAiExportPath()` 弹「另存为」，返回用户选的完整路径
 *   `savePastedImage()`  把剪贴板里的图片字节落成临时文件（附件按路径走）
 *
 * 🔴 为什么 docx / pdf 必须在主进程做：
 *    docx 是个 ZIP（要写容器），pdf 要起一个隐藏窗口 `printToPDF`——
 *    渲染层是 sandbox + contextIsolation，两件都干不了。
 *    其余格式（md / txt / csv / 代码 / html）的转换是纯字符串，
 *    已经在 `shared/ai-export.ts` 里由界面算好，这里只管写盘。
 *
 * 🔴 为什么不用第三方库（docx / pdfkit / jszip）：
 *    本项目的既定约定是「主进程零第三方依赖，asar 自包含」——
 *    打包不携带 node_modules。docx 需要的 ZIP 写在 `services/zip.ts`（stored 模式），
 *    pdf 复用 Electron 自带的打印能力，都不引入新依赖。
 */

import { BrowserWindow, app, dialog } from 'electron';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, extname, join } from 'path';
import { createZip } from './zip';
import { getAiConfig } from './ai';
import { log } from './adb';
import {
  DEFAULT_AI_EXPORT_DIR,
  type AiConfig,
} from '../../shared/ai-conf';
import { mdToHtml, safeFileName } from '../../shared/ai-export';
import type { AiExportRequest, AiExportResult } from '../../shared/types';

/* ------------------------------------------------------------------ */
/* 默认目录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 默认保存目录。
 *
 * ai.json 里写的是 `D:\adbdocs`（与 D:\adbcrash / D:\adblogs 同一套约定），
 * 但机器上可能根本没有 D 盘 —— 那种情况下拼出来的路径写不进去，
 * 用户会看到「导出失败：ENOENT」。所以这里先探一下盘符，
 * 不存在就退到「文档\ADB助手\AI导出」，保证**永远有一个能写进去的默认目录**。
 */
export function defaultAiExportDir(): string {
  let raw = DEFAULT_AI_EXPORT_DIR;
  try {
    const cfg: AiConfig = getAiConfig();
    if (cfg.exportDir && cfg.exportDir.trim()) raw = cfg.exportDir.trim();
  } catch {
    /* 配置读不出来就用出厂值，不影响导出 */
  }
  const m = /^([a-zA-Z]):/.exec(raw);
  if (m && !existsSync(`${m[1]}:\\`)) {
    return join(app.getPath('documents'), 'ADB助手', 'AI导出');
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* 路径处理                                                            */
/* ------------------------------------------------------------------ */

/** 目标已存在时不覆盖，改成 `名字 (1).md` —— 导出是「顺手存一份」，不该吃掉旧文件 */
function uniquePath(p: string): { path: string; renamed: boolean } {
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

function extOfRequest(req: AiExportRequest): string {
  if (req.format === 'code') return `.${String(req.ext || 'txt').replace(/^\./, '')}`;
  return `.${req.format}`;
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/**
 * 写一个文件出去。
 *
 * 三种落点，优先级从高到低：
 *   ① `targetPath` —— 「另存为」选好的完整路径（用户明确指定，绝不改名）
 *   ② `dir`       —— 对话框里临时改的目录
 *   ③ 默认目录    —— ai.json 的 exportDir
 */
export async function exportAiDoc(req: AiExportRequest): Promise<AiExportResult> {
  if (!req || !req.format) throw new Error('导出参数不完整');

  const format = req.format;
  const ext = extOfRequest(req);
  const baseName = safeFileName(req.fileName || req.title || 'AI文档');

  let target: string;
  let renamed = false;

  if (req.targetPath) {
    target = req.targetPath;
    // 「另存为」对话框已经带了扩展名；万一是用户自己删掉了，这里补回来
    if (!extname(target)) target += ext;
    mkdirSync(dirname(target), { recursive: true });
  } else {
    const dir = (req.dir && req.dir.trim()) || defaultAiExportDir();
    mkdirSync(dir, { recursive: true });
    const picked = uniquePath(join(dir, baseName + ext));
    target = picked.path;
    renamed = picked.renamed;
  }

  const md = req.markdown ?? req.text ?? '';

  if (format === 'docx') {
    writeFileSync(target, buildDocx(md, req.title || baseName));
  } else if (format === 'pdf') {
    await writePdf(req.html || mdToHtml(md, req.title || baseName), req.title || baseName, target);
  } else if (format === 'html' && req.html) {
    // html 以主进程手里的这份为准（渲染层同时要拿它去预览，两边不该有两套实现）
    writeFileSync(target, Buffer.from(req.html, 'utf8'));
  } else {
    let buf = Buffer.from(req.text ?? '', 'utf8');
    // CSV 加 BOM：Excel 双击打开中文不乱码（本工具的日志导出也是这么做的）
    if (format === 'csv') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
    writeFileSync(target, buf);
  }

  const bytes = statSync(target).size;
  log('info', 'AI', `导出 ${format} → ${target}（${bytes} 字节）`);
  return { path: target, dir: dirname(target), bytes, renamed };
}

/** 弹「另存为」，返回用户选定的路径；取消返回 null */
export async function pickAiExportPath(req: AiExportRequest): Promise<string | null> {
  const ext = extOfRequest(req);
  const baseName = safeFileName(req.fileName || req.title || 'AI文档');
  const dir = (req.dir && req.dir.trim()) || defaultAiExportDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录建不出来就让对话框自己回落到系统默认位置 */
  }
  const label = ext.slice(1).toUpperCase();
  const r = await dialog.showSaveDialog({
    title: '导出为文件',
    defaultPath: join(dir, baseName + ext),
    filters: [
      { name: `${label} 文件`, extensions: [ext.slice(1)] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
}

/* ------------------------------------------------------------------ */
/* docx                                                                */
/* ------------------------------------------------------------------ */

function escX(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Word 里的行内标记清理（**粗体** / `行内码` / [文字](链接)） */
function plainInline(s: string): string {
  return String(s ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

interface ParaStyle {
  bold?: boolean;
  italic?: boolean;
  /** 字号（半磅，22 = 11pt） */
  size?: number;
  /** 等宽字体（代码段） */
  mono?: boolean;
  /** 左缩进（twips，720 = 0.5 英寸） */
  indent?: number;
  color?: string;
  /** 段后间距（twips） */
  after?: number;
  shading?: string;
}

function wPara(text: string, st: ParaStyle = {}): string {
  const runPr: string[] = [];
  if (st.mono) {
    runPr.push(
      '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/>',
    );
  }
  if (st.bold) runPr.push('<w:b/><w:bCs/>');
  if (st.italic) runPr.push('<w:i/>');
  if (st.color) runPr.push(`<w:color w:val="${st.color}"/>`);
  if (st.size) runPr.push(`<w:sz w:val="${st.size}"/><w:szCs w:val="${st.size}"/>`);

  const pPr: string[] = [];
  if (st.shading) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${st.shading}"/>`);
  if (st.indent) pPr.push(`<w:ind w:left="${st.indent}"/>`);
  if (st.after !== undefined) pPr.push(`<w:spacing w:after="${st.after}"/>`);
  if (runPr.length) pPr.push(`<w:rPr>${runPr.join('')}</w:rPr>`);

  // 空段落（视觉上的空行）也要给一个 run，否则某些版本的 Word 会把它吃掉
  const runs = text
    ? `<w:r>${runPr.length ? `<w:rPr>${runPr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${escX(text)}</w:t></w:r>`
    : '';

  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runs}</w:p>`;
}

function wTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const width = Math.floor(9360 / cols); // A4 去掉页边距后约 9360 twips
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="C9D2DE"/>`)
      .join('') +
    '</w:tblBorders>';
  const body = rows
    .map((r, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => {
        const txt = plainInline(r[ci] ?? '');
        return (
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
          (ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F5F9"/>' : '') +
          `</w:tcPr>${wPara(txt, { bold: ri === 0, size: 20, after: 0 })}</w:tc>`
        );
      }).join('');
      return `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${body}</w:tbl>${wPara('', { after: 0 })}`;
}

function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * Markdown → docx 字节。
 *
 * 按行扫，识别出四类结构：标题 / 列表 / 围栏代码 / 表格，其余当正文段落。
 * 不做完整 Markdown（不引库的代价），但**报告与计划书这两种最常见的产物**都够用：
 * 标题层级、有序无序列表、引用、分隔线、代码段、表格全在里面。
 */
export function buildDocx(markdown: string, title = 'AI 文档'): Buffer {
  const lines = String(markdown || '')
    .replace(/^\ufeff/, '')
    .split(/\r?\n/);
  const body: string[] = [];
  let fence: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fenceOpen = /^\s*```(.*)$/.exec(raw);
    if (fenceOpen) {
      if (fence) {
        for (const l of fence) body.push(wPara(l || ' ', { mono: true, size: 19, shading: 'F5F7FA', after: 0 }));
        body.push(wPara('', { after: 0 }));
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }

    if (!raw.trim()) {
      body.push(wPara('', { after: 0 }));
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows: string[][] = [splitRow(raw)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      body.push(wTable(rows));
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,})\s*$/.test(raw)) {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9DFE8"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>');
      continue;
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const lv = Math.min(4, h[1].length);
      const size = lv === 1 ? 36 : lv === 2 ? 30 : lv === 3 ? 26 : 24;
      body.push(wPara(plainInline(h[2]), { bold: true, size, after: 160 }));
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(raw);
    if (q) {
      body.push(wPara(plainInline(q[1]), { italic: true, color: '4A5058', indent: 360, after: 100 }));
      continue;
    }

    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const marker = ordered ? `${li[1].replace(/[.)]$/, '')}. ` : '· ';
      body.push(wPara(marker + plainInline(li[2]), { indent: 360, after: 60 }));
      continue;
    }

    body.push(wPara(plainInline(raw), { after: 120 }));
  }
  if (fence) {
    for (const l of fence) body.push(wPara(l || ' ', { mono: true, size: 19, shading: 'F5F7FA', after: 0 }));
  }

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}` +
    '<w:sectPr>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const buf = createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
  ]);

  // 标题只进日志，文件名由调用方决定 —— 这里不再往正文塞大标题（md 自己通常已经有 # 标题）
  log('info', 'AI', `生成 docx（${title}）：${buf.length} 字节`);
  return buf;
}

/* ------------------------------------------------------------------ */
/* pdf                                                                 */
/* ------------------------------------------------------------------ */

/**
 * HTML → PDF，用 Electron 自带的 `printToPDF`。
 *
 * 🔴 为什么先写临时文件再 `loadFile` 而不是 `loadURL('data:text/html,…')`：
 *    长文档的 data URL 会被 Chromium 的长度限制截断（导航失败时只留一个空白页，
 *    printToPDF 照样能出结果 —— 表现为「导出的 pdf 是空的」，极难查）。
 *
 * 🔴 窗口必须 `show:false` 且用完立刻 `destroy()`：导出是高频动作，
 *    每漏一个隐藏窗口就多一个不会自己消失的渲染进程。
 */
async function writePdf(html: string, title: string, outPath: string): Promise<void> {
  const tmp = join(app.getPath('temp'), `ai-export-${Date.now()}-${process.pid}.html`);
  let win: BrowserWindow | null = null;
  try {
    writeFileSync(tmp, html, 'utf8');
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      title,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    await win.loadFile(tmp);
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    writeFileSync(outPath, buf);
  } catch (e) {
    throw new Error(`生成 PDF 失败：${(e as Error).message}`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉不算失败，系统临时目录自己会清 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 粘贴图片落盘                                                        */
/* ------------------------------------------------------------------ */

const PASTE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

function pasteDir(): string {
  const dir = join(app.getPath('userData'), 'ai-paste');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function extFromMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'png';
}

/**
 * 把剪贴板里的图片字节存成临时文件，返回绝对路径。
 *
 * 🔴 为什么要落盘而不是直接给 data URL：
 *    附件这条链（预览、随消息持久化、发请求时读成 base64）全部是按**路径**工作的。
 *    多一条 data URL 支路就意味着「同一个附件两种形态」，会话存盘时还要考虑
 *    几 MB 的 base64 塞进 ai-chats.json —— 落一个临时文件最省事，
 *    预览还能直接走 `file://`（与「常用工具 → 截图」同一套写法）。
 */
export function savePastedImage(bytes: Uint8Array | Buffer | number[], mime = 'image/png'): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
  if (!buf.length) throw new Error('剪贴板里没有图片数据');
  if (buf.length > 32 * 1024 * 1024) {
    throw new Error('这张图片超过 32MB，先保存成文件再拖进来吧');
  }

  const dir = pasteDir();

  // 顺手清掉三天前的：粘贴的截图用完就没价值，但也不能当场删（用户还没发出去）
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('paste-')) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > PASTE_KEEP_MS) unlinkSync(p);
      } catch {
        /* 正在被预览/杀毒软件占用，下次再说 */
      }
    }
  } catch {
    /* 清理失败不影响本次保存 */
  }

  const ts = new Date();
  const stamp =
    `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}` +
    `-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;
  const p = join(dir, `paste-${stamp}-${Math.random().toString(36).slice(2, 6)}.${extFromMime(mime)}`);
  writeFileSync(p, buf);
  return p;
}
