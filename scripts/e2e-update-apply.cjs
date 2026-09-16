/**
 * 增量更新端到端驱动（真机真安装版，两阶段）
 *
 *   node scripts/e2e-update-apply.cjs --zip <小包.zip> --from 1.0.12 --to 1.0.13
 *   node scripts/e2e-update-apply.cjs --zip <坏包.zip> --from 1.0.12 --to 1.0.13 --rollback
 *
 * 阶段一：起安装版（CDP）→ 断言当前版本 == --from → prepareUpdate(zip)
 *         → 断言包版本 == --to → applyUpdate() → 应用自行退出 → 等助手跑完
 * 阶段二：强杀残留 → 重新起安装版（CDP）→ 断言当前版本 == 期望值
 *         （成功路径断 --to，--rollback 断 --from，即已自动回滚）
 *
 * 为什么走 IPC 而不是点界面上的「选择更新包…」：那一步会弹系统文件选择框，
 * 没法脚本化。prepareUpdate / applyUpdate 就是按钮背后调的同一对接口，
 * 所以除了「选文件」这一下，其余全是生产路径。
 *
 * 跑之前先 python scripts/_kill-our-processes.py（安装版有单实例锁）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
fs.mkdirSync(OUT, { recursive: true });

const argOf = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};
// 必须绝对化：安装版是拿 os.tmpdir() 当 cwd 起的，相对路径在它那边一定找不到
const ZIP_PATH = argOf('--zip') ? path.resolve(ROOT, argOf('--zip')) : null;
const FROM = argOf('--from') || '1.0.13';
const TO = argOf('--to') || '1.0.14';
const ROLLBACK = process.argv.includes('--rollback');

const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'ADB桌面助手.exe');
const STATE = path.join(process.env.APPDATA, 'adb-assistant', 'update');
const HELPER_LOG = path.join(STATE, 'helper.log');
const RESULT = path.join(STATE, 'result.json');

const LOG = path.join(OUT, ROLLBACK ? '_update-e2e-rollback.log' : '_update-e2e.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rows = [];
let infos = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
};
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const info = (m) => infos.push(m);

function killOurs() {
  const PY = process.env.ADBA_PY || path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
  const py = fs.existsSync(PY) ? PY : 'python';
  try {
    spawnSync(py, [path.join(ROOT, 'scripts', '_kill-our-processes.py')], { timeout: 120000, encoding: 'utf8' });
  } catch {
    /* ignore */
  }
}

/* ---------------- CDP ---------------- */

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.closed = false;
    this.ws.addEventListener('close', () => {
      this.closed = true;
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
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        return reject(new Error('ws send failed: ' + e.message));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 90000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
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

async function openApp(port) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 必须：否则 Electron 退化成纯 Node
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', cwd: os.tmpdir(), env });
  child.unref();

  for (let i = 0; i < 90; i++) {
    const found = await new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              resolve(list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
            } catch {
              resolve(null);
            }
          });
        })
        .on('error', () => resolve(null));
    });
    if (found) {
      const cdp = new CDP(found.webSocketDebuggerUrl);
      await cdp.ready;
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      return { cdp, child };
    }
    await sleep(500);
  }
  throw new Error('安装版未能在预期时间内开出调试端点（先跑 _kill-our-processes.py 清残留）');
}

async function uiVersion(cdp) {
  await cdp.eval(`(() => { location.hash = '#/settings'; return true; })()`);
  for (let i = 0; i < 25; i++) {
    const v = await cdp.eval(`
      (() => {
        const p = document.querySelector('[data-update-panel]');
        if (!p) return null;
        let out = null;
        p.querySelectorAll('.kv').forEach((r) => {
          const k = r.querySelector('.kv-key'); const val = r.querySelector('.kv-value');
          if (k && val && k.textContent.trim() === '当前版本') out = val.textContent.trim();
        });
        return out;
      })()
    `);
    if (v) return v;
    await sleep(400);
  }
  return null;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  fs.writeFileSync(LOG, '');
  if (!ZIP_PATH || !fs.existsSync(ZIP_PATH)) {
    log(`小包不存在：${ZIP_PATH}`);
    log('UPDATE E2E DONE');
    process.exit(1);
  }
  info(`小包: ${ZIP_PATH} (${(fs.statSync(ZIP_PATH).size / 1024).toFixed(0)} KB)`);
  info(`期望: v${FROM} → v${TO}${ROLLBACK ? '（含回滚）' : ''}`);

  // 清掉上一轮的痕迹，避免读到旧结果
  fs.rmSync(RESULT, { force: true });
  fs.rmSync(HELPER_LOG, { force: true });

  /* ---------- 阶段一 ---------- */
  let a = null;
  try {
    a = await openApp(9352);
    const before = await uiVersion(a.cdp);
    record(before === `v${FROM}`, `阶段一：更新前版本为 v${FROM}`, String(before));

    const prep = await a.cdp.eval(`window.adbApi.prepareUpdate(${JSON.stringify(ZIP_PATH)})`);
    const pinfo = prep && prep.data;
    record(!!(prep && prep.ok && pinfo && pinfo.ok), '阶段一：应用内校验通过（prepareUpdate.ok）', JSON.stringify(pinfo && { ok: pinfo.ok, reason: pinfo.reason }).slice(0, 140));
    record(!!(pinfo && pinfo.manifest && pinfo.manifest.version === TO), `阶段一：更新包版本识别为 v${TO}`, String(pinfo && pinfo.manifest && pinfo.manifest.version));
    record(fs.existsSync(pinfo && pinfo.stageDir ? pinfo.stageDir : '___'), '阶段一：更新包已解压到暂存目录', String(pinfo && pinfo.stageDir));

    let applied = false;
    try {
      const r = await a.cdp.eval(`window.adbApi.applyUpdate()`);
      applied = !!(r && r.ok);
      info(`applyUpdate 回包: ${JSON.stringify(r)}`);
    } catch (e) {
      // 应用在回包之前就退出了也算成功（正是期望行为）
      applied = /closed|WebSocket|target/i.test(String(e && e.message));
      info(`applyUpdate 期间连接断开（预期内）：${String(e && e.message).slice(0, 80)}`);
    }
    record(applied, '阶段一：applyUpdate 已被接受，应用准备退出', String(applied));
  } catch (e) {
    record(false, '阶段一执行', String(e && e.message));
  } finally {
    if (a) {
      a.cdp.close();
      try {
        process.kill(a.child.pid);
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------- 等助手跑完 ---------- */
  const deadline = Date.now() + 150_000;
  let helperDone = false;
  let logText = '';
  while (Date.now() < deadline) {
    logText = fs.existsSync(HELPER_LOG) ? fs.readFileSync(HELPER_LOG, 'utf8') : '';
    if (/health ok/.test(logText) && /helper exit/.test(logText)) {
      helperDone = true;
      break;
    }
    if (/health timeout -> rollback/.test(logText) && /helper exit/.test(logText)) {
      helperDone = true;
      break;
    }
    if (/FAILED:/.test(logText) && /helper exit/.test(logText)) {
      helperDone = true;
      break;
    }
    await sleep(1000);
  }
  record(helperDone, '助手：走完了完整流程（有结论 + 已退出）', helperDone ? `${((150000 - (deadline - Date.now())) / 1000).toFixed(0)}s` : '超时');
  info('helper.log:');
  for (const l of logText.split('\n').filter(Boolean).slice(-14)) info('  ' + l);

  const replacedOk = /replaced /.test(logText);
  const rolledBack = /health timeout -> rollback/.test(logText) || /FAILED:/.test(logText);
  if (ROLLBACK) {
    record(rolledBack, '助手：检测到新版启动异常并判定回滚', '');
    record(!/health ok/.test(logText), '助手：没有把坏版本判成成功', '');
  } else {
    record(replacedOk, '助手：已完成文件替换', '');
    record(/health ok/.test(logText), '助手：收到新版渲染层的健康握手', '');
  }

  /* ---------- 阶段二 ---------- */
  killOurs();
  await sleep(3000);

  let b = null;
  try {
    b = await openApp(9353);
    const after = await uiVersion(b.cdp);
    const want = ROLLBACK ? `v${FROM}` : `v${TO}`;
    record(after === want, `阶段二：重启后版本为 ${want}`, `实际 ${after}`);
    try {
      const r = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
      if (r && r.data) fs.writeFileSync(path.join(OUT, ROLLBACK ? 'update-e2e-rollback.png' : 'update-e2e.png'), Buffer.from(r.data, 'base64'));
    } catch {
      /* ignore */
    }
  } catch (e) {
    record(false, '阶段二执行', String(e && e.message));
  } finally {
    if (b) {
      b.cdp.close();
      try {
        process.kill(b.child.pid);
      } catch {
        /* ignore */
      }
    }
  }

  log(`===== 增量更新 E2E（${ROLLBACK ? '回滚' : '正常'}路径）=====`);
  for (const r of rows) log(r);
  if (infos.length) {
    log('===== INFO =====');
    for (const i of infos) log(i);
  }
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`${pass} 通过 / ${fail} 失败`);
  log('UPDATE E2E DONE');
  process.exit(fail === 0 ? 0 : 1);
})();
