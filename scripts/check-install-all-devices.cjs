/**
 * 「安装到全部设备 / 所选设备」验收（v1.1.0 新增）
 *
 * 开发态：
 *   python scripts/run-electron.py scripts/check-install-all-devices.cjs \
 *       --watch ui-shots/_installall.log --until "INSTALL ALL CHECK DONE" --timeout 900
 *
 * 覆盖点
 * ---------------------------------------------------------------
 *  1. 多台设备在线时，选设备弹窗里每一行都有勾选框（勾选框与设备行是两个控件）
 *  2. 只勾 1 台 → 不算批量（仍是三种安装方式，不出现「安装到所选」按钮）
 *  3. 勾 ≥2 台 → 批量：安装方式收敛成「覆盖 / 清洁」两种，并写明整批同一种方式
 *  4. 批量态切到清洁安装时，提示里必须点明「所有设备」都会清数据
 *  5. 点「安装到所选 N 台」→ 逐台安装，最后收口成一条汇总（不是一台一个弹窗）
 *  6. 「安装到全部设备」按钮等价于勾选全部设备
 *  7. 渲染层无 error 级日志
 *
 * 🔴 安全约束（照抄 check-drag-install 的立场）
 * ---------------------------------------------------------------
 * 这个用例会**真的往所有在线设备装包**，所以：
 *   · 默认只用「覆盖安装」；清洁安装会把应用数据清掉，只做界面态断言，绝不点下去；
 *   · 素材是设备上已装应用的 base.apk（-r 重装同版本，必然成功且不改数据）；
 *   · 要求在线设备 ≥2 台，否则这条用例没意义，直接判失败并说明原因。
 * 跑之前请确认在线设备都是可被装包的（真机上已有该包才安全）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { execCapture } = require('./_spawn-capture.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_installall.log');

/** 测试素材放系统临时目录（与 check-drag-install 共用，不重复拉） */
const DND = path.join(os.tmpdir(), 'adb-assistant-dnd');
const REAL_APK = path.join(DND, 'real-app.apk');
const ADB = path.join(ROOT, 'bin', 'adb.exe');
/** 从哪台设备上拉素材（重新 -r 安装必然成功） */
const PULL_PKG = process.env.PULL_PKG || 'com.zidongdianji';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
const infos = [];
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}
const rec = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const info = (m) => infos.push(m);

/** adb 输出里带 FAIL / Error 字样会污染 run-electron 的判定，落盘前打码 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r')
    .replace(/failure/g, 'f*ilure');

/* ------------------------------------------------------------------ */
/* 页面内注入的辅助函数                                                */
/* ------------------------------------------------------------------ */

const PAGE_HELPERS = `
window.__iad = {
  makeDT(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  },
  fire(target, files, types) {
    const dt = this.makeDT(files);
    for (const t of (types || ['dragenter', 'dragover', 'drop'])) {
      target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return true;
  },
  probe() {
    const el = document.getElementById('__iad_probe');
    return el ? Array.from(el.files) : [];
  },
  /** 选设备弹窗的完整状态（v1.1.0 增加了勾选框与批量按钮） */
  pick() {
    const m = document.querySelector('[data-pick-device]');
    if (!m) return null;
    const boxes = Array.from(m.querySelectorAll('[data-pick-select]'));
    return {
      title: (m.querySelector('.install-title')?.textContent || '').trim(),
      chips: Array.from(m.querySelectorAll('.install-chip')).map((c) => c.textContent.trim()),
      note: (m.querySelector('.install-note')?.textContent || '').trim(),
      mode: (m.querySelector('[data-pick-mode]')?.getAttribute('data-pick-mode') || ''),
      modeOptions: Array.from(m.querySelectorAll('[data-pick-mode] .segmented-item')).map((b) => b.textContent.trim()),
      modeHint: (m.querySelector('.install-mode-hint')?.textContent || '').trim(),
      buttons: Array.from(m.querySelectorAll('.install-actions .btn')).map((b) => b.textContent.trim()),
      checkboxCount: boxes.length,
      selected: boxes.filter((b) => b.getAttribute('aria-checked') === 'true')
        .map((b) => b.getAttribute('data-pick-select')),
      devices: Array.from(m.querySelectorAll('[data-install-device]')).map((b) => b.getAttribute('data-install-device')),
    };
  },
  /** 勾选 / 取消勾选某台设备（点的是勾选框，不是设备行） */
  toggle(serial) {
    const b = document.querySelector('[data-pick-select="' + serial + '"]');
    if (!b) return 'no-box';
    b.click();
    return 'ok';
  },
  /** 在选设备弹窗里切安装方式 */
  setMode(label) {
    const box = document.querySelector('[data-pick-mode]');
    if (!box) return 'no-box';
    const btn = Array.from(box.querySelectorAll('.segmented-item')).find((b) => b.textContent.trim() === label);
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  },
  /** 点某个批量按钮（按文案找，避免依赖按钮顺序） */
  clickButton(text) {
    const b = Array.from(document.querySelectorAll('[data-pick-device] .install-actions .btn'))
      .find((x) => x.textContent.trim().indexOf(text) >= 0);
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  },
  /** 结果弹窗（安装完成后是它，不再是选设备那一屏） */
  mask() {
    const m = document.querySelector('.install-mask');
    if (!m) return null;
    return {
      title: (m.querySelector('.install-title')?.textContent || '').trim(),
      file: (m.querySelector('.install-file')?.textContent || '').trim(),
      detail: (m.querySelector('.install-detail')?.textContent || '').trim(),
      chips: Array.from(m.querySelectorAll('.install-chip')).map((c) => c.textContent.trim()),
      buttons: Array.from(m.querySelectorAll('.install-actions .btn')).map((b) => b.textContent.trim()),
    };
  },
  closeMask() {
    const b = Array.from(document.querySelectorAll('.install-actions .btn'))
      .find((x) => ['知道了', '关闭'].includes(x.textContent.trim()));
    if (b) b.click();
    return !!b;
  },
  toasts: () => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent.trim()),
};
undefined;
`;

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runChecks(page) {
  /* 等 React 挂载 + 设备列表就绪 */
  for (let i = 0; i < 40; i++) {
    const n = await page.evalJS(`document.getElementById('root') ? document.getElementById('root').children.length : 0`).catch(() => 0);
    if (n > 0) break;
    await sleep(400);
  }
  for (let i = 0; i < 30; i++) {
    const n = await page.evalJS(`document.querySelectorAll('.device-select option').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(500);
  }

  const online = onlineSerials();
  info(`在线设备: ${JSON.stringify(online)}`);

  /* ---------- 0. 前置：至少两台在线，否则这条用例没意义 ---------- */
  rec(online.length >= 2, '至少两台设备在线（批量安装用例的前提）',
    `在线 ${online.length} 台：${online.join(', ')}`);
  if (online.length < 2) return page;

  /* ---------- 1. 进入「常用工具 → 安装安装包」，用 CDP 挂真实 APK ---------- */
  await page.evalJS(`(window.location.hash = '#/tools', true)`);
  await sleep(800);
  const tab = await page.evalJS(`
    (() => {
      const want = ['安装安装包', '安装 APK'];
      const t = Array.from(document.querySelectorAll('.tab')).find((x) => want.includes(x.textContent.trim()));
      if (!t) return 'no-tab';
      t.click();
      return 'ok';
    })()
  `);
  rec(tab === 'ok', '进入「安装安装包」标签页', String(tab));
  await sleep(400);

  await page.evalJS(`
    (() => {
      const old = document.getElementById('__iad_probe');
      if (old) old.remove();
      const input = document.createElement('input');
      input.type = 'file';
      input.id = '__iad_probe';
      input.multiple = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(input);
      return true;
    })()
  `);
  await page.evalJS(PAGE_HELPERS);

  const dbg = { send: (m, p) => page.cdpSend(m, p) };
  await dbg.send('DOM.enable');
  const { root } = await dbg.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await dbg.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#__iad_probe' });
  await dbg.send('DOM.setFileInputFiles', { files: [REAL_APK], nodeId });
  const attached = await page.evalJS(`window.__iad.probe().map((f) => f.name)`);
  rec(Array.isArray(attached) && attached.length === 1, 'CDP 挂上真实 APK 素材', JSON.stringify(attached));

  /* ---------- 2. 拖放 → 选设备弹窗：每行都有勾选框 ---------- */
  const openPick = async () => {
    await page.evalJS(`
      (() => { const fs = window.__iad.probe(); window.__iad.fire(window, fs, ['drop']); return true; })()
    `);
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const p = await page.evalJS(`window.__iad.pick()`);
      if (p) return p;
    }
    return null;
  };

  const p1 = await openPick();
  info(`选设备弹窗: ${safe(JSON.stringify(p1))}`);
  rec(!!p1, '多台设备在线时拖入安装包先问「装到哪台设备」', safe(JSON.stringify(p1 && p1.chips)));
  if (!p1) return page;

  rec(p1.checkboxCount === p1.devices.length && p1.checkboxCount >= 2,
    '每一行设备都有一个勾选框（勾选框 ≠ 设备行）',
    `checkbox=${p1.checkboxCount} devices=${p1.devices.length}`);
  rec(p1.selected.length === 0, '刚打开时一台都没勾选', `selected=${JSON.stringify(p1.selected)}`);
  rec(p1.buttons.some((b) => b.indexOf('安装到全部设备') >= 0),
    '弹窗提供「安装到全部设备」按钮', safe(JSON.stringify(p1.buttons)));
  rec(!p1.buttons.some((b) => b.indexOf('安装到所选') >= 0),
    '没勾选时不出现「安装到所选」按钮', safe(JSON.stringify(p1.buttons)));

  /* ---------- 3. 只勾一台：不算批量 ---------- */
  await page.evalJS(`window.__iad.toggle(${JSON.stringify(p1.devices[0])})`);
  await sleep(300);
  const p2 = await page.evalJS(`window.__iad.pick()`);
  info(`勾 1 台: ${safe(JSON.stringify({ selected: p2 && p2.selected, modeOptions: p2 && p2.modeOptions, buttons: p2 && p2.buttons }))}`);
  rec(p2 && p2.selected.length === 1, '能勾选单台设备', safe(JSON.stringify(p2 && p2.selected)));
  rec(p2 && p2.modeOptions.length === 3,
    '只勾一台时仍是三种安装方式（不算批量）', safe(JSON.stringify(p2 && p2.modeOptions)));
  rec(p2 && !p2.buttons.some((b) => b.indexOf('安装到所选') >= 0),
    '只勾一台时不出现「安装到所选」按钮', safe(JSON.stringify(p2 && p2.buttons)));

  /* ---------- 4. 勾两台：批量，安装方式收敛为覆盖 / 清洁 ---------- */
  await page.evalJS(`window.__iad.toggle(${JSON.stringify(p1.devices[1])})`);
  await sleep(350);
  const p3 = await page.evalJS(`window.__iad.pick()`);
  info(`勾 2 台: ${safe(JSON.stringify(p3))}`);
  rec(p3 && p3.selected.length === 2, '能勾选两台（多选成立）', safe(JSON.stringify(p3 && p3.selected)));
  rec(p3 && p3.modeOptions.length === 2
    && p3.modeOptions.includes('覆盖安装') && p3.modeOptions.includes('清洁安装')
    && !p3.modeOptions.includes('全新安装'),
    '批量态只剩「覆盖 / 清洁」两种安装方式（不支持逐台各自选 / 全新）',
    safe(JSON.stringify(p3 && p3.modeOptions)));
  rec(p3 && p3.chips.some((c) => c.indexOf('已选 2 台') >= 0),
    '弹窗标出已选台数', safe(JSON.stringify(p3 && p3.chips)));
  rec(p3 && p3.buttons.some((b) => b.indexOf('安装到所选 2 台') >= 0),
    '出现「安装到所选 2 台」按钮', safe(JSON.stringify(p3 && p3.buttons)));

  /* 清洁安装必须把「所有设备都会清数据」写出来（只断言文案，绝不真的点下去） */
  await page.evalJS(`window.__iad.setMode('清洁安装')`);
  await sleep(300);
  const p4 = await page.evalJS(`window.__iad.pick()`);
  rec(p4 && p4.mode === 'clean' && /所有设备/.test(p4.modeHint || '') && /清除/.test(p4.modeHint || ''),
    '批量切到清洁安装后，提示点明「所有设备」都会清数据',
    safe(p4 && p4.modeHint));
  await page.evalJS(`window.__iad.setMode('覆盖安装')`);
  await sleep(300);
  const p5 = await page.evalJS(`window.__iad.pick()`);
  rec(p5 && p5.mode === 'overwrite', '批量态能切回覆盖安装', safe(p5 && p5.mode));

  /* ---------- 5. 点「安装到所选 2 台」→ 逐台装完收口成一条汇总 ---------- */
  await page.evalJS(`window.__iad.clickButton('安装到所选')`);
  let sum = null;
  let sawProgress = false;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    const m = await page.evalJS(`window.__iad.mask()`);
    if (!m) break;
    if (m.title.indexOf('正在安装中') >= 0) sawProgress = true;
    if (/^已装到 \d+ 台设备$/.test(m.title) || /台安装成功$/.test(m.title)) { sum = m; break; }
    if (m.title === '安装成功' || m.title === '安装失败') { sum = m; break; }
  }
  info(`批量汇总: ${safe(JSON.stringify(sum))}`);
  rec(sawProgress, '批量安装过程中能看到逐台进度（不是一路黑屏）', `sawProgress=${sawProgress}`);
  rec(!!(sum && sum.title === `已装到 ${online.length} 台设备`),
    `批量安装收口成一条汇总「已装到 ${online.length} 台设备」`,
    safe(sum && sum.title));
  rec(!!(sum && online.every((s) => (sum.detail || '').indexOf(s) >= 0)),
    '汇总里逐台列出了装到哪几台（含序列号）',
    safe(sum && sum.detail));
  rec(!!(sum && (sum.chips || []).some((c) => c.indexOf('共 ' + online.length + ' 台设备') >= 0)),
    '汇总弹窗标出「共 N 台设备」', safe(JSON.stringify(sum && sum.chips)));
  await page.screenshot(path.join(OUT, 'install-all-1-selected.png'));

  /* 汇总弹窗不该自己关掉（要能看清装到哪几台） */
  await sleep(2200);
  const still = await page.evalJS(`window.__iad.mask()`);
  rec(!!still, '批量汇总弹窗不会自动消失', `still=${!!still}`);
  await page.evalJS(`window.__iad.closeMask()`);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (!(await page.evalJS(`window.__iad.mask()`))) break;
  }

  /* ---------- 6. 「安装到全部设备」等价于勾选全部 ---------- */
  const p6 = await openPick();
  rec(!!p6, '（全部设备用例）重新拖放仍会先问目标设备', safe(p6 && p6.title));
  if (p6) {
    const hit = await page.evalJS(`window.__iad.clickButton('安装到全部设备')`);
    rec(hit === 'ok', '能点到「安装到全部设备」按钮', String(hit));
    let sum2 = null;
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      const m = await page.evalJS(`window.__iad.mask()`);
      if (!m) break;
      if (/^已装到 \d+ 台设备$/.test(m.title) || /台安装成功$/.test(m.title)) { sum2 = m; break; }
      if (m.title === '安装成功' || m.title === '安装失败') { sum2 = m; break; }
    }
    rec(!!(sum2 && sum2.title === `已装到 ${online.length} 台设备`),
      '「安装到全部设备」把这一批装到了所有在线设备',
      safe(sum2 && sum2.title));
    await page.screenshot(path.join(OUT, 'install-all-2-all-devices.png'));
    await page.evalJS(`window.__iad.closeMask()`);
  }

  return page;
}

/** 当前在线设备序列号（物理设备在前，与界面顺序一致） */
function onlineSerials() {
  try {
    const out = execCapture(ADB, ['devices'], { timeout: 20000 });
    const list = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a[1] === 'device')
      .map((a) => a[0]);
    return [...list.filter((s) => !/^emulator-/.test(s)), ...list.filter((s) => /^emulator-/.test(s))];
  } catch (e) {
    log('取设备列表失败：' + safe(e.message));
    return [];
  }
}

/**
 * 从设备上拉一个真 APK 当素材（与 check-drag-install 同一套理由：
 * 仓库里不该塞二进制；而「安装成功」这条路径必须用真包才走得通）。
 */
function ensureFixture() {
  fs.mkdirSync(DND, { recursive: true });
  if (fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0) return true;

  const serials = onlineSerials();
  for (const s of serials) {
    try {
      const out = execCapture(ADB, ['-s', s, 'shell', 'pm', 'path', PULL_PKG], { timeout: 60000 });
      const line = out.split(/\r?\n/).find((l) => l.startsWith('package:'));
      if (!line) continue;
      execCapture(ADB, ['-s', s, 'pull', line.slice('package:'.length).trim(), REAL_APK], { timeout: 180000 });
      if (fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0) return true;
    } catch (e) {
      log(`在 ${s} 上拉 ${PULL_PKG} 失败：${safe(e.message)}`);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 汇总输出                                                            */
/* ------------------------------------------------------------------ */

function finish(errors = []) {
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log('===== 批量安装 CHECK =====');
  for (const r of rows) log(r);
  if (infos.length) {
    log('===== INFO =====');
    for (const i of infos) log(safe(i));
  }
  if (errors.length) {
    log('===== 渲染层异常 =====');
    for (const e of errors) log(safe(e));
  } else {
    log('渲染层无异常');
  }
  log(`${pass} 通过 / ${fail} 失败`);
  log('INSTALL ALL CHECK DONE');
  return fail === 0 && errors.length === 0;
}

/** 开局就瘸（素材/运行时不对）时的收尾：直接出报告，别装作跑过 */
function bail(reason) {
  rec(false, '前置准备', safe(reason));
  finish([]);
}

/* ------------------------------------------------------------------ */
/* 入口（开发态：Electron 运行时里加载 dist）                            */
/* ------------------------------------------------------------------ */

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }

  if (!ensureFixture()) {
    bail(`准备素材失败：设备上找不到 ${PULL_PKG}，造不出「真 APK」`);
    process.exit(1);
    return;
  }
  info(`素材: ${REAL_APK} ${fs.statSync(REAL_APK).size} bytes`);

  const electronMain = require('electron');
  if (typeof electronMain !== 'object' || !electronMain.app) {
    // ⚠️ 必须 return，别只靠 process.exit：在 Electron 主机里 process.exit 要等下一个
    // tick 才生效，后面的代码仍会被注册执行，往同一份日志里再塞一条 FAIL。
    bail('未在 Electron 运行时中执行（请用 run-electron.py 起）');
    process.exit(2);
    return;
  }
  const { app, BrowserWindow } = electronMain;

  app.whenReady().then(async () => {
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

    const page = {
      evalJS: (expr) => win.webContents.executeJavaScript(expr),
      cdpSend: (m, p) => {
        const d = win.webContents.debugger;
        if (!d.isAttached()) d.attach('1.3');
        return d.sendCommand(m, p);
      },
      screenshot: async (file) => {
        try { win.webContents.invalidate(); } catch { /* ignore */ }
        await sleep(120);
        await win.webContents.capturePage().catch(() => null);
        await sleep(160);
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        fs.writeFileSync(file, png);
        return png.length;
      },
    };

    try {
      await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
      await new Promise((r) => setTimeout(r, 400));
      // 隐藏窗口的合成器不会主动出帧，先丢一帧再截真正要的那张
      await win.webContents.capturePage().catch(() => null);
      await runChecks(page);
    } catch (e) {
      rec(false, '执行检查流程', safe(e && e.message));
    }

    const ok = finish(errors);
    try { win.webContents.debugger.detach(); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  });
})();
