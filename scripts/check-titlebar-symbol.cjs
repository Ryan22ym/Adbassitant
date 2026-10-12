/**
 * 标题栏右上角窗口按钮「符号色」校验（v1.1.12）。
 *
 * 背景：那三个按钮是 titleBarOverlay 由主进程画的，颜色只有 `symbolColor` 一个入口。
 * 原来渲染层直接拿 `--text-primary` 当符号色 —— 浅/深色主题下恰好对（标题栏底色与
 * 内容区同明暗），但**原神主题是「米白内容区 + 深靛蓝标题栏」**：
 * --text-primary(#403d37) 是给米白底配的深墨字，画到深靛蓝标题栏上等于隐形。
 * 现在符号色单列一条 `--titlebar-symbol`，谁家标题栏偏深谁自己往浅里调。
 *
 * 这个脚本要挡住的**不是**「变量改没改」，而是下面这几类静默失效：
 *   1) 只把 CSS 变量改了、App.tsx 没跟着读新变量 → 界面没变化（最容易漏）；
 *   2) 新变量写成了 `var(--x)` 的**嵌套链**，而某一环没定义 →
 *      getPropertyValue 拿到字面量 `var(--g-gold)`，主进程校验不过、
 *      整条 setTitleBarOverlay 抛错跳过 —— 按钮会**留在上一个主题的颜色上**，
 *      既不报错也不生效，比原 bug 更难查；
 *   3) 以后加新主题（崩铁…）时重犯：符号色与标题栏底色明度太近。
 *
 * 🔴 所以断言只认**主进程实际收到的参数**（给 setTitleBarOverlay 打桩记录），
 *    而不是页面里的 CSS 文本 —— 中间任何一环断了都拿不到合法的 #rrggbb。
 *    （本 Electron 没有 getTitleBarOverlay()，读回系统值也不现实，见 check-titlebar-scrim.cjs）
 *
 * 顺带出「改前 / 改后」两张**真实屏幕截图**（窗口按钮由系统画在渲染内容之外，
 * capturePage 拍不到，只能用系统截屏按窗口外框裁）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-titlebar-symbol.cjs \
 *     --watch ui-shots/_titlebar-symbol.log --until "TITLEBAR SYMBOL CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_titlebar-symbol.log');
function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, screen } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 主进程实际收到的标题栏配色 ---------------- */
const seen = [];
const origSetOverlay = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function patched(opts) {
  try {
    seen.push({ ...opts });
  } catch {
    /* 记录失败不影响主流程 */
  }
  try {
    return origSetOverlay ? origSetOverlay.call(this, opts) : undefined;
  } catch {
    /* 环境不支持就跳过，本脚本只看参数 */
  }
};
const HEX = /^#[0-9a-f]{6}$/;
const last = () => (seen.length ? seen[seen.length - 1] : {});
/** 等**新的一次**回传（链路每跳不在同一帧，必须轮询） */
async function waitNext(prevLen, timeout = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (seen.length > prevLen) return seen[seen.length - 1];
    await sleep(80);
  }
  return seen.length ? seen[seen.length - 1] : null;
}

/* ---------------- WCAG 对比度 ---------------- */
function lum(hex) {
  const c = [0, 1, 2]
    .map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  if (!HEX.test(a) || !HEX.test(b)) return 0;
  const l1 = lum(a);
  const l2 = lum(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * 计算样式里读到的颜色 → #rrggbb。
 *
 * ⚠️ 必须和 src/lib/color.ts 的 toHexColor 一样三种写法都认，少认一种就会
 * 把标题栏底色读成空串（对比度瞬间算成 0 → 一片假 FAIL）：
 *   - `color(srgb 0.89 0.92 0.99)` —— color-mix() 求值后的样子（浅/深色的标题栏就是它！）
 *   - `rgb(227, 235, 252)`
 *   - 直接就是 `#454c5c`（主题里写死底色的那一类）
 */
function hexOf(input) {
  const s = String(input || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  const cm = /^color\(\s*srgb\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)/i.exec(s);
  if (cm) {
    const to2 = (v) =>
      Math.round(Math.min(1, Math.max(0, parseFloat(v))) * 255)
        .toString(16)
        .padStart(2, '0');
    return '#' + to2(cm[1]) + to2(cm[2]) + to2(cm[3]);
  }
  const rm = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i.exec(s);
  if (rm) return '#' + [rm[1], rm[2], rm[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
  return '';
}

/* ---------------- 页面驱动 ---------------- */
function readCss(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const bar = document.querySelector('.titlebar');
      return {
        theme: root.getAttribute('data-theme'),
        accent: root.getAttribute('data-accent'),
        symbolVar: cs.getPropertyValue('--titlebar-symbol').trim(),
        textPrimary: cs.getPropertyValue('--text-primary').trim(),
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
      };
    })()
  `);
}

function clickSeg(win, fieldText, optionText) {
  return win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll('.field')]
        .find((f) => f.textContent.includes(${JSON.stringify(fieldText)}));
      if (!field) return 'no-field';
      const btn = [...field.querySelectorAll('.segmented-item')]
        .find((b) => b.textContent.trim() === ${JSON.stringify(optionText)});
      if (!btn) return 'no-option';
      btn.click();
      return 'ok';
    })()
  `);
}

function clickAccent(win, id) {
  return win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('.accent-chip[data-accent-id=${JSON.stringify(id)}]');
      if (!b) return 'no-chip';
      b.click();
      return 'ok';
    })()
  `);
}

/* ---------------- 真实屏幕截图（只截窗口外框那块） ---------------- */
/*
 * 为什么不用 capturePage：titleBarOverlay 的按钮由系统画在**渲染内容之外**，
 * webContents 的合成结果里根本没有它 —— 拍出来右上角是空的，等于没验。
 * 只能按窗口外框做系统截屏；窗口是刚 show 出来的，会盖在最上层。
 * 🔴 bounds 是 DIP，屏幕截屏是物理像素，得乘 scaleFactor（本机若 125% 就会错位）。
 */
function captureWindow(win, name) {
  const b = win.getBounds();
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const x = Math.round(b.x * sf);
  const y = Math.round(b.y * sf);
  const w = Math.round(b.width * sf);
  const h = Math.round(b.height * sf);
  const file = path.join(OUT, name);
  /*
   * ⚠️ 路径必须用 PowerShell 的**单引号**包（字面量）。
   * 双引号里 `\` 虽然也不转义，但 JSON.stringify 会把 `\` 写成 `\\`，
   * 于是实际路径变成 `D:\\WorkSpace\\...` —— 保存直接失败。
   */
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()',
  ].join('; ');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      timeout: 20000,
    });
    return fs.existsSync(file) ? file : '';
  } catch {
    return ''; // 截屏失败不算断言失败：它只是给人看的旁证
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');
  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    x: 40,
    y: 60,
    // 要出真实截图，必须真显示（隐藏窗口合成器不产新帧，见 check-genshin.cjs）
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 25 },
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

  /**
   * 每次采集：页面侧 CSS + 主进程侧实收参数，成对记下来，最后统一查对比度。
   * `negative` = 故意造出来的「改前」对照样本，不计入最后的兜底闸门
   * （那一条要挡的是**真实配置**撞色，别被自己的对照组误伤）。
   */
  const samples = [];
  function sample(tag, css, got, negative = false) {
    const barHex = hexOf(css.barBg);
    const symHex = String((got || {}).symbolColor || '').toLowerCase();
    const ratio = contrast(symHex, barHex);
    samples.push({ tag, barHex, symHex, ratio, negative });
    return { barHex, symHex, ratio };
  }

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }',
  );
  await sleep(1500);
  win.focus();
  await sleep(200);

  /* ================= 1. 浅色（默认） ================= */
  const first = await waitNext(0);
  ok(!!first, '渲染层已回传标题栏配色', JSON.stringify(last()));
  const css1 = await readCss(win);
  ok(
    css1.symbolVar.toLowerCase() === css1.textPrimary.toLowerCase(),
    '浅色下 --titlebar-symbol 默认 = --text-primary（其余主题行为不变）',
    `symbol=${css1.symbolVar} text=${css1.textPrimary}`,
  );
  const s1 = sample('light', css1, first);
  ok(
    s1.symHex === first.symbolColor.toLowerCase() && HEX.test(s1.symHex),
    '传入主进程的 symbolColor 是合法 #rrggbb（不是字面量 var(...)）',
    `symbolColor=${first.symbolColor}`,
  );
  ok(s1.ratio >= 4.5, '浅色：符号与标题栏对比度 ≥ 4.5', `${s1.symHex} on ${s1.barHex} = ${r2(s1.ratio)}:1`);

  /* ================= 2. 深色 ================= */
  let n = seen.length;
  ok((await clickSeg(win, '主题模式', '深色')) === 'ok', '能切到深色模式');
  await sleep(400);
  const cssDark = await readCss(win);
  const sDark = sample('dark', cssDark, await waitNext(n));
  ok(
    cssDark.theme === 'dark' && sDark.ratio >= 4.5,
    '深色：符号仍跟随 --text-primary 且对比度 ≥ 4.5',
    `${sDark.symHex} on ${sDark.barHex} = ${r2(sDark.ratio)}:1`,
  );

  /* ================= 3. 每个主题色都要跟着走 ================= */
  /*
   * 这一步是在验「`--titlebar-symbol: var(--text-primary)` 这条**嵌套链**真的会求值」：
   * 各个 [data-accent] 块只覆盖 --text-primary，如果浏览器（或将来某人）把
   * 符号色写成不可解析的表达式，这里就会拿到字面量、对比度算成 0 而 FAIL。
   */
  let accentBad = [];
  for (const id of ['cloud', 'mist', 'cangqiong', 'ocean', 'ink']) {
    n = seen.length;
    const clicked = await clickAccent(win, id);
    if (clicked !== 'ok') {
      accentBad.push(`${id}:no-chip`);
      continue;
    }
    await sleep(350);
    const css = await readCss(win);
    const s = sample(`dark/${id}`, css, await waitNext(n));
    if (!(css.accent === id && HEX.test(s.symHex) && s.ratio >= 4.5 && s.symHex !== s.barHex)) {
      accentBad.push(`${id}:${s.symHex}/${css.barBg}`);
    }
  }
  ok(
    accentBad.length === 0,
    '深色下 5 个主题色的符号色都合法且与标题栏对比度 ≥ 4.5',
    accentBad.length ? accentBad.join(' ') : '5/5',
  );

  /* ================= 4. 原神：本次修复的重点 ================= */
  n = seen.length;
  ok((await clickSeg(win, '主题模式', '原神')) === 'ok', '能切到原神主题');
  await sleep(500);
  const cssG = await readCss(win);
  const gotG = await waitNext(n);
  const sG = sample('genshin', cssG, gotG);
  ok(cssG.theme === 'genshin', 'data-theme=genshin', `theme=${cssG.theme}`);
  ok(
    cssG.symbolVar.toLowerCase() === '#d3bc8e',
    '🔴 原神下 --titlebar-symbol = 淡金 #d3bc8e（嵌套 var(--g-gold) 真的求值了，不是字面量）',
    `symbolVar=${cssG.symbolVar}`,
  );
  const gotGhex = String(gotG.symbolColor || '').toLowerCase();
  ok(
    HEX.test(gotGhex) && gotGhex === '#d3bc8e',
    '🔴 主进程实际收到 symbolColor=#d3bc8e（CSS 改了、App.tsx 没读 → 这条就会红）',
    `received=${gotG.symbolColor}`,
  );
  ok(
    sG.barHex === '#454c5c',
    '原神标题栏底色 = 深靛蓝 #454c5c',
    `titlebar=${sG.barHex} (${cssG.barBg})`,
  );
  ok(
    gotGhex !== cssG.textPrimary.toLowerCase(),
    '🔴 符号色不再等于 --text-primary（原神下那正是隐形的原因）',
    `symbol=${gotGhex} textPrimary=${cssG.textPrimary}`,
  );
  ok(
    sG.ratio >= 3,
    '🔴 原神：符号与标题栏对比度 ≥ 3:1（可辨识下限）',
    `${sG.symHex} on ${sG.barHex} = ${r2(sG.ratio)}:1`,
  );
  /*
   * 静态记账：把「改前为什么看不见」写进断言里。
   * 这两条不依赖运行环境，是纯算式 —— 万一以后有人把 --text-primary 调回深色，
   * 它会立刻提醒：原神标题栏和它撞上了。
   */
  ok(
    contrast('#403d37', '#454c5c') < 1.5,
    '改前（--text-primary #403d37）在原神标题栏上对比度 < 1.5 —— 确实不可见',
    `${r2(contrast('#403d37', '#454c5c'))}:1`,
  );
  const afterFile = captureWindow(win, 'genshin-titlebar-symbol-after.png');
  ok(!!afterFile, '截到「改后」的窗口（含系统画的按钮）', afterFile ? path.basename(afterFile) : '截屏失败');

  /* ================= 5. 复现「改前」：把符号色按老写法压回深墨 ================= */
  /*
   * 注入一条同优先级、但更靠后的规则盖掉 --titlebar-symbol，
   * 再切走切回触发 effect（effect 依赖 [theme, accent, scrimActive]，
   * 只改 DOM 属性是不会重跑的 —— 这也是本脚本必须走 UI 点的原因）。
   */
  const injectKey = await win.webContents.insertCSS(
    `:root[data-theme='genshin'] { --titlebar-symbol: #403d37 !important; }`,
  );
  await clickSeg(win, '主题模式', '深色');
  await sleep(300);
  n = seen.length;
  await clickSeg(win, '主题模式', '原神');
  await sleep(500);
  const cssB = await readCss(win);
  const gotB = await waitNext(n);
  const sB = sample('genshin/old', cssB, gotB, true);
  ok(
    String(gotB.symbolColor || '').toLowerCase() === '#403d37' && sB.ratio < 1.5,
    '能复现改前状态（符号=深墨 #403d37，对比度 < 1.5）',
    `${sB.symHex} on ${sB.barHex} = ${r2(sB.ratio)}:1`,
  );
  const beforeFile = captureWindow(win, 'genshin-titlebar-symbol-before.png');
  ok(!!beforeFile, '截到「改前」的窗口（与改后同机位，可直接对比）', beforeFile ? path.basename(beforeFile) : '截屏失败');

  /* 撤掉注入，回到真状态 */
  await win.webContents.removeInsertedCSS(injectKey);
  await clickSeg(win, '主题模式', '深色');
  await sleep(300);
  n = seen.length;
  await clickSeg(win, '主题模式', '原神');
  await sleep(500);
  const restored = await waitNext(n);
  ok(
    String(restored.symbolColor || '').toLowerCase() === '#d3bc8e',
    '撤掉注入后回到淡金（不是被永久改坏）',
    `symbolColor=${restored.symbolColor}`,
  );

  /* ================= 6. 遮罩压暗时符号色仍走同一个基准 ================= */
  n = seen.length;
  await win.webContents.executeJavaScript(`
    (() => {
      const d = document.createElement('div');
      d.className = 'install-mask';
      d.id = '__probe_symbol';
      document.body.appendChild(d);
      return true;
    })()
  `);
  const dimmed = await waitNext(n);
  ok(
    HEX.test(String(dimmed.symbolColor || '').toLowerCase()) &&
      String(dimmed.symbolColor).toLowerCase() !== '#d3bc8e',
    '弹窗遮罩下符号色也跟着压暗（没有绕开 dimOver）',
    `symbolColor=${dimmed.symbolColor}`,
  );
  await win.webContents.executeJavaScript(`document.getElementById('__probe_symbol')?.remove()`);

  /* ================= 7. 全组合兜底：任何主题/主题色都不能撞色 ================= */
  const real = samples.filter((s) => !s.negative);
  const bad = real.filter((s) => !(HEX.test(s.symHex) && s.ratio >= 3));
  ok(
    bad.length === 0,
    '🔴 所有采集到的组合，符号色合法且与标题栏对比度 ≥ 3:1（新主题的兜底闸门）',
    bad.length ? bad.map((s) => `${s.tag}:${r2(s.ratio)}`).join(' ') : `${real.length} 组全过`,
  );

  /* ================= 7. 收尾：切回浅色，别把用户设置留在原神 ================= */
  ok((await clickSeg(win, '主题模式', '浅色')) === 'ok', '能切回浅色模式');
  await sleep(400);
  n = seen.length;
  await clickAccent(win, 'cangqiong');
  await sleep(350);
  const cssBack = await readCss(win);
  const backLight = await waitNext(n);
  const sBack = sample('back/light', cssBack, backLight);
  ok(
    cssBack.theme === 'light' &&
      cssBack.symbolVar.toLowerCase() === cssBack.textPrimary.toLowerCase() &&
      HEX.test(sBack.symHex) &&
      sBack.ratio >= 4.5,
    '收尾：切回浅色后符号色跟着回到深墨（不是被原神永久改坏）',
    `theme=${cssBack.theme} symbol=${sBack.symHex} on ${sBack.barHex} = ${r2(sBack.ratio)}:1`,
  );

  log('=== TITLEBAR SYMBOL CHECK ===');
  log(`回传记录 ${seen.length} 次；采集组合 ${samples.length} 组`);
  for (const r of rows) log(r);
  log('--- 采集明细（符号色 / 标题栏底 / 对比度）---');
  for (const s of samples) log(`  ${s.tag.padEnd(16)} ${s.symHex} on ${s.barHex}  ${r2(s.ratio)}:1`);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('TITLEBAR SYMBOL CHECK DONE');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
