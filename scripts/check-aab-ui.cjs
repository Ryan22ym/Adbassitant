/**
 * AAB 安装界面验收（Electron 真渲染层）
 *
 * 开发态（默认）：
 *   python scripts/run-electron.py scripts/check-aab-ui.cjs \
 *       --watch ui-shots/_aab-ui.log --until "AAB UI CHECK DONE" --timeout 480
 *
 * 覆盖点
 * ---------------------------------------------------------------
 *  1. 工具页标签已改名为「安装安装包」（APK + AAB 同一个入口）
 *  2. 拖放区接受 .apk 与 .aab 两种文件
 *  3. 选中 .aab 后出现 AAB 类型标签
 *  4. AAB 环境提示（Java / bundletool）能读出来 —— 本机已就绪
 *  5. AAB 安装方式提示与 APK 不同（AAB 覆盖安装会被签名差异挡住）
 *  6. 拖入 .aab → 弹窗标题为「正在安装 AAB…」，并出现拆包提示
 *  7. 弹窗里有 bundletool 的实时输出流（拆包/安装过程可见）
 *  8. 装完复核通过 → 弹窗切「安装成功」，且文案说明用了 AAB 链路
 *  9. 渲染层无 error 级日志
 *
 * 素材：~/Downloads 下最小的 .aab（可用 AAB_FILE 指定）。
 * 目标设备默认 emulator-5556（可用 ADB_SERIAL 覆盖）—— 一定要挑模拟器，
 * 真机上的 AAB 签名跟原版几乎必然不同，覆盖安装会被系统拒。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_aab-ui.log');

const ADB = path.join(ROOT, 'bin', 'adb.exe');
const SERIAL = process.env.ADB_SERIAL || 'emulator-5556';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rows = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
};
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
/** 外部输出里的 FAIL/ERROR 会污染调用方的判定，统一打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r');

function pickAab() {
  if (process.env.AAB_FILE && fs.existsSync(process.env.AAB_FILE)) return process.env.AAB_FILE;
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return null;
  const list = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.aab'))
    .map((f) => ({ p: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.s - b.s);
  return list.length ? list[0].p : null;
}

/** 页内辅助：操作「安装安装包」页 + 读弹窗状态 */
const PAGE_HELPERS = `
window.__aab = {
  /** 切到常用工具页 */
  goto() { window.location.hash = '#/tools'; return true; },
  /** 点某个 tab */
  tab(label) {
    const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.textContent.trim() === label);
    if (!t) return 'no-tab:' + Array.from(document.querySelectorAll('.tab')).map(x=>x.textContent.trim()).join('|');
    t.click();
    return 'ok';
  },
  tabs: () => Array.from(document.querySelectorAll('.tab')).map((x) => x.textContent.trim()),
  /** 拖放区里的 APK/AAB 类型标签 */
  kindChip: () => {
    const c = document.querySelector('.install-kind-chip');
    return c ? { text: c.textContent.trim(), cls: c.className } : null;
  },
  /** AAB 环境提示块的文本 */
  envNotice: () => {
    const n = document.querySelector('[data-aab-env]');
    return n ? n.textContent.trim() : null;
  },
  /** 「安装方式」提示文案（AAB 与 APK 不同，用于验证提示按类型分流） */
  modeHint: () => {
    const box = document.querySelector('[data-install-mode]');
    if (!box) return null;
    const field = box.closest('.field');
    const h = field ? field.querySelector('.field-hint') : null;
    return h ? h.textContent.trim() : null;
  },
  /** 进度弹窗状态（data-install-kind 挂在 .install-card 上） */
  mask() {
    const m = document.querySelector('.install-mask');
    if (!m) return null;
    const card = m.querySelector('.install-card');
    return {
      kind: (card && card.getAttribute('data-install-kind')) || '',
      title: (m.querySelector('.install-title')?.textContent || '').trim(),
      detail: (m.querySelector('.install-detail:not(.install-stream)')?.textContent || '').trim(),
      stream: (m.querySelector('.install-stream')?.textContent || '').trim(),
      hasStream: !!m.querySelector('.install-stream'),
      note: (m.querySelector('.install-note')?.textContent || '').trim(),
      chips: Array.from(m.querySelectorAll('.install-chip')).map((c) => c.textContent.trim()),
    };
  },
  closeMask() {
    const m = document.querySelector('.install-mask');
    if (!m) return 'no-mask';
    const b = Array.from(m.querySelectorAll('button')).find((x) => /知道了|关闭|确定|好/.test(x.textContent));
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  },
  /** 选设备弹窗（多台在线时会出现） */
  pickDialog() {
    const d = document.querySelector('[data-pick-device]');
    if (!d) return null;
    return {
      text: d.textContent.trim(),
      options: Array.from(d.querySelectorAll('button,[role=button]')).map((b) => b.textContent.trim()),
    };
  },
  pickDevice(serial) {
    const d = document.querySelector('[data-pick-device]');
    if (!d) return 'no-dialog';
    const b = Array.from(d.querySelectorAll('button,[role=button]')).find((x) => x.textContent.includes(serial));
    if (!b) return 'no-option';
    b.click();
    return 'ok';
  },
  /** 给隐藏 input 挂文件后再派发拖放（与真人拖放同一条处理器） */
  fire(files, target) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const t = target || window;
    for (const ev of ['dragenter', 'dragover', 'drop']) {
      t.dispatchEvent(new DragEvent(ev, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return true;
  },
  probe: () => {
    const el = document.getElementById('__aab_probe');
    return el ? Array.from(el.files) : [];
  },
  /** 页面上「将安装到 xxx」 */
  targetText: () => (document.querySelector('.apk-target')?.textContent || '').trim(),
};
true;
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runChecks(page) {
  /* 等 React 挂载 + 设备列表就绪 */
  for (let i = 0; i < 40; i++) {
    const n = await page
      .evalJS(`document.getElementById('root') ? document.getElementById('root').children.length : 0`)
      .catch(() => 0);
    if (n > 0) break;
    await sleep(400);
  }
  for (let i = 0; i < 30; i++) {
    const n = await page.evalJS(`document.querySelectorAll('.device-select option').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(500);
  }

  /* 固定到模拟器（不要往真机上装 AAB 测试包） */
  const picked = await page.evalJS(`
    (() => {
      const sel = document.querySelector('.device-select');
      if (!sel) return 'no-select';
      const has = Array.from(sel.options).some((o) => o.value === ${JSON.stringify(SERIAL)});
      if (!has) return 'no-target:' + Array.from(sel.options).map((o) => o.value).join(',');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, ${JSON.stringify(SERIAL)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()
  `);
  record(picked === 'ok', '测试设备已固定为模拟器', String(picked));
  await sleep(800);

  /* 进常用工具页 */
  await page.evalJS(`window.location.hash = '#/tools'`);
  await sleep(700);
  await page.evalJS(PAGE_HELPERS);

  /* ---------- 1. 标签名 ---------- */
  const tabs = await page.evalJS(`window.__aab.tabs()`);
  log(`tabs: ${JSON.stringify(tabs)}`);
  const aabTab = (tabs || []).find((t) => /安装安装包|安装 APK/.test(t));
  record(!!aabTab, '工具页存在安装包入口标签', String(aabTab));
  record(
    aabTab === '安装安装包',
    '入口已改名为「安装安装包」（APK/AAB 共用）',
    String(aabTab),
  );

  const clicked = await page.evalJS(`window.__aab.tab(${JSON.stringify(aabTab || '安装安装包')})`);
  record(clicked === 'ok', '进入「安装安装包」标签页', String(clicked));
  await sleep(600);

  /* ---------- 2. 拖放区文案提到两种格式 ---------- */
  const dropText = await page.evalJS(
    `(document.querySelector('.apk-drop')?.textContent || '').trim()`,
  );
  log(`drop zone: ${safe(dropText)}`);
  record(/\bAPK\b/i.test(dropText), '拖放区提示接受 APK', safe(dropText));
  record(/\bAAB\b/i.test(dropText), '拖放区提示接受 AAB', safe(dropText));

  /* ---------- 3. AAB 环境（本机应已就绪） ---------- */
  const envApi = await page.evalJS(`window.adbApi.aabEnv(false)`);
  log(`aabEnv: ${JSON.stringify(envApi)}`);
  const env = envApi && envApi.ok ? envApi.data : null;
  record(!!env, 'aabEnv 接口可达', safe(envApi && envApi.error));
  if (env) {
    record(env.ready === true, 'AAB 环境就绪（Java + bundletool）', safe(env.reason || ''));
    record(env.bundletoolReady === true, 'bundletool 就位', safe(env.bundletoolPath));
    record(env.javaOk === true, 'Java 满足 11+', safe(env.javaVersion));
    record(
      !!env.downloadUrl && /github|bundletool/i.test(env.downloadUrl),
      '提供 bundletool 下载地址',
      safe(env.downloadUrl),
    );
  }

  /* ---------- 4. 挂真实文件 + 注入辅助 ---------- */
  const aabFile = pickAab();
  record(!!aabFile, '找到 .aab 素材', safe(aabFile || '无'));
  if (!aabFile) return;

  await page.evalJS(`
    (() => {
      const old = document.getElementById('__aab_probe');
      if (old) old.remove();
      const input = document.createElement('input');
      input.type = 'file';
      input.id = '__aab_probe';
      input.multiple = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(input);
      return true;
    })()
  `);
  await page.evalJS(PAGE_HELPERS);

  const dbg = { sendCommand: (m, p) => page.cdpSend(m, p) };
  await dbg.sendCommand('DOM.enable');
  const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 1 });
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#__aab_probe',
  });
  record(!!nodeId, 'CDP 找到隐藏文件输入框', `nodeId=${nodeId}`);
  if (!nodeId) return;

  await dbg.sendCommand('DOM.setFileInputFiles', { files: [aabFile], nodeId });

  /* ---------- 5. 选中 .aab → 出现 AAB 标签 ---------- */
  // 先记录 APK 状态下的提示与标签，稍后与 AAB 对比
  const apkHint = await page.evalJS(`window.__aab.modeHint()`);
  const apkChip = await page.evalJS(`window.__aab.kindChip()`);
  log(`apk hint: ${safe(apkHint)} | apk chip: ${JSON.stringify(apkChip)}`);
  record(!apkChip, '未选文件时没有类型标签', safe(JSON.stringify(apkChip)));

  await page.evalJS(`
    (() => {
      const z = document.querySelector('[data-dropzone]') || document.querySelector('.apk-drop');
      const files = window.__aab.probe();
      window.__aab.fire(files, z);
      return true;
    })()
  `);
  await sleep(900);

  let chip = await page.evalJS(`window.__aab.kindChip()`);
  log(`kind chip: ${JSON.stringify(chip)}`);
  record(!!chip, '选中 .aab 后出现类型标签', safe(JSON.stringify(chip)));
  record(!!chip && /AAB/i.test(chip.text || ''), '类型标签标识为 AAB', safe(chip ? chip.text : 'null'));
  record(!!chip && /aab/.test(chip.cls || ''), '类型标签带 aab 样式类（配色区分）', safe(chip ? chip.cls : 'null'));

  const target = await page.evalJS(`window.__aab.targetText()`);
  log(`target: ${safe(target)}`);
  record(!!target && target.length > 0, '页面显示了目标设备', safe(target));

  /* ---------- 6. 安装方式提示区分 AAB ---------- */
  const hint = await page.evalJS(`window.__aab.modeHint()`);
  log(`aab mode hint: ${safe(hint)}`);
  record(!!hint, '「安装方式」有提示文案', safe(hint || 'null'));
  record(
    !!hint && hint !== apkHint,
    'AAB 的安装方式提示与 APK 不同（签名差异需说明）',
    `${safe(apkHint)} → ${safe(hint)}`,
  );

  /* AAB 环境提示块应出现且显示就绪 */
  const envText = await page.evalJS(`window.__aab.envNotice()`);
  log(`env notice: ${safe(envText)}`);
  record(!!envText, '页面显示 AAB 环境提示块', safe(envText || 'null'));
  record(
    !!envText && /就绪|bundletool/i.test(envText),
    'AAB 环境提示块说明了 Java/bundletool 状态',
    safe((envText || '').slice(0, 160)),
  );

  /* 起装：走整窗拖放（与真人一致） */
  await page.evalJS(`
    (() => {
      const files = window.__aab.probe();
      window.__aab.fire(files, window);
      return true;
    })()
  `);

  /* 多台在线会先问「装到哪台」——必须问，不能自己猜 */
  let sawPick = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const d = await page.evalJS(`window.__aab.pickDialog()`);
    if (d) {
      sawPick = true;
      log(`pick dialog: ${safe(JSON.stringify(d))}`);
      // AAB 要按所选设备拆包，提示里应当说明
      record(/aab/i.test(d.text), '选设备弹窗说明 AAB 会额外拆包', safe(d.text.slice(0, 120)));
      await page.evalJS(`window.__aab.pickDevice(${JSON.stringify(SERIAL)})`);
      break;
    }
    const m = await page.evalJS(`window.__aab.mask()`);
    if (m) break;
  }
  const onlineCount = await page.evalJS(`document.querySelectorAll('.device-select option').length`);
  log(`online devices in UI: ${onlineCount}, sawPick=${sawPick}`);
  record(
    onlineCount > 1 ? sawPick : true,
    onlineCount > 1 ? '多台设备在线时必须先问装到哪台' : '单台设备在线时直接开装',
    `online=${onlineCount} sawPick=${sawPick}`,
  );

  /* ---------- 7. 安装中：标题 + 拆包提示 + 输出流 ---------- */
  let seen = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const m = await page.evalJS(`window.__aab.mask()`);
    if (m) {
      seen = m;
      break;
    }
  }
  log(`mask during install: ${safe(JSON.stringify({ ...seen, detail: (seen && seen.detail || '').slice(0, 120) }))}`);
  record(!!seen, '出现安装进度弹窗', safe(JSON.stringify(seen)));
  if (seen) {
    record(
      /AAB/i.test(seen.title),
      '弹窗标题标明这是在装 AAB',
      safe(seen.title),
    );
    record(
      seen.kind === 'aab',
      '弹窗带 data-install-kind=aab（样式与文案分流正确）',
      safe(seen.kind),
    );
    record(
      /拆包|bundletool|复用/.test(seen.note || ''),
      '弹窗提示 AAB 会先按设备拆包',
      safe(seen.note),
    );
  }
  await page.screenshot(path.join(OUT, 'aab-ui-1-installing.png'));

  /* 拆包过程应当有实时输出（首次会跑十几秒） */
  let streamText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const m = await page.evalJS(`window.__aab.mask()`);
    if (!m) break;
    if (m.stream) streamText = m.stream;
    if (m.stream && m.stream.length > 0) break;
    if (/安装成功|安装失败/.test(m.title)) break;
  }
  record(streamText.length > 0, '弹窗展示了 bundletool 的实时输出', safe(streamText.slice(0, 120)));

  /* ---------- 8. 等结果 ---------- */
  let done = null;
  for (let i = 0; i < 200; i++) {
    await sleep(500);
    const m = await page.evalJS(`window.__aab.mask()`);
    if (m && /安装成功|安装失败/.test(m.title)) {
      done = m;
      break;
    }
    if (!m) break;
  }
  log(`mask result: ${safe(JSON.stringify({ ...done, detail: (done && done.detail || '').slice(0, 400) }))}`);
  record(
    !!(done && done.title.includes('安装成功')),
    'AAB 安装成功，弹窗切到「安装成功」',
    safe(done ? done.title : 'null'),
  );
  if (done && done.title.includes('安装成功')) {
    // 文案要说明走的是 AAB 链路（bundletool 拆包 + install-multiple）
    const blob = `${done.detail || ''} ${done.note || ''}`;
    record(/AAB|bundletool|拆包|install-multiple/.test(blob), '成功文案说明走的是 AAB 链路', safe(blob.slice(0, 200)));
    record(/复核|pm path|已确认/.test(blob), '成功文案提到装后复核', safe(blob.slice(0, 200)));
  }
  await page.screenshot(path.join(OUT, 'aab-ui-2-result.png'));

  /* 清场：关掉结果弹窗 */
  const closed = await page.evalJS(`window.__aab.closeMask()`);
  log(`close mask: ${closed}`);

  /* ---------- 9. 渲染层错误 ---------- */
  const errs = page.errors ? page.errors() : [];
  log(`renderer errors: ${safe(JSON.stringify(errs))}`);
  record(!errs || errs.length === 0, '渲染层无 error 级日志', safe(JSON.stringify((errs || []).slice(0, 3))));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url, errors) {
    this.id = 0;
    this.pending = new Map();
    this.errors = errors || [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    }
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

async function openInstalled() {
  const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'ADB桌面助手.exe');
  const PORT = 9349;
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  log(`launching installed: ${EXE} (cdp ${PORT})`);
  spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    env,
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
  }).unref();

  let target = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    target = await new Promise((resolve) => {
      const req = require('http').get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
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
    if (target) break;
  }
  if (!target) throw new Error('安装版未能在预期时间内开出调试端点');

  const errors = [];
  const cdp = new CDP(target.webSocketDebuggerUrl, errors);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        errors.push(m.params.entry.text);
      }
    } catch {
      /* ignore */
    }
  });

  return {
    page: {
      evalJS: (expr) => cdp.eval(expr),
      cdpSend: (m, p) => cdp.send(m, p),
      screenshot: async (file) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      },
      errors: () => errors,
    },
    close: () => cdp.close(),
  };
}

/* ------------------------------------------------------------------ */
/* 开发态渲染层：在 Electron 里加载 dist/index.html 后直接跑             */
/* ------------------------------------------------------------------ */

async function runInElectron() {
  const electronMain = require('electron');
  if (typeof electronMain !== 'object' || !electronMain.app) {
    log('FATAL 未在 Electron 运行时中执行（请用 run-electron.py 起）');
    return;
  }
  const { app, BrowserWindow } = electronMain;
  await app.whenReady();

  // 界面要调 window.adbApi，主进程的 IPC handler 必须先注册
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) errors.push(msg);
  });

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));

  // 隐藏窗口的合成器不会主动出帧，首次 capturePage 往往拿到陈旧帧，先丢一帧
  const page = {
    evalJS: (expr) => win.webContents.executeJavaScript(expr),
    // 懒 attach：与既有脚本保持一致的时机
    cdpSend: (m, p) => {
      const d = win.webContents.debugger;
      if (!d.isAttached()) d.attach('1.3');
      return d.sendCommand(m, p);
    },
    screenshot: async (file) => {
      try {
        win.webContents.invalidate();
      } catch {
        /* ignore */
      }
      await sleep(300);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
    },
    errors: () => errors,
  };

  try {
    await page.screenshot(path.join(OUT, 'aab-ui-0-boot.png'));
    await runChecks(page);
  } catch (e) {
    log(`FATAL ${safe(e && e.message)}`);
    record(false, '执行检查流程', safe(e && e.message));
  } finally {
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    } catch {
      /* ignore */
    }
    app.quit();
  }
}

/* ------------------------------------------------------------------ */

(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  const INSTALLED = process.argv.includes('--installed');
  // 安装版分支跑在 **Electron 主进程** 里，而主进程没有全局 WebSocket（见 _ws-shim.cjs），
  // 不打这个垫片，CDP 客户端会直接抛 "WebSocket is not defined" 变成假失败。
  if (INSTALLED) {
    const patched = require('./_ws-shim.cjs').install();
    log(`ws-shim: ${patched ? '已挂载' : '已存在（未覆盖）'}`);
  }
  const aabFile = pickAab();
  log(`aab fixture: ${safe(aabFile || 'none')}`);
  if (aabFile) log(`size: ${(fs.statSync(aabFile).size / 1048576).toFixed(1)}MB`);

  if (INSTALLED) {
    let session = null;
    try {
      session = await openInstalled();
      await runChecks(session.page);
    } catch (e) {
      log(`FATAL ${safe(e.message)}`);
      record(false, '安装版界面验收可执行', safe(e.message));
    } finally {
      if (session) session.close();
    }
    finish();
  } else {
    await runInElectron();
    finish();
  }

  function finish() {
    const pass = rows.filter((r) => r.startsWith('PASS')).length;
    const fail = rows.filter((r) => r.startsWith('FAIL')).length;
    log('===== AAB UI CHECK =====');
    for (const r of rows) log(r);
    log(`${pass} 通过 / ${fail} 失败`);
    log('AAB UI CHECK DONE');
    process.exit(fail === 0 ? 0 : 1);
  }
})();
