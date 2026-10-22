/**
 * v1.1.15 · AI 自动执行 adb 指令（工具循环）回归
 *
 * 验的是「模型给命令 → 执行 → 输出回传 → 模型决定停不停」这条链，
 * 光靠类型检查一条都盖不住，所以整条链打桩真跑一遍：
 *
 *   · 假 OpenAI 接口（本地 http server）：按轮次返回「命令块」或「最终结论」，
 *     每轮的请求体都留档 —— 用它证明「上一轮的命令输出真的发回给模型了」；
 *   · 打桩 adb：runAdb / listDevices 换成假的，不碰真机、不启 adb server。
 *
 * 覆盖 10 组：
 *   A 两轮：给命令 → 执行 → 回传 → 结论（顺带查 guide/设备摘要注入）
 *   B 危险命令拦截（rm -rf / pm clear），且**一次都没真执行**
 *   C 输出截断（头 + 尾 + 省略标记）
 *   D 轮数上限后强制收尾
 *   E allowAdb=false：一个命令都不执行，system 里也没有 guide
 *   F 非 adb 行 / 非命令语言块被过滤
 *   G shell 引号保留（adb shell "ls /sdcard/My Music"）
 *   H 全局命令不插 -s；普通命令插 -s
 *   I 停止：第 2 轮发出后取消 → stopped=true，不再执行
 *   J 会话落盘：steps 跟着消息存下来，单条输出被精简
 *
 * 🔴 为什么用 node 跑而不是 electron：
 *    被测模块只需要一个 `electron.app`（拿 userData 路径）。
 *    用 Module._load 钩子塞一个假的就行，省掉整个窗口与启动开销，
 *    跑一次不到两秒。
 *
 * 跑法：
 *   node scripts/check-ai-adb-agent.cjs
 * 输出：
 *   ui-shots/_ai-adb-agent.log （逐项 PASS/FAIL + 末尾 RESULT 行）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_ai-adb-agent.log');
const CONF = path.join(ROOT, 'Conf', 'ai.json');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

function log(line) {
  fs.appendFileSync(LOG, `${line}\n`);
}

/* ------------------------------------------------------------------ */
/* 假的 electron.app（只为了 userData 路径）                           */
/* ------------------------------------------------------------------ */

const DATA = path.join(os.tmpdir(), `adb-aiadbagent-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });

const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getPath: () => DATA,
        getAppPath: () => ROOT,
      },
      BrowserWindow: class {},
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------------ */
/* 打桩 adb                                                            */
/* ------------------------------------------------------------------ */

const adb = require('../dist-electron/electron/services/adb');

let runCalls = [];      // 每次 runAdb 收到的 args
let listCalls = 0;      // listDevices 调用次数
let fakeStdout = 'ok';  // 下一批命令统一返回的输出（用例可改）

adb.runAdb = async (args) => {
  runCalls.push(args);
  const out = typeof fakeStdout === 'function' ? fakeStdout(args) : fakeStdout;
  return { ok: true, code: 0, stdout: out, stderr: '', commandLine: `adb ${args.join(' ')}`, duration: 3 };
};

adb.listDevices = async () => {
  listCalls += 1;
  return [{ serial: 'FAKE123', state: 'device', model: 'Pixel 9', brand: 'Google', androidVersion: '14' }];
};

/* ensureDevice 是 adb.ts 的**内部调用**（同文件里直接调 listDevices，不走 exports），
 * 所以上面那个 listDevices 的桩对它无效，要单独打 —— 否则它会去连真实设备。 */
adb.ensureDevice = async () => 'FAKE123';

/* ------------------------------------------------------------------ */
/* 假模型服务                                                          */
/* ------------------------------------------------------------------ */

let turn = 0;
let responder = () => '（打桩未定义）';
let bodies = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => {
    raw += d;
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 忽略 */
    }
    bodies.push(body);
    const i = turn++;
    let content = '（打桩未定义）';
    try {
      content = responder(i, body);
    } catch (e) {
      content = `打桩异常：${e.message}`;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    log(`PASS  ${name}`);
  } else {
    fail += 1;
    log(`FAIL  ${name}${detail === undefined ? '' : `  —  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const backup = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null;

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  log(`假模型接口：http://127.0.0.1:${port}/v1`);

  fs.writeFileSync(
    CONF,
    JSON.stringify(
      {
        activeProvider: 'fake',
        providers: [
          {
            id: 'fake',
            name: 'Fake',
            type: 'openai',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'test-key',
            model: 'fake-model',
            temperature: 0.3,
            maxTokens: 2048,
          },
        ],
        systemPrompt: '你是测试助手。',
        crashPrompt: 'x',
        crashDir: 'D:\\adbcrash',
        crashLogMinutes: 10,
      },
      null,
      2,
    ),
    'utf8',
  );

  const ai = require('../dist-electron/electron/services/ai');

  const chat = (text, extra = {}) =>
    ai.aiChat(
      {
        runId: extra.runId,
        allowAdb: extra.allowAdb,
        messages: [{ id: 'u1', role: 'user', content: text, time: Date.now() }],
      },
      extra.hooks,
    );

  const reset = (next) => {
    turn = 0;
    bodies = [];
    runCalls = [];
    listCalls = 0;
    fakeStdout = 'ok';
    responder = next;
  };

  try {
    /* ---------------- A 两轮：命令 → 执行 → 回传 → 结论 ---------------- */
    log('\n== A 基本两轮 ==');
    reset((i) =>
      i === 0
        ? '我先看一下当前前台应用。\n\n```adb\nadb shell dumpsys window | grep mCurrentFocus\n```'
        : '当前前台是 com.example.app 的 MainActivity。',
    );
    fakeStdout = 'mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}';
    const stepHook = [];
    const a = await chat('看看当前前台是什么应用', { runId: 'run-a', hooks: { onStep: (s) => stepHook.push(s) } });

    eq('A1 只执行 1 条命令', a.steps.length, 1);
    check('A2 命令原文被保留', a.steps[0].command === 'adb shell dumpsys window | grep mCurrentFocus', a.steps[0].command);
    check('A3 命令执行成功', a.steps[0].ok === true, a.steps[0]);
    check('A4 输出非空', a.steps[0].output.includes('com.example.app'), a.steps[0].output);
    eq('A5 问了两轮模型', a.rounds, 2);
    eq('A6 服务端收到两次请求', bodies.length, 2);
    check('A7 最终结论已返回', a.content.includes('com.example.app'), a.content);
    check('A8 结论里没有命令块残留', !a.content.includes('```'), a.content);

    const sys0 = bodies[0].messages[0];
    check('A9 首轮 system 里注入了工具说明', sys0.role === 'system' && sys0.content.includes('你可以直接操作设备'));
    check('A10 首轮 system 里带了设备摘要', sys0.content.includes('Pixel 9') && sys0.content.includes('FAKE123'));
    check('A11 首轮 system 里保留了用户提示词', sys0.content.includes('你是测试助手'));

    const lastUser = bodies[1].messages[bodies[1].messages.length - 1];
    check(
      'A12 第二轮把命令输出回传给了模型',
      lastUser.role === 'user' && String(lastUser.content).includes('com.example.app') && String(lastUser.content).includes('命令执行结果'),
      String(lastUser.content).slice(0, 200),
    );
    const asstEcho = bodies[1].messages[bodies[1].messages.length - 2];
    check('A13 第二轮历史里保留了模型上一轮原话', asstEcho.role === 'assistant' && String(asstEcho.content).includes('dumpsys'));
    eq('A14 onStep 推了 1 次', stepHook.length, 1);
    check('A15 有设备时命令带 -s', JSON.stringify(runCalls[0]).includes('"-s","FAKE123"'), runCalls[0]);

    /* ---------------- B 危险命令拦截 ---------------- */
    log('\n== B 危险命令拦截 ==');
    reset((i) => (i === 0 ? '```adb\nadb shell rm -rf /sdcard/DCIM\nadb shell pm clear com.example\n```' : '好的，我不执行这些操作。'));
    const b = await chat('清空一下相册', { runId: 'run-b' });
    eq('B1 两条都进了结果', b.steps.length, 2);
    check('B2 rm -rf 被拦截', !!b.steps[0].blocked, b.steps[0]);
    check('B3 pm clear 被拦截', !!b.steps[1].blocked, b.steps[1]);
    eq('B4 一次都没有真执行', runCalls.length, 0);
    check('B5 拦截原因回传给了模型', String(bodies[1].messages[bodies[1].messages.length - 1].content).includes('已拦截'));
    check('B6 拦截的命令 ok=false', b.steps.every((s) => s.ok === false));

    /* ---------------- C 输出截断 ---------------- */
    log('\n== C 输出截断 ==');
    const HUGE = 'A'.repeat(30000) + '临界点' + 'B'.repeat(30000);
    reset((i) => (i === 0 ? '```adb\nadb shell dumpsys meminfo\n```' : '内存正常。'));
    fakeStdout = HUGE;
    const c = await chat('看下内存', { runId: 'run-c' });
    check('C1 标记为已截断', c.steps[0].truncated === true);
    check('C2 长度被压到上限附近', c.steps[0].output.length <= 4300, c.steps[0].output.length);
    check('C3 保留头部', c.steps[0].output.startsWith('AAAA'));
    check('C4 保留尾部', c.steps[0].output.trimEnd().endsWith('BBBB'));
    check('C5 有省略标记', c.steps[0].output.includes('中间省略'));

    /* ---------------- D 轮数上限 ---------------- */
    log('\n== D 轮数上限收尾 ==');
    reset((i) =>
      i < 6 ? `继续查：\n\n\`\`\`adb\nadb shell getprop ro.product.model\n\`\`\`` : '综合以上信息，机型是 Pixel 9。',
    );
    fakeStdout = 'Pixel 9';
    const d = await chat('把设备信息全查一遍', { runId: 'run-d' });
    eq('D1 最多执行 6 轮命令', d.steps.length, 6);
    eq('D2 第 7 次请求用于收尾', bodies.length, 7);
    check('D3 收尾轮明确要求不要再用命令块', String(bodies[6].messages[bodies[6].messages.length - 1].content).includes('不要再输出 adb 代码块'));
    check('D4 仍然拿到了结论', d.content.includes('Pixel 9'), d.content);

    /* ---------------- E 关掉开关 ---------------- */
    log('\n== E allowAdb=false ==');
    reset(() => '```adb\nadb shell getprop ro.product.model\n```');
    const e = await chat('查一下机型', { runId: 'run-e', allowAdb: false });
    eq('E1 一条都没执行', e.steps.length, 0);
    eq('E2 只问了一次', bodies.length, 1);
    eq('E3 不查设备列表', listCalls, 0);
    check('E4 system 里没有工具说明', !String(bodies[0].messages[0].content).includes('你可以直接操作设备'));
    check('E5 原文（含命令块）照常返回', e.content.includes('adb shell getprop'), e.content);

    /* ---------------- F 非命令内容过滤 ---------------- */
    log('\n== F 混杂代码块过滤 ==');
    reset((i) =>
      i === 0
        ? [
            '先跑这些：',
            '```bash',
            'ls -la /sdcard',
            'adb shell getprop ro.build.version.sdk',
            '```',
            '这段是解释，不是命令：',
            '```js',
            'console.log("adb shell rm -rf /")',
            '```',
          ].join('\n')
        : 'SDK 是 34。',
    );
    const f = await chat('查 SDK', { runId: 'run-f' });
    eq('F1 只收下真正的 adb 行', f.steps.length, 1);
    check('F2 收的是那行 adb', f.steps[0].command.includes('ro.build.version.sdk'), f.steps[0].command);
    check('F3 js 块里的东西没被执行', !JSON.stringify(runCalls).includes('rm -rf'), runCalls);

    /* ---------------- G shell 引号 ---------------- */
    log('\n== G shell 引号的两种情形 ==');
    // G1：整串被一对引号包住（管道必需这么写）→ 引号只能留在 Windows 侧，不能传到设备端
    reset((i) => (i === 0 ? '```adb\nadb shell "dumpsys window | grep mCurrentFocus"\n```' : '看到前台了。'));
    await chat('看看前台窗口', { runId: 'run-g' });
    eq('G1 整串引号被剥掉（否则设备端管道失效）', runCalls[0], [
      '-s',
      'FAKE123',
      'shell',
      'dumpsys window | grep mCurrentFocus',
    ]);

    // G2：只有参数被引号包住 → 引号必须留着，否则带空格的路径会被拆成两个参数
    reset((i) => (i === 0 ? '```adb\nadb shell ls "/sdcard/My Music"\n```' : '目录存在。'));
    const g = await chat('看看音乐目录', { runId: 'run-g2' });
    eq('G2 参数级引号被保留', runCalls[0], ['-s', 'FAKE123', 'shell', 'ls "/sdcard/My Music"']);
    check('G3 命令记录仍是原文', g.steps[0].command === 'adb shell ls "/sdcard/My Music"', g.steps[0].command);

    /* ---------------- H 全局命令不加 -s ---------------- */
    log('\n== H 全局命令不加 -s ==');
    reset((i) => (i === 0 ? '```adb\nadb devices\n```' : '只有一台在线。'));
    const h = await chat('列出设备', { runId: 'run-h' });
    eq('H1 adb devices 不加 -s', runCalls[0], ['devices']);
    check('H2 结果正常', h.steps.length === 1 && h.steps[0].ok, h.steps[0]);

    /* ---------------- I 停止 ---------------- */
    log('\n== I 中途停止 ==');
    reset((i, body) => {
      if (i === 1) {
        // 第 2 轮请求到手就取消：此时第 1 轮的命令已经跑完
        ai.cancelAiChat('run-i');
        void body;
      }
      return `继续：\n\n\`\`\`adb\nadb shell getprop ro.product.model\n\`\`\``;
    });
    const iRes = await chat('一直查下去', { runId: 'run-i' });
    check('I1 标记为已停止', iRes.stopped === true, iRes.stopped);
    eq('I2 只执行了第 1 轮那一条', iRes.steps.length, 1);
    check('I3 结论里写明已停止', iRes.content.includes('已停止'), iRes.content);

    /* ---------------- J 会话落盘 ---------------- */
    log('\n== J 会话落盘 ==');
    const store = JSON.parse(fs.readFileSync(path.join(DATA, 'ai-chats.json'), 'utf8'));
    const withSteps = store.filter((s) => s.messages.some((m) => m.role === 'assistant' && m.steps && m.steps.length));
    check('J1 有会话保存了 steps', withSteps.length > 0, `会话数=${store.length}`);
    const big = withSteps
      .flatMap((s) => s.messages)
      .filter((m) => m.steps)
      .flatMap((m) => m.steps)
      .sort((x, y) => y.output.length - x.output.length)[0];
    check('J2 落盘的单条输出被精简', !!big && big.output.length <= 1300, big && big.output.length);
    check('J3 落盘保留了命令与状态', !!big && !!big.command && typeof big.ok === 'boolean');
    /* ---------------- K 解析与拦截规则（纯函数直测） ---------------- */
    log('\n== K 解析 / 拦截规则 ==');
    const aiAdb = require('../dist-electron/electron/services/ai-adb');

    eq('K1 无语言标注也认', aiAdb.parseAdbCommands('```\nadb shell id\n```').commands, ['adb shell id']);
    eq('K2 大写作 ADB 也认', aiAdb.parseAdbCommands('```ADB\nadb shell id\n```').commands, ['adb shell id']);
    eq('K3 纯文本块也认', aiAdb.parseAdbCommands('```text\nadb shell id\n```').commands, ['adb shell id']);
    eq(
      'K4 一轮最多 4 条（多出的丢弃）',
      aiAdb.parseAdbCommands(
        '```adb\nadb devices\nadb shell id\nadb shell wm size\nadb shell getprop a\nadb shell getprop b\n```',
      ).commands.length,
      4,
    );
    eq('K5 提示符前缀被清掉', aiAdb.parseAdbCommands('```adb\n$ adb shell id\n```').commands, ['adb shell id']);
    check('K6 rm -rf 被拦', !!aiAdb.blockedReason('adb shell rm -rf /sdcard/DCIM'));
    check('K7 普通 rm 单文件不拦', aiAdb.blockedReason('adb shell rm /sdcard/a.txt') === null);
    check('K8 reboot bootloader 被拦', !!aiAdb.blockedReason('adb reboot bootloader'));
    check('K9 普通 reboot 不拦', aiAdb.blockedReason('adb reboot') === null);
    check('K10 只读命令不拦', aiAdb.blockedReason('adb shell dumpsys battery') === null);
    check('K11 空输出有占位', aiAdb.parseAdbCommands('没有命令的普通回答').commands.length === 0);
  } catch (err) {
    check('未捕获异常', false, err && (err.stack || err.message));
  } finally {
    if (backup === null) {
      try {
        fs.unlinkSync(CONF);
      } catch {
        /* 原本就没有这个文件 */
      }
    } else {
      fs.writeFileSync(CONF, backup, 'utf8');
    }
    server.close();
  }

  log('');
  if (fail === 0) log(`RESULT OK  ${pass} 项全通过`);
  else log(`RESULT FAIL  ${pass} 项通过 / ${fail} 项失败`);
  log('AI ADB AGENT CHECK DONE');
  process.exitCode = fail === 0 ? 0 : 1;
}

main();
