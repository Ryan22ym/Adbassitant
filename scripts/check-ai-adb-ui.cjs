/**
 * v1.1.15 · 「AI 自动执行 adb 指令」界面回归
 *
 * 验的是渲染层那一半（主进程循环由 check-ai-adb-agent.cjs 用假模型覆盖）：
 *
 *   A. composer 里那个「执行 adb 指令」开关：默认开、点一下关、状态落 localStorage；
 *   B. 发送期间：能收到 push:aiAgentStep 并当场画出执行记录（不是干等转圈）；
 *   C. 发送按钮变成「停止」，点它会真的发出 ai:cancel；
 *   D. 结果气泡：命令条数、命令行原文、成功/失败徽标、输出默认折叠（失败默认展开）、
 *      点开能看到输出正文；
 *   E. 最终结论照常走 Markdown 渲染；
 *   F. 渲染层无报错。
 *
 * 🔴 AI 侧全部打桩（ai:chat / ai:cancel / ai:configGet），不联网、不需要真机。
 * 🔴 独立 userData 临时目录（带 pid，不做「先删再建」，理由见 check-ai-page.cjs）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-ai-adb-ui.cjs \
 *     --watch ui-shots/_ai-adb-ui.log --until "AI ADB UI CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_ai-adb-ui.log');
const SHOT = path.join(OUT, 'ai-adb-agent.png');

fs.mkdirSync(OUT, { recursive: true });

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, ipcMain } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-aiadbui-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

/* 通道名照抄 shared/types.ts + preload.ts 两份字面量 */
const CH_CHAT = 'ai:chat';
const CH_CANCEL = 'ai:cancel';
const CH_CFG_GET = 'ai:configGet';
const CH_AGENT_STEP = 'push:aiAgentStep';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 打桩数据                                                            */
/* ------------------------------------------------------------------ */

/** 让渲染层的 isAiUsable() 通过，否则 doSend 会被「还没配模型」挡住 */
const FAKE_CFG = {
  activeProvider: 'fake',
  providers: [
    {
      id: 'fake',
      name: '打桩模型',
      type: 'openai',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'fake-model',
      temperature: 0.3,
      maxTokens: 2048,
    },
  ],
  systemPrompt: '',
  crashPrompt: 'x',
  crashDir: 'D:\\adbcrash',
  crashLogMinutes: 10,
};

const STEP_OK = {
  id: 'step-1',
  command: 'adb shell dumpsys window | grep mCurrentFocus',
  reason: '我先看一下当前前台应用。',
  ok: true,
  code: 0,
  output: 'mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}',
  truncated: false,
  durationMs: 86,
  at: Date.now(),
};

const STEP_BAD = {
  id: 'step-2',
  command: 'adb shell dumpsys activity top',
  ok: false,
  code: 1,
  output: 'error: closed\n（这条故意做成失败，用来验「失败默认展开输出」）',
  truncated: false,
  durationMs: 1204,
  at: Date.now(),
};

const FINAL_TEXT = '当前前台是 **com.example.app** 的 `MainActivity`。';

const chatCalls = [];
const cancelCalls = [];
/** 发送后多久返回结果：留出时间给「实时进度 / 停止按钮」两条断言 */
const CHAT_DELAY = 1400;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  log('userData = ' + DATA);

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  /* ---- 覆盖 AI 三个通道 ---- */
  ipcMain.removeHandler(CH_CFG_GET);
  ipcMain.handle(CH_CFG_GET, () => ({ ok: true, data: FAKE_CFG }));

  ipcMain.removeHandler(CH_CHAT);
  ipcMain.handle(CH_CHAT, async (e, req) => {
    chatCalls.push(req);
    // 模拟主进程的实时进度推送（真实实现见 ipc.ts 的 onStep）
    if (req && req.runId && !e.sender.isDestroyed()) {
      e.sender.send(CH_AGENT_STEP, { runId: req.runId, step: STEP_OK, index: 1 });
    }
    await sleep(CHAT_DELAY);
    return {
      ok: true,
      data: {
        sessionId: 's-fake',
        content: FINAL_TEXT,
        model: 'fake-model',
        durationMs: CHAT_DELAY,
        steps: [STEP_OK, STEP_BAD],
        rounds: 2,
      },
    };
  });

  ipcMain.removeHandler(CH_CANCEL);
  ipcMain.handle(CH_CANCEL, (_e, runId) => {
    cancelCalls.push(runId);
    return { ok: true, data: true };
  });

  const rendererErrors = [];
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

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + detail : ''}`);

  const read = (expr) => win.webContents.executeJavaScript(expr);
  async function waitFor(expr, timeout = 5000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await read(expr)) return true;
      await sleep(step);
    }
    return false;
  }

  try {
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/ai' });
    await win.show();
    await sleep(1500);

    /* ---------------- A. 开关 ---------------- */
    log('\n== A 「执行 adb 指令」开关 ==');
    ok(await read(`!!document.querySelector('.ai-adb-toggle')`), 'A1 开关存在');
    ok((await read(`document.querySelector('.ai-adb-toggle')?.dataset.allowAdb`)) === '1', 'A2 默认开启');
    ok(
      (await read(`document.querySelector('.ai-adb-toggle')?.textContent || ''`)).includes('执行 adb 指令'),
      'A3 开关有文案',
    );

    await read(`document.querySelector('.ai-adb-toggle').click()`);
    await sleep(250);
    ok((await read(`document.querySelector('.ai-adb-toggle')?.dataset.allowAdb`)) === '0', 'A4 点一下关闭');
    ok((await read(`localStorage.getItem('adb.ai.allowAdb')`)) === '0', 'A5 关闭状态落到 localStorage');

    await read(`document.querySelector('.ai-adb-toggle').click()`);
    await sleep(250);
    ok((await read(`document.querySelector('.ai-adb-toggle')?.dataset.allowAdb`)) === '1', 'A6 再点回来开启');
    ok((await read(`localStorage.getItem('adb.ai.allowAdb')`)) === '1', 'A7 开启状态落到 localStorage');

    /* ---------------- B/C. 发送期间的实时进度与停止 ---------------- */
    log('\n== B/C 实时进度 + 停止 ==');
    const typed = await read(`
      (() => {
        const ta = document.querySelector('textarea.ai-input');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '看看当前前台是什么应用');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    ok(typed, 'B1 输入框可写');

    const clicked = await read(`
      (() => {
        const b = [...document.querySelectorAll('.ai-composer-bar button')].find((x) => x.textContent.includes('发送'));
        if (!b) return false;
        b.click();
        return true;
      })()
    `);
    ok(clicked, 'B2 找到并点了「发送」');

    ok(await waitFor(`!!document.querySelector('.ai-bubble.live .ai-step')`, 3000), 'B3 发送期间实时画出执行记录');
    ok(
      (await read(`document.querySelector('.ai-bubble.pending')?.textContent || ''`)).includes('已执行'),
      'B4 等待文案显示已执行条数',
    );

    ok(
      await waitFor(
        `[...document.querySelectorAll('.ai-composer-bar button')].some((x) => x.textContent.includes('停止'))`,
        3000,
      ),
      'C1 发送中按钮变成「停止」',
    );
    await read(`
      (() => {
        const b = [...document.querySelectorAll('.ai-composer-bar button')].find((x) => x.textContent.includes('停止'));
        if (b) b.click();
        return true;
      })()
    `);
    await sleep(400);
    ok(cancelCalls.length > 0, 'C2 点停止发出了 ai:cancel', `收到 ${cancelCalls.length} 次`);
    ok(
      chatCalls.length > 0 && typeof chatCalls[0].runId === 'string' && chatCalls[0].runId.length > 0,
      'C3 请求带着 runId（主进程靠它认领取消）',
      chatCalls[0] && chatCalls[0].runId,
    );
    ok(chatCalls.length > 0 && chatCalls[0].allowAdb === true, 'C4 请求带上了 allowAdb=true');

    /* ---------------- D. 结果气泡里的执行记录 ---------------- */
    log('\n== D 执行记录渲染 ==');
    ok(
      await waitFor(`document.querySelectorAll('.ai-bubble.assistant .ai-steps .ai-step').length === 2`, 4000),
      'D1 结果气泡里两条执行记录',
    );
    ok(
      (await read(`document.querySelector('.ai-bubble.assistant .ai-step-cmd')?.textContent || ''`)).includes(
        'dumpsys window',
      ),
      'D2 命令行原文显示出来',
    );
    ok(
      (await read(`
        (() => {
          const steps = [...document.querySelectorAll('.ai-bubble.assistant .ai-step')];
          return steps.map((s) => ({ cls: s.className, badge: s.querySelector('.ai-step-badge')?.textContent || '' }));
        })()
      `)).every((s, i) => (i === 0 ? s.cls.includes('ok') && s.badge === '成功' : s.cls.includes('bad') && s.badge.includes('1'))),
      'D3 成功 / 失败两种状态都标出来了',
    );
    ok(
      (await read(`
        (() => {
          const steps = [...document.querySelectorAll('.ai-bubble.assistant .ai-step')];
          return { first: !!steps[0].querySelector('pre'), second: !!steps[1].querySelector('pre') };
        })()
      `)).first === false,
      'D4 成功命令的输出默认折叠',
    );
    ok(
      (await read(`
        (() => {
          const steps = [...document.querySelectorAll('.ai-bubble.assistant .ai-step')];
          return !!steps[1].querySelector('pre');
        })()
      `)) === true,
      'D5 失败命令的输出默认展开',
    );
    ok(
      (await read(`document.querySelector('.ai-bubble.assistant .ai-step-reason')?.textContent || ''`)).includes(
        '我先看一下',
      ),
      'D6 模型当时的说明也跟着显示',
    );

    // 点开第一条的输出
    await read(`
      (() => {
        const b = document.querySelector('.ai-bubble.assistant .ai-step-toggle');
        if (b) b.click();
        return true;
      })()
    `);
    await sleep(200);
    ok(
      (await read(`document.querySelector('.ai-bubble.assistant .ai-step pre')?.textContent || ''`)).includes(
        'com.example.app',
      ),
      'D7 点开后能看到输出正文',
    );

    /* ---------------- E. 结论 ---------------- */
    log('\n== E 最终结论 ==');
    ok(
      (await read(`document.querySelector('.ai-bubble.assistant .ai-md')?.textContent || ''`)).includes('com.example.app'),
      'E1 结论正文渲染出来',
    );
    ok(
      (await read(`!!document.querySelector('.ai-bubble.assistant .ai-md strong')`)),
      'E2 Markdown 粗体生效',
    );
    ok(
      (await read(`document.querySelector('.ai-bubble.live') === null`)),
      'E3 结束后实时气泡已撤掉（不重复显示）',
    );

    /* ---------------- F. 渲染层报错 ---------------- */
    log('\n== F 渲染层 ==');
    ok(rendererErrors.length === 0, 'F1 渲染层无错误', rendererErrors.slice(0, 3).join(' | '));

    // 截图留档（先等一下，capturePage 抓的是上一帧，见 MEMORY 的坑）
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    log('截图：' + SHOT);
  } catch (e) {
    rows.push(`FAIL  脚本异常   ${e && (e.stack || e.message)}`);
  }

  log('');
  for (const r of rows) log(r);
  const fails = rows.filter((r) => r.startsWith('FAIL')).length;
  log('');
  log(fails === 0 ? `RESULT OK  ${rows.length} 项全通过` : `RESULT FAIL  ${rows.length - fails} 项通过 / ${fails} 项失败`);
  log('AI ADB UI CHECK DONE');
  app.exit(fails === 0 ? 0 : 1);
});
