/**
 * Logcat 渲染层数据仓（性能优化 B3）的页面级回归。
 *
 * 单测（check-logcat-store.cjs）保证数据结构本身对；这一条负责保证**页面接得对**：
 *   · store 里的东西真的画到了界面上（占位层高度 / 行数 / 末行内容）；
 *   · 过滤输入框改一次，可见行数与渲染出来的行同步变（render 期 setFilter 的时序）；
 *   · 暂停期间推送不增长、恢复后一次补齐（heldRef 合并路径）；
 *   · 清空把数据与计数一起归零。
 *
 * 全程走真实链路：`push:logcatLines` → 页面的订阅 → LogcatStore → 虚拟滚动。
 * 不需要设备（推送是构造的），也就不受设备在线状态影响。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-logcat-datalayer.cjs \
 *     --watch ui-shots/_logcat-datalayer.log --until "LOGCAT DATALAYER CHECK DONE" --timeout 300
 *
 * 前置：`vite build`（脚本读 dist/index.html）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_logcat-datalayer.log');

function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-logcat-datalayer-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = `(() => {
  const foot = document.querySelector('.logcat-foot .text-dim');
  const spacer = document.querySelector('.log-spacer');
  return {
    rows: document.querySelectorAll('.logcat-line').length,
    spacerH: spacer ? parseFloat(spacer.style.height) || 0 : 0,
    countText: foot ? foot.textContent.trim() : '',
    msgs: [...document.querySelectorAll('.logcat-line .log-msg')].map((e) => e.textContent),
    tags: [...document.querySelectorAll('.logcat-line .logcat-tag')].map((e) => e.textContent),
    toolbar: document.querySelector('.log-toolbar') ? document.querySelector('.log-toolbar').textContent : '',
    footBtns: [...document.querySelectorAll('.logcat-foot .btn')].map((b) => b.textContent.trim()),
  };
})()`;

const read = (win) => win.webContents.executeJavaScript(READ);

const clickBtn = (win, text) =>
  win.webContents.executeJavaScript(
    `(() => {
      const b = [...document.querySelectorAll('.logcat-foot .btn')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return false;
      b.click();
      return true;
    })()`,
  );

/** 往输入框里写值（React 受控组件必须用原生 setter + input 事件） */
const typeInto = (win, placeholderPrefix, value) =>
  win.webContents.executeJavaScript(
    `(() => {
      const el = [...document.querySelectorAll('.log-toolbar input')].find(
        (i) => (i.placeholder || '').startsWith(${JSON.stringify(placeholderPrefix)}),
      );
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );

const LEVELS = ['V', 'D', 'I', 'W', 'E'];

/** 造推送批次：tag 每 7 条一个 ActivityManager，其余 LayoutRegression */
function makeBatch(from, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const seq = from + i;
    const lv = LEVELS[seq % LEVELS.length];
    const tag = seq % 7 === 0 ? 'ActivityManager' : 'LayoutRegression';
    const t = '11-02 10:00:00.000';
    out.push({
      seq,
      time: t,
      pid: 1000 + (seq % 90),
      tid: 1000 + (seq % 90),
      level: lv,
      tag,
      message: `line ${seq} 填充内容`,
      raw: `${t} ${1000 + (seq % 90)} ${1000 + (seq % 90)} ${lv} ${tag}: line ${seq} 填充内容`,
    });
  }
  return out;
}

/** 解析底栏的 "N 行" / "M / N 行" */
function parseCount(text) {
  const m = text.match(/(\d+)\s*\/\s*(\d+)\s*行/);
  if (m) return { visible: Number(m[1]), total: Number(m[2]) };
  const one = text.match(/(\d+)\s*行/);
  if (one) return { visible: Number(one[1]), total: Number(one[1]) };
  return { visible: -1, total: -1 };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');

  const { registerIpc } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
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
      backgroundThrottling: false,
    },
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  const rows = [];
  const ok = (cond, name, detail) =>
    rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const send = async (from, n, wait = 90) => {
    win.webContents.send('push:logcatLines', makeBatch(from, n));
    await sleep(wait);
  };

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  await win.show();
  await sleep(1200);

  await win.webContents.executeJavaScript(
    `(() => { const a = document.querySelector('.nav-item[href="#/logcat"]'); if (a) a.click(); return !!a; })()`,
  );
  await sleep(1000);

  /* ---------------- 1. 3000 行：行数 / 占位层 / 末行 ---------------- */
  for (let i = 0; i < 10; i += 1) await send(i * 300 + 1, 300);
  await sleep(600);
  const a = await read(win);
  const ca = parseCount(a.countText);
  ok(ca.total === 3000 && ca.visible === 3000, 'P1 底栏显示 3000 行', `"${a.countText}"`);
  ok(Math.abs(a.spacerH - 3000 * 22) < 3, 'P2 占位层高度 = 3000 × 22', `spacerH=${a.spacerH}`);
  ok(a.rows > 0 && a.rows < 120, 'P3 DOM 行数仍是视口量级', `rows=${a.rows}`);
  ok(
    a.msgs.length > 0 && a.msgs[a.msgs.length - 1].includes('line 3000'),
    'P4 自动滚到底：最后一行是最新那条',
    a.msgs.length ? a.msgs[a.msgs.length - 1] : 'none',
  );

  /* ---------------- 2. 计数徽标来自增量维护 ---------------- */
  // 3000 行按 5 个级别循环 → 每级 600 条，工具栏应出现 “E 600”
  ok(/E\s*600/.test(a.toolbar), 'P5 级别计数徽标正确（E 600）', a.toolbar.replace(/\s+/g, ' ').slice(0, 80));

  /* ---------------- 3. 关键字过滤：可见行数立即跟着变 ---------------- */
  ok(await typeInto(win, '关键字', 'line 2999'), 'P6 关键字输入框可写入');
  await sleep(400);
  const b = await read(win);
  const cb = parseCount(b.countText);
  ok(cb.visible === 1 && cb.total === 3000, 'P7 精确命中一条：1 / 3000 行', `"${b.countText}"`);
  ok(b.rows === 1 && Math.abs(b.spacerH - 22) < 2, 'P8 只剩一行时占位层同步缩短', `rows=${b.rows} spacerH=${b.spacerH}`);

  await typeInto(win, '关键字', '填充内容');
  await sleep(400);
  const c = await read(win);
  ok(parseCount(c.countText).visible === 3000, 'P9 全部命中时回到 3000 行（不再显示 x / y）', `"${c.countText}"`);

  await typeInto(win, '关键字', '绝不存在的字符串');
  await sleep(400);
  const d = await read(win);
  ok(parseCount(d.countText).visible === 0 && d.rows === 0, 'P10 无命中时 0 行且不渲染任何行', `"${d.countText}"`);

  await typeInto(win, '关键字', '');
  await sleep(400);

  /* ---------------- 4. TAG 通配过滤 ---------------- */
  await typeInto(win, 'TAG', 'Activity*');
  await sleep(400);
  const e = await read(win);
  const ce = parseCount(e.countText);
  ok(ce.total === 3000 && ce.visible > 0 && ce.visible < ce.total, 'P11 TAG 通配过滤命中一部分', `"${e.countText}"`);
  ok(e.tags.length > 0 && e.tags.every((t) => t.startsWith('Activity')), 'P12 渲染出来的行 TAG 全部命中通配', `tags=${[...new Set(e.tags)].join(',')}`);

  await typeInto(win, 'TAG', '');
  await sleep(400);

  /* ---------------- 5. 超出容量：裁旧不裁新 ---------------- */
  for (let i = 0; i < 5; i += 1) await send(3001 + i * 300, 300);
  await sleep(600);
  const f = await read(win);
  const cf = parseCount(f.countText);
  ok(cf.total === 4000 && cf.visible === 4000, 'P13 4500 行时界面只留 4000（环形裁剪）', `"${f.countText}"`);
  ok(Math.abs(f.spacerH - 4000 * 22) < 3, 'P14 占位层 = 4000 × 22', `spacerH=${f.spacerH}`);
  ok(
    f.msgs.length > 0 && f.msgs[f.msgs.length - 1].includes('line 4500'),
    'P15 末行仍是最新那条（裁掉的是旧行）',
    f.msgs.length ? f.msgs[f.msgs.length - 1] : 'none',
  );

  /* ---------------- 6. 暂停 / 恢复 ---------------- */
  /*
   * 「暂停刷新」按钮在 !running 时是禁用的。本脚本不依赖设备，所以用一条状态推送
   * 把界面切到「抓取中」——它走的正是主进程真实会发的那条通道，不是直接改 state。
   */
  win.webContents.send('push:logcatStatus', { running: true, serial: 'TEST', lines: 4500 });
  await sleep(300);
  ok(await clickBtn(win, '暂停刷新'), 'P16 点得到「暂停刷新」');
  await sleep(300);
  for (let i = 0; i < 2; i += 1) await send(4501 + i * 100, 100);
  await sleep(500);
  const g = await read(win);
  ok(
    parseCount(g.countText).total === 4000 &&
      g.msgs.length > 0 &&
      !g.msgs[g.msgs.length - 1].includes('line 4700'),
    'P17 暂停期间推送不进入界面',
    `"${g.countText}" last=${g.msgs[g.msgs.length - 1]}`,
  );
  ok(await clickBtn(win, '恢复刷新'), 'P18 点得到「恢复刷新」');
  await sleep(600);
  const h = await read(win);
  ok(
    h.msgs.length > 0 && h.msgs[h.msgs.length - 1].includes('line 4700'),
    'P19 恢复后暂存行一次补齐（末行是 4700）',
    h.msgs.length ? h.msgs[h.msgs.length - 1] : 'none',
  );

  /* ---------------- 7. 清空 ---------------- */
  ok(await clickBtn(win, '清空'), 'P20 点得到「清空」');
  await sleep(500);
  const i2 = await read(win);
  ok(parseCount(i2.countText).total === 0 && i2.rows === 0, 'P21 清空后 0 行', `"${i2.countText}"`);
  ok(!/[VDIWEF]\s*[1-9]/.test(i2.toolbar), 'P22 清空后级别徽标数字一起归零', i2.toolbar.replace(/\s+/g, ' ').slice(0, 80));

  /* ---------------- 收尾 ---------------- */
  win.hide();
  log('=== LOGCAT DATALAYER CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log(`汇总：PASS ${rows.length - fail} / 失败 ${fail}`);
  log('LOGCAT DATALAYER CHECK DONE');
  app.exit(fail ? 1 : 0);
});
