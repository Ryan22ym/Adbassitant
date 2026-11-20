/**
 * 工具箱页回归（v1.1.25 起，v1.1.26 加段位换算）
 * ============================================================
 * 验四件事：
 *   1. 入口 —— 侧栏有「工具箱」、点进去标题与高亮都对；
 *   2. 时间戳 —— 时间戳↔时间双向换算自洽，UTC 结果绝对正确；
 *   3. MD5 —— 固定输入的摘要与 `md5sum` 一致（含 32/16 位）；
 *   4. 段位换算 —— 0/91/92 三个锚点、小段边界、段位选择器反查。
 *
 * 用法：
 *   electron scripts/check-toolbox.cjs
 * 结果：ui-shots/_toolbox.log（末尾 TOOLBOX CHECK DONE）
 *
 * ⚠️ 窗口必须 show:true：隐藏窗口不产生新帧，capturePage 拍到的永远是初始画面，
 *    截图有、界面看着却是空的（这个坑在 check-nav 那套脚本里踩过）。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_toolbox.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

let failed = 0;
function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}
function ok(cond, name, detail) {
  if (!cond) failed++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

/** React 受控组件：必须走原型链上的原生 setter，直接改 value 不会触发重渲染 */
const SET_VAL = `
  (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
`;

/** 原生 select：React 在 select 上监听的是 change 事件，dispatch input 不生效 */
const SET_SELECT = `
  (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
`;

/** 读当前工具面板里的「标签 + 值」 */
const READ_ROWS = `[...document.querySelectorAll('.toolbox-main .tb-row')].map(r => ({
  label: r.querySelector('.tb-row-label')?.textContent || '',
  value: r.querySelector('.tb-row-value')?.textContent || '',
}))`;

app.whenReady().then(async () => {
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  const evalJS = (code) => win.webContents.executeJavaScript(code);
  const setVal = (sel, val) => evalJS(`(${SET_VAL})(${JSON.stringify(sel)}, ${JSON.stringify(val)})`);
  const rows = () => evalJS(READ_ROWS);
  const rowValue = async (label) => (await rows()).find((r) => r.label === label)?.value ?? '';
  /*
   * ⚠️ 「本地时间」在页面上有**两行**：一块是当前时间戳（第 1 行），一块是换算结果（第 2 行）。
   *    按 label 取第一个会拿到当前时间 —— B4/B5 曾因此假 FAIL。
   */
  const rowValueAt = async (label, idx) =>
    (await rows()).filter((r) => r.label === label)[idx]?.value ?? '';

  log('=== TOOLBOX CHECK ===');

  /* ---------- 1. 入口与清单 ---------- */
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/toolbox' });
  await sleep(1200);

  const shell = await evalJS(`(() => ({
    title: document.querySelector('.header-title')?.textContent || '',
    active: [...document.querySelectorAll('.nav-item.active .nav-label')].map(e => e.textContent),
    tools: [...document.querySelectorAll('.toolbox-nav-item')].map(e => e.getAttribute('data-tool')),
    panel: document.querySelector('.toolbox-main')?.getAttribute('data-tool-panel'),
  }))()`);

  ok(shell.title === '工具箱', 'A1 页头标题 = 工具箱', `实际="${shell.title}"`);
  ok(
    shell.active.length === 1 && shell.active[0] === '工具箱',
    'A2 侧栏高亮只有「工具箱」一项',
    JSON.stringify(shell.active),
  );
  ok(
    JSON.stringify(shell.tools) === JSON.stringify(['timestamp', 'md5', 'rank']),
    'A3 工具清单 = 时间戳 + MD5 + 段位换算',
    JSON.stringify(shell.tools),
  );
  ok(shell.panel === 'timestamp', 'A4 默认停在第一个工具（时间戳）', shell.panel);

  /* ---------- 2. 时间戳 ---------- */
  await setVal('[data-tb-input="ts"]', '1731234567');
  await sleep(300);

  ok(
    (await rowValue('UTC')) === '2024-11-10 10:29:27 UTC',
    'B1 1731234567 → UTC 时间正确',
    await rowValue('UTC'),
  );
  ok(
    (await rowValue('ISO 8601')) === '2024-11-10T10:29:27.000Z',
    'B2 1731234567 → ISO 8601 正确',
    await rowValue('ISO 8601'),
  );
  ok(/年前|个月前|天前/.test(await rowValue('距今')), 'B3 「距今」有单位', await rowValue('距今'));

  /*
   * 往返：把刚算出来的本地时间填回「时间 → 时间戳」，应回到 1731234567。
   * 这样断言不依赖机器时区（本地时间串本身是 +8 还是 +0 都不影响自洽性）。
   */
  const localFromTs = (await rowValueAt('本地时间', 1)).replace(/\.\d+$/, '').replace(' ', 'T');
  await setVal('[data-tb-input="dt"]', localFromTs);
  await sleep(300);
  /* 「秒」「毫秒」同样各有两行：第 0 行是当前时间戳，第 1 行才是反算结果 */
  ok(
    (await rowValueAt('秒', 1)) === '1731234567',
    'B4 本地时间 → 秒级时间戳 往返一致',
    `${localFromTs} → ${await rowValueAt('秒', 1)}`,
  );
  ok(
    (await rowValueAt('毫秒', 1)) === '1731234567000',
    'B5 本地时间 → 毫秒级时间戳 往返一致',
    await rowValueAt('毫秒', 1),
  );

  /* 非法输入不该崩，只给提示 */
  await setVal('[data-tb-input="ts"]', 'abc');
  await sleep(200);
  const badHint = await evalJS(
    `[...document.querySelectorAll('.toolbox-main .tb-hint')].map(e => e.textContent).join('|')`,
  );
  ok(badHint.includes('看不懂'), 'B6 非数字输入给出提示且不崩', badHint);

  /* ---------- 3. MD5 ---------- */
  await evalJS(`document.querySelector('.toolbox-nav-item[data-tool="md5"]').click()`);
  await sleep(300);
  ok(
    (await evalJS(`document.querySelector('.toolbox-main').getAttribute('data-tool-panel')`)) ===
      'md5',
    'C1 点击清单可切到 MD5',
  );

  await setVal('[data-tb-input="md5"]', 'abc');
  await sleep(250);
  ok(
    (await rowValue('32 位小写')) === '900150983cd24fb0d6963f7d28e17f72',
    'C2 MD5("abc") 32 位小写正确',
    await rowValue('32 位小写'),
  );
  ok(
    (await rowValue('32 位大写')) === '900150983CD24FB0D6963F7D28E17F72',
    'C3 MD5("abc") 32 位大写正确',
  );
  ok(
    (await rowValue('16 位')) === '3cd24fb0d6963f7d',
    'C4 MD5("abc") 16 位 = 32 位中间 16 位',
    await rowValue('16 位'),
  );

  /* 中文必须按 UTF-8 算（用 charCodeAt 会得出另一串） */
  await setVal('[data-tb-input="md5"]', '中文');
  await sleep(250);
  ok(
    (await rowValue('32 位小写')) === 'a7bac2239fcdcb3a067903d8077c4a07',
    'C5 中文按 UTF-8 计算（与 md5sum 一致）',
    await rowValue('32 位小写'),
  );

  /* 清空后回到占位，不留上一次的摘要 */
  await evalJS(`[...document.querySelectorAll('.toolbox-main .btn')].find(b => b.textContent.trim() === '清空')?.click()`);
  await sleep(250);
  ok(
    (await rowValue('32 位小写')) === '—',
    'C6 清空后摘要回到占位（不留旧值）',
    await rowValue('32 位小写'),
  );

  /* ---------- 4. 段位换算 ---------- */
  await evalJS(`document.querySelector('.toolbox-nav-item[data-tool="rank"]').click()`);
  await sleep(300);
  ok(
    (await evalJS(`document.querySelector('.toolbox-main').getAttribute('data-tool-panel')`)) ===
      'rank',
    'D1 点击清单可切到段位换算',
  );

  const rankText = () =>
    evalJS(`document.querySelector('.rank-result')?.getAttribute('data-rank-result') ?? ''`);

  /*
   * 锚点表：青铜 4 的 1⭐ = 0，王者 1⭐ = 92。
   * 专挑「小段边界」和「大段交界」—— 满星算成下一小段 1⭐ 这类差一格的错，
   * 只在边界上露出来，取中间值永远是 PASS 的。
   */
  const RANK_CASES = [
    [0, '青铜 Ⅳ 1⭐'],
    [2, '青铜 Ⅳ 3⭐'],
    [3, '青铜 Ⅲ 1⭐'],
    [11, '青铜 Ⅰ 3⭐'],
    [12, '白银 Ⅳ 1⭐'],
    [24, '黄金 Ⅳ 1⭐'],
    [35, '黄金 Ⅰ 3⭐'],
    [36, '白金 Ⅳ 1⭐'],
    [51, '白金 Ⅰ 4⭐'],
    [52, '钻石 Ⅴ 1⭐'],
    [71, '钻石 Ⅰ 4⭐'],
    [72, '大师 Ⅴ 1⭐'],
    [91, '大师 Ⅰ 4⭐'],
    [92, '王者 1⭐'],
    [10090, '王者 9999⭐'],
  ];
  for (const [n, expect] of RANK_CASES) {
    await setVal('[data-tb-input="rank-level"]', String(n));
    await sleep(120);
    const got = await rankText();
    ok(got === expect, `D2 编号 ${n} → ${expect}`, got);
  }

  /* 负数 / 小数 / 超上限 都不该换算，也不该崩 */
  for (const bad of ['abc', '-1', '12.5', '10091']) {
    await setVal('[data-tb-input="rank-level"]', bad);
    await sleep(120);
    ok((await rankText()) === '', `D3 非法编号「${bad}」不换算`, await rankText());
  }

  /* ---------------- 反向：选段位看编号 ---------------- */
  const setSelect = (sel, val) =>
    evalJS(`(${SET_SELECT})(${JSON.stringify(sel)}, ${JSON.stringify(val)})`);

  await setSelect('[data-rank-tier]', '0');
  await sleep(150);
  ok((await rowValue('编号')) === '0', 'D4 默认 青铜 Ⅳ 1⭐ = 0', await rowValue('编号'));

  await setSelect('[data-rank-tier]', '4'); /* 钻石：5→1 */
  await sleep(200);
  ok((await rowValue('编号')) === '52', 'D5 切大段后落到 钻石 Ⅴ 1⭐ = 52', await rowValue('编号'));

  await setSelect('[data-rank-sub]', '1');
  await sleep(150);
  ok((await rowValue('编号')) === '68', 'D6 钻石 Ⅰ 1⭐ = 68', await rowValue('编号'));

  await setSelect('[data-rank-star]', '4');
  await sleep(150);
  ok((await rowValue('编号')) === '71', 'D7 钻石 Ⅰ 4⭐ = 71', await rowValue('编号'));

  await setSelect('[data-rank-tier]', '6'); /* 王者：没有小段 */
  await sleep(200);
  ok((await rowValue('编号')) === '92', 'D8 王者 1⭐ = 92', await rowValue('编号'));

  await setVal('[data-rank-star]', '123');
  await sleep(200);
  ok((await rowValue('编号')) === '214', 'D9 王者 123⭐ = 214', await rowValue('编号'));

  /* 截图停在有结果的一格：截图是给人看的，停在提示文字上等于没截 */
  await setVal('[data-tb-input="rank-level"]', '55');
  await sleep(300);

  await sleep(400);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, '_toolbox.png'), shot.toPNG());

  log(errors.length ? `渲染层错误:\n${errors.join('\n')}` : '渲染层无错误');
  log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  log('TOOLBOX CHECK DONE');
  app.exit(failed === 0 ? 0 : 1);
});
