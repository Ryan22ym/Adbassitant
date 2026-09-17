/**
 * 拖放安装（进度弹窗 + 防重复）验证
 *
 * 开发态（默认）：在 Electron 里以被测应用方式加载 dist/index.html
 *   python scripts/run-electron.py scripts/check-drag-install.cjs \
 *       --watch ui-shots/_draginstall.log --until "DRAG INSTALL CHECK DONE" --timeout 420
 *
 * 安装版：node 直接跑，脚本会启动安装目录里的 exe 并用 CDP 连过去
 *   node scripts/check-drag-install.cjs --installed
 *   （安装版日志写 ui-shots/_draginstall-installed.log）
 *
 * 为什么这样测
 * ---------------------------------------------------------------
 * 真实「从资源管理器拖文件进来」无法脚本化，所以分两步逼近：
 *   A. 用 CDP 的 DOM.setFileInputFiles 给隐藏 input 挂上**真实磁盘文件**，
 *      取到的 File 对象与拖放时 Chromium 造出来的同源 —— 用它验证
 *      webUtils.getPathForFile 能拿到绝对路径（这正是 Electron 32+ 的坑）。
 *   B. 把这些 File 塞进 DataTransfer，在 window 上派发 dragenter/dragover/drop，
 *      走的是和真人拖放完全相同的处理器。
 *
 * 覆盖点
 * ---------------------------------------------------------------
 *  1. 拖入文件时出现整窗拖放遮罩
 *  2. 非 APK 文件被拒绝，且窗口没有被拖成导航
 *  3. 拖放文件能解析出真实绝对路径
 *  4. 拖入真 APK → 弹窗「正在安装中…」→「安装成功」→ 自动关闭
 *  5. 安装中再拖一次 → 被拒绝，弹窗不被覆盖（防重复）
 *  6. 假 APK → 弹窗「安装失败」+ 真实 adb 失败原因
 *  7. 「安装安装包」页内的拖放区能独立接住拖放（不走整窗逻辑）
 *  8. 主进程侧并发安装被互斥锁拦下
 *  9. 渲染层无 error 级日志
 *
 * 素材自动准备（放系统临时目录，仓库不新增二进制）：真 APK 从设备上
 * `pm path` + `adb pull` 拉一个已装应用的 base.apk，-r 重装必然成功。
 * 默认设备 emulator-5556、默认包 com.zidongdianji，可用环境变量覆盖：
 *   ADB_SERIAL / PULL_PKG
 * 跑之前记得 unset ELECTRON_RUN_AS_NODE（run-electron.py 会自己清）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/** 安装版走 CDP 连安装目录的真身；开发态在 Electron 里加载 dist */
const INSTALLED = process.argv.includes('--installed');
// 安装版分支跑在 **Electron 主进程** 里，而主进程没有全局 WebSocket（见 _ws-shim.cjs），
// 不打这个垫片，CDP 客户端会直接抛 "WebSocket is not defined" 变成假失败。
if (INSTALLED) require('./_ws-shim.cjs').install();
const LOG = path.join(OUT, INSTALLED ? '_draginstall-installed.log' : '_draginstall.log');

/** 测试素材放系统临时目录，不污染仓库 */
const DND = path.join(os.tmpdir(), 'adb-assistant-dnd');
const REAL_APK = path.join(DND, 'real-app.apk');
const FAKE_APK = path.join(DND, 'fake-broken.apk');
const NOTES = path.join(DND, 'notes.txt');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

/** 安装目标设备：默认挑模拟器，避免把测试包装到真机上（真机可能弹安装确认框） */
const SERIAL = process.env.ADB_SERIAL || 'emulator-5556';
/** 从哪台设备上拉一个真 APK 当素材（重新 -r 安装必然成功） */
const PULL_PKG = process.env.PULL_PKG || 'com.zidongdianji';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rows = [];
let infos = [];
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}
const record = (ok, name, detail = '') => rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
const info = (msg) => infos.push(msg);

/**
 * 外部输出（adb 的 Failure[...]、异常消息）里带 FAIL / Error 字样会污染
 * run-electron.py 的 PASS/FAIL 判定，落盘前先打码，避免假失败。
 */
const safe = (s) =>
  String(s == null ? '' : s)
    .replace(/FAIL/g, 'F*IL')
    .replace(/ERROR/g, 'ERR*R')
    .replace(/Error/g, 'Err*r')
    .replace(/failure/g, 'f*ilure');

/* ------------------------------------------------------------------ */
/* 页面内注入的辅助函数                                                */
/* ------------------------------------------------------------------ */

/** 把 DataTransfer 里的文件按真实拖放顺序派发到指定元素（默认 window） */
const PAGE_HELPERS = `
window.__dnd = {
  makeDT(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  },
  fire(target, files, types) {
    const dt = this.makeDT(files);
    const list = types || ['dragenter', 'dragover', 'drop'];
    for (const t of list) {
      target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return { types: Array.from(dt.types) };
  },
  probe() {
    const el = document.getElementById('__dnd_probe');
    return el ? Array.from(el.files) : [];
  },
  veil: () => !!document.querySelector('.drop-veil'),
  /**
   * 切换「安装方式」。拖放安装读的是 store 里的 installMode，
   * 所以点一下分段控件就够了（前提：页面在「安装安装包」标签页上）。
   */
  setMode(label) {
    const box = document.querySelector('[data-install-mode]');
    if (!box) return 'no-mode-box';
    const btn = Array.from(box.querySelectorAll('.segmented-item')).find(
      (b) => b.textContent.trim() === label,
    );
    if (!btn) return 'no-btn:' + Array.from(box.querySelectorAll('.segmented-item')).map((b) => b.textContent.trim()).join('|');
    btn.click();
    return 'ok';
  },
  modeInfo() {
    const box = document.querySelector('[data-install-mode]');
    if (!box) return null;
    return {
      options: Array.from(box.querySelectorAll('.segmented-item')).map((b) => b.textContent.trim()),
      active: (box.querySelector('.segmented-item.active')?.textContent || '').trim(),
      value: box.getAttribute('data-install-mode'),
    };
  },
  /** 页面上的「将安装到 xxx · serial」 */
  targetText: () => (document.querySelector('.apk-target')?.textContent || '').trim(),
  /**
   * 「装到哪台设备」弹窗的状态。多台设备在线时它必须出现 ——
   * 不允许应用自己挑一台就开装。
   */
  pickInfo() {
    const mask = document.querySelector('[data-pick-device]');
    if (!mask) return null;
    return {
      title: (mask.querySelector('.install-title')?.textContent || '').trim(),
      file: (mask.querySelector('.install-file')?.textContent || '').trim(),
      chips: Array.from(mask.querySelectorAll('.install-chip')).map((c) => c.textContent.trim()),
      note: (mask.querySelector('.install-note')?.textContent || '').trim(),
      buttons: Array.from(mask.querySelectorAll('.install-actions .btn')).map((b) => b.textContent.trim()),
      devices: Array.from(mask.querySelectorAll('[data-install-device]')).map((b) => ({
        serial: b.getAttribute('data-install-device'),
        kind: (b.querySelector('.install-device-kind')?.textContent || '').trim(),
        name: (b.querySelector('.install-device-name')?.textContent || '').trim(),
        cur: (b.querySelector('.install-device-serial')?.textContent || '').includes('当前'),
      })),
    };
  },
  /** 在选设备弹窗里点某台设备 */
  pickDevice(serial) {
    const btn = document.querySelector('[data-install-device="' + serial + '"]');
    if (!btn) return 'no-btn';
    btn.click();
    return 'ok';
  },
  /** 选设备弹窗里点「取消」 */
  pickCancel() {
    const mask = document.querySelector('[data-pick-device]');
    if (!mask) return 'no-mask';
    const b = Array.from(mask.querySelectorAll('.install-actions .btn')).find(
      (x) => x.textContent.trim() === '取消',
    );
    if (!b) return 'no-cancel';
    b.click();
    return 'ok';
  },
  maskState() {
    const mask = document.querySelector('.install-mask');
    if (!mask) return null;
    return {
      title: (mask.querySelector('.install-title')?.textContent || '').trim(),
      file: (mask.querySelector('.install-file')?.textContent || '').trim(),
      detail: (mask.querySelector('.install-detail')?.textContent || '').trim(),
      note: (mask.querySelector('.install-note')?.textContent || '').trim(),
      chips: Array.from(mask.querySelectorAll('.install-chip')).map((c) => c.textContent.trim()),
      buttons: Array.from(mask.querySelectorAll('.install-actions .btn')).map((b) => b.textContent.trim()),
    };
  },
  toasts: () => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent.trim()),
  shellAlive: () => !!document.querySelector('.app-shell'),
};
undefined;
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

  /* ---------- 0. 默认设备必须落在物理设备上（这次的 bug 本体） ---------- */
  const expectedDefault = firstPhysicalSerial();
  const defaultSerial = await page.evalJS(
    `(document.querySelector('.device-select') || {}).value || ''`,
  );
  record(
    !!expectedDefault && defaultSerial === expectedDefault,
    '启动后默认选中物理设备（不是 adb 列表里的模拟器）',
    `default=${defaultSerial} expected=${expectedDefault}`,
  );

  /* 固定选到模拟器，避免把测试包装到真机上（真机可能有安装确认弹窗） */
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

  /* 切到「常用工具 → 安装安装包」（v1.0.17 起这个标签同时管 APK 与 AAB） */
  const tabOk = await page.evalJS(`
    (() => {
      window.location.hash = '#/tools';
      return true;
    })()
  `);
  await sleep(700);
  const clickedTab = await page.evalJS(`
    (() => {
      const want = ['安装安装包', '安装 APK'];
      const all = Array.from(document.querySelectorAll('.tab'));
      const t = all.find((x) => want.includes(x.textContent.trim()));
      if (!t) return 'no-tab:' + all.map((x) => x.textContent.trim()).join('|');
      t.click();
      return 'ok';
    })()
  `);
  record(clickedTab === 'ok' && !!tabOk, '进入「安装安装包」标签页', String(clickedTab));
  await sleep(500);

  const zoneOk = await page.evalJS(`
    (() => {
      const z = document.querySelector('[data-dropzone="apk"] .apk-drop, .apk-drop[data-dropzone], [data-dropzone]');
      return !!(z && z.classList.contains('apk-drop'));
    })()
  `);
  record(zoneOk, '「安装安装包」页存在显式拖放区', `found=${zoneOk}`);

  /* 注入辅助函数 + 隐藏 input，再用 CDP 挂真实文件 */
  await page.evalJS(`
    (() => {
      const old = document.getElementById('__dnd_probe');
      if (old) old.remove();
      const input = document.createElement('input');
      input.type = 'file';
      input.id = '__dnd_probe';
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
    selector: '#__dnd_probe',
  });
  record(!!nodeId, 'CDP 找到隐藏文件输入框', `nodeId=${nodeId}`);
  await dbg.sendCommand('DOM.setFileInputFiles', {
    files: [REAL_APK, FAKE_APK, NOTES],
    nodeId,
  });

  const resolved = await page.evalJS(`
    (() => {
      const files = window.__dnd.probe();
      return {
        names: files.map((f) => f.name),
        sizes: files.map((f) => f.size),
        paths: files.map((f) => (window.adbApi.getPathForFile ? window.adbApi.getPathForFile(f) : null)),
      };
    })()
  `);
  info(`挂载到的 File: ${JSON.stringify(resolved.names)}`);
  info(`解析出的路径: ${JSON.stringify(resolved.paths)}`);

  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const pathOk =
    resolved.paths &&
    resolved.paths.length === 3 &&
    norm(resolved.paths[0]) === norm(REAL_APK);

  if (pathOk) {
    record(true, '拖放文件能解析出真实绝对路径（webUtils.getPathForFile）', norm(resolved.paths[0]));
  } else {
    record(false, '拖放文件能解析出真实绝对路径（webUtils.getPathForFile）', safe(JSON.stringify(resolved.paths)));
  }
  if (!pathOk) {
    info('拿不到路径 → 后续拖放用例无法覆盖安装链路，提前结束');
    return page;
  }

  /* ---------- 1. 拖拽遮罩 ---------- */
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().slice(0, 1);
      window.__dnd.fire(window, files, ['dragenter', 'dragover']);
      return true;
    })()
  `);
  await sleep(220);
  const veil = await page.evalJS(`window.__dnd.veil()`);
  record(!!veil, '拖入文件时出现整窗拖放遮罩', `veil=${veil}`);
  await page.screenshot(path.join(OUT, 'drag-install-1-veil.png'));

  /* ---------- 2. 非 APK 被拒绝 ---------- */
  const before2 = new Date().toISOString();
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().filter((f) => /\\.txt$/i.test(f.name));
      window.__dnd.fire(window, files, ['dragenter', 'dragover', 'drop']);
      return true;
    })()
  `);
  await sleep(700);
  const after2 = await page.evalJS(`
    ({ veil: window.__dnd.veil(), mask: window.__dnd.maskState(), toasts: window.__dnd.toasts(), alive: window.__dnd.shellAlive() })
  `);
  record(after2.alive, '拖入非 APK 后界面没有被拖成导航', `shellAlive=${after2.alive}`);
  record(!after2.veil, 'drop 之后拖放遮罩消失', `veil=${after2.veil}`);
  record(
    !after2.mask && after2.toasts.some((t) => t.includes('没有可安装的文件')),
    '拖入非 APK 被拒绝并给出提示',
    safe(JSON.stringify(after2.toasts)),
  );

  /* ---------- 3. 拖入真 APK → 安装中 ---------- */
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().filter((f) => /real-app\\.apk$/i.test(f.name));
      window.__dnd.fire(window, files, ['dragenter', 'dragover', 'drop']);
      return true;
    })()
  `);
  /* 多台设备在线时会先弹「装到哪台设备」—— 点掉之后才看得到进度弹窗 */
  const rp3 = await resolvePick(page);
  let sawInstalling = rp3.mask;
  for (let i = 0; i < 40; i++) {
    if (sawInstalling && sawInstalling.title.includes('正在安装中')) break;
    await sleep(250);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && s.title.includes('正在安装中')) { sawInstalling = s; break; }
    if (s && (s.title.includes('安装成功') || s.title.includes('安装失败'))) break;
  }
  record(
    !!(sawInstalling && sawInstalling.file.includes('real-app.apk')),
    '拖入 APK 后弹出「正在安装中…」',
    safe(JSON.stringify(sawInstalling)),
  );
  await page.screenshot(path.join(OUT, 'drag-install-2-installing.png'));

  /* ---------- 4. 安装中再拖一次 → 防重复 ---------- */
  const lockProbe = await page.evalJS(`
    (async () => {
      const files = window.__dnd.probe().filter((f) => /real-app\\.apk$/i.test(f.name));
      const fired = window.__dnd.fire(window, files, ['dragenter', 'dragover', 'drop']);
      let over = null;
      try {
        const el = document.querySelector('.apk-drop');
        over = window.__dnd.fire(el, files, ['dragover', 'drop']);
      } catch (e) { over = { err: String(e) }; }
      const main = await window.adbApi.installApk(${JSON.stringify(SERIAL)}, ${JSON.stringify(REAL_APK)}, true, false);
      return { fired, over, main, mask: window.__dnd.maskState(), toasts: window.__dnd.toasts() };
    })()
  `);
  info(`安装中重复触发: ${safe(JSON.stringify(lockProbe))}`);
  record(
    !!(lockProbe.mask && lockProbe.mask.title.includes('正在安装中')),
    '安装中再次拖放：弹窗仍停在「正在安装中」，未被新任务覆盖',
    safe(lockProbe.mask ? lockProbe.mask.title : 'null'),
  );
  record(
    !!(lockProbe.main && lockProbe.main.ok === false && String(lockProbe.main.error).includes('正在安装')),
    '主进程侧并发安装被互斥锁拦下',
    safe(lockProbe.main ? lockProbe.main.error : 'null'),
  );
  record(
    !!(lockProbe.main === null || lockProbe.main.ok === false),
    '安装中的重复拖放没有被当成第二个安装任务',
    safe(JSON.stringify(lockProbe.main)),
  );

  /* ---------- 5. 等安装成功 ---------- */
  let done = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && (s.title.includes('安装成功') || s.title.includes('安装失败'))) { done = s; break; }
    if (!s) { done = null; break; }
  }
  record(
    !!(done && done.title.includes('安装成功')),
    '真 APK 拖放安装成功，弹窗切到「安装成功」',
    safe(JSON.stringify(done)),
  );
  await page.screenshot(path.join(OUT, 'drag-install-3-success.png'));

  /* 成功后自动关闭 */
  let autoClosed = false;
  for (let i = 0; i < 16; i++) {
    await sleep(400);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (!s) { autoClosed = true; break; }
  }
  record(autoClosed, '「安装成功」弹窗自动关闭', `closed=${autoClosed}`);

  /* ---------- 6. 假 APK → 安装失败 ---------- */
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().filter((f) => /fake-broken\\.apk$/i.test(f.name));
      window.__dnd.fire(window, files, ['dragenter', 'dragover', 'drop']);
      return true;
    })()
  `);
  await resolvePick(page);
  let failed = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && s.title.includes('安装失败')) { failed = s; break; }
    if (s && s.title.includes('安装成功')) { failed = s; break; }
  }
  record(
    !!(failed && failed.title.includes('安装失败') && failed.detail && failed.detail.length > 0),
    '假 APK 拖放：弹窗切到「安装失败」并带出真实原因',
    safe(JSON.stringify(failed)),
  );
  await page.screenshot(path.join(OUT, 'drag-install-4-failed.png'));

  /* 失败弹窗要能手动关掉，且不自动关 */
  await sleep(2200);
  const stillOpen = await page.evalJS(`window.__dnd.maskState()`);
  record(!!(stillOpen && stillOpen.title.includes('安装失败')), '「安装失败」弹窗不会自动消失', `stillOpen=${!!stillOpen}`);

  await page.evalJS(`
    (() => {
      const b = document.querySelector('.install-actions .btn');
      if (b) b.click();
      return true;
    })()
  `);
  await sleep(500);
  const closedAfterClick = await page.evalJS(`window.__dnd.maskState()`);
  record(!closedAfterClick, '「安装失败」弹窗可手动关闭', `mask=${JSON.stringify(closedAfterClick)}`);

  /* ---------- 7. 页面内拖放区（不走整窗逻辑） ---------- */
  const zoneDrop = await page.evalJS(`
    (async () => {
      const el = document.querySelector('.apk-drop');
      if (!el) return { err: 'no-dropzone' };
      const files = window.__dnd.probe().filter((f) => /real-app\\.apk$/i.test(f.name));
      const r = window.__dnd.fire(el, files, ['dragenter', 'dragover', 'drop']);
      await new Promise((res) => setTimeout(res, 300));
      return { r, veil: window.__dnd.veil() };
    })()
  `);
  record(
    !!(zoneDrop.r && zoneDrop.veil === false),
    '页面内拖放区接管拖放：不再显示整窗遮罩',
    safe(JSON.stringify(zoneDrop.r)),
  );
  /* 页面内拖放区走的是同一个入口，所以同样要先穿过「装到哪台设备」那一屏 */
  const rp7 = await resolvePick(page);
  record(rp7.sawPick, '页面内拖放区拖入后同样先问「装到哪台设备」', `sawPick=${rp7.sawPick}`);
  const zoneMask = rp7.mask || (await page.evalJS(`window.__dnd.maskState()`));
  record(
    !!(zoneMask && zoneMask.title.includes('正在安装中')),
    '页面内拖放区拖入后同样弹出安装进度',
    safe(JSON.stringify(zoneMask)),
  );

  let zoneDone = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && (s.title.includes('安装成功') || s.title.includes('安装失败'))) { zoneDone = s; break; }
    if (!s) break;
  }
  record(
    !!(zoneDone && zoneDone.title.includes('安装成功')),
    '页面内拖放区安装成功',
    safe(JSON.stringify(zoneDone)),
  );
  const panelState = await page.evalJS(`
    (() => {
      const zone = document.querySelector('.apk-drop');
      const btn = Array.from(document.querySelectorAll('.btn')).find((b) => b.textContent.trim() === '开始安装');
      return {
        fileName: zone ? (zone.querySelector('.apk-drop-file-name')?.textContent || '').trim() : '',
        size: zone ? (zone.querySelector('.apk-drop-file-size')?.textContent || '').trim() : '',
        btnDisabled: btn ? btn.disabled : null,
        result: (document.querySelector('.output-block')?.textContent || '').trim(),
      };
    })()
  `);
  record(
    panelState.fileName.includes('real-app.apk') && panelState.btnDisabled === false,
    '拖放后页面回填文件名并解锁「开始安装」',
    safe(JSON.stringify(panelState)),
  );
  record(
    panelState.result.includes('安装成功'),
    '页面内保留安装结果供回看',
    safe(panelState.result),
  );
  await page.screenshot(path.join(OUT, 'drag-install-5-page-zone.png'));

  /* ---------- 10. 安装方式三选一 + 目标设备必须可见 ---------- */
  const modeInfo = await page.evalJS(`window.__dnd.modeInfo()`);
  log('安装方式:', JSON.stringify(modeInfo));
  record(
    !!modeInfo &&
      ['覆盖安装', '清洁安装', '全新安装'].every((t) => (modeInfo.options || []).includes(t)),
    '页面提供三种安装方式（覆盖 / 清洁 / 全新）',
    safe(JSON.stringify(modeInfo)),
  );
  record(
    !!modeInfo && modeInfo.active === '覆盖安装',
    '默认是覆盖安装（不破坏数据）',
    String(modeInfo && modeInfo.active),
  );

  const targetText = await page.evalJS(`window.__dnd.targetText()`);
  record(
    !!targetText && targetText.includes(SERIAL),
    '页面上标出了安装目标设备（含序列号）',
    safe(targetText),
  );

  /* ---------- 11. 全新安装遇已装包：界面必须报失败 ---------- */
  await page.evalJS(`window.__dnd.setMode('全新安装')`);
  await sleep(250);
  const switched = await page.evalJS(`window.__dnd.modeInfo()`);
  record(switched && switched.active === '全新安装', '能切到「全新安装」', String(switched && switched.value));

  const freshState = await dropAndWait(page, 120);
  record(
    !!(freshState && freshState.title.includes('安装失败') && /已存在/.test(freshState.detail || '')),
    '全新安装遇已装包：界面报失败而不是假成功',
    safe(JSON.stringify(freshState)),
  );

  // 失败弹窗不会自动关，先关掉再进下一步，否则下一轮会读到这个旧状态
  await closeInstallMask(page);

  /* ---------- 12. 清洁安装：先卸载再装，弹窗要写明数据被清 ---------- */
  await page.evalJS(`window.__dnd.setMode('清洁安装')`);
  await sleep(250);
  const cleanState = await dropAndWait(page, 180);
  record(
    !!(cleanState && cleanState.title.includes('安装成功')),
    '清洁安装成功',
    safe(JSON.stringify(cleanState)),
  );
  record(
    !!(cleanState && /已先卸载旧版本/.test(cleanState.detail || '')),
    '清洁安装弹窗写明「已先卸载旧版本，应用数据已清除」',
    safe(JSON.stringify(cleanState && cleanState.detail)),
  );
  record(
    !!(cleanState && /已复核/.test(cleanState.detail || '')),
    '弹窗写明装后已复核（设备上确有该包）',
    safe(JSON.stringify(cleanState && cleanState.detail)),
  );
  record(
    !!(cleanState && (cleanState.chips || []).some((c) => c.includes(SERIAL))),
    '弹窗里标出了目标设备（含序列号）',
    safe(JSON.stringify(cleanState && cleanState.chips)),
  );
  record(
    !!(cleanState && (cleanState.chips || []).some((c) => c.includes('清洁安装'))),
    '弹窗里标出了安装方式',
    safe(JSON.stringify(cleanState && cleanState.chips)),
  );
  record(
    !!(cleanState && (cleanState.chips || []).some((c) => c.includes('已复核'))),
    '弹窗给出「已复核」标记',
    safe(JSON.stringify(cleanState && cleanState.chips)),
  );
  /* ---------- 13. 多台设备在线：必须先问「装到哪台」---------- */
  await page.evalJS(`window.__dnd.setMode('覆盖安装')`);
  await sleep(250);

  const fired = await dropAndWait(page, 40, null);
  const pick = fired && fired.pendingPick ? fired.pick : null;
  log('选设备弹窗:', safe(JSON.stringify(pick)));

  record(
    !!pick,
    '多台设备在线时拖放不直接开装，而是先问装到哪台',
    safe(JSON.stringify(fired)),
  );
  record(
    !!(pick && Array.isArray(pick.devices) && pick.devices.length >= 2),
    '选设备弹窗列出了全部在线设备',
    safe(`devices=${pick && pick.devices && pick.devices.length}`),
  );

  const options = await page.evalJS(
    `Array.from(document.querySelectorAll('.device-select option')).map((o) => o.value)`,
  );
  record(
    !!(pick && (pick.devices || []).every((d) => options.includes(d.serial))),
    '弹窗里的设备都来自设备列表（没有凭空造设备）',
    safe(JSON.stringify({ listed: (pick && pick.devices || []).map((d) => d.serial), options })),
  );

  /* 物理设备必须排在模拟器前面 —— 否则默认那一行就是模拟器，等于没修 */
  const kinds = ((pick && pick.devices) || []).map((d) => d.kind);
  const firstPhone = kinds.indexOf('手机');
  const firstEmu = kinds.indexOf('模拟器');
  record(
    firstEmu === -1 || (firstPhone !== -1 && firstPhone < firstEmu),
    '物理设备排在模拟器前面（第一行永远是手机）',
    safe(kinds.join(' | ')),
  );
  record(
    !!(pick && (pick.devices || []).some((d) => d.cur)),
    '选设备弹窗标出了「当前」设备',
    safe(JSON.stringify((pick && pick.devices) || [])),
  );
  record(
    !!(pick && /real-app\.apk/.test(pick.file || '')),
    '选设备弹窗写明了要装哪个文件',
    safe(pick && pick.file),
  );
  record(
    !!(pick && (pick.buttons || []).includes('取消')),
    '选设备弹窗可以取消',
    safe(JSON.stringify(pick && pick.buttons)),
  );
  await page.screenshot(path.join(OUT, 'drag-install-7-pick-device.png'));

  /* 取消后不得开装 */
  await page.evalJS(`window.__dnd.pickCancel()`);
  await sleep(700);
  const afterCancel = {
    pick: await page.evalJS(`window.__dnd.pickInfo()`),
    mask: await page.evalJS(`window.__dnd.maskState()`),
  };
  record(
    !afterCancel.pick && !afterCancel.mask,
    '点「取消」后不安装（弹窗关闭且没有进度弹窗）',
    safe(JSON.stringify(afterCancel)),
  );

  /* ---------- 14. 选定设备后才开装，并把选择同步为当前设备 ---------- */
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().slice(0, 1);
      window.__dnd.fire(window, files, ['drop']);
      return true;
    })()
  `);
  let pick2 = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    pick2 = await page.evalJS(`window.__dnd.pickInfo()`);
    if (pick2) break;
  }
  record(!!pick2, '再次拖放仍会先问目标设备（不记忆、不自作主张）', safe(pick2 && pick2.title));

  await page.evalJS(`window.__dnd.pickDevice(${JSON.stringify(SERIAL)})`);
  let chosen = null;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && (s.title.includes('安装成功') || s.title.includes('安装失败'))) {
      chosen = s;
      break;
    }
  }
  record(
    !!(chosen && chosen.title.includes('安装成功') && (chosen.chips || []).some((c) => c.includes(SERIAL))),
    '在弹窗里选定设备后才开装，且装到该设备',
    safe(JSON.stringify(chosen)),
  );
  const targetAfter = await page.evalJS(`window.__dnd.targetText()`);
  record(
    !!targetAfter && targetAfter.includes(SERIAL),
    '选择结果写回当前设备（页面同步显示）',
    safe(targetAfter),
  );
  await page.screenshot(path.join(OUT, 'drag-install-8-picked.png'));

  await page.screenshot(path.join(OUT, 'drag-install-6-clean.png'));

  return page;
}

/**
 * 用当前已挂载的 File 拖一次，等弹窗落到终态。
 *
 * 多台设备在线时会先弹「装到哪台设备」，默认按 autoPick 指定的设备点下去 ——
 * 既覆盖了这道新增的步骤，也让下面的用例继续测「安装过程」本身。
 * autoPick 传 null 则遇到选设备弹窗就原样返回（供专门测这一步的用例使用）。
 */
async function dropAndWait(page, rounds, autoPick = SERIAL) {
  await page.evalJS(`
    (() => {
      const files = window.__dnd.probe().slice(0, 1);
      window.__dnd.fire(window, files, ['drop']);
      return true;
    })()
  `);
  for (let i = 0; i < rounds; i++) {
    await sleep(500);
    const pick = await page.evalJS(`window.__dnd.pickInfo()`);
    if (pick) {
      if (!autoPick) return { pendingPick: true, pick };
      await page.evalJS(`window.__dnd.pickDevice(${JSON.stringify(autoPick)})`);
      continue;
    }
    const s = await page.evalJS(`window.__dnd.maskState()`);
    if (s && (s.title.includes('安装成功') || s.title.includes('安装失败'))) return s;
  }
  return null;
}

/**
 * 第一台在线的**物理**设备序列号（模拟器的 serial 一律以 emulator- 开头）。
 *
 * 用来断言应用的默认选择：多台设备在线时，默认目标必须是手机而不是模拟器。
 * 取不到（只有模拟器在线）时返回 null，对应用例会被跳过式判失败并在详情里说明。
 */
function firstPhysicalSerial() {
  try {
    const out = execFileSync(ADB, ['devices'], { encoding: 'utf8', timeout: 20000 });
    const serials = out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a[1] === 'device')
      .map((a) => a[0]);
    return serials.find((s) => !/^emulator-/.test(s)) || null;
  } catch {
    return null;
  }
}

/**
 * 拖一次并穿过「选设备」那一屏。
 *
 * 多台设备在线时，拖放不会直接开装，而是先弹「装到哪台设备？」。
 * 这个 helper 负责把那一屏点掉（选 serial 那台），再等进度弹窗出现，
 * 返回 { sawPick, mask } —— sawPick 可以用来断言「确实问了」。
 */
async function resolvePick(page, serial = SERIAL) {
  let sawPick = false;
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const st = await page.evalJS(
      `({ pick: window.__dnd.pickInfo(), mask: window.__dnd.maskState() })`,
    );
    if (st.pick) {
      await page.evalJS(`window.__dnd.pickDevice(${JSON.stringify(serial)})`);
      sawPick = true;
      break;
    }
    // 单设备场景不会出现这一屏，直接就有进度弹窗了
    if (st.mask) return { sawPick: false, mask: st.mask };
  }
  if (!sawPick) return { sawPick: false, mask: null };

  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const mask = await page.evalJS(`window.__dnd.maskState()`);
    if (mask) return { sawPick: true, mask };
  }
  return { sawPick: true, mask: null };
}

/** 关掉结果弹窗并等它真的消失（防止下一轮读到上一个任务的残留状态） */
async function closeInstallMask(page) {
  await page.evalJS(`
    (() => {
      const pick = document.querySelector('[data-pick-device]');
      if (pick) {
        const c = Array.from(pick.querySelectorAll('.install-actions .btn'))
          .find((b) => b.textContent.trim() === '取消');
        if (c) c.click();
      }
      const btn = Array.from(document.querySelectorAll('.install-actions .btn'))
        .find((b) => b.textContent.trim() === '关闭' || b.textContent.trim() === '知道了');
      if (btn) btn.click();
      return true;
    })()
  `);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const st = await page.evalJS(`window.__dnd.maskState()`);
    const pk = await page.evalJS(`window.__dnd.pickInfo()`);
    if (!st && !pk) return true;
  }
  return false;
}

/**
 * 从设备上拉一个真 APK 当素材。
 *
 * 为什么不用现成安装包：仓库里不该塞 20MB 的二进制；而「安装成功」这条路径
 * 又必须用真的 APK 才能走通。取设备上已装应用的 base.apk 再 -r 重装，
 * 版本一致，必然成功，且不需要额外准备。
 */
function ensureFixtures() {
  fs.mkdirSync(DND, { recursive: true });
  fs.writeFileSync(FAKE_APK, Buffer.from('NOT-A-REAL-APK'.repeat(64)));
  fs.writeFileSync(NOTES, 'this is not an apk\n');

  if (fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0) return true;

  const adb = (args) => execFileSync(ADB, args, { encoding: 'utf8', timeout: 180000 });

  let remote = '';
  try {
    const out = adb(['-s', SERIAL, 'shell', 'pm', 'path', PULL_PKG]);
    const line = out.split(/\r?\n/).find((l) => l.startsWith('package:'));
    if (line) remote = line.slice('package:'.length).trim();
  } catch (e) {
    log(`FATAL 取不到远端 APK 路径（${PULL_PKG} @ ${SERIAL}）：${safe(e.message)}`);
    return false;
  }
  if (!remote) {
    log(`FATAL 设备 ${SERIAL} 上没有 ${PULL_PKG}，无法准备真 APK 素材（可用 PULL_PKG 指定别的包）`);
    return false;
  }

  try {
    adb(['-s', SERIAL, 'pull', remote, REAL_APK]);
  } catch (e) {
    log(`FATAL 拉取真 APK 失败：${safe(e.message)}`);
    return false;
  }
  return fs.existsSync(REAL_APK) && fs.statSync(REAL_APK).size > 0;
}

/* ------------------------------------------------------------------ */
/* 汇总输出                                                            */
/* ------------------------------------------------------------------ */

/** 打印结果并返回是否全过（两种后端共用） */
function finish(errors = [], warnings = []) {
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;

  log(`===== 拖放安装 CHECK（${INSTALLED ? '安装版' : '开发态'}）=====`);
  for (const r of rows) log(r);
  if (infos.length) {
    log('===== INFO =====');
    for (const i of infos) log(safe(i));
  }
  if (warnings.length) {
    log('===== 渲染层警告（不计入失败） =====');
    for (const w of warnings) log(safe(w));
  }
  if (errors.length) {
    log('===== 渲染层异常 =====');
    for (const e of errors) log(safe(e));
  } else {
    log('渲染层无异常');
  }
  log(`${pass} 通过 / ${fail} 失败`);
  log('DRAG INSTALL CHECK DONE');
  return fail === 0 && errors.length === 0;
}

/* ------------------------------------------------------------------ */
/* 安装版后端：CDP over WebSocket 连安装目录里的真身                    */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url, errors) {
    this.id = 0;
    this.pending = new Map();
    this.errors = errors || [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      // 顺带把渲染层异常收上来，等价于开发态的 console-message 监听
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = (msg.params && msg.params.exceptionDetails) || {};
        this.errors.push(d.text || (d.exception && d.exception.description) || 'exception');
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 起安装目录里的 exe 并连 CDP，返回与开发态同形的 page */
async function openInstalled() {
  const EXE = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant', 'ADB桌面助手.exe');
  const PORT = 9348;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // ★ 必须：否则 Electron 退化成纯 Node
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: os.tmpdir(), env,
  });
  child.unref();

  const waitTarget = async (retries = 90, interval = 500) => {
    for (let i = 0; i < retries; i++) {
      const found = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              resolve(list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null);
            } catch { resolve(null); }
          });
        }).on('error', () => resolve(null));
      });
      if (found) return found;
      await sleep(interval);
    }
    return null;
  };

  const target = await waitTarget();
  if (!target) throw new Error('安装版未能在预期时间内开出调试端点');

  const errors = [];
  const cdp = new CDP(target.webSocketDebuggerUrl, errors);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    page: {
      evalJS: (expr) => cdp.eval(expr),
      cdpSend: (m, p) => cdp.send(m, p),
      screenshot: async (file) => {
        // fromSurface:false —— 安装版的窗口可能不在前台/没被合成，
        // 默认的 fromSurface:true 在这种状态下会一直等不到帧（CDP timeout）。
        // 关掉它走渲染层直接抓，窗口在后台也能出图。
        let r;
        try {
          r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
        } catch {
          return 0;
        }
        if (!r || !r.data) return 0;
        const buf = Buffer.from(r.data, 'base64');
        fs.writeFileSync(file, buf);
        return buf.length;
      },
    },
    errors,
    close: () => {
      cdp.close();
      try { process.kill(child.pid); } catch { /* ignore */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch { /* ignore */ }

  if (!ensureFixtures()) {
    log('DRAG INSTALL CHECK DONE');
    process.exit(1);
  }
  info(`素材目录: ${DND}`);
  info(`真 APK: ${path.basename(REAL_APK)} ${fs.statSync(REAL_APK).size} bytes`);

  /* ---- 安装版：node 直接跑，CDP 连安装目录的 exe ---- */
  if (INSTALLED) {
    let session = null;
    try {
      session = await openInstalled();
      await runChecks(session.page);
      await sleep(600);
      await session.page.screenshot(path.join(OUT, 'drag-install-installed.png'));
    } catch (e) {
      record(false, '执行检查流程', safe(e && e.message));
    }
    const ok = finish(session ? session.errors : []);
    if (session) session.close();
    // ⚠️ 必须 return，不能只靠 process.exit：
    //   Electron 主进程里 process.exit() 会在当前 tick 之后才真正生效，
    //   底下开发态那段 app.whenReady().then(...) 仍会被注册并跑起来 ——
    //   它会去 loadFile(dist/index.html)（安装版环境里没有 dist/）而抛错，
    //   往同一份日志里写一条 FAIL，把一次干净的 47/0 污染成 47/1。
    //   return 让 IIFE 正常结束，开发态那段根本不会被执行到。
    process.exit(ok ? 0 : 1);
    return;
  }

  /* ---- 开发态：Electron 运行时里加载 dist ---- */
  // 兜底断言：走到这里说明 INSTALLED 分支没能提前结束（见那里的 return 注释）。
  // 宁可直接退出，也不要在安装版环境里 loadFile(dist/...) 抛错、污染日志。
  if (INSTALLED) {
    log('FATAL 安装版分支未提前结束（不应到达开发态代码）');
    log('DRAG INSTALL CHECK DONE');
    process.exit(1);
    return;
  }
  const electronMain = require('electron');
  if (typeof electronMain !== 'object' || !electronMain.app) {
    log('FATAL 未在 Electron 运行时中执行（请用 run-electron.py 起）');
    log('DRAG INSTALL CHECK DONE');
    process.exit(2);
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

    const warnings = [];
    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 3) errors.push(msg);
      else if (level === 2) warnings.push(msg);
    });

    // 隐藏窗口的合成器不会主动出帧，**首次** capturePage 往往拿到陈旧帧
    // （实测会截到跳转前的页面）。所以先丢掉一帧，再截真正要的那张。
    const page = {
      evalJS: (expr) => win.webContents.executeJavaScript(expr),
      // 懒 attach：保持与原实现相同的时机（第一次 DOM 调用时才挂调试器）
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
      await win.webContents.capturePage().catch(() => null); // 预热：逼合成器出第一帧
      await runChecks(page);
    } catch (e) {
      record(false, '执行检查流程', safe(e && e.message));
    }

    const ok = finish(errors, warnings);
    try { win.webContents.debugger.detach(); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  });
})();
