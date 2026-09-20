#!/usr/bin/env node
/**
 * 在线更新（v1.0.22）界面验收。
 *
 * 做什么：
 *   1. 在本机起一个**假更新源**（纯 node:http，随机端口），latest.json 声明一个比当前更高的版本；
 *   2. 起 vite dev server + dev 模式的 Electron（未打包 → 主进程 localKind() = 'dev'）；
 *   3. 用 CDP 进设置页，按真实用户路径走一遍：填更新源地址 → 保存 → 点「检查更新」；
 *   4. 断言六态里的「未配置」与「有新版本」，以及「离线兜底入口还在」等界面契约。
 *
 * 为什么用 dev 模式而不是安装版：
 *   这一轮改的是界面与主进程接口，dev 形态足以覆盖渲染与 IPC；
 *   真正「下载 → 替换 → 重启成新版本」的端到端属于 e2e-update-apply.cjs 那条链，
 *   需要在安装版上跑（见 docs/online-update-design.md §6）。
 *
 * 不碰设备、不联网（除 127.0.0.1）；跑完会把 updateBaseUrl 恢复成空。
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const VITE_JS = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_PORT = 5273;
const CDP_PORT = 9342;
const OUT_DIR = path.join(ROOT, 'ui-shots');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** 造一个必然大于当前版本的版本号（读 package.json，末位 +1） */
function nextVersion(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join('.');
}
const NEXT_VERSION = nextVersion(PKG_VERSION);

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
};
const info = (m) => console.log('  · ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 极简 zip 生成（store 不压缩）—— 只为让 prepareUpdate 能读到 manifest.json */
/* ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/* ------------------------------------------------------------------ */
/* 假更新源                                                            */
/* ------------------------------------------------------------------ */

function startFakeSource() {
  /*
   * 包里放一份**合法 manifest**（而不是随便几个字节）—— 这样下载回来的包会真的
   * 走进 prepareUpdate 的校验链，只是被「开发模式（未打包）」这一关拒掉；
   * 用垃圾字节的话会在「读 manifest」更早一步就失败，证明不了链路是通的。
   */
  const manifest = {
    schema: 1,
    productName: 'ADB桌面助手',
    appId: 'com.xiaoyang.adbassistant',
    version: NEXT_VERSION,
    builtAt: '2026-09-25T09:50:00',
    electronVersion: process.versions.electron || '33.0.0',
    baseRuntimeHash: 'x'.repeat(64),
    resultRuntimeHash: 'x'.repeat(64),
    kind: 'asar',
    files: [{ path: 'app.asar', size: 3, sha256: 'y'.repeat(64) }],
  };
  const payload = makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }]);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const hitLog = [];

  const doc = {
    schema: 1,
    productName: 'ADB桌面助手',
    appId: 'com.xiaoyang.adbassistant',
    channel: 'stable',
    generatedAt: new Date().toISOString(),
    latest: {
      version: NEXT_VERSION,
      publishedAt: '2026-09-25T10:00:00+08:00',
      notes: '这是一条来自假更新源的更新说明。\n第二行用于验证换行。',
      critical: false,
      packages: {
        asar: { url: 'pkg.zip', size: payload.length, sha256: sha },
        portable: { url: 'pkg.zip', size: payload.length, sha256: sha },
      },
    },
  };

  const server = http.createServer((req, res) => {
    hitLog.push(req.url);
    if (req.url.startsWith('/latest.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(doc));
      return;
    }
    if (req.url.startsWith('/pkg.zip')) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(payload.length) });
      res.end(payload);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}/`;
      resolve({ server, baseUrl, hitLog, pkgUrl: baseUrl + 'pkg.zip', pkgSha: sha });
    });
  });
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
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

function waitHttp(port, pathName = '/', retries = 80, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => (n >= retries ? resolve(false) : setTimeout(tick, interval)));
      req.on('timeout', () => {
        req.destroy();
        n >= retries ? resolve(false) : setTimeout(tick, interval);
      });
    };
    tick();
  });
}

function waitTarget(retries = 90, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http
        .get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              /*
               * 🔴 dev 模式下应用会自带 DevTools 窗口，它同样是 type='page'。
               * 不过滤的话会连上 DevTools 自己的页面（症状：body 里只有
               * 「DevTools is undocked」、没有 #root），断言全部落空。
               */
              const pages = list.filter(
                (t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^devtools:/i.test(t.url || ''),
              );
              const page = pages.find((t) => /5273/.test(t.url || '')) || pages[0];
              if (page) return resolve(page);
            } catch {
              /* ignore */
            }
            if (n >= retries) return resolve(null);
            setTimeout(tick, interval);
          });
        })
        .on('error', () => (n >= retries ? resolve(null) : setTimeout(tick, interval)));
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */

/**
 * dev 模式的 Electron 跑的是 `dist-electron/` 里的编译产物，不是 src。
 * 编译产物过期 = 拿旧的主进程代码验收界面，会出现「界面绿了、接口没生效」。
 * 所以这里先自己编一遍（约 5~10 秒），编不过直接判失败。
 */
function ensureBuilt() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.log('找不到 typescript（' + tsc + '），先 npm install 再跑。');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log('主进程编译失败，验收无意义（先修 tsc）：');
    console.log((r.stdout || '') + (r.stderr || ''));
    process.exit(2);
  }
}

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.log('找不到 electron：' + ELECTRON);
    process.exit(2);
  }
  ensureBuilt();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const src = await startFakeSource();
  info(`假更新源：${src.baseUrl} → 声明 v${NEXT_VERSION}（当前 v${PKG_VERSION}）`);

  let vite = null;
  let app = null;
  let cdp = null;

  try {
    // vite dev server：main.ts 在未打包时加载 VITE_DEV_SERVER_URL 或 http://localhost:5273。
    // 🔴 必须显式 --host 127.0.0.1：vite 6 默认只绑 localhost（本机是 IPv6 的 ::1），
    // 那样下面的 127.0.0.1 探测与 Electron 里的 localhost 解析都可能对不上。
    const viteAlive = await waitHttp(VITE_PORT, '/', 2, 200);
    if (viteAlive) {
      info('检测到已有 vite dev server，直接复用');
    } else {
      vite = spawn(
        process.execPath,
        [VITE_JS, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'],
        { cwd: ROOT, stdio: 'ignore' },
      );
      const up = await waitHttp(VITE_PORT, '/', 60, 500);
      check('vite dev server 已就绪', up, `:${VITE_PORT}`);
      if (!up) throw new Error('vite 启动失败');
    }

    const env = {
      ...process.env,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${VITE_PORT}`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env,
    });
    app.unref();

    const target = await waitTarget();
    check('dev 模式应用可启动（CDP 可连）', !!target);
    if (!target) throw new Error('应用没起来');

    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    for (let i = 0; i < 40; i++) {
      const n = await cdp
        .eval(`document.getElementById('root') ? document.getElementById('root').children.length : -1`)
        .catch(() => -1);
      if (n > 0) break;
      await sleep(400);
    }

    await cdp.eval(`location.hash = '#/settings'; true`);
    // 等到面板出现、且检查状态离开「检查中」为止（首次进页面会自动查一次）
    let panelOk = false;
    let st1 = null;
    for (let i = 0; i < 30; i++) {
      st1 = await cdp.eval(`(() => {
        const p = document.querySelector('[data-update-panel]');
        return p ? p.getAttribute('data-update-check') : null;
      })()`);
      if (st1 && st1 !== 'checking') {
        panelOk = true;
        break;
      }
      await sleep(400);
    }
    if (!panelOk) {
      // 渲染不出来时把现场 dump 出来：是没切到设置页，还是页面崩了（白屏）
      const diag = await cdp.eval(`(() => {
        const cards = [...document.querySelectorAll('.card')].map((c) => (c.innerText || '').split('\\n')[0]);
        return {
          hash: location.hash,
          rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
          cards: cards.slice(0, 14),
          hasUpdatePanelText: /软件更新/.test(document.body.innerText || ''),
          text: (document.body.innerText || '').slice(0, 500),
        };
      })()`);
      console.log('  [diag] ' + JSON.stringify(diag).slice(0, 1200));
    }

    /* ---------------- 段一：未配置更新源（服务器没就绪时的常态） ---------------- */

    const part1 = await cdp.eval(`(() => {
      const p = document.querySelector('[data-update-panel]');
      if (!p) return { found: false };
      const btns = Array.from(p.querySelectorAll('button')).map((b) => b.textContent.trim());
      return {
        found: true,
        kind: p.getAttribute('data-update-kind'),
        checkState: p.getAttribute('data-update-check'),
        text: p.innerText || '',
        btns,
        hasUnconfigured: !!p.querySelector('[data-update-unconfigured]'),
        hasCheckBtn: !!p.querySelector('[data-update-check-btn]'),
        hasPickBtn: !!p.querySelector('[data-update-pick]'),
        hasDownloadBtn: !!p.querySelector('[data-update-download]'),
        hasSourceInput: !!document.querySelector('[data-update-source-input]'),
        hasSourceSave: !!document.querySelector('[data-update-source-save]'),
      };
    })()`);

    check('设置页渲染出「软件更新」面板', !!part1.found);
    if (!part1.found) throw new Error('面板没渲染出来');
    info(`形态=${part1.kind} 检查态=${part1.checkState}`);

    check('未配置更新源时是「未配置」灰字态（不是错误态）', part1.checkState === 'unconfigured', part1.checkState);
    check('未配置态有一行说明文字', part1.hasUnconfigured);
    check('dev 形态被识别为 dev（未打包）', part1.kind === 'dev', String(part1.kind));
    check('dev 下提示「当前不支持应用内更新」', /当前不支持应用内更新/.test(part1.text));
    check('有「检查更新」按钮', part1.hasCheckBtn && part1.btns.some((b) => b.includes('检查更新')), part1.btns.join(' | '));
    check('保留「选择更新包…」离线兜底入口', part1.hasPickBtn && part1.btns.some((b) => b.includes('选择更新包')), part1.btns.join(' | '));
    check('未选包时不出现「立即更新并重启」（不会误点）', !/立即更新并重启/.test(part1.text));
    check('未配置态不出现「下载并更新」', !part1.hasDownloadBtn);
    check('「更新源」设置卡片存在（输入框 + 保存）', part1.hasSourceInput && part1.hasSourceSave);
    check('面板仍写明校验项（含 SHA-256）', /SHA-256/.test(part1.text));
    check('面板写明两条更新入口', /在线更新/.test(part1.text) && /选择更新包/.test(part1.text));

    /* ---------------- 段二：填地址 → 保存 → 检查更新 ---------------- */

    const savedOk = await cdp.eval(`(async () => {
      const el = document.querySelector('[data-update-source-input]');
      if (!el) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(src.baseUrl)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const btn = document.querySelector('[data-update-source-save]');
      if (!btn) return 'no-save-btn';
      if (btn.disabled) return 'save-disabled';
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      const r = await window.adbApi.getSettings();
      return (r && r.data && r.data.updateBaseUrl) || '';
    })()`);
    check('通过界面保存更新源地址（落进设置）', String(savedOk).startsWith('http://127.0.0.1'), String(savedOk));

    // 点「检查更新」（dev 形态也允许，只读操作）
    const clicked = await cdp.eval(`(() => {
      const btn = document.querySelector('[data-update-check-btn]');
      if (!btn) return false;
      if (btn.disabled) return 'disabled';
      btn.click();
      return true;
    })()`);
    check('可以点「检查更新」（dev 形态下不被禁用）', clicked === true, String(clicked));

    let part2 = null;
    for (let i = 0; i < 30; i++) {
      part2 = await cdp.eval(`(() => {
        const p = document.querySelector('[data-update-panel]');
        if (!p) return null;
        const avail = p.querySelector('[data-update-available]');
        return {
          checkState: p.getAttribute('data-update-check'),
          text: p.innerText || '',
          availText: avail ? avail.innerText : '',
          hasDownloadBtn: !!p.querySelector('[data-update-download]'),
          kv: (() => { const o = {}; p.querySelectorAll('.kv').forEach((r) => {
            const k = r.querySelector('.kv-key'); const v = r.querySelector('.kv-value');
            if (k && v) o[k.textContent.trim()] = v.textContent.trim();
          }); return o; })(),
        };
      })()`);
      if (part2 && part2.checkState === 'available') break;
      await sleep(500);
    }

    check('检查更新后进入「有新版本」态', !!part2 && part2.checkState === 'available', part2 && part2.checkState);
    if (part2) {
      check('新版本卡片显示版本号', new RegExp(NEXT_VERSION.replace(/\./g, '\\.')).test(part2.availText), part2.availText.replace(/\s+/g, ' ').slice(0, 120));
      check('新版本卡片显示更新说明（含换行）', /假更新源的更新说明/.test(part2.availText), '');
      check('新版本卡片显示发布时间', /发布时间/.test(part2.availText), '');
      check('kv 里的「更新源」变成真实地址描述', /127\.0\.0\.1/.test(String(part2.kv['更新源'] || '')), String(part2.kv['更新源']));
      check('kv 里的「最近检查」已写入时间', /\d{4}-\d{2}-\d{2}/.test(String(part2.kv['最近检查'] || '')), String(part2.kv['最近检查']));
      // dev 形态没有对应的包（pkg=null）→ 不该出现下载按钮，且给出提示
      check('dev 形态下不出现「下载并更新」（无对应形态的包）', !part2.hasDownloadBtn);
      check('假更新源确实被请求过 latest.json', src.hitLog.some((u) => u.startsWith('/latest.json')), src.hitLog.join(','));
    }

    /* ---------------- 段三：下载链路（IPC，同一个假源） ---------------- */

    const dlGood = await cdp.eval(`(async () => {
      const r = await window.adbApi.downloadUpdate(${JSON.stringify(src.pkgUrl)}, ${JSON.stringify(src.pkgSha)});
      return r;
    })()`);
    check(
      '下载正常包：请求成功返回（下载 + sha256 校验过）',
      !!dlGood && dlGood.ok === true && !!dlGood.data,
      JSON.stringify(dlGood).slice(0, 200),
    );
    check(
      '下载后确实走进既有校验链（合法包一路校验，在「开发模式」这一关被拒）',
      !!(dlGood && dlGood.data && !dlGood.data.ok && /开发模式/.test(String(dlGood.data.reason || ''))),
      String(dlGood && dlGood.data && dlGood.data.reason),
    );

    const dlBad = await cdp.eval(`(async () => {
      const r = await window.adbApi.downloadUpdate(${JSON.stringify(src.pkgUrl)}, 'deadbeef');
      return r;
    })()`);
    check(
      '下载内容与清单 sha256 不符 → 被拒绝且给出原因',
      !!(dlBad && dlBad.data && !dlBad.data.ok && /校验值不符/.test(String(dlBad.data.reason || ''))),
      String(dlBad && dlBad.data && dlBad.data.reason),
    );

    const dl404 = await cdp.eval(`(async () => {
      const r = await window.adbApi.downloadUpdate(${JSON.stringify(src.baseUrl)} + 'nope.zip', '');
      return r;
    })()`);
    check(
      '包地址 404 → 明确报错（不崩）',
      !!(dl404 && dl404.data && !dl404.data.ok && /下载更新包失败/.test(String(dl404.data.reason || ''))),
      String(dl404 && dl404.data && dl404.data.reason),
    );

    // 截图（滚动到更新面板）
    await cdp.eval(`(() => {
      const p = document.querySelector('[data-update-panel]');
      if (p) p.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
    if (shot && shot.data) {
      const p = path.join(OUT_DIR, 'update-online-settings.png');
      fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
      console.log('\n截图 ->', p);
    }

    /* ---------------- 收尾：把更新源恢复成空，别污染本机设置 ---------------- */

    await cdp
      .eval(`(async () => { await window.adbApi.setSettings({ updateBaseUrl: '' }); return true; })()`)
      .catch(() => {});
    const restored = await cdp
      .eval(`(async () => { const r = await window.adbApi.getSettings(); return (r && r.data && r.data.updateBaseUrl) || ''; })()`)
      .catch(() => '__unknown__');
    check('跑完把更新源恢复为空（不留残留配置）', restored === '', String(restored));
  } catch (e) {
    fails++;
    console.log('[FAIL] 运行异常 :: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (cdp) cdp.close();
    if (app && app.pid) {
      try {
        process.kill(app.pid);
      } catch {
        /* ignore */
      }
    }
    if (vite && vite.pid) {
      try {
        process.kill(vite.pid);
      } catch {
        /* ignore */
      }
    }
    src.server.close();
  }

  console.log(fails === 0 ? '\nUPDATE ONLINE UI CHECK: 全部通过' : `\nUPDATE ONLINE UI CHECK: ${fails} 项失败`);
  console.log('UPDATE ONLINE UI CHECK DONE');
  process.exit(fails === 0 ? 0 : 1);
})();
