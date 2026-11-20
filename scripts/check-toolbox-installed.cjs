/**
 * 安装版工具箱验收（v1.1.25）
 * ============================================================
 * 与 scripts/check-toolbox.cjs 的分工：那个跑在开发态（自己 new BrowserWindow 加载
 * dist/index.html），验的是源码；这个连**装到本机的 exe**，验的是新代码真的进了包。
 * 「装完了还是旧版本」这类问题只有这条链路能发现 —— asar 里搜字符串只能证明字节在，
 * 证明不了界面真的把入口渲染出来、点得动。
 *
 * 跑法：
 *   node scripts/check-toolbox-installed.cjs
 *   （**必须用宿主 Node**：Node 22 才有全局 WebSocket；Electron 33 内置的 Node 20 没有）
 * 结果：ui-shots/_toolbox-installed.log（末尾 INSTALLED TOOLBOX CHECK DONE）
 *       ui-shots/_toolbox-installed.png（验收时的界面截图）
 *
 * ⚠️ 脚本会先 taskkill 正在跑的实例，验完再关掉自己拉起的那个。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EXE = path.join(
  process.env.LOCALAPPDATA,
  'Programs',
  'ADBAssistant',
  'ADB桌面助手.exe',
);
const PORT = 9354;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_toolbox-installed.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
function log(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(s);
  fs.appendFileSync(LOG, s + '\n');
}
let failed = 0;
function ok(cond, name, detail) {
  if (!cond) failed++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + (e.message || '?'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        this.errors.push(m.params.entry.text);
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result ? r.result.value : undefined;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 读 /json/list 里的页面 target */
function listTarget() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).find((t) => t.type === 'page' && t.webSocketDebuggerUrl));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

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

const READ_ROWS = `[...document.querySelectorAll('.toolbox-main .tb-row')].map(r => ({
  label: r.querySelector('.tb-row-label')?.textContent || '',
  value: r.querySelector('.tb-row-value')?.textContent || '',
}))`;

(async () => {
  log('=== INSTALLED TOOLBOX CHECK ===');
  ok(fs.existsSync(EXE), '安装版 exe 存在', EXE);

  try {
    execSync('taskkill /IM "ADB桌面助手.exe" /F', { stdio: 'ignore' });
    await sleep(800);
  } catch {
    /* 本来就没在跑 */
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    env,
    detached: true,
    stdio: 'ignore',
    cwd: require('os').tmpdir(),
  });
  child.unref();

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(1000);
    target = await listTarget();
  }
  if (!target) {
    log('FAIL 安装版 60s 内没开出调试端点');
    log('INSTALLED TOOLBOX CHECK DONE');
    process.exit(1);
  }

  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  /* ---- 1. 侧栏 ---- */
  let nav = [];
  for (let i = 0; i < 40; i++) {
    nav = (await page.eval(`[...document.querySelectorAll('.nav-item .nav-label')].map(e => e.textContent)`)) || [];
    if (nav.length) break;
    await sleep(250);
  }
  ok(
    nav.includes('工具箱'),
    'A1 侧栏有「工具箱」',
    JSON.stringify(nav),
  );
  ok(nav.indexOf('工具箱') === nav.indexOf('常用工具') + 1, 'A2 位置紧跟「常用工具」', String(nav.indexOf('工具箱')));

  /* ---- 2. 点进工具箱 ---- */
  await page.eval(`(() => {
    const it = [...document.querySelectorAll('.nav-item')].find(n => (n.textContent || '').includes('工具箱'));
    if (it) it.click();
    return !!it;
  })()`);
  let panel = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    panel = await page.eval(`document.querySelector('.toolbox-main')?.getAttribute('data-tool-panel') || ''`);
    if (panel) break;
  }
  const title = await page.eval(`document.querySelector('.header-title')?.textContent || ''`);
  const tools = await page.eval(
    `[...document.querySelectorAll('.toolbox-nav-item')].map(e => e.getAttribute('data-tool'))`,
  );
  ok(title === '工具箱', 'B1 页头标题 = 工具箱', title);
  ok(panel === 'timestamp', 'B2 默认停在时间戳', String(panel));
  ok(
    JSON.stringify(tools) === JSON.stringify(['timestamp', 'md5', 'rank']),
    'B3 工具清单三项',
    JSON.stringify(tools),
  );

  /* ---- 3. 时间戳换算 ---- */
  const setVal = (sel, val) =>
    page.eval(`(${SET_VAL})(${JSON.stringify(sel)}, ${JSON.stringify(val)})`);
  const rows = () => page.eval(READ_ROWS);
  const rowValue = async (label) => ((await rows()) || []).find((r) => r.label === label)?.value ?? '';

  await setVal('[data-tb-input="ts"]', '1731234567');
  await sleep(400);
  ok((await rowValue('UTC')) === '2024-11-10 10:29:27 UTC', 'C1 时间戳 → UTC 正确', await rowValue('UTC'));
  ok(
    (await rowValue('ISO 8601')) === '2024-11-10T10:29:27.000Z',
    'C2 ISO 8601 正确',
    await rowValue('ISO 8601'),
  );

  /* ---- 4. MD5 ---- */
  await page.eval(`document.querySelector('.toolbox-nav-item[data-tool="md5"]')?.click()`);
  await sleep(400);
  await setVal('[data-tb-input="md5"]', 'abc');
  await sleep(300);
  ok(
    (await rowValue('32 位小写')) === '900150983cd24fb0d6963f7d28e17f72',
    'D1 MD5("abc") 正确',
    await rowValue('32 位小写'),
  );

  /* ---- 5. 段位换算（只验两个锚点：证明新工具真的进了包、算得对） ---- */
  await page.eval(`document.querySelector('.toolbox-nav-item[data-tool="rank"]')?.click()`);
  await sleep(400);
  const rankText = () =>
    page.eval(`document.querySelector('.rank-result')?.getAttribute('data-rank-result') ?? ''`);

  await setVal('[data-tb-input="rank-level"]', '91');
  await sleep(350);
  ok((await rankText()) === '大师 Ⅰ 4⭐', 'E1 91 → 大师 Ⅰ 4⭐', await rankText());

  await setVal('[data-tb-input="rank-level"]', '92');
  await sleep(350);
  ok((await rankText()) === '王者 1⭐', 'E2 92 → 王者 1⭐', await rankText());

  /* ---- 6. 截图 ---- */
  await sleep(600);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '_toolbox-installed.png'), Buffer.from(shot.data, 'base64'));

  ok(page.errors.length === 0, 'F1 渲染层无 error 级日志', page.errors.join(' | ') || '(空)');

  page.close();
  try {
    execSync('taskkill /IM "ADB桌面助手.exe" /F', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }

  log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  log('INSTALLED TOOLBOX CHECK DONE');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  log('脚本异常: ' + ((e && e.stack) || e));
  log('INSTALLED TOOLBOX CHECK DONE');
  process.exit(1);
});
