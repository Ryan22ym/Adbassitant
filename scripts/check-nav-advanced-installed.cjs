/**
 * 安装版「导航增强」验收（v1.1.27）
 * ============================================================
 * 与 scripts/check-nav-advanced.cjs 的分工：那个跑开发态（自己 new BrowserWindow 加载
 * dist/index.html），验的是源码；这个连**装到本机的 exe**，验的是新代码真的进了包、
 * 界面真的把拖拽与拖出开窗跑起来了 —— 「装完了还是旧版本」只有这条链路能发现。
 *
 * 跑法（必须用宿主 Node：Node 22 才有全局 WebSocket）：
 *   node scripts/check-nav-advanced-installed.cjs
 * 结果：ui-shots/_nav-adv-installed.log（末尾 NAV ADV INSTALLED CHECK DONE）
 *
 * 🔴 脚本会改两处真实配置（装出来的 Conf/features.json 与 userData/settings.json），
 *    开跑前整份备份、结束时原样写回 —— 否则用户装好的应用会被验成「功能开着」。
 * ⚠️ 会先 taskkill 正在跑的实例，验完再关掉自己拉起的那个。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'ADB桌面助手.exe');
const CONF = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'Conf', 'features.json');
const SETTINGS = path.join(process.env.APPDATA, 'adb-assistant', 'settings.json');
const PORT = 9356;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_nav-adv-installed.log');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(LOG, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}
let failed = 0;
function ok(cond, name, detail) {
  if (!cond) failed++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + detail : ''}`);
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
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

const READ = `
  (() => {
    const nav = document.querySelector('.sidebar-nav');
    const bar = document.querySelector('.sidebar');
    return {
      enhanced: nav ? nav.dataset.navEnhanced : null,
      order: [...document.querySelectorAll('[data-nav-item]')].map((e) => e.dataset.navItem),
      popCount: document.querySelectorAll('.nav-pop').length,
      tear: document.querySelector('.nav-tear')?.dataset.navTear || null,
      barRight: bar ? Math.round(bar.getBoundingClientRect().right) : null,
      wins: [...document.querySelectorAll('.mini-window')].map((w) => ({
        id: w.dataset.miniId,
        pinned: w.dataset.miniPinned === '1',
        left: Math.round(w.getBoundingClientRect().left),
      })),
      card: [...document.querySelectorAll('.card-title')].some((t) => t.textContent.includes('导航增强')),
      switchOn: (() => {
        const el = document.querySelector('[data-nav-adv-switch] .switch');
        return el ? el.getAttribute('aria-checked') === 'true' : null;
      })(),
    };
  })()
`;

const killApp = () => {
  try {
    execSync('taskkill /IM "ADB桌面助手.exe" /F', { stdio: 'ignore' });
  } catch {
    /* 本来就没在跑 */
  }
};

const launch = async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    env,
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
  });
  child.unref();
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(1000);
    target = await listTarget();
  }
  if (!target) throw new Error('安装版 60s 内没开出调试端点');
  const page = new Cdp(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  return page;
};

/** 读一个 JSON 文件（坏/缺失返回 null） */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const confBackup = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : null;
const settingsBackup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;

function restore() {
  try {
    if (confBackup !== null) fs.writeFileSync(CONF, confBackup, 'utf8');
  } catch (e) {
    log('还原 Conf 失败:', String(e));
  }
  try {
    if (settingsBackup !== null) fs.writeFileSync(SETTINGS, settingsBackup, 'utf8');
  } catch (e) {
    log('还原 settings 失败:', String(e));
  }
}

(async () => {
  log('=== INSTALLED NAV ADVANCED CHECK ===');
  ok(fs.existsSync(EXE), 'A0 安装版 exe 存在', EXE);

  /* 先把功能明确关掉（文件里写 false），验关闭态 */
  const conf = readJson(CONF) || {};
  conf.features = conf.features || {};
  conf.features.ui = { ...(conf.features.ui || {}), navAdvanced: false };
  fs.writeFileSync(CONF, JSON.stringify(conf, null, 2), 'utf8');

  killApp();
  await sleep(900);

  /* ---------------- 阶段 1：关闭态 ---------------- */
  let page = await launch();
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await page.eval(READ);
    if (st && st.order && st.order.length) break;
    await sleep(300);
  }
  log('关闭态:', JSON.stringify(st));

  ok(st && st.enhanced === '0', 'B1 安装版：关闭态侧栏没有拖拽形态', st && st.enhanced);
  ok(st && st.popCount === 0, 'B2 安装版：没有任何小窗入口按钮', st && st.popCount);
  ok(st && st.order.includes('toolbox'), 'B3 安装版：导航项齐全', st && st.order.join('/'));

  await page.eval(`location.hash = '#/settings'`);
  await sleep(1500);
  const setSt = await page.eval(READ);
  ok(setSt && setSt.card, 'B4 安装版：设置页有「导航增强」卡片', String(setSt && setSt.card));
  ok(setSt && setSt.switchOn === false, 'B5 安装版：卡片开关显示为关', String(setSt && setSt.switchOn));

  page.close();
  killApp();
  await sleep(900);

  /* ---------------- 阶段 2：改文件 + 重启 → 开启态 ---------------- */
  conf.features.ui.navAdvanced = true;
  fs.writeFileSync(CONF, JSON.stringify(conf, null, 2), 'utf8');
  page = await launch();
  let on = null;
  for (let i = 0; i < 40; i++) {
    on = await page.eval(READ);
    if (on && on.order && on.order.length) break;
    await sleep(300);
  }
  log('开启态:', JSON.stringify(on));

  ok(on && on.enhanced === '1', 'C1 安装版：文件开关 true 重启后生效', on && on.enhanced);
  ok(on && on.popCount === 0, 'C2 安装版：仍然没有入口按钮', on && on.popCount);

  /* 拖出去：按下 → 拖到栏外 → 看拖影 → 松手开窗 */
  const targetId = on.order[0];
  const dropX = on.barRight + 300;
  const grabY = await page.eval(
    `(() => { const r = document.querySelector('[data-nav-item="${targetId}"]').getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`,
  );

  await page.eval(`
    (() => {
      const slot = document.querySelector('[data-nav-item="${targetId}"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 21, button: 0, clientX: cx, clientY: cy });
      slot.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x + 60, y + 6)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(${dropX}, ${grabY})));
      return true;
    })()
  `);
  await sleep(400);
  const mid = await page.eval(READ);
  ok(mid.tear === targetId, 'C3 安装版：拖到栏外出现拖影', String(mid.tear));
  ok(mid.order.join('|') === on.order.join('|'), 'C4 安装版：拖出期间顺序不变', mid.order.join('/'));

  await page.eval(
    `window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 21, button: 0, clientX: ${dropX}, clientY: ${grabY} }))`,
  );
  await sleep(700);
  const dropped = await page.eval(READ);
  ok(
    dropped.wins.length === 1 && dropped.wins[0].id === targetId,
    'C5 安装版：松手开出对应页面小窗',
    JSON.stringify(dropped.wins),
  );
  ok(dropped.tear === null, 'C6 安装版：松手后拖影消失', String(dropped.tear));

  /* 未 pin：点外部关 */
  await page.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(400);
  const closed = await page.eval(READ);
  ok(closed.wins.length === 0, 'C7 安装版：未固定时点外部自动关闭', `${closed.wins.length} 扇`);

  /* 再拖一次并 pin，点外部应保持 */
  await page.eval(`
    (() => {
      const slot = document.querySelector('[data-nav-item="${targetId}"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const opt = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 22, button: 0, clientX: cx, clientY: cy });
      slot.dispatchEvent(new PointerEvent('pointerdown', opt(x, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(x + 60, y)));
      window.dispatchEvent(new PointerEvent('pointermove', opt(${dropX}, ${grabY})));
      window.dispatchEvent(new PointerEvent('pointerup', opt(${dropX}, ${grabY})));
      return true;
    })()
  `);
  await sleep(700);
  await page.eval(`document.querySelector('[data-mini-pin]').click()`);
  await sleep(300);
  await page.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(400);
  const pinned = await page.eval(READ);
  ok(
    pinned.wins.length === 1 && pinned.wins[0].pinned === true,
    'C8 安装版：固定后点外部保持显示',
    JSON.stringify(pinned.wins),
  );

  await page.eval(`document.querySelector('[data-mini-close]').click()`);
  await sleep(300);
  const done = await page.eval(READ);
  ok(done.wins.length === 0, 'C9 安装版：关闭按钮能关掉小窗', `${done.wins.length} 扇`);

  page.close();
  log(`合计 ${failed === 0 ? 'PASS' : '有 ' + failed + ' 项失败'}`);
  log('NAV ADV INSTALLED CHECK DONE');
  killApp();
  restore();
  await sleep(500);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  log('CRASH:', (e && e.stack) || String(e));
  log('NAV ADV INSTALLED CHECK DONE');
  killApp();
  restore();
  await sleep(300);
  process.exit(1);
});
