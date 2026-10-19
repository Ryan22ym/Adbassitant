/**
 * AI 助手 + 崩溃自动分析校验（v1.1.14）。
 *
 * 这一块是「配置驱动的整条链」，纯类型检查盖不住，必须真跑一次：
 *   1. 侧栏有没有 AI 入口、是否排在「设置」之前；
 *   2. Conf/ai.json 是否真的被主进程读出来并渲染进「模型接入」表单
 *      （出厂 6 家、activeProvider=deepseek、缺 key 时给出提示）；
 *   3. 对话面板的三条附件入口（图片 / 文件 / 链接）与发送按钮是否齐；
 *   4. 崩溃监听状态条是否跟着「设置页最后一行那个开关」实时变化
 *      —— 这需要把 main.ts 里的 settingsChangedHook → syncCrashWatch 接线
 *        在本脚本里照样接一遍，否则开关点了状态条不动（假 FAIL）；
 *   5. 未读报告 → 侧栏红点 → 进页面看报告 → 红点消失 这条链。
 *
 * 🔴 用**独立的 userData 临时目录**：本脚本要往报告索引里塞一份伪造报告，
 *    写进用户真实的 %APPDATA%\adb-assistant\ 会留下垃圾数据。
 *    userData 一改，settings.json / ai-chats.json / crash-reports.json 全都隔离。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-ai-page.cjs \
 *     --watch ui-shots/_ai-page.log --until "AI PAGE CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_ai-page.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

/* ------------------------------------------------------------------ */
/* 隔离的 userData + 一份伪造的崩溃报告                                  */
/* ------------------------------------------------------------------ */

/*
 * 🔴 目录名**每次运行都不一样**（带 pid），不用「先删再建」。
 *    踩过：写成固定的 `ui-shots/_ai-page-data` 时，第二次运行要在
 *    `fs.rmSync` 里删掉上一次留下的一整套 Chromium profile ——
 *    只要还有任何一个句柄没放开（上一次的 electron 进程常常拖延退出），
 *    这行就抛 EBUSY，而且是在模块顶层抛的：日志连清空都轮不到，
 *    表现成「Electron 起来了但一个字都不写、干等到超时」。
 *    换个新目录就完全绕开了这件事。
 */
const DATA = path.join(os.tmpdir(), `adb-ai-check-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const REPORT_DIR = path.join(DATA, 'crash', 'OPPO PGT-AN00', '2026-10-16');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const REPORT_ID = 'check-report-1';
const REPORT_AT = new Date('2026-10-16T14:03:25').getTime();
const REPORT_MD = path.join(REPORT_DIR, 'crash-report_20261016-140325.md');
const REPORT_LOG = path.join(REPORT_DIR, 'crash_20261016-140325.log.txt');

/*
 * 报告正文**照抄 crash.ts 生成的结构**（标题 / 无序列表字段 / 围栏块 / 引用 / 分隔线）。
 * 界面用的是一套自写的极简 Markdown 渲染器，只有喂给它真实结构才能验到：
 * 「崩溃发生时间 / 设备名称 / 崩溃前执行的操作 / AI 分析」四段都在。
 */
fs.writeFileSync(
  REPORT_MD,
  '\ufeff' +
    [
      '# 崩溃分析报告',
      '',
      '- **崩溃发生时间**：2026-10-16 14:03:25.118',
      '- **设备名称**：OPPO PGT-AN00 · Android 10（aaab4f58）',
      '- **崩溃应用**：com.example.demo',
      `- **日志文件**：${REPORT_LOG}`,
      '- **报告生成**：2026-10-16 14:03:41.902',
      '- **分析模型**：deepseek-chat',
      '- **触发方式**：自动（检测到闪退）',
      '',
      '## 崩溃前执行的操作',
      '',
      '```text',
      '14:02:51 [命令] adb shell am start -n com.example.demo/.MainActivity',
      '14:03:10 [投屏] 开始投屏 aaab4f58',
      '```',
      '',
      '## AI 分析',
      '',
      '一、崩溃原因：`MainActivity.onCreate` 里读到的 intent extra 为 null，直接解引用导致空指针。',
      '二、关键日志：',
      '- `NullPointerException: Attempt to invoke virtual method on a null object reference`',
      '- `FATAL EXCEPTION: main`',
      '三、复现路径：冷启动 → 不传 extra 直接进入主界面。',
      '四、修复建议：给 extra 加默认值，或在使用前判空。',
      '',
      '下面是**故意塞进来的一行原始 HTML**，用来验「报告正文不会被当 HTML 解析」：',
      '<b>这段文字必须原样显示，不能变成粗体元素</b>',
      '',
      '> ⚠️ 以上结论仅基于日志，未在真机复现验证。',
      '',
      '---',
      '',
      `日志原文见：\`${REPORT_LOG}\``,
    ].join('\r\n'),
  'utf8',
);
fs.writeFileSync(REPORT_LOG, '\ufeff（伪造的日志文件，仅用于校验定位入口）\r\n', 'utf8');

const REPORT_META = {
  id: REPORT_ID,
  at: REPORT_AT,
  deviceLabel: 'OPPO PGT-AN00 · Android 10',
  serial: 'aaab4f58',
  packageName: 'com.example.demo',
  summary: '空指针：MainActivity.onCreate 读到的 intent extra 为 null 后直接解引用。',
  reportPath: REPORT_MD,
  logPath: REPORT_LOG,
  dir: REPORT_DIR,
  read: false,
  model: 'deepseek-chat',
};
fs.writeFileSync(path.join(DATA, 'crash-reports.json'), JSON.stringify([REPORT_META], null, 2), 'utf8');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询一个返回布尔值的渲染层表达式 */
async function waitFor(win, expr, timeout = 4000, step = 120) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await win.webContents.executeJavaScript(expr);
    if (last) return true;
    await sleep(step);
  }
  return false;
}

function read(win, expr) {
  return win.webContents.executeJavaScript(expr);
}

/** 点一个元素（不存在就返回 false） */
function click(win, sel) {
  return win.webContents.executeJavaScript(`
    (() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()
  `);
}

/**
 * 点「设置页最后一个 .setting-line 里的开关」。
 *
 * 🔴 不能用 `.setting-line:last-of-type .switch`：每个 .setting-line 都各自
 *    待在一张 Card 里，`last-of-type` 是按**父节点内同类型元素**算的 ——
 *    它会在每一张卡片里都命中，选到的根本不是最后一行。
 *    只能取出全部再按数组下标点。
 */
function clickLastSettingSwitch(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.setting-line')];
      const sw = rows[rows.length - 1]?.querySelector('.switch');
      if (!sw) return false;
      sw.click();
      return true;
    })()
  `);
}

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  /*
   * 先把「走到哪一步了」落盘再干活：这个脚本要起两个窗口、跑十来条异步等待，
   * 万一卡在注册 IPC 或建窗口上，日志里至少能看到进度，不至于连清空都轮不到
   * （上一次就是这么被误导成「Electron 起来了但一个字都不写」的）。
   */
  log('userData = ' + DATA);
  log('registerIpc …');

  const { registerIpc, setSettingsChangedHook } = require('../dist-electron/electron/ipc.js');
  const { syncCrashWatch, getCrashWatchStatus } = require('../dist-electron/electron/services/crash.js');
  registerIpc();
  /*
   * 🔴 照 main.ts 把两条链路接上。少了它们：
   *   · 设置页开关 → syncCrashWatch：状态条永远停在「开关未开启」；
   *   · 监听器状态 → PUSH_AI_CRASH_STATUS：界面收不到推送。
   */
  setSettingsChangedHook(() => {
    syncCrashWatch();
  });
  syncCrashWatch();

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const rendererErrors = [];

  async function makeWindow() {
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
    return win;
  }

  /* ================================================================ */
  /* 窗口 1：带着一份「未读」报告启动                                   */
  /* ================================================================ */

  const win = await makeWindow();
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await win.show();
  await sleep(1400);

  /* ---- A. 侧栏入口 ---- */
  const navInfo = await read(
    win,
    `(() => {
      const items = [...document.querySelectorAll('.nav-item')];
      return {
        hrefs: items.map((e) => e.getAttribute('href')),
        labels: items.map((e) => (e.querySelector('.nav-label')?.textContent || '').trim()),
      };
    })()`,
  );
  const aiIdx = navInfo.hrefs.indexOf('#/ai');
  const setIdx = navInfo.hrefs.indexOf('#/settings');
  ok(aiIdx >= 0, '侧栏有「AI 助手」入口', `hrefs=${navInfo.hrefs.join(',')}`);
  ok(navInfo.labels[aiIdx] === 'AI 助手', '入口文字 = AI 助手', `label=${navInfo.labels[aiIdx]}`);
  ok(aiIdx >= 0 && setIdx > aiIdx, '🔴 AI 入口排在「设置」之前', `ai=${aiIdx} settings=${setIdx}`);
  /*
   * 报告索引是启动后异步拉的，红点会晚一两拍才亮 —— 必须轮询等它。
   * 直接 sleep 固定时长后读一次，会把它误判成「红点不亮」。
   */
  const dotSeen = await waitFor(
    win,
    `!!document.querySelector('.nav-item[href="#/ai"] .nav-dot')`,
    8000,
  );
  ok(dotSeen, '🔴 有未读报告时侧栏亮红点（启动就把未读数拉回来了）', `dot=${dotSeen}`);

  /* ---- 进入 AI 页 ---- */
  await click(win, '.nav-item[href="#/ai"]');
  await waitFor(win, `!!document.querySelector('.ai-page')`);
  /*
   * 报告索引是启动后异步拉回来的：得等 store 里有了未读数，
   * 「带未读进来 → 落在崩溃报告」这条默认才可能生效。
   * 用 .ai-status 出现作为「已经切到报告页」的信号。
   */
  const landedOnReports = await waitFor(win, `!!document.querySelector('.ai-page .ai-status')`, 5000);
  await sleep(300);

  const head = await read(
    win,
    `(() => ({
      hash: location.hash,
      title: (document.querySelector('.header-title')?.textContent || '').trim(),
      tabs: [...document.querySelectorAll('.ai-head .segmented-item')].map((e) => e.textContent.trim()),
      activeTab: (document.querySelector('.ai-head .segmented-item.active')?.textContent || '').trim(),
      hasCfg: !!document.querySelector('.ai-cfg'),
    }))()`,
  );
  ok(head.hash === '#/ai', '点击后路由到 /ai', `hash=${head.hash}`);
  ok(head.title === 'AI 助手', '页头标题 = AI 助手', `title=${head.title}`);
  ok(head.tabs.length === 2, '有「对话 / 崩溃报告」两个标签', `tabs=${head.tabs.join(' | ')}`);
  ok(
    head.activeTab.includes('崩溃报告'),
    '🔴 有未读报告时默认停在「崩溃报告」（红点点进来要能直接看到东西）',
    `active=${head.activeTab} landed=${landedOnReports}`,
  );

  /* ---- B. 模型接入表单（读的是真 Conf/ai.json）---- */
  const cfgForm = await read(
    win,
    `(() => {
      const sel = document.querySelector('.ai-cfg select');
      const byLabel = {};
      const fields = [...document.querySelectorAll('.ai-cfg .field')];
      for (const f of fields) {
        /*
         * 🔴 标签文字只能取 .field-label 的**首个文本节点**：
         *    Field 把 label 与 hint 一起塞进同一个 span（hint 是个 <em>），
         *    直接读 textContent 会得到「接口地址写到 /v1 为止，不要带 …」，
         *    按 label 精确查表就永远查不到。
         */
        const lbEl = f.querySelector('.field-label');
        const lb = (lbEl?.firstChild?.textContent || '').trim();
        const el = f.querySelector('input, select, textarea');
        if (lb && el) byLabel[lb] = el.value;
      }
      return {
        providerCount: sel ? sel.options.length : -1,
        activeProvider: sel ? sel.value : '',
        labels: Object.keys(byLabel),
        fields: byLabel,
        warn: (document.querySelector('.ai-page .notice-warn')?.textContent || '').trim(),
      };
    })()`,
  );
  ok(head.hasCfg, '「模型接入」卡片存在', `hasCfg=${head.hasCfg}`);
  ok(cfgForm.providerCount === 6, 'Conf/ai.json 的 6 家提供商都读到了', `count=${cfgForm.providerCount}`);
  ok(cfgForm.activeProvider === 'deepseek', 'activeProvider = deepseek', `active=${cfgForm.activeProvider}`);
  ok(
    cfgForm.fields['模型名'] === 'deepseek-flash',
    '模型名回填 = deepseek-flash（来自 ai.json 而不是界面写死）',
    `model=${cfgForm.fields['模型名']}`,
  );
  ok(
    cfgForm.fields['接口地址'] === 'https://api.deepseek.com/v1',
    '接口地址回填正确（尾斜杠已被规范化去掉）',
    `baseUrl=${cfgForm.fields['接口地址']}`,
  );
  ok(
    cfgForm.fields['API Key'] === '',
    '出厂 apiKey 为空（必须用户自己填）',
    `key=${JSON.stringify(cfgForm.fields['API Key'])}`,
  );
  ok(
    cfgForm.warn.includes('还没有可用的模型'),
    '🔴 没配 Key 时给出提示（不给提示用户会以为对话坏了）',
    `warn=${cfgForm.warn.slice(0, 40)}`,
  );

  /* ---- C. 崩溃报告面板 ---- */
  const statusBar = await read(
    win,
    `(() => {
      const el = document.querySelector('.ai-status');
      return {
        exists: !!el,
        state: el ? el.getAttribute('data-crash-status') : null,
        text: el ? el.textContent.trim() : '',
        hasAnalyze: [...document.querySelectorAll('.ai-status button')].some((b) =>
          b.textContent.includes('立即分析'),
        ),
        hint: (document.querySelector('.ai-status-text span')?.textContent || '').trim(),
      };
    })()`,
  );
  ok(statusBar.exists, '崩溃报告页有监听状态条', `state=${statusBar.state}`);
  ok(statusBar.state === 'idle', '开关没开时状态是 idle', `state=${statusBar.state}`);
  ok(
    statusBar.hint.includes('开关未开启'),
    '状态条把「为什么没在监听」说清楚',
    `hint=${statusBar.hint}`,
  );
  ok(statusBar.hasAnalyze, '有「立即分析当前应用」手动入口', `analyze=${statusBar.hasAnalyze}`);

  /* ---- D. 报告列表 + 详情（含四段必需内容）---- */
  const listInfo = await read(
    win,
    `(() => {
      const items = [...document.querySelectorAll('.ai-report-item')];
      return {
        count: items.length,
        pkg: (items[0]?.querySelector('.ai-report-pkg')?.textContent || '').trim(),
        sum: (items[0]?.querySelector('.ai-report-sum')?.textContent || '').trim(),
      };
    })()`,
  );
  ok(listInfo.count === 1, '报告列表读到 1 份', `count=${listInfo.count}`);
  ok(listInfo.pkg === 'com.example.demo', '列表项显示崩溃包名', `pkg=${listInfo.pkg}`);
  ok(listInfo.sum.includes('空指针'), '列表项显示一句话摘要', `sum=${listInfo.sum.slice(0, 24)}`);
  /*
   * ⚠️ 这里**不能**断言「列表里有小红点」：带未读进来时页面会自动选中最新那份，
   *    而「正在看的那份算已读」是同一个 tick 里发生的 —— 等到详情渲染出来再读，
   *    小红点必然已经消失。那是**正确行为**，不是 bug。
   *    「列表里的红点」只能在「已经在看旧报告、又来了新报告」时观察到，
   *    放在最后用推送专门验（见窗口 2 末尾）。
   */

  await waitFor(win, `!!document.querySelector('.ai-report-detail .ai-md')`);
  await sleep(300);
  const detail = await read(
    win,
    `(() => {
      const metas = [...document.querySelectorAll('.ai-report-meta > div')].map((d) => [
        (d.querySelector('span')?.textContent || '').trim(),
        (d.querySelector('strong')?.textContent || '').trim(),
      ]);
      const labels = metas.map((m) => m[0]);
      const val = (k) => (metas.find((m) => m[0] === k) || [])[1] || '';
      return {
        labels,
        device: val('设备名称'),
        pkg: val('崩溃应用'),
        at: val('崩溃发生时间'),
        h2: [...document.querySelectorAll('.ai-report-body .ai-md h2')].map((e) => e.textContent.trim()),
        h3: [...document.querySelectorAll('.ai-report-body .ai-md h3')].map((e) => e.textContent.trim()),
        preCount: document.querySelectorAll('.ai-report-body .ai-md pre').length,
        quoteCount: document.querySelectorAll('.ai-report-body .ai-md blockquote').length,
        /* 🔴 报告里有设备日志原文：任何一段都不许被当成 HTML 渲染出来 */
        injectedTags: document.querySelectorAll(
          '.ai-report-body .ai-md b, .ai-report-body .ai-md script, .ai-report-body .ai-md img',
        ).length,
        body: (document.querySelector('.ai-report-body')?.textContent || ''),
        buttons: [...document.querySelectorAll('.ai-report-actions button')].map((b) =>
          b.textContent.trim(),
        ),
      };
    })()`,
  );
  ok(detail.h2.includes('崩溃分析报告'), '详情渲染出报告标题（极简 Markdown 生效）', `h2=${detail.h2.join(',')}`);
  ok(
    detail.labels.includes('崩溃发生时间') && !!detail.at,
    '🔴 详情含「崩溃发生时间」',
    `at=${detail.at}`,
  );
  ok(
    detail.labels.includes('设备名称') && detail.device.includes('OPPO'),
    '🔴 详情含「设备名称」',
    `device=${detail.device}`,
  );
  ok(detail.h3.includes('崩溃前执行的操作'), '🔴 详情含「崩溃前执行的操作」小节', `h3=${detail.h3.join(' / ')}`);
  ok(detail.preCount >= 1, '操作记录渲染成等宽代码块', `pre=${detail.preCount}`);
  ok(detail.h3.includes('AI 分析'), '🔴 详情含「AI 分析」小节');
  ok(
    detail.injectedTags === 0 && detail.body.includes('这段文字必须原样显示'),
    '🔴 报告正文里的原始 HTML 只当文本渲染（不执行日志里的标记 —— 没有 dangerouslySetInnerHTML）',
    `注入元素=${detail.injectedTags} 文本在位=${detail.body.includes('这段文字必须原样显示')}`,
  );
  ok(detail.quoteCount >= 1, '引用块（> 开头）被识别', `quote=${detail.quoteCount}`);
  const btns = detail.buttons.join(' | ');
  ok(btns.includes('定位报告文件夹'), '🔴 有「定位报告文件夹」一键入口', `buttons=${btns}`);
  ok(btns.includes('定位报告文件') || btns.includes('定位日志文件'), '可定位到具体文件');

  /* ---- E. 看过即已读 → 红点消失 ---- */
  const dotGone = await waitFor(win, `!document.querySelector('.nav-item[href="#/ai"] .nav-dot')`, 3000);
  const tabAfter = await read(
    win,
    `(document.querySelector('.ai-head .segmented-item:nth-child(2)')?.textContent || '').trim()`,
  );
  ok(dotGone, '🔴 看过报告后侧栏红点消失（未读被消费）', `dotGone=${dotGone}`);
  ok(!/\d/.test(tabAfter), '标签上的未读数也一起清掉', `tab=${tabAfter}`);
  const idxAfter = await read(win, `window.adbApi.crashReports().then((r) => r.data[0].read)`);
  ok(idxAfter === true, '已读状态写回主进程索引', `read=${idxAfter}`);

  /* ---- F. 对话面板（切到「对话」标签验）---- */
  await click(win, '.ai-head .segmented-item:nth-child(1)');
  await sleep(500);
  const chat = await read(
    win,
    `(() => {
      const btns = [...document.querySelectorAll('.ai-composer-bar button')].map((b) =>
        b.textContent.trim(),
      );
      return {
        hasLayout: !!document.querySelector('.ai-layout'),
        hasSide: !!document.querySelector('.ai-side'),
        hasChat: !!document.querySelector('.ai-chat'),
        newBtn: [...document.querySelectorAll('.ai-side-head button')].some((b) =>
          b.textContent.includes('新建对话'),
        ),
        btns,
        sendDisabled: (document.querySelector('.ai-composer-bar .btn-primary') || {}).disabled,
        input: !!document.querySelector('.ai-input'),
        sideEmpty: (document.querySelector('.ai-side-empty')?.textContent || '').trim(),
      };
    })()`,
  );
  ok(chat.hasLayout && chat.hasSide && chat.hasChat, '对话页是「会话列表 + 对话窗口」两栏');
  ok(chat.newBtn, '有「新建对话」');
  ok(chat.sideEmpty.includes('还没有历史对话'), '没有历史时会话列表给出空态', `empty=${chat.sideEmpty}`);
  ok(chat.input, '有多行输入框');
  ok(
    chat.btns.includes('图片') && chat.btns.includes('文件') && chat.btns.includes('链接'),
    '🔴 图片 / 文件 / 链接三种附件入口都在',
    `btns=${chat.btns.join('|')}`,
  );
  ok(chat.btns.includes('发送'), '有发送按钮');
  ok(chat.sendDisabled === true, '没有 Key 时发送按钮是禁用的（点不出错误弹窗）');

  await click(win, '.ai-composer-bar button:nth-child(3)');
  await sleep(250);
  const linkRow = await read(
    win,
    `(() => {
      const row = document.querySelector('.ai-link-row');
      return { exists: !!row, placeholder: row?.querySelector('input')?.placeholder || '' };
    })()`,
  );
  ok(linkRow.exists, '点「链接」后出现地址输入行', `exists=${linkRow.exists}`);
  ok(linkRow.placeholder.includes('网页地址'), '链接输入框有可读提示', `ph=${linkRow.placeholder.slice(0, 20)}`);

  /* ---- H. 切走再回来要接上上次那段对话 ---- */
  /*
   * 造一段历史：调主进程的 appendToSession 写进会话文件。
   *
   * 🔴 不能直接往 ai-chats.json 里写文件 —— ai.ts 有内存缓存，
   *    F 段渲染对话面板时已经 load 过一次（当时是空数组），
   *    之后再改文件，内存里还是空的。必须走它自己的写入口。
   */
  const aiSvc = require('../dist-electron/electron/services/ai.js');
  const sessId = aiSvc.appendToSession(undefined, [
    { id: 'm-1', role: 'user', content: '上次聊到哪了？', time: Date.now() - 60000 },
    {
      id: 'm-2',
      role: 'assistant',
      content: '上次停在「投屏延迟排查」这一步。',
      model: 'deepseek-flash',
      time: Date.now() - 59000,
    },
  ]);
  log('造历史会话 ' + sessId);

  // 假装用户上次就停在这段（正常使用时是「发送 / 点开列表」时写进去的）
  await read(win, `(localStorage.setItem('adb.ai.lastSession', ${JSON.stringify(sessId)}), true)`);

  // 切走再切回：AiPage 整个卸载重建，正好覆盖「用户切到别的模块」这条路
  const backToChat = async () => {
    // ⚠️ 「设备」页的 href 是 `#/`（首页），不是 `#/device` ——
    //    写成后者 click 会落空，页面根本没卸载，等于什么都没验。
    await click(win, '.nav-item[href="#/tools"]');
    await sleep(400);
    await click(win, '.nav-item[href="#/ai"]');
    await waitFor(win, `!!document.querySelector('.ai-head')`);
    await sleep(300);
    // 万一进来落在「崩溃报告」，切回「对话」——真实路径是同一次挂载
    if (!(await read(win, `!!document.querySelector('.ai-chat')`))) {
      await click(win, '.ai-head .segmented-item:nth-child(1)');
      await sleep(500);
    }
    await sleep(500);
  };
  await backToChat();

  const restored = await read(
    win,
    `(() => ({
      bubbles: document.querySelectorAll('.ai-bubble').length,
      // ⚠️ 助手消息走的是 Markdown 渲染（MdView），没有 .ai-bubble-text；
      //    取整个气泡的 textContent 才不会漏掉回复内容。
      texts: [...document.querySelectorAll('.ai-bubble')].map((e) => e.textContent.trim()),
      active: [...document.querySelectorAll('.ai-session')].findIndex((e) => e.classList.contains('on')),
      count: document.querySelectorAll('.ai-session').length,
    }))()`,
  );
  ok(restored.count === 1, '造出来的历史会话出现在左侧列表', `count=${restored.count}`);
  ok(
    restored.bubbles === 2,
    '🔴 切走再切回来，自动接上上次那段对话（不是空白新对话）',
    `bubbles=${restored.bubbles}`,
  );
  ok(
    restored.texts.some((t) => t.includes('投屏延迟排查')),
    '恢复出来的是同一段对话的内容',
    `texts=${restored.texts.join(' / ').slice(0, 40)}`,
  );
  ok(restored.active === 0, '左侧列表的高亮也跟着恢复到那段', `activeIdx=${restored.active}`);

  /* 点「新建对话」之后就不该再记着上一段了 */
  await click(win, '.ai-side-head button');
  await sleep(400);
  const afterNew = await read(
    win,
    `(() => ({
      saved: localStorage.getItem('adb.ai.lastSession'),
      bubbles: document.querySelectorAll('.ai-bubble').length,
    }))()`,
  );
  ok(afterNew.saved === null, '点「新建对话」后清掉「上次会话」标记', `saved=${afterNew.saved}`);
  ok(afterNew.bubbles === 0, '新建后消息区是空的', `bubbles=${afterNew.bubbles}`);

  await backToChat();
  const afterBack = await read(win, `document.querySelectorAll('.ai-bubble').length`);
  ok(
    afterBack === 0,
    '🔴 新建对话后切走再回来仍停在空对话（不会又跳回旧会话）',
    `bubbles=${afterBack}`,
  );

  /* ---- G. 设置页最后一行开关 ---- */
  await click(win, '.nav-item[href="#/settings"]');
  await waitFor(win, `!!document.querySelector('.setting-line')`);
  await sleep(500);
  const lastRow = await read(
    win,
    `(() => {
      const rows = [...document.querySelectorAll('.setting-line')];
      const last = rows[rows.length - 1];
      const sw = last?.querySelector('.switch');
      return {
        count: rows.length,
        label: (last?.querySelector('.setting-line-label')?.textContent || '').trim(),
        hasSwitch: !!sw,
        checked: sw?.getAttribute('aria-checked'),
        note: (last?.querySelector('.setting-note')?.textContent || '').trim(),
        switchCount: last?.querySelectorAll('.switch').length ?? 0,
      };
    })()`,
  );
  ok(
    lastRow.label === '检测崩溃自动AI分析日志',
    '🔴 设置页最后一行就是那个开关',
    `label=${lastRow.label}`,
  );
  ok(lastRow.hasSwitch && lastRow.switchCount === 1, '该行只有一个开关', `switches=${lastRow.switchCount}`);
  ok(lastRow.checked === 'false', '默认关闭', `aria-checked=${lastRow.checked}`);
  ok(lastRow.note === '', '🔴 开关旁没有任何说明文字（需求就是这么要求的）', `note="${lastRow.note}"`);

  /* 打开它：设置落盘 + 监听状态跟着变（走 settingsChangedHook → syncCrashWatch） */
  await clickLastSettingSwitch(win);
  await sleep(700);
  const afterOn = await read(
    win,
    `(() => {
      const rows = [...document.querySelectorAll('.setting-line')];
      const last = rows[rows.length - 1];
      return { checked: last?.querySelector('.switch')?.getAttribute('aria-checked') };
    })()`,
  );
  const savedFlag = await read(win, `window.adbApi.getSettings().then((r) => r.data.crashAutoAnalyze)`);
  ok(afterOn.checked === 'true', '点击后开关变开', `aria-checked=${afterOn.checked}`);
  ok(savedFlag === true, 'crashAutoAnalyze 已落盘', `saved=${savedFlag}`);

  const watchStatus = await read(win, `window.adbApi.crashWatchStatus().then((r) => r.data)`);
  ok(watchStatus?.enabled === true, '🔴 主进程读到的开关状态跟着变了', `enabled=${watchStatus?.enabled}`);
  ok(
    watchStatus?.watching === false && String(watchStatus?.note || '').includes('等待投屏'),
    '🔴 开关开了但没投屏 → 不监听，并说明原因（不常驻白烧 logcat）',
    `watching=${watchStatus?.watching} note=${watchStatus?.note}`,
  );

  /*
   * 回到 AI 页 → 切到「崩溃报告」：状态条那句话应该已经从「开关未开启」
   * 换成「等待投屏开始」—— 证明 设置落盘 → settingsChangedHook → syncCrashWatch
   * → 推送 → 界面 这条链是通的（只验 IPC 返回值的话，推送断链看不出来）。
   *
   * ⚠️ 必须显式点一下「崩溃报告」标签：此时未读已经清零，页面默认落在「对话」，
   *    `.ai-status` 根本不在 DOM 里（之前就是漏了这一步导致读到空字符串）。
   */
  await click(win, '.nav-item[href="#/ai"]');
  await waitFor(win, `!!document.querySelector('.ai-page')`);
  await click(win, '.ai-head .segmented-item:nth-child(2)');
  const hintOk = await waitFor(
    win,
    `(document.querySelector('.ai-status-text span')?.textContent || '').includes('等待投屏')`,
    5000,
  );
  const hint2 = await read(win, `(document.querySelector('.ai-status-text span')?.textContent || '').trim()`);
  ok(hintOk, '🔴 状态条经推送实时更新（开关开启后换成「等待投屏开始」）', `hint=${hint2}`);

  win.hide();

  /* ================================================================ */
  /* 窗口 2：报告已读、未读为 0 —— 默认该停在「对话」                    */
  /* ================================================================ */

  const win2 = await makeWindow();
  await win2.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/ai' });
  await win2.show();
  /*
   * 等够：App 的初始化是一串串行 IPC（界面配置 → 设置 → 签名 → 日志 → 报告索引 → …），
   * 日志一大，前几步就能吃掉两秒多，报告索引排在后面，等太短会读到空 store。
   */
  await sleep(3200);
  const w2 = await read(
    win2,
    `(() => ({
      activeTab: (document.querySelector('.ai-head .segmented-item.active')?.textContent || '').trim(),
      dot: !!document.querySelector('.nav-item[href="#/ai"] .nav-dot'),
    }))()`,
  );
  ok(w2.activeTab === '对话', '🔴 没有未读时默认停在「对话」（Conf 的 ai.chat 生效）', `active=${w2.activeTab}`);
  ok(!w2.dot, '没有未读就不亮红点', `dot=${w2.dot}`);

  /* 已读的历史报告仍在列表里（要显式切到报告页才看得到列表） */
  await click(win2, '.ai-head .segmented-item:nth-child(2)');
  await waitFor(win2, `!!document.querySelector('.ai-report-item')`, 8000);
  const w2list = await read(
    win2,
    `(() => ({
      reports: document.querySelectorAll('.ai-report-item').length,
      unreadDots: document.querySelectorAll('.ai-report-item .ai-unread-dot').length,
    }))()`,
  );
  ok(w2list.reports === 1, '已读的历史报告仍在列表里', `reports=${w2list.reports}`);
  ok(w2list.unreadDots === 0, '已读的那份不带未读小红点', `dots=${w2list.unreadDots}`);

  /* ================================================================ */
  /* 窗口 2 末尾：正在看旧报告时又崩了一次                               */
  /* ================================================================ */

  /*
   * 这一条钉的是「列表里的未读小红点」+「视图不被拽走」两件事 ——
   * 只有「已经在看某一份、又来了新的一份」这个时刻才观察得到
   * （带未读进来时新那份会被自动选中并立刻算已读，红点一闪而过）。
   */
  const REPORT_B = {
    ...REPORT_META,
    id: 'check-report-2',
    at: REPORT_AT + 12 * 60 * 1000,
    packageName: 'com.example.other',
    summary: '第二份：用来验证新报告到达时的列表表现。',
    read: false,
  };
  win2.webContents.send('push:aiCrashReport', REPORT_B);
  await sleep(600);

  const afterPush = await read(
    win2,
    `(() => {
      const items = [...document.querySelectorAll('.ai-report-item')];
      const first = items[0];
      const detailH2 = (document.querySelector('.ai-report-body .ai-md h2')?.textContent || '').trim();
      const detailPkg = [...document.querySelectorAll('.ai-report-meta > div')]
        .map((d) => [(d.querySelector('span')?.textContent || '').trim(), (d.querySelector('strong')?.textContent || '').trim()])
        .find((m) => m[0] === '崩溃应用');
      return {
        count: items.length,
        firstPkg: (first?.querySelector('.ai-report-pkg')?.textContent || '').trim(),
        firstHasDot: !!first?.querySelector('.ai-unread-dot'),
        dot: !!document.querySelector('.nav-item[href="#/ai"] .nav-dot'),
        detailH2,
        detailPkg: detailPkg ? detailPkg[1] : '',
      };
    })()`,
  );
  ok(afterPush.count === 2, '推送后列表多出一份', `count=${afterPush.count}`);
  ok(afterPush.firstPkg === 'com.example.other', '新报告排在列表最前', `first=${afterPush.firstPkg}`);
  ok(afterPush.firstHasDot, '🔴 新的未读报告在列表里带小红点', `dot=${afterPush.firstHasDot}`);
  ok(afterPush.dot, '🔴 侧栏红点重新亮起（清过之后又来一份，要能再提醒）', `dot=${afterPush.dot}`);
  ok(
    afterPush.detailH2 === '崩溃分析报告' && afterPush.detailPkg === 'com.example.demo',
    '🔴 新报告不会把正在读的那份挤走（视图不被拽走）',
    `detail=${afterPush.detailH2}/${afterPush.detailPkg}`,
  );

  /* 点一下新的那份 → 未读被消费、红点再灭 */
  await click(win2, '.ai-report-item:first-child');
  const dotGone2 = await waitFor(win2, `!document.querySelector('.nav-item[href="#/ai"] .nav-dot')`, 3000);
  ok(dotGone2, '点开新报告后红点再次消失', `dotGone=${dotGone2}`);

  win2.hide();

  log('=== AI PAGE CHECK ===');
  for (const r of rows) log(r);
  log(
    rendererErrors.length
      ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}`
      : '渲染层无错误',
  );
  log('AI PAGE CHECK DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
