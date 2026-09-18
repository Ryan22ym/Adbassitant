/**
 * 「导出通用 APK」安装版界面冒烟（默认**不碰设备、不装任何包**）
 *
 *   node scripts/check-aab-universal-ui.cjs                    # 安全模式（默认）
 *   node scripts/check-aab-universal-ui.cjs --with-drop        # 追加拖放段（要求设备全是模拟器）
 *   node scripts/check-aab-universal-ui.cjs --exe "D:\\...\\ADB桌面助手.exe"
 *   AAB_FILE="D:\\xxx.aab" node scripts/check-aab-universal-ui.cjs --with-drop
 *
 * 背景：为什么要拆成「安全默认 + 显式开关」
 * ---------------------------------------------------------------
 * 发版后需要一个代价极低的冒烟，确认装到本机的这一份里「导出通用 APK」
 * 入口真的渲染出来了。但踩过一个坑，必须写在这里：
 *
 *   ⚠️ 安装页的拖放区（`.apk-drop`）onDrop **就是「拖入即安装」**
 *      （ToolsPage → handleDroppedFiles），它不区分「只是选中」。
 *      用 DataTransfer 合成 drop 事件（哪怕落点在拖放区）会**真实安装到
 *      当前选中的设备**上 —— 真机上就是这么被误装了一个 200 MB 的包。
 *      而且事件 bubbles:true，落到哪儿都会冒泡到整窗处理器。
 *
 * 所以：默认模式只用「不需要选中文件」的断言；真要验证「选中 AAB → 按钮出现」，
 * 必须显式加 --with-drop，且脚本会先确认**在线设备全是 emulator-***
 * （模拟器上被装包无所谓，真机上不行），否则直接跳过这一段。
 *
 * 安全模式覆盖点
 * ---------------------------------------------------------------
 *  1. 找得到安装版 exe
 *  2. 安装版能启动、开出调试端点、渲染层挂载
 *  3. 「安装安装包」tab 存在且能切过去
 *  4. 拖放区存在
 *  5. 未选文件时不存在 AAB 专属出口
 *  6. 关于页版本号 == package.json
 *  7. 关于页版本说明写到了本功能
 *  8. 装进包里的 asar 真的含新按钮的标记与文案
 *  9. 渲染层无 error 级日志
 * 10. 截图
 *
 * --with-drop 追加
 * ---------------------------------------------------------------
 * 11. 在线设备全是模拟器（否则跳过并注明）
 * 12. 选中 .aab 后出现 AAB 类型标签
 * 13. 「导出通用 APK（.apk）」按钮出现、文案正确、可点击
 * 14. 「仅拆包并另存为 .apks」仍在（纯新增，没破坏老入口）
 * 15. AAB 环境提示里提到了新出口
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_aab-universal-ui.log');
const SHOT = path.join(OUT, 'aab-universal-installed.png');
const PORT = 9351;
const APP = 'ADB桌面助手.exe';
const ADB = path.join(ROOT, 'bin', 'adb.exe');

const WITH_DROP = process.argv.includes('--with-drop');
/** 新入口在产物里的两处「痕迹」：DOM 标记 + 人话文案 */
const MARKERS = ['data-export-universal', '导出通用 APK'];

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
const skip = (name, detail = '') => rows.push(`SKIP  ${name}  ::  ${detail}`);
/** 外部输出里的 FAIL/ERROR 会污染调用方判定，统一打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r');

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function exePath() {
  const i = process.argv.indexOf('--exe');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  return path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', APP);
}

function pkgVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

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

/** 在线设备序列号（status=device） */
function onlineDevices() {
  const r = spawnSync(ADB, ['devices'], { encoding: 'buffer' });
  const txt = (r.stdout || Buffer.alloc(0)).toString('utf8');
  const out = [];
  for (const line of txt.split(/\r?\n/).slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 2 && p[1] === 'device') out.push(p[0]);
  }
  return out;
}

/** 中文 Windows 的 tasklist 输出是 GBK。⚠️ Node 的 Buffer.toString 不认 'gbk'
 *  （抛 ERR_UNKNOWN_ENCODING），必须走 TextDecoder。 */
function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

function appPids() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'buffer' });
  const txt = decodeGbk(r.stdout || Buffer.alloc(0));
  const pids = [];
  for (const line of txt.split(/\r?\n/)) {
    const parts = line.split('","').map((x) => x.replace(/"/g, '').trim());
    if (parts[0] === APP) {
      const p = parseInt(parts[1], 10);
      if (!Number.isNaN(p)) pids.push(p);
    }
  }
  return pids;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    } catch {
      break;
    }
  }
}

/** 收尾：只关掉我们拉起来的那一份（先温柔、再强制） */
function closeApp(pid) {
  const targets = pid && appPids().includes(pid) ? [pid] : appPids();
  for (const p of targets) spawnSync('taskkill', ['/PID', String(p)]);
  for (let i = 0; i < 10 && appPids().length; i++) sleepSync(400);
  for (const p of appPids()) spawnSync('taskkill', ['/F', '/PID', String(p)]);
  return appPids();
}

/* ------------------------------------------------------------------ */
/* 页内辅助                                                            */
/* ------------------------------------------------------------------ */
const PAGE_HELPERS = `
window.__u = {
  tabs: () => Array.from(document.querySelectorAll('.tab')).map((x) => x.textContent.trim()),
  tab(label) {
    const t = Array.from(document.querySelectorAll('.tab')).find((x) => x.textContent.trim() === label);
    if (!t) return 'no-tab:' + window.__u.tabs().join('|');
    t.click();
    return 'ok';
  },
  dropzone: () => !!(document.querySelector('[data-dropzone]') || document.querySelector('.apk-drop')),
  kindChip: () => {
    const c = document.querySelector('.install-kind-chip');
    return c ? c.textContent.trim() : null;
  },
  exportBtn() {
    const b = document.querySelector('[data-export-universal]');
    return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
  },
  convertBtn() {
    const b = document.querySelector('[data-convert-apks]');
    return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
  },
  envNotice: () => {
    const n = document.querySelector('[data-aab-env]');
    return n ? n.textContent.trim() : null;
  },
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
    const el = document.getElementById('__u_probe');
    return el ? Array.from(el.files) : [];
  },
};
true;
`;

const MAKE_PROBE = `
(() => {
  const old = document.getElementById('__u_probe');
  if (old) old.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.id = '__u_probe';
  input.multiple = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.appendChild(input);
  return true;
})()
`;

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
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

function findTarget(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
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

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
let childPid = null;

async function main() {
  fs.writeFileSync(LOG, '');
  const exe = exePath();
  const want = pkgVersion();
  log(`=== AAB universal UI check :: ${new Date().toISOString()} ===`);
  log(`mode=${WITH_DROP ? 'with-drop' : 'safe'}`);
  log(`exe=${exe}`);
  log(`expectVersion=${want}`);

  if (!fs.existsSync(exe)) {
    record(false, '找得到安装版 exe', safe(exe));
    return;
  }
  record(true, '找得到安装版 exe', safe(exe));

  /* ---------- 0. asar 痕迹（不依赖界面） ---------- */
  const asar = path.join(path.dirname(exe), 'resources', 'app.asar');
  if (fs.existsSync(asar)) {
    const buf = fs.readFileSync(asar);
    for (const m of MARKERS) {
      const n = buf.toString('utf8').split(m).length - 1;
      record(n > 0, `app.asar 含新入口痕迹「${m}」`, `命中 ${n} 次`);
    }
  } else {
    record(false, '找得到 app.asar', safe(asar));
  }

  /* ---------- 起应用 ---------- */
  const stale = appPids();
  if (stale.length) {
    log(`stale pids: ${JSON.stringify(stale)}`);
    closeApp(null);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    env,
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
  });
  child.unref();
  childPid = child.pid;

  let target = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    target = await findTarget(PORT);
    if (target) break;
  }
  if (!target) {
    record(false, '安装版开出调试端点', safe(`port ${PORT} 无响应`));
    return;
  }
  record(true, '安装版开出调试端点', safe(`port ${PORT} / pid ${childPid}`));

  const errors = [];
  const cdp = new CDP(target.webSocketDebuggerUrl);
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

  try {
    /* ---------- 1. 挂载 ---------- */
    let mounted = 0;
    for (let i = 0; i < 40; i++) {
      mounted = await cdp
        .eval(`document.getElementById('root') ? document.getElementById('root').children.length : 0`)
        .catch(() => 0);
      if (mounted > 0) break;
      await sleep(400);
    }
    record(mounted > 0, '渲染层挂载成功', `root.children=${mounted}`);
    if (!mounted) return;

    /* ---------- 2. 进「安装安装包」页 ---------- */
    await cdp.eval(`window.location.hash = '#/tools'`);
    await sleep(900);
    await cdp.eval(PAGE_HELPERS);
    const tabs = await cdp.eval(`window.__u.tabs()`);
    log(`tabs: ${JSON.stringify(tabs)}`);
    record((tabs || []).includes('安装安装包'), '「安装安装包」tab 存在', JSON.stringify(tabs));
    const tabRes = await cdp.eval(`window.__u.tab('安装安装包')`);
    record(tabRes === 'ok', '能切到「安装安装包」tab', safe(tabRes));
    await sleep(700);

    const hasZone = await cdp.eval(`window.__u.dropzone()`);
    record(!!hasZone, '拖放区存在', String(hasZone));

    /* 未选文件时：AAB 专属出口都不该在 */
    const chipBefore = await cdp.eval(`window.__u.kindChip()`);
    const expBefore = await cdp.eval(`window.__u.exportBtn()`);
    record(
      !chipBefore && !expBefore,
      '未选文件时没有 AAB 专属出口按钮',
      safe(`chip=${JSON.stringify(chipBefore)} exp=${JSON.stringify(expBefore)}`),
    );

    /* ---------- 3. 关于页 ---------- */
    await cdp.eval(`window.location.hash = '#/settings'`);
    await sleep(1600);
    const about = await cdp.eval(`document.body.innerText.replace(/\\s+/g, ' ')`);
    const hasVer = (about || '').includes(want);
    const hasNote = /导出通用\s*APK/.test(about || '');
    log(`about hasVersion(${want})=${hasVer} hasNote=${hasNote}`);
    record(hasVer, `关于页显示版本 ${want}`, hasVer ? 'ok' : safe((about || '').slice(0, 200)));
    record(hasNote, '关于页版本说明写到了「导出通用 APK」', hasNote ? 'ok' : '未命中');

    /* ---------- 4. 截图（回到安装页 —— 注意切 hash 不够，
       工具页内部的 tab 状态会重置回「截图」，必须再点一次） ---------- */
    await cdp.eval(`window.location.hash = '#/tools'`);
    await sleep(900);
    await cdp.eval(PAGE_HELPERS);
    await cdp.eval(`window.__u.tab('安装安装包')`);
    await sleep(800);
    try {
      // 窗口可能在后台：fromSurface:false 才不会卡到超时
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      record(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 2000, '截图成功', safe(SHOT));
    } catch (e) {
      record(false, '截图成功', safe(String(e && e.message)));
    }

    /* ---------- 5. 可选：拖放段（会真实安装！必须先过模拟器守卫） ---------- */
    if (WITH_DROP) {
      const devs = onlineDevices();
      log(`online devices: ${JSON.stringify(devs)}`);
      const allEmu = devs.length > 0 && devs.every((s) => /^emulator-/.test(s));
      if (!allEmu) {
        skip('拖放段（选中 AAB → 按钮出现）', `在线设备含真机，拒绝执行：${JSON.stringify(devs)}`);
        skip('选中 .aab 后出现 AAB 类型标签', '同上');
        skip('「导出通用 APK」按钮已渲染', '同上');
      } else {
        const aab = pickAab();
        record(!!aab, '找到 .aab 素材', safe(aab ? `${aab} (${(fs.statSync(aab).size / 1048576).toFixed(1)} MB)` : '无'));
        if (aab) {
          // ⚠️ 拖放 = 真实安装。仅当设备全是模拟器时才走到这里。
          await cdp.eval(MAKE_PROBE);
          await cdp.send('DOM.enable');
          const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#__u_probe' });
          if (nodeId) {
            await cdp.send('DOM.setFileInputFiles', { files: [aab], nodeId });
            await cdp.eval(`window.__u.fire(window.__u.probe(), document.querySelector('[data-dropzone]'))`);
            let chip = null;
            for (let i = 0; i < 30; i++) {
              await sleep(500);
              chip = await cdp.eval(`window.__u.kindChip()`);
              if (chip) break;
            }
            log(`kind chip: ${JSON.stringify(chip)}`);
            record(!!chip && /AAB/i.test(chip), '选中 .aab 后出现 AAB 类型标签', safe(JSON.stringify(chip)));
            let exp = null;
            for (let i = 0; i < 30; i++) {
              exp = await cdp.eval(`window.__u.exportBtn()`);
              if (exp && !exp.disabled) break;
              await sleep(500);
            }
            log(`export btn: ${JSON.stringify(exp)}`);
            record(!!exp, '「导出通用 APK」按钮已渲染（data-export-universal）', safe(JSON.stringify(exp)));
            record(!!exp && /通用\s*APK/.test(exp.text), '按钮文案提到「通用 APK」', safe(exp ? exp.text : ''));
            record(!!exp && exp.disabled === false, '按钮可点击（AAB 环境就绪）', safe(exp ? `disabled=${exp.disabled}` : ''));
            const conv = await cdp.eval(`window.__u.convertBtn()`);
            record(!!conv, '「仅拆包并另存为 .apks」仍在（没被替换）', safe(JSON.stringify(conv)));
            const notice = await cdp.eval(`window.__u.envNotice()`);
            record(!!notice && /通用\s*APK/.test(notice), 'AAB 环境提示里提到了「导出通用 APK」', safe(notice || ''));
          }
        }
      }
    } else {
      skip('拖放段（选中 AAB → 按钮出现）', '需 --with-drop；拖放会真实安装到选中设备');
    }

    /* ---------- 6. 渲染层错误 ---------- */
    log(`renderer errors: ${safe(JSON.stringify(errors))}`);
    record(errors.length === 0, '渲染层无 error 级日志', safe(JSON.stringify(errors.slice(0, 3))));
  } finally {
    cdp.close();
    const left = closeApp(childPid);
    log(`closed app, leftover pids: ${JSON.stringify(left)}`);
  }
}

main()
  .catch((e) => record(false, '脚本异常', safe(String(e && e.stack))))
  .then(() => {
    const pass = rows.filter((r) => r.startsWith('PASS')).length;
    const fail = rows.filter((r) => r.startsWith('FAIL')).length;
    log('');
    log(rows.join('\n'));
    log('');
    log(`SUMMARY pass=${pass} fail=${fail} total=${rows.length}`);
    log('AAB UNIVERSAL UI CHECK DONE');
    console.log(rows.join('\n'));
    console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${rows.length}`);
    process.exit(fail === 0 ? 0 : 1);
  });
