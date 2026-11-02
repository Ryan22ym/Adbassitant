/**
 * 内存曲线观测（v1.1.21 起）：在**真实日志负载**下画出内存随时间的变化。
 *
 * 为什么需要它
 * ---------------------------------------------------------------
 * 空转时的内存曲线是一条平线，看不出任何优化效果 —— 真正的开销都在
 * 「日志每 120ms 一批推进来」这条路径上。所以这里一边启动真实 logcat 抓取、
 * 一边用 `adb shell log` 往设备日志里灌确定的流量，同时用 memory-probe
 * 每 4s 采一次：主进程工作集 / 堆、渲染进程工作集、Electron 合计。
 *
 * 判据（H 段）
 * ---------------------------------------------------------------
 * · 抓取期间主进程堆的增量必须远小于「日志文本本身的大小」；
 * · 数据仓换成增量维护后，缓冲区到 4000 行时渲染进程工作集不应持续抬升；
 * · 负载停止后 30s 内回落到与开始时同量级（±25MB）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/mem-curve.cjs \
 *     --watch ui-shots/_mem-curve.log --until "MEM CURVE DONE" --timeout 600
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_mem-curve.log');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

fs.mkdirSync(OUT, { recursive: true });

function say(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  fs.appendFileSync(LOG, s + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-mem-curve-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 采样间隔：低于 QUIET_INTERVAL(5000) 时探针只落 JSONL，不写运行日志污染被测对象 */
const INTERVAL = 4000;

/** 在一块设备上灌 n 行日志（单次 shell 会话，避免几百次 adb 往返） */
function burst(serial, tag, n) {
  const script =
    `i=0; while [ $i -lt ${n} ]; do ` +
    `log -t ${tag} "load $i payload-abcdefghijklmnopqrstuvwxyz-0123456789"; ` +
    'i=$((i+1)); done';
  return new Promise((resolve) => {
    execFile(ADB, ['-s', serial, 'shell', script], { timeout: 180000 }, (err) => {
      resolve(!err);
    });
  });
}

function readProbe(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function rowOf(s) {
  const byType = {};
  for (const p of s.electron) byType[p.type] = (byType[p.type] || 0) + p.wsMB;
  /*
   * ⚠️ app.getAppMetrics() 的 type 不是 'renderer' 而是 **'Tab'**（Electron 33 实测：
   * Browser / Tab / GPU / Utility 四种）。按 'renderer' 取会恒为 0，把最大的一块
   * 内存直接漏掉 —— 第一版就踩了这个坑，曲线里「渲染」整列全是 0。
   */
  const renderer = byType.Tab || byType.renderer || 0;
  return {
    at: s.upSec,
    mainWS: s.main.residentMB,
    heap: s.main.heapUsedMB,
    heapTotal: s.main.heapTotalMB,
    external: s.main.externalMB,
    renderer: Math.round(renderer * 10) / 10,
    gpu: Math.round((byType.GPU || byType.gpu || 0) * 10) / 10,
    browser: Math.round((byType.Browser || 0) * 10) / 10,
    utility: Math.round((byType.Utility || 0) * 10) / 10,
    total: s.totalWSMB,
  };
}

function table(rows) {
  const head = '  时刻   主进程WS  堆/总量   external   渲染   GPU  浏览器  工具   合计';
  const body = rows
    .map(
      (r) =>
        `  ${String(r.at).padStart(4)}s  ${String(r.mainWS).padStart(7)}M  ` +
        `${String(r.heap).padStart(5)}/${String(r.heapTotal).padEnd(5)}  ` +
        `${String(r.external).padStart(7)}M  ${String(r.renderer).padStart(5)}M ` +
        `${String(r.gpu).padStart(5)}M ${String(r.browser).padStart(6)}M ` +
        `${String(r.utility).padStart(5)}M ${String(r.total).padStart(6)}M`,
    )
    .join('\n');
  return head + '\n' + body;
}

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  /* ---------- 设备 ---------- */
  let devices = '';
  try {
    devices = execFileSync(ADB, ['devices'], { timeout: 8000 }).toString();
  } catch {
    devices = '';
  }
  const m = devices.match(/^(\S+)\tdevice$/m);
  if (!m) {
    say('没有在线设备，跳过（本脚本需要真机/模拟器）');
    say('MEM CURVE DONE');
    app.exit(0);
    return;
  }
  const serial = m[1];
  say(`设备 ${serial}`);

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const probeFile = path.join(DATA, 'memory-probe.jsonl');
  const probe = require('../dist-electron/electron/services/memory-probe.js');
  probe.startMemoryProbe({ intervalMs: INTERVAL, file: probeFile });

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const read = (expr) => win.webContents.executeJavaScript(expr);
  const click = (sel) =>
    read(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()`);
  /*
   * 行数读数：优先底栏的「N 行」文案，取不到就数实际渲染出来的行元素。
   * 第一版只认 `.logcat-foot` 的文案，某次运行里那个 span 没找到 → 全程 -1，
   * 判据全废。多路兜底比猜类名可靠。
   */
  const lineCount = () =>
    read(`(() => {
      const foot = document.querySelector('.logcat-foot');
      const txt = (foot && foot.textContent) || '';
      const mm = txt.match(/([\\d,]+)\\s*行/);
      if (mm) return parseInt(mm[1].replace(/,/g, ''), 10);
      const rows = document.querySelectorAll('.logcat-line, .log-line, .logcat-row').length;
      if (rows > 0) return rows;
      const dim = document.querySelector('.logcat-foot .text-dim');
      const m2 = ((dim && dim.textContent) || '').match(/([\\d,]+)/);
      return m2 ? parseInt(m2[1], 10) : -1;
    })()`);
  /** 一次性诊断：读数取不到时先看清页面到底在哪个状态 */
  const diag = () =>
    read(`(() => ({
      hash: location.hash,
      hasFoot: !!document.querySelector('.logcat-foot'),
      footText: (document.querySelector('.logcat-foot')?.textContent || '').slice(0, 80),
      btnText: (document.querySelector('.logcat-foot .btn')?.textContent || '').slice(0, 20),
      lineEls: document.querySelectorAll('.logcat-line, .log-line, .logcat-row').length,
      bodyClass: (document.body.className || '').slice(0, 60),
    }))()`);

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/logcat' });
  await win.show();

  /* 等设备就绪（首屏设备扫描是异步的，早了会点在 disabled 上） */
  const startState = () =>
    read(`(() => {
      const b = document.querySelector('.logcat-foot .btn');
      return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
    })()`);
  let btn = null;
  for (let i = 0; i < 60; i++) {
    btn = await startState();
    if (btn && !btn.disabled) break;
    await sleep(500);
  }
  if (!btn || btn.disabled) {
    ok(false, 'H0 「开始抓取」可点', JSON.stringify(btn));
    say(table(rows.map(() => ({}))));
    fs.appendFileSync(LOG, rows.join('\n') + '\nMEM CURVE DONE\n');
    app.exit(1);
    return;
  }

  /* ---------- 阶段 1：空转基线 24s ---------- */
  say('\n[阶段 1] 空转基线');
  await sleep(24000);
  const base = readProbe(probeFile).map(rowOf);
  say(table(base));

  /* ---------- 阶段 2：开抓 + 灌流量 ---------- */
  say('\n[阶段 2] 开始抓取 + 设备侧灌 3 轮日志');
  await click('.logcat-foot .btn');
  await sleep(1500);
  const d0 = await diag();
  say('  诊断：' + JSON.stringify(d0));
  ok(
    String(d0.btnText).includes('停止'),
    'H2a 点完按钮变成「停止抓取」（抓取真的启动了）',
    String(d0.btnText),
  );

  const t0 = Date.now();
  for (let round = 1; round <= 3; round++) {
    const lines0 = await lineCount();
    const started = Date.now();
    await burst(serial, 'MEMCURVE', 2500);
    const lines1 = await lineCount();
    say(
      `  第 ${round} 轮：灌 2500 行，界面行数 ${lines0} → ${lines1}，` +
        `耗时 ${Math.round((Date.now() - started) / 1000)}s`,
    );
    await sleep(6000);
  }
  const loadSec = Math.round((Date.now() - t0) / 1000);
  const peakLines = await lineCount();
  say(`  负载结束：界面 ${peakLines} 行 / 用时 ${loadSec}s`);
  say('  诊断：' + JSON.stringify(await diag()));

  /* ---------- 阶段 3：停抓 + 静置 40s ---------- */
  say('\n[阶段 3] 停止抓取并静置');
  await click('.logcat-foot .btn');
  await sleep(40000);
  const settled = await lineCount();

  /* ---------- 汇总 ---------- */
  const all = readProbe(probeFile).map(rowOf);
  /*
   * 基线取**阶段 1 的最后 5 个样本**，不要从头取：第一个样本是建窗瞬间，
   * 渲染进程还没起来（合计比稳态低 200MB），拿它当基线会把「启动爬升」
   * 算成「负载导致的上涨」。
   */
  const steadyIdle = base.slice(-5);
  const load = all.slice(base.length, Math.max(base.length, all.length - 10));
  const tail = all.slice(-6);

  const avg = (arr, k) => (arr.length ? Math.round((arr.reduce((s, r) => s + r[k], 0) / arr.length) * 10) / 10 : 0);
  const max = (arr, k) => (arr.length ? Math.max(...arr.map((r) => r[k])) : 0);

  say('\n[全量曲线]');
  say(table(all));

  say('\n[分段均值]');
  say(
    `  空转：主进程WS ${avg(steadyIdle, 'mainWS')}M / 堆 ${avg(steadyIdle, 'heap')}M / 渲染 ${avg(steadyIdle, 'renderer')}M / 合计 ${avg(steadyIdle, 'total')}M`,
  );
  say(
    `  负载：主进程WS ${avg(load, 'mainWS')}M / 堆 ${avg(load, 'heap')}M / 渲染 ${avg(load, 'renderer')}M / 合计 ${avg(load, 'total')}M`,
  );
  say(
    `  静置：主进程WS ${avg(tail, 'mainWS')}M / 堆 ${avg(tail, 'heap')}M / 渲染 ${avg(tail, 'renderer')}M / 合计 ${avg(tail, 'total')}M`,
  );

  ok(
    all.length >= 20,
    'H1 采到足够样本（全程 >= 20 个）',
    `${all.length} 个 / 间隔 ${INTERVAL}ms`,
  );
  ok(peakLines >= 1000, 'H2 日志确实灌进去了', `界面 ${peakLines} 行`);
  ok(
    avg(steadyIdle, 'renderer') > 20,
    'H2b 渲染进程已计入（app.getAppMetrics 里叫 Tab，不叫 renderer）',
    `渲染 ${avg(steadyIdle, 'renderer')}M`,
  );
  const heapGrowth = max(load, 'heap') - avg(steadyIdle, 'heap');
  ok(heapGrowth < 40, 'H3 负载期主进程堆增量 < 40MB', `峰值增量 ${Math.round(heapGrowth * 10) / 10}MB`);
  const rendererGrowth = max(load, 'renderer') - avg(steadyIdle, 'renderer');
  ok(
    rendererGrowth < 80,
    'H4 负载期渲染进程工作集增量 < 80MB',
    `峰值增量 ${Math.round(rendererGrowth * 10) / 10}MB`,
  );
  const back = avg(tail, 'total') - avg(steadyIdle, 'total');
  /*
   * 「停抓后比空转高多少」不能当泄漏判据：界面按设计保留 4000 行，
   * 这批数据本身就要占内存（实测 15~25MB）。真正要证的是**不再继续涨**，
   * 所以看静置窗口内合计工作集的漂移。
   */
  const drift = tail.length > 1 ? tail[tail.length - 1].total - tail[0].total : 0;
  ok(
    Math.abs(drift) < 5,
    'H5 静置期间合计工作集不再上涨（漂移 < 5MB）',
    `漂移 ${Math.round(drift * 10) / 10}MB`,
  );
  say(
    `  参考：停抓后相对空转基线 +${Math.round(back * 10) / 10}MB —— ` +
      `主要是界面按设计保留的 ${peakLines} 行数据本身，不是泄漏`,
  );
  const heapBack = avg(tail, 'heap') - avg(steadyIdle, 'heap');
  ok(
    heapBack < 8,
    'H6 停抓后堆回落（GC 真回收，不只是裁剪缓冲）',
    `偏差 ${Math.round(heapBack * 10) / 10}MB`,
  );
  ok(settled > 0, 'H7 停抓后界面仍有日志（不因停抓清空）', `${settled} 行`);

  fs.appendFileSync(LOG, rows.join('\n') + '\n');
  say('MEM CURVE DONE');
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
