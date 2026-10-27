/**
 * 主题扩展校验（v1.1.14）：淡粉 / 樱花、自定义色盘、玻璃主题色底图。
 *
 * 为什么不能只「点了按钮看到 data-accent 变了」就算过 —— 这次几个改动的坑都在别处：
 *
 *  1) 新增主题色**必须浅深各写一条**（global.css 的文件头写了原因：:root 是伪类，
 *     优先级高于单独的 [data-theme='dark']，只写浅色的话深色模式下会串成浅色）。
 *     所以每条都要在 light / dark 两种模式下各读一次 --accent 与 --bg-sidebar。
 *
 *  2) 自定义色的整组变量是**内联**的（不是 CSS 块）。两个最容易翻车的地方：
 *     · 切回内置主题色时没清干净 → 侧栏还是粉的、按钮已经蓝了（所以断言内联值被移除）；
 *     · 浅色那套派生值在切到深色后没有重算 → 深底上压一个发暗的色（所以切深色后再读一次）。
 *
 *  3) 派生底色的**饱和度**（最容易被忽略的一条）：只看「底色变了」不够 ——
 *     第一版把侧栏饱和度压到 22% 封顶，挑一支很艳的色算出来几乎还是灰的，
 *     观感上等于「没生效」，而「变了」这条断言照样 PASS。所以按通道极差判。
 *
 *  4) 玻璃主题的「壁纸 / 主题色」互斥是需求硬要求，必须验到**作用**上：
 *     · 主题色模式下 .glass-backdrop 上要挂着 glass-tint、背景是 CSS 渐变（不是图）；
 *     · 切回壁纸模式要真的退出主题色底图（class 掉掉）；
 *     · 色系切换要真的换掉 --accent 与渐变（不是只改个属性）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-theme-ext.cjs \
 *     --watch ui-shots/_theme-ext.log --until "THEME EXT CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_theme-ext.log');
function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点某个 .field 里的某个分段选项 */
function clickSeg(win, fieldText, optionText) {
  return win.webContents.executeJavaScript(`
    (() => {
      const field = [...document.querySelectorAll('.field')]
        .find((f) => f.textContent.includes(${JSON.stringify(fieldText)}));
      if (!field) return 'no-field';
      const btn = [...field.querySelectorAll('.segmented-item')]
        .find((b) => b.textContent.trim() === ${JSON.stringify(optionText)});
      if (!btn) return 'no-option';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'ok';
    })()
  `);
}

/** 点一枚主题色 / 色系色块 */
function clickChip(win, attr, id) {
  return win.webContents.executeJavaScript(`
    (() => {
      const b = document.querySelector('[${attr}="${id}"]');
      if (!b) return 'no-chip';
      if (b.disabled) return 'disabled';
      b.click();
      return 'ok';
    })()
  `);
}

/**
 * 改原生 <input type="color"> 的值并触发 input。
 *
 * 🔴 不能直接 `input.value = '#ff00aa'`：React 在 input 上挂了自己的 value tracker，
 *    直接赋值不会触发 onChange（这是 React 的老行为，不是 bug）。
 *    标准绕法是拿 prototype 上的原生 setter 写值，再手动派发 input。
 */
function setColorInput(win, hex) {
  return win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.custom-accent-input');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(hex)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()
  `);
}

/** 读一次当前外观的关键形态 */
function readSnap(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const V = (n) => cs.getPropertyValue(n).trim();
      const toRgb = (s) => {
        const str = String(s || '').trim();
        let m = /^#([0-9a-f]{6})$/i.exec(str);
        if (m) { const n = parseInt(m[1], 16); return [(n>>16)&255, (n>>8)&255, n&255]; }
        m = /^rgba?\\(([^)]+)\\)/i.exec(str);
        if (m) { const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2]]; }
        m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/i.exec(str);
        if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255];
        return null;
      };
      const lum = (s) => { const c = toRgb(s); return c ? (Math.max(c[0],c[1],c[2]) + Math.min(c[0],c[1],c[2])) / 2 / 255 : null; };
      const bd = document.querySelector('.glass-backdrop');
      const field = (t) => [...document.querySelectorAll('.field')].find((f) => f.textContent.includes(t));
      return {
        theme: root.getAttribute('data-theme'),
        accentAttr: root.getAttribute('data-accent'),
        tintAttr: root.getAttribute('data-glass-tint'),
        accentVar: V('--accent'),
        sidebarVar: V('--bg-sidebar'),
        appBgVar: V('--bg-app'),
        /* 侧栏元素的**算完**的背景色：内联变量把它盖掉时，这里才是真相 */
        sidebarBg: (() => {
          const el = document.querySelector('.sidebar');
          return el ? getComputedStyle(el).backgroundColor : null;
        })(),
        accentLum: lum(V('--accent')),
        appBgLum: lum(V('--bg-app')),
        inlineAccent: root.style.getPropertyValue('--accent'),
        inlineSidebar: root.style.getPropertyValue('--bg-sidebar'),
        hasBackdrop: !!bd,
        backdropClass: bd ? bd.className : null,
        backdropBg: bd ? getComputedStyle(bd).backgroundImage : null,
        tintChips: [...document.querySelectorAll('[data-glass-tint-id]')].map((b) => ({
          id: b.getAttribute('data-glass-tint-id'),
          disabled: b.disabled,
        })),
        accentChips: [...document.querySelectorAll('[data-accent-id]')].map((b) => b.getAttribute('data-accent-id')),
        hasCustomPanel: !!document.querySelector('.custom-accent'),
        hasColorInput: !!document.querySelector('.custom-accent-input'),
        modeSeg: (() => { const f = field('主题模式'); return f ? [...f.querySelectorAll('.segmented-item')].map((b) => b.textContent.trim()) : []; })(),
        backdropSegActive: (() => { const f = field('底图模式'); return f ? (f.querySelector('.segmented-item.active') || {}).textContent : null; })(),
        notes: [...document.querySelectorAll('.accent-note')].map((n) => n.textContent.trim()),
        /* 原神那句说明不是 .accent-note（它是 .accent-field 里的 .text-dim） */
        fixedNote: (() => {
          const f = document.querySelector('.accent-field');
          const d = f ? f.querySelector('.text-dim') : null;
          return d ? d.textContent.trim() : '';
        })(),
      };
    })()
  `);
}

async function shot(win, name, waitMs = 500) {
  await sleep(waitMs);
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    return true;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  const { saveSettings } = require('../dist-electron/electron/services/settings.js');
  registerIpc();

  saveSettings({ theme: 'light', accent: 'cangqiong' });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
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
  const near = (a, b, tol = 6) => a !== null && b !== null && Math.abs(a - b) <= tol;

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });
  /* 关掉过渡：读到的必须是终态，不是过渡中间态 */
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }',
  );
  await sleep(1800);

  /* ================= 0. 主题色清单 ================= */
  const t0 = await readSnap(win);
  ok(
    JSON.stringify(t0.accentChips) ===
      JSON.stringify(['cloud', 'mist', 'cangqiong', 'ocean', 'ink', 'blush', 'sakura', 'custom']),
    '主题色清单新增淡粉 / 樱花 / 自定义',
    JSON.stringify(t0.accentChips),
  );

  /* ================= 1. 淡粉 / 樱花（浅 + 深） ================= */
  const rBlush = await clickChip(win, 'data-accent-id', 'blush');
  await sleep(260);
  const b1 = await readSnap(win);
  ok(rBlush === 'ok' && b1.accentAttr === 'blush', '切到「淡粉」', `ret=${rBlush} attr=${b1.accentAttr}`);
  ok(b1.accentVar.toLowerCase() === '#d4718f', '淡粉 · 浅色主色 = #d4718f', b1.accentVar);
  ok(b1.sidebarVar.toLowerCase() === '#f7dde6', '淡粉 · 浅色侧栏 = #f7dde6', b1.sidebarVar);

  await clickSeg(win, '主题模式', '深色');
  await sleep(320);
  const b2 = await readSnap(win);
  ok(b2.theme === 'dark' && b2.accentAttr === 'blush', '淡粉保持选中并切到深色', `theme=${b2.theme}`);
  ok(
    b2.accentVar.toLowerCase() === '#ef9ab4',
    '🔴 淡粉 · 深色主色 = #ef9ab4（深色那条变量块真的存在）',
    b2.accentVar,
  );
  ok(b2.sidebarVar.toLowerCase() === '#150f14', '淡粉 · 深色侧栏 = #150f14', b2.sidebarVar);
  ok(b2.appBgLum !== null && b2.appBgLum < 0.2, '淡粉深色底确实是深色', `lum=${b2.appBgLum?.toFixed(3)}`);

  await clickSeg(win, '主题模式', '浅色');
  await sleep(260);
  const rSakura = await clickChip(win, 'data-accent-id', 'sakura');
  await sleep(260);
  const s1 = await readSnap(win);
  ok(rSakura === 'ok' && s1.accentAttr === 'sakura', '切到「樱花」', `attr=${s1.accentAttr}`);
  ok(s1.accentVar.toLowerCase() === '#e2637f', '樱花 · 浅色主色 = #e2637f', s1.accentVar);
  ok(s1.sidebarVar.toLowerCase() === '#f9d6dc', '樱花 · 浅色侧栏 = #f9d6dc', s1.sidebarVar);
  await shot(win, 'theme-ext-sakura.png');

  /* ================= 2. 自定义色盘 ================= */
  const rCustom = await clickChip(win, 'data-accent-id', 'custom');
  await sleep(360);
  const c1 = await readSnap(win);
  ok(rCustom === 'ok' && c1.accentAttr === 'custom', '点「自定义」进入自定义主题色', `attr=${c1.accentAttr}`);
  ok(c1.hasColorInput, '出现色盘（原生 input[type=color]）', `input=${c1.hasColorInput}`);
  ok(c1.hasCustomPanel, '出现色盘面板', `panel=${c1.hasCustomPanel}`);
  ok(!!c1.inlineAccent, '🔴 自定义色以内联变量写在 <html> 上', `--accent=${c1.inlineAccent}`);

  const rSet = await setColorInput(win, '#ff00aa');
  await sleep(900);
  const c2 = await readSnap(win);
  ok(rSet === 'ok', '能写入色盘的值', `ret=${rSet}`);
  ok(!!c2.inlineAccent, '色值变化后内联变量仍在', `--accent=${c2.inlineAccent}`);
  /* #ff00aa 派生的主色应当仍是「品红方向」：R 高、G 低、B 中高 */
  const rgb2 = /^#([0-9a-f]{6})$/i.exec(c2.inlineAccent || '');
  const ch = rgb2 ? [(parseInt(rgb2[1], 16) >> 16) & 255, (parseInt(rgb2[1], 16) >> 8) & 255, parseInt(rgb2[1], 16) & 255] : null;
  ok(
    !!ch && ch[0] > 180 && ch[1] < 110 && ch[2] > 110,
    '🔴 派生主色保留了用户挑的色相（品红：R 高 G 低 B 中高）',
    `rgb=${JSON.stringify(ch)}  hex=${c2.inlineAccent}`,
  );
  ok(
    !!c2.inlineSidebar && c2.sidebarVar !== c1.sidebarVar,
    '侧栏底色跟着自定义色变了',
    `${c1.sidebarVar} → ${c2.sidebarVar}`,
  );
  /*
   * 🔴 只看「变了」是不够的：第一版把底色饱和度压到 22% 封顶，
   *    挑一个很艳的品红，侧栏算出来几乎是灰的（#e6d8e1）—— 观感上等于「没生效」，
   *    而「变了」这条断言照样 PASS。所以这里按**通道极差**判有没有真的染色：
   *    内置那几套的侧栏极差是 45~62/255（拿 global.css 里的值算的），
   *    这条用 ≥ 24/255 兜住「明显偏灰」的情况。
   */
  const spread = (hex) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return Math.max(...c) - Math.min(...c);
  };
  ok(
    (spread(c2.inlineSidebar) ?? 0) >= 24,
    '🔴 侧栏是**真的**染上了色（通道极差 ≥ 24/255，不是灰的）',
    `${c2.inlineSidebar} spread=${spread(c2.inlineSidebar)}`,
  );

  /* 切深色：同一支色必须重算成深色那套（亮一点、底变深） */
  await clickSeg(win, '主题模式', '深色');
  await sleep(340);
  const c3 = await readSnap(win);
  ok(
    c3.accentLum !== null && c2.accentLum !== null && c3.accentLum > c2.accentLum + 0.04,
    '🔴 切深色后自定义主色被抬亮（没有沿用浅色那套派生值）',
    `${c2.accentLum?.toFixed(3)} → ${c3.accentLum?.toFixed(3)}`,
  );
  ok(
    c3.appBgLum !== null && c3.appBgLum < 0.25,
    '🔴 切深色后自定义底色也换成深色（不是白底）',
    `lum=${c3.appBgLum?.toFixed(3)}`,
  );

  /* 切回内置主题色：内联覆盖必须被清干净 */
  await clickSeg(win, '主题模式', '浅色');
  await sleep(240);
  await clickChip(win, 'data-accent-id', 'cangqiong');
  await sleep(320);
  const c4 = await readSnap(win);
  ok(c4.accentAttr === 'cangqiong', '切回「苍穹」', `attr=${c4.accentAttr}`);
  ok(
    !c4.inlineAccent && !c4.inlineSidebar,
    '🔴 切回内置主题色后内联覆盖被清掉（否则侧栏还是自定义色）',
    `accent="${c4.inlineAccent}" sidebar="${c4.inlineSidebar}"`,
  );
  ok(c4.accentVar.toLowerCase() === '#3b6ae1', '苍穹主色回到 #3b6ae1', c4.accentVar);

  /* ================= 3. 玻璃主题 · 底图互斥 + 色系 ================= */
  /*
   * 🔴 先回到「浅色 + 自定义色」，把内联变量挂上再进玻璃主题。
   *
   * 只从苍穹切玻璃是验不出东西的 —— 内联本来就是空的。而这个 bug 的形态是：
   * 用户挑过自定义色之后切到固定配色的主题（原神 / 玻璃），
   * **自定义色的内联变量仍然盖着侧栏与底色**，于是画面变成
   * 「卡片已经是深靛蓝 / 半透明玻璃，左侧栏还是自定义色那块不透明实色」。
   * 2026-10-22 用户截图报的正是这个（原神主题 + 淡绿侧栏 = 自定义色那套）。
   */
  await clickChip(win, 'data-accent-id', 'custom');
  await sleep(320);
  await setColorInput(win, '#5b8c5a');
  await sleep(700);
  const cx = await readSnap(win);
  ok(
    cx.accentAttr === 'custom' && !!cx.inlineSidebar,
    '进玻璃前先恢复「自定义色」（内联已挂上）',
    `attr=${cx.accentAttr} inline=${cx.inlineSidebar}`,
  );

  const rGlass = await clickSeg(win, '主题模式', '透明玻璃');
  await sleep(1200);
  const g1 = await readSnap(win);
  ok(g1.theme === 'glass', '切到「透明玻璃」', `theme=${g1.theme}`);
  ok(
    !g1.inlineAccent && !g1.inlineSidebar,
    '🔴 切到「玻璃」后自定义内联被清掉（否则侧栏是一块实色板、壁纸透不进来）',
    `accent="${g1.inlineAccent}" sidebar="${g1.inlineSidebar}"`,
  );
  ok(
    /^rgba?\(/.test(g1.sidebarBg || '') && !/^rgb\(243, 245, 249\)$/.test(g1.sidebarBg || ''),
    '🔴 玻璃侧栏是半透明的那一档（不是自定义色的实色）',
    `sidebarBg=${g1.sidebarBg}`,
  );
  ok(
    g1.backdropSegActive === '桌面壁纸',
    '玻璃默认底图模式 = 桌面壁纸',
    `active=${g1.backdropSegActive}`,
  );
  ok(
    g1.tintChips.length === 4 && g1.tintChips.every((c) => c.disabled),
    '🔴 壁纸模式下四个色系色块**不可选**（互斥）',
    JSON.stringify(g1.tintChips),
  );
  ok(
    (g1.notes || []).some((n) => n.includes('桌面壁纸')),
    '壁纸模式给出说明文案',
    (g1.notes || [])[0]?.slice(0, 40),
  );

  const rTintMode = await clickSeg(win, '底图模式', '主题色');
  await sleep(700);
  const g2 = await readSnap(win);
  ok(rTintMode === 'ok' && g2.backdropSegActive === '主题色', '切到「主题色」底图模式', `ret=${rTintMode} active=${g2.backdropSegActive}`);
  ok(g2.tintChips.every((c) => !c.disabled), '主题色模式下四个色系可选', JSON.stringify(g2.tintChips));
  ok(!!g2.backdropClass && g2.backdropClass.includes('glass-tint'), '🔴 底图元素挂上 glass-tint（改用 CSS 渐变）', `class=${g2.backdropClass}`);
  ok(
    /radial-gradient/.test(g2.backdropBg || ''),
    '🔴 主题色底图是生成的渐变（不是图片）',
    String(g2.backdropBg).slice(0, 48),
  );
  /* 原先断言「主题色模式明确提示壁纸已停用」；那句提示已按用户要求删掉，
     改成断言它不在，避免以后又被加回来。 */
  ok(
    !(g2.notes || []).some((n) => n.includes('停用')),
    '主题色模式不再堆一句「壁纸已停用」的说明',
    (g2.notes || []).find((n) => n.includes('停用'))?.slice(0, 48) || '(none)',
  );
  const blueBg = g2.backdropBg;
  ok(g2.tintAttr === 'blue', '默认色系 = 淡蓝', `data-glass-tint=${g2.tintAttr}`);
  ok(g2.accentVar.toLowerCase() === '#4a7fd4', '淡蓝主色 = #4a7fd4', g2.accentVar);
  await shot(win, 'theme-ext-glass-blue.png');

  const rPinkTint = await clickChip(win, 'data-glass-tint-id', 'pink');
  await sleep(520);
  const g3 = await readSnap(win);
  ok(rPinkTint === 'ok' && g3.tintAttr === 'pink', '切到「淡粉」色系', `tint=${g3.tintAttr}`);
  ok(g3.accentVar.toLowerCase() === '#ce6a90', '淡粉色系主色同步换成 #ce6a90', g3.accentVar);
  ok(g3.backdropBg !== blueBg, '🔴 底图渐变真的换了一套（不是只改属性）', String(g3.backdropBg).slice(0, 40));
  await shot(win, 'theme-ext-glass-pink.png');

  /* 切回壁纸模式：主题色底图必须真正退出 */
  const rBack = await clickSeg(win, '底图模式', '桌面壁纸');
  await sleep(1200);
  const g4 = await readSnap(win);
  ok(rBack === 'ok' && g4.backdropSegActive === '桌面壁纸', '切回「桌面壁纸」模式', `active=${g4.backdropSegActive}`);
  ok(
    !g4.backdropClass || !g4.backdropClass.includes('glass-tint'),
    '🔴 主题色底图已退出（glass-tint 摘掉）',
    `class=${g4.backdropClass}`,
  );
  ok(g4.tintChips.every((c) => c.disabled), '色系色块重新变为不可选', JSON.stringify(g4.tintChips.map((c) => c.disabled)));
  ok(g4.tintAttr === 'pink', '色系选择被记住（切回来还是淡粉）', `data-glass-tint=${g4.tintAttr}`);

  /* ================= 4. 原神主题不参与主题色（回归） ================= */
  /*
   * 从玻璃切回浅色：自定义色应当**自动恢复**（色值一直在 store 里，只是被摘下来了），
   * 然后切原神再验一次「摘掉」。这是 2026-10-22 那个 bug 的正向回归：
   * 修复前切原神后 .sidebar 的算完背景仍是自定义色派生的 #d8e6d8（淡绿）。
   */
  await clickSeg(win, '主题模式', '浅色');
  await sleep(500);
  const n0 = await readSnap(win);
  ok(!!n0.inlineSidebar, '🔴 从玻璃切回浅色后自定义色自动恢复（色值没丢）', `inline=${n0.inlineSidebar}`);

  const rGenshin = await clickSeg(win, '主题模式', '原神');
  await sleep(700);
  const n1 = await readSnap(win);
  ok(rGenshin === 'ok' && n1.theme === 'genshin', '切到「原神」', `theme=${n1.theme}`);
  ok(
    !n1.inlineAccent && !n1.inlineSidebar,
    '🔴 切到「原神」后自定义内联被清掉（否则左侧栏还是自定义色）',
    `accent="${n1.inlineAccent}" sidebar="${n1.inlineSidebar}"`,
  );
  ok(
    (n1.sidebarBg || '').replace(/\s/g, '') === 'rgb(79,81,93)',
    '🔴 原神侧栏是深靛蓝 #4f515d（不是自定义色那套）',
    `sidebarBg=${n1.sidebarBg}`,
  );
  /* 原神那句「配色固定」说明已按用户要求去掉（整块不渲染），断言反过来钉住 */
  ok(
    !n1.fixedNote.includes('固定配色'),
    '原神不再显示「配色固定」说明',
    n1.fixedNote.slice(0, 30) || '(none)',
  );

  /* ================= 收尾 ================= */
  if (rendererErrors.length) {
    log('[renderer] 有 console 报错：');
    for (const e of rendererErrors) log('   -', e);
  }
  const failed = rows.filter((r) => r.startsWith('FAIL')).length;
  log('');
  for (const r of rows) log(r);
  log('');
  log(`rendererErrors = ${rendererErrors.length}`);
  log(`THEME EXT CHECK DONE  ${rows.length - failed}/${rows.length} 通过`);

  app.exit(failed > 0 ? 1 : 0);
});
