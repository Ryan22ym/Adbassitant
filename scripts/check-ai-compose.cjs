/**
 * AI 助手「复制 / 导出 / 粘贴 / 拖放」校验（v1.1.17）。
 *
 * 这四件事都靠浏览器事件 + 主进程落盘，纯类型检查一条都盖不住，必须真跑：
 *   1. 每条助手回复上有「复制 / 导出」，点复制真的进系统剪贴板（主进程读回来比对）；
 *   2. 导出对话框把一条回复拆成「整篇 / 表格 / 代码块」三种内容，各给对的格式；
 *      保存后磁盘上真的有文件，md/csv/代码 的内容与预期逐字一致，
 *      docx 是合法 ZIP（PK 头 + 解得出 document.xml），pdf 有 %PDF- 头；
 *   3. Ctrl+V 粘一张图 → 落成临时文件 + 变成附件；**纯文本粘贴不被拦**；
 *   4. 文件拖到输入区 → 只在这一块出提示，**整窗「松开即可安装」遮罩不出现**；
 *      换到别的页面拖，遮罩照旧出现（= 其它页行为没被改）。
 *
 * 🔴 用独立 userData 临时目录：本脚本要往会话文件里塞一条伪造的 AI 回复、
 *    还要往 ai-paste 里写图，写进用户真实的 %APPDATA%\adb-assistant\ 就是垃圾数据。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-ai-compose.cjs \
 *     --watch ui-shots/_ai-compose.log --until "AI COMPOSE CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_ai-compose.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, clipboard, ipcMain } = electronMain;

/* ------------------------------------------------------------------ */
/* 隔离环境                                                            */
/* ------------------------------------------------------------------ */

const DATA = path.join(os.tmpdir(), `adb-ai-compose-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/** 导出的落点（**不碰** 用户 Conf 里的 exportDir，测试自己指定目录） */
const EXPORT_DIR = path.join(DATA, 'export');
fs.mkdirSync(EXPORT_DIR, { recursive: true });

/**
 * 造的这条 AI 回复里刻意三种内容都有：
 *   一级标题 → 整篇文档有了像样的文件名；
 *   标准 Markdown 表格 → 应该被识别成「表格」并转 csv；
 *   带语言标记 + title= 的围栏块 → 应该被识别成 .ts 代码文件。
 */
const MSG = [
  '# 崩溃分析报告',
  '',
  '结论：**空指针**，发生在 `MainActivity.onCreate`。',
  '',
  '## 关键字段',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 崩溃时间 | 2026-10-23 10:00:12 |',
  '| 包名 | com.example.demo |',
  '',
  '## 修复片段',
  '',
  '```ts title=fix-demo.ts',
  'const safe = (v: string | null) => v ?? "";',
  '```',
].join('\n');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function read(win, expr) {
  return win.webContents.executeJavaScript(expr);
}
async function waitFor(win, expr, timeout = 4000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await read(win, expr)) return true;
    await sleep(step);
  }
  return false;
}
function click(win, sel) {
  return read(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()`,
  );
}
/** 给受控 <input> 赋值：必须走原生 setter + input 事件，否则 React 的 state 不动 */
async function setInput(win, sel, value) {
  return read(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
}
/**
 * 下拉赋值：同样要给 select 走原生 setter + change。
 *
 * 🔴 必须按**下标**取，不能用 `select:nth-of-type(1)` —— 每个 select 都各自
 *    待在独立的 .field 里，`nth-of-type` 是按父节点算的，两个都会被命中。
 */
async function setSelectAt(win, index, value) {
  return read(
    win,
    `(() => {
      const el = document.querySelectorAll('.ai-export-card select')[${index}];
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
}

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  log('userData = ' + DATA);

  const { registerIpc, setSettingsChangedHook } = require('../dist-electron/electron/ipc.js');
  const { syncCrashWatch } = require('../dist-electron/electron/services/crash.js');
  const aiSvc = require('../dist-electron/electron/services/ai.js');
  const shared = require('../dist-electron/shared/ai-export.js');
  registerIpc();
  setSettingsChangedHook(() => syncCrashWatch());
  syncCrashWatch();

  const rows = [];
  const rendererErrors = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  /* 造一段会话：一条用户提问 + 一条带完整结构的助手回复 */
  const sessId = aiSvc.appendToSession(undefined, [
    { id: 'c-1', role: 'user', content: '帮我分析一下这个崩溃', time: Date.now() - 60000 },
    { id: 'c-2', role: 'assistant', content: MSG, model: 'deepseek-flash', time: Date.now() - 59000 },
  ]);

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/ai' });
  await win.show();
  await win.focus();
  await waitFor(win, `!!document.querySelector('.ai-page')`, 8000);
  await read(win, `(localStorage.setItem('adb.ai.lastSession', ${JSON.stringify(sessId)}), true)`);

  /* 切走再切回，让页面按「上次会话」把那条回复拉出来 */
  const gotoChat = async () => {
    await click(win, '.nav-item[href="#/tools"]');
    await sleep(350);
    await click(win, '.nav-item[href="#/ai"]');
    await waitFor(win, `!!document.querySelector('.ai-page')`, 6000);
    await sleep(300);
    if (!(await read(win, `!!document.querySelector('.ai-chat')`))) {
      await click(win, '.ai-head .segmented-item:nth-child(1)');
      await sleep(500);
    }
    await sleep(600);
  };
  await gotoChat();

  const seeded = await read(
    win,
    `(() => ({
      bubbles: document.querySelectorAll('.ai-bubble.assistant').length,
      hasCopy: !!document.querySelector('.ai-bubble.assistant .ai-bubble-act[data-act="copy"]'),
      hasExport: !!document.querySelector('.ai-bubble.assistant .ai-bubble-act[data-act="export"]'),
      userHasAct: !!document.querySelector('.ai-bubble.user .ai-bubble-act'),
    }))()`,
  );
  ok(seeded.bubbles === 1, '取回了造的那条助手回复', `bubbles=${seeded.bubbles}`);
  ok(seeded.hasCopy, '🔴 助手回复上有「复制」按钮', `copy=${seeded.hasCopy}`);
  ok(seeded.hasExport, '🔴 助手回复上有「导出」按钮', `export=${seeded.hasExport}`);
  ok(seeded.userHasAct === false, '用户自己的消息不挂这两个按钮（只给 AI 回复）', `user=${seeded.userHasAct}`);

  /* 表格：以前界面上是一排原始竖线，导出却能识别成 csv —— 两边必须一致 */
  const tblRender = await read(
    win,
    `(() => {
      const t = document.querySelector('.ai-bubble.assistant .ai-md-table');
      return {
        exists: !!t,
        cols: t ? t.querySelectorAll('thead th').length : 0,
        rows: t ? t.querySelectorAll('tbody tr').length : 0,
        firstCell: (t?.querySelector('tbody td')?.textContent || '').trim(),
        rawPipes: (document.querySelector('.ai-bubble.assistant .ai-md')?.textContent || '').includes('| --- |'),
      };
    })()`,
  );
  ok(
    tblRender.exists && tblRender.cols === 2 && tblRender.rows === 2,
    '🔴 回复里的 Markdown 表格渲染成真表格（与导出的识别口径一致）',
    `cols=${tblRender.cols} rows=${tblRender.rows}`,
  );
  ok(tblRender.firstCell === '崩溃时间', '表格首行数据没串列', `first=${tblRender.firstCell}`);
  ok(tblRender.rawPipes === false, '不再把表格当原始竖线文本摊在屏幕上', `rawPipes=${tblRender.rawPipes}`);

  /* ---- 1. 复制 ---- */
  /*
   * 🔴 为什么在「交给 clipboardWrite 的内容」这一层断言，而不是读回系统剪贴板：
   *    这个施工环境里进程的剪贴板是隔离的 —— 主进程 `clipboard.writeText('SENTINEL')`
   *    紧接着 `clipboard.readText()` 读回来就是空字符串（连 Electron 自己写的都读不到），
   *    按真值断言只会得到一个永远红的假 FAIL。
   *    所以这里把「交给剪贴板的那段文本」抓下来比对，真正的系统写入交给 Electron
   *    自己的 clipboard 模块（那部分不是我们的代码）。若环境允许读回，
   *    detail 里会附带 `real=true` 作为额外佐证。
   */
  /*
   * 在主进程这一侧接住「写剪贴板」的调用。
   * 🔴 不能在渲染层包一层 window.adbApi —— contextBridge 暴露的对象是**冻结**的，
   *    赋值静默失败（非严格模式下连异常都没有），第一版就是这么拿到 null 的。
   *    先让产品代码 registerIpc() 注册好，再拆掉换成带探针的同名 handler，
   *    顺带也证明了「通道名两处同步」这件事是对的（名字不一致就接不到）。
   */
  let copied = null;
  ipcMain.removeHandler('clipboard:write');
  ipcMain.handle('clipboard:write', (_e, text) => {
    copied = String(text ?? '');
    clipboard.writeText(copied);
    return { ok: true, data: true };
  });
  clipboard.writeText('__before_copy__');
  await click(win, '.ai-bubble.assistant .ai-bubble-act[data-act="copy"]');
  await sleep(500);
  const copiedText = copied;
  const clipReal = clipboard.readText() === MSG;
  ok(
    copiedText === MSG,
    '🔴 点「复制」后交给系统剪贴板的就是这条回复全文',
    `len=${(copiedText || '').length}/${MSG.length} real=${clipReal}`,
  );
  const copiedLabel = await read(
    win,
    `(document.querySelector('.ai-bubble.assistant .ai-bubble-act[data-act="copy"]')?.textContent || '').trim()`,
  );
  ok(copiedLabel.includes('已复制'), '按钮就地变成「已复制」', `label=${copiedLabel}`);
  await sleep(1700);
  const labelBack = await read(
    win,
    `(document.querySelector('.ai-bubble.assistant .ai-bubble-act[data-act="copy"]')?.textContent || '').trim()`,
  );
  ok(labelBack.includes('复制') && !labelBack.includes('已复制'), '1.6 秒后按钮文字自己还原', `label=${labelBack}`);

  /* ---- 2. 导出 ---- */
  await click(win, '.ai-bubble.assistant .ai-bubble-act[data-act="export"]');
  const dlgReady = await waitFor(win, `!!document.querySelector('.ai-export-card')`, 3000);
  await sleep(300);
  ok(dlgReady, '点「导出」打开导出对话框', `open=${dlgReady}`);

  const dlg = await read(
    win,
    `(() => {
      const card = document.querySelector('.ai-export-card');
      const sels = [...card.querySelectorAll('select')];
      const inputs = [...card.querySelectorAll('input.input')];
      return {
        partOptions: [...(sels[0]?.options || [])].map((o) => o.value),
        partLabels: [...(sels[0]?.options || [])].map((o) => o.textContent.trim()),
        formatOptions: [...(sels[1]?.options || [])].map((o) => o.value),
        dirValue: inputs[0]?.value || '',
        fileName: (card.querySelector('.ai-export-name code')?.textContent || '').trim(),
        btnLabels: [...card.querySelectorAll('.ai-export-actions button')].map((b) => b.textContent.trim()),
      };
    })()`,
  );
  ok(
    dlg.partOptions.length === 3 &&
      dlg.partOptions.includes('doc') &&
      dlg.partOptions.includes('table-1') &&
      dlg.partOptions.includes('code-1'),
    '🔴 一条回复被拆成「整篇 / 表格 / 代码块」三块',
    `parts=${dlg.partOptions.join(',')}`,
  );
  ok(
    ['md', 'docx', 'pdf', 'html', 'txt'].every((f) => dlg.formatOptions.includes(f)),
    '整篇文档可选 md / docx / pdf / html / txt',
    `formats=${dlg.formatOptions.join(',')}`,
  );
  ok(dlg.fileName === '崩溃分析报告.md', '文件名取自标题 + 当前格式扩展名', `name=${dlg.fileName}`);
  ok(!!dlg.dirValue, '对话框里带出默认保存目录（可改）', `dir=${dlg.dirValue}`);
  ok(
    dlg.btnLabels.some((t) => t === '保存') && dlg.btnLabels.some((t) => t.includes('另存为')),
    '有「保存」与「另存为…」两个出口',
    `btns=${dlg.btnLabels.join('|')}`,
  );

  /* 改成测试目录后保存 md */
  await setInput(win, '.ai-export-card input.input', EXPORT_DIR);
  await sleep(200);
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await waitFor(win, `!!document.querySelector('.ai-export-card .notice')`, 6000);
  await sleep(200);

  const mdPath = path.join(EXPORT_DIR, '崩溃分析报告.md');
  const mdOnDisk = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  ok(fs.existsSync(mdPath), '🔴 保存后磁盘上真的有文件', mdPath);
  ok(mdOnDisk === MSG, 'md 的内容与回复原文逐字一致', `len=${mdOnDisk.length}/${MSG.length}`);
  const savedNotice = await read(
    win,
    `(() => {
      const n = document.querySelector('.ai-export-card .notice');
      return { text: (n?.textContent || '').replace(/\\s+/g, ' ').trim(),
               acts: [...(n?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()) };
    })()`,
  );
  ok(savedNotice.text.includes(mdPath), '对话框里回显完整保存路径', `notice=${savedNotice.text.slice(0, 60)}`);
  ok(
    savedNotice.acts.some((t) => t.includes('打开文件')) && savedNotice.acts.some((t) => t.includes('打开文件夹')),
    '保存成功后给「打开文件 / 打开文件夹」两个动作',
    `acts=${savedNotice.acts.join('|')}`,
  );

  /* 切到「表格」→ 格式应自动变成 csv，存出来的 csv 带 BOM、内容对得上 */
  await setSelectAt(win, 0, 'table-1');
  await sleep(300);
  const tableDlg = await read(
    win,
    `(() => {
      const sels = [...document.querySelectorAll('.ai-export-card select')];
      return { format: sels[1]?.value || '', opts: [...(sels[1]?.options || [])].map((o) => o.value),
               name: (document.querySelector('.ai-export-name code')?.textContent || '').trim() };
    })()`,
  );
  ok(tableDlg.format === 'csv', '🔴 切到「表格」后格式自动落到 csv', `format=${tableDlg.format}`);
  ok(
    tableDlg.opts.length === 2 && tableDlg.opts.includes('csv') && tableDlg.opts.includes('txt'),
    '表格只给 csv / txt 两种（不给它 pdf 这种没意义的选项）',
    `opts=${tableDlg.opts.join(',')}`,
  );
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await sleep(900);
  const csvFiles = fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.csv'));
  const csvBuf = csvFiles.length ? fs.readFileSync(path.join(EXPORT_DIR, csvFiles[0])) : Buffer.alloc(0);
  const csvText = csvBuf.toString('utf8');
  ok(csvFiles.length === 1, '表格导出成 .csv', `files=${csvFiles.join(',')}`);
  ok(csvBuf.subarray(0, 3).toString('hex') === 'efbbbf', 'csv 带 UTF-8 BOM（Excel 打开不乱码）');
  ok(
    csvText.includes('崩溃时间,2026-10-23 10:00:12') && csvText.includes('包名,com.example.demo'),
    'csv 内容与表格逐格对得上',
    `csv=${csvText.replace(/\r?\n/g, ' / ').slice(0, 60)}`,
  );

  /* 切到「代码块」→ 格式 = 原样 .ts */
  await setSelectAt(win, 0, 'code-1');
  await sleep(300);
  const codeDlg = await read(
    win,
    `(() => {
      const sels = [...document.querySelectorAll('.ai-export-card select')];
      return { format: sels[1]?.value || '', name: (document.querySelector('.ai-export-name code')?.textContent || '').trim() };
    })()`,
  );
  ok(codeDlg.format === 'code', '🔴 切到「代码块」后格式是「原样」', `format=${codeDlg.format}`);
  ok(codeDlg.name === 'fix-demo.ts', '代码块用围栏里声明的文件名 fix-demo.ts', `name=${codeDlg.name}`);
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await sleep(900);
  const tsPath = path.join(EXPORT_DIR, 'fix-demo.ts');
  ok(fs.existsSync(tsPath), '代码块导出成 .ts', tsPath);
  ok(
    fs.existsSync(tsPath) && fs.readFileSync(tsPath, 'utf8').trim() === 'const safe = (v: string | null) => v ?? "";',
    '代码文件内容不含围栏与语言标记',
  );

  /* 回到整篇 → docx / pdf */
  await setSelectAt(win, 0, 'doc');
  await sleep(300);
  await setSelectAt(win, 1, 'docx');
  await sleep(200);
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await sleep(1200);
  const docxPath = path.join(EXPORT_DIR, '崩溃分析报告.docx');
  const docxBuf = fs.existsSync(docxPath) ? fs.readFileSync(docxPath) : Buffer.alloc(0);
  ok(docxBuf.length > 0, '导出成 .docx', `${docxBuf.length}B`);
  ok(docxBuf.subarray(0, 2).toString('latin1') === 'PK', 'docx 是合法 ZIP 容器（PK 头）');
  let docxOk = false;
  let docxDetail = '';
  try {
    const { listZipEntries, readZipEntry } = require('../dist-electron/electron/services/zip.js');
    const entries = listZipEntries(docxBuf);
    const names = entries.map((e) => e.name);
    const body = readZipEntry(docxBuf, entries.find((e) => e.name === 'word/document.xml')).toString('utf8');
    docxOk =
      names.includes('word/document.xml') &&
      names.includes('word/styles.xml') &&
      body.includes('崩溃分析报告') &&
      body.includes('<w:tbl>') &&
      body.includes('NullPointerException') === false; // 这条回复里没有这段，确认没串内容
    docxDetail = `entries=${names.length} len=${body.length} table=${body.includes('<w:tbl>')}`;
  } catch (e) {
    docxDetail = 'ERR ' + e.message;
  }
  ok(docxOk, '🔴 docx 内部结构齐（document.xml / styles.xml / 标题 / 表格）', docxDetail);

  await read(win, `(() => { const s = document.querySelectorAll('.ai-export-card select')[1];
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, 'pdf'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(250);
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await sleep(2500);
  const pdfPath = path.join(EXPORT_DIR, '崩溃分析报告.pdf');
  const pdfBuf = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath) : Buffer.alloc(0);
  ok(pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-', '导出成 .pdf（文件头正确）', `${pdfBuf.length}B`);
  ok(pdfBuf.length > 3000, 'pdf 不是空壳（一页 A4 至少几 KB）', `${pdfBuf.length}B`);

  /* 重名不覆盖：再存一次 md，应出现「(1)」 */
  await read(win, `(() => { const s = document.querySelectorAll('.ai-export-card select')[1];
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, 'md'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(250);
  await click(win, '.ai-export-card .ai-export-actions button:nth-child(1)');
  await sleep(800);
  const mdFiles = fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.md'));
  ok(
    mdFiles.some((f) => f.includes('(1)')) && mdFiles.includes('崩溃分析报告.md'),
    '🔴 同名文件不覆盖，自动加序号',
    `md=${mdFiles.join(',')}`,
  );

  /* Esc 关闭对话框 */
  await read(win, `(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true)`);
  const closed = await waitFor(win, `!document.querySelector('.ai-export-card')`, 2500);
  ok(closed, 'Esc 关闭导出对话框', `closed=${closed}`);

  /* ---- 3. 粘贴图片 ---- */
  const PNG_HEX =
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
  const pasted = await read(
    win,
    `(() => {
      const hex = '${PNG_HEX}';
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      const file = new File([bytes], 'image.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ta = document.querySelector('.ai-input');
      if (!ta) return 'no-textarea';
      ta.focus();
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      const notPrevented = ta.dispatchEvent(ev);
      return notPrevented ? 'not-prevented' : 'ok';
    })()`,
  );
  ok(pasted === 'ok', '🔴 粘贴图片时接管事件（不让文件名文本落进输入框）', `res=${pasted}`);
  const attSeen = await waitFor(win, `!!document.querySelector('.ai-composer .ai-att.att-image')`, 6000);
  const attInfo = await read(
    win,
    `(() => {
      const el = document.querySelector('.ai-composer .ai-att.att-image');
      return { exists: !!el, name: (el?.querySelector('.ai-att-name')?.textContent || '').trim(),
               thumb: !!el?.querySelector('.ai-att-thumb'), title: el?.querySelector('.ai-att-name')?.title || '' };
    })()`,
  );
  ok(attSeen, '🔴 粘贴后输入区多出一个图片附件', `exists=${attInfo.exists}`);
  ok(attInfo.thumb, '附件带缩略图（file:// 预览）');
  const pasteDirPath = path.join(DATA, 'ai-paste');
  const pasteFiles = fs.existsSync(pasteDirPath) ? fs.readdirSync(pasteDirPath) : [];
  ok(
    pasteFiles.length === 1 && /^paste-.*\.png$/.test(pasteFiles[0]),
    '图片被落成临时文件（附件只认路径）',
    `files=${pasteFiles.join(',')}`,
  );
  ok(
    !!attInfo.title && attInfo.title.includes('ai-paste') && /paste-.*\.png$/.test(attInfo.title),
    '附件路径指向那个临时文件',
    `path=${attInfo.title}`,
  );

  /* 纯文本粘贴必须放行 */
  const textPaste = await read(
    win,
    `(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello');
      const ta = document.querySelector('.ai-input');
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
      return ta.dispatchEvent(ev) ? 'not-prevented' : 'prevented';
    })()`,
  );
  ok(textPaste === 'not-prevented', '🔴 纯文本粘贴不被拦截（默认行为照旧）', `res=${textPaste}`);

  /* 清掉附件，避免影响后面的拖放断言 */
  await click(win, '.ai-composer .ai-att .ai-att-x');
  await sleep(200);

  /* ---- 4. 拖放只在输入区生效 ---- */
  const dropzone = await read(
    win,
    `(() => {
      const el = document.querySelector('.ai-composer');
      return { attr: el?.getAttribute('data-dropzone') || '', hasHanlder: !!el };
    })()`,
  );
  ok(!!dropzone.attr, '🔴 输入区带 data-dropzone 标记（窗级拖放安装据此让路）', `attr=${dropzone.attr}`);

  /*
   * 🔴 两个细节都踩过，缺一个就是假 FAIL：
   *   ① dataTransfer 必须在构造后 defineProperty 挂上去 ——
   *      new DragEvent(t, { dataTransfer }) 在 Chromium 里照样能带上，
   *      但显式挂一遍最保险（早期版本会丢）；
   *   ② 派发与断言**必须分成两次 executeJavaScript** —— React 的 setState 是异步的，
   *      同一段同步代码里读 className 拿到的一定是旧值（第一版就是这么假 FAIL 的）。
   */
  await read(
    win,
    `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1,2,3])], 'a.png', { type: 'image/png' }));
      const el = document.querySelector('.ai-composer');
      for (const type of ['dragenter', 'dragover']) {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        el.dispatchEvent(ev);
      }
      return true;
    })()`,
  );
  await sleep(400);
  const dragOnComposer = await read(
    win,
    `(() => ({
      hint: !!document.querySelector('.ai-drop-hint'),
      cls: document.querySelector('.ai-composer')?.className || '',
      veil: !!document.querySelector('.drop-veil'),
    }))()`,
  );
  ok(dragOnComposer.hint && /drag-on/.test(dragOnComposer.cls), '🔴 拖到输入区上方时这一块高亮并提示', `cls=${dragOnComposer.cls}`);
  ok(dragOnComposer.veil === false, '🔴 拖到输入区时**不出现**整窗「松开即可安装」遮罩', `veil=${dragOnComposer.veil}`);

  // 松手（用 dragleave 收尾，空 files 的 drop 不做任何事）
  await read(
    win,
    `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
      const el = document.querySelector('.ai-composer');
      const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
      return true;
    })()`,
  );
  await sleep(250);
  const afterLeave = await read(win, `!!document.querySelector('.ai-drop-hint')`);
  ok(afterLeave === false, '拖走之后高亮与提示自己消失', `hint=${afterLeave}`);

  /* 换到别的页面拖 → 整窗安装遮罩照旧出现（其它页行为没被改） */
  await click(win, '.nav-item[href="#/tools"]');
  await waitFor(win, `location.hash === '#/tools'`, 4000);
  await sleep(500);
  await read(
    win,
    `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1,2,3])], 'a.apk', { type: 'application/vnd.android.package-archive' }));
      const fire = (type) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        document.body.dispatchEvent(ev);
      };
      fire('dragenter');
      fire('dragover');
      return true;
    })()`,
  );
  await sleep(400);
  const otherPage = await read(
    win,
    `(() => ({ veil: !!document.querySelector('.drop-veil'),
               onAiPage: !!document.querySelector('.ai-composer') }))()`,
  );
  await read(
    win,
    `(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'a.apk', { type: 'application/vnd.android.package-archive' }));
      const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      document.body.dispatchEvent(ev);
      return true;
    })()`,
  );
  ok(otherPage.onAiPage === false, '已经离开 AI 页', `ai=${otherPage.onAiPage}`);
  ok(otherPage.veil === true, '🔴 其它页面拖文件仍是原来的「松开即可安装」整窗提示', `veil=${otherPage.veil}`);

  /* 回到 AI 页，确认输入区没有残留 */
  await gotoChat();
  const finalState = await read(
    win,
    `(() => ({
      atts: document.querySelectorAll('.ai-composer .ai-att').length,
      dialog: !!document.querySelector('.ai-export-card'),
      hint: !!document.querySelector('.ai-drop-hint'),
    }))()`,
  );
  ok(finalState.atts === 0 && !finalState.dialog && !finalState.hint, '回到 AI 页时没有残留附件/弹窗/提示', JSON.stringify(finalState));

  ok(rendererErrors.length === 0, '渲染层无报错', rendererErrors.slice(0, 2).join(' | '));

  log('=== AI COMPOSE CHECK ===');
  for (const r of rows) log(r);
  log('AI COMPOSE CHECK DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
