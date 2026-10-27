/**
 * 「明日方舟」主题校验（v1.1.17）。
 *
 * 只断言「点了按钮 data-theme 变了」是不够的 —— 这套东西的坑都在别处：
 *   - 主题变量块与 global.css 的 [data-accent] 是**同级选择器**（都是 0,2,0），
 *     靠加载顺序分胜负。顺序被改动过（比如有人把 import 提到 global.css 前面），
 *     界面会**静默**退化成「主题色生效、明日方舟不生效」，看着像没事；
 *   - 「配色固定」是需求硬要求，必须验证真的压得住 [data-accent] ——
 *     不是靠设置页藏个入口就算数（别处照样能改 data-accent）；
 *   - 「和浅色/深色同一级、且没有深色变体」也要钉住：
 *     它是 data-theme 的又一个取值，不存在独立的皮肤属性，也不能与 dark 叠加；
 *   - 卡片角标是 background-image 拼的，很容易被别的规则覆盖掉；
 *   - 侧栏品牌行：logo 要随主题换成配套那枚（**同形换色的真实像素**，
 *     不是「文件存在」就算数），名字要从「继承下来的近黑色」变成标志蓝；
 *   - 🔴 五个主题来回切一圈不能互相污染（这是「切换不出问题」那条需求的实测）：
 *     每切一次都读一遍底色，任何一次残留都会在矩阵里暴露；
 *   - 主题状态要写回主进程，下次启动才能保持。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-arknights.cjs \
 *     --watch ui-shots/_arknights.log --until "ARKNIGHTS CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_arknights.log');
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

/** 切页：HashRouter，改 hash 就够 */
const goto = (win, hash) =>
  win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + hash)}`);

/**
 * 把「注入鼠标」挪到标题栏那条带子上（没有任何内容），让 :hover 状态变成确定的。
 * 理由同 check-genshin.cjs：卡片头是整块可点区域，光标停在上面会让
 * .card-title 变成 --accent，断言就会随用户光标位置随机 FAIL。
 */
async function parkMouse(win) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
  await sleep(40);
}

/** 点设置页某个字段里的某个分段选项 */
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

/** 读一次当前外观的关键形态 */
async function readTheme(win) {
  await parkMouse(win);
  return win.webContents.executeJavaScript(`
    (() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const card = document.querySelector('.card');
      const title = document.querySelector('.header-title');
      const themeField = () => [...document.querySelectorAll('.field')]
        .find((x) => x.textContent.includes('主题模式'));
      const cardBgImage = card ? getComputedStyle(card).backgroundImage : '';
      return {
        themeAttr: root.getAttribute('data-theme'),
        accentAttr: root.getAttribute('data-accent'),
        accent: cs.getPropertyValue('--accent').trim(),
        bgApp: cs.getPropertyValue('--bg-app').trim(),
        radiusLg: cs.getPropertyValue('--r-lg').trim(),
        radiusFull: cs.getPropertyValue('--r-full').trim(),
        radiusLgPx: card ? parseFloat(getComputedStyle(card).borderTopLeftRadius) : null,
        accentPicker: document.querySelectorAll('.accent-picker').length,
        themeNote: (document.querySelector('.accent-field .text-dim') || {}).textContent || '',
        cardGradientCount: (cardBgImage.match(/linear-gradient/g) || []).length,
        /* 右上角斜切角标：背景图里必须出现 225deg 那一层（近黑三角） */
        cardCornerCut: /225deg/.test(cardBgImage),
        cardBg: card ? getComputedStyle(card).backgroundColor : '',
        headerTitleColor: title ? getComputedStyle(title).color : '',
        cardTitleColor: (() => {
          const t = document.querySelector('.card-title');
          return t ? getComputedStyle(t).color : '';
        })(),
        sidebarBg: (() => {
          const s = document.querySelector('.sidebar');
          return s ? getComputedStyle(s).backgroundColor : '';
        })(),
        sidebarColor: (() => {
          const s = document.querySelector('.sidebar');
          return s ? getComputedStyle(s).color : '';
        })(),
        titlebarBg: (() => {
          const t = document.querySelector('.titlebar');
          return t ? getComputedStyle(t).backgroundColor : '';
        })(),
        titlebarSymbol: cs.getPropertyValue('--titlebar-symbol').trim(),
        themeModeLabels: (() => {
          const f = themeField();
          return f ? [...f.querySelectorAll('.segmented-item')].map((b) => b.textContent.trim()) : [];
        })(),
        /*
         * 入口收起（v1.1.17）：明日方舟那一项仍在 DOM 里、但 display:none。
         * ⚠️ 这段代码在 executeJavaScript 的模板字符串里面，注释里**不能出现反引号**，
         *    否则模板字符串提前闭合 → 整个脚本 SyntaxError: missing ) after argument list。
         * 必须同时读「它自己的 display」和「可见的有哪几个」——
         * 只看总数的话，把 hidden 写错位置（比如加在别项上）照样是 5 项。
         */
        themeOptionDisplay: (() => {
          const f = themeField();
          const b = f
            ? [...f.querySelectorAll('.segmented-item')].find(
                (x) => x.textContent.trim() === '明日方舟',
              )
            : null;
          return b ? getComputedStyle(b).display : null;
        })(),
        themeVisibleLabels: (() => {
          const f = themeField();
          return f
            ? [...f.querySelectorAll('.segmented-item')]
                .filter((b) => getComputedStyle(b).display !== 'none')
                .map((b) => b.textContent.trim())
            : [];
        })(),
        themeSegActive: (() => {
          const f = themeField();
          const a = f ? f.querySelector('.segmented-item.active') : null;
          if (!a) return null;
          const s = getComputedStyle(a);
          return { text: a.textContent.trim(), bg: s.backgroundColor, color: s.color };
        })(),
        navActiveColor: (() => {
          const n = document.querySelector('.nav-item.active');
          return n ? getComputedStyle(n).color : '';
        })(),
        navIconColor: (() => {
          const n = document.querySelector('.nav-icon');
          return n ? getComputedStyle(n).color : '';
        })(),
        navCountBg: (() => {
          const n = document.querySelector('.nav-count');
          return n ? getComputedStyle(n).backgroundColor : null;
        })(),
        /*
         * 品牌行：logo 只取 src —— 颜色不在渲染层验，改由主进程直接读那张 png 的像素
         * （file:// 下的 canvas 是 tainted 的，getImageData 会抛 SecurityError）。
         */
        brandSrc: (() => {
          const im = document.querySelector('.brand-mark');
          return im ? im.getAttribute('src') || '' : '';
        })(),
        brandTextColor: (() => {
          const t = document.querySelector('.brand-text strong');
          return t ? getComputedStyle(t).color : '';
        })(),
        /*
         * ---- 悬浮化改造（v1.1.17）要读的几项 ----
         * 这一轮改的全是「层次」：底纹层在不在、半透明面板有没有真的采样背景、
         * 外壳是不是透明的。都不能拿变量值糊过去，必须读**计算样式**。
         */
        /* 底纹层：真 DOM 元素，主题切换时必须来去干净（浅色下不能残留） */
        hasBackdrop: document.querySelectorAll('.ark-backdrop').length,
        backdropZ: (() => {
          const b = document.querySelector('.ark-backdrop');
          return b ? getComputedStyle(b).zIndex : null;
        })(),
        /*
         * ---- 每格导航底图（v1.1.17 第二轮）----
         * DOM 里每格都带一个 .nav-ghost（放大版同款图标），
         * 只有明日方舟主题把它 display:block，其余主题靠 CSS 关掉。
         * 三个数字都要读：display（开没开）、72px（真放大了）、
         * 容器高 36px（只露上半截 —— 容器比图标矮才成立）。
         */
        ghostCount: document.querySelectorAll('.nav-ghost').length,
        ghostDisplay: (() => {
          const g = document.querySelector('.nav-ghost');
          return g ? getComputedStyle(g).display : null;
        })(),
        ghost: (() => {
          const g = document.querySelector('.nav-ghost');
          const svg = g ? g.querySelector('svg') : null;
          if (!g || !svg) return null;
          const gs = getComputedStyle(g);
          const ss = getComputedStyle(svg);
          const shape = svg.querySelector('rect, path, circle, line, polyline');
          return {
            opacity: gs.opacity,
            boxH: Math.round(g.getBoundingClientRect().height),
            w: ss.width,
            h: ss.height,
            strokeWidth: shape ? parseFloat(getComputedStyle(shape).strokeWidth) : null,
            right: ss.right,
            z: gs.zIndex,
            mask: (gs.maskImage || gs.webkitMaskImage || '').includes('gradient'),
          };
        })(),
        /*
         * ---- 按钮材质（v1.1.17 第二轮）----
         * 不依赖当前页有没有按钮：临时造一枚读计算样式再拆掉，
         * 测的是「CSS 规则有没有落到 .btn-default / .btn-primary 上」。
         * layers 数 gradient 出现次数 —— 条纹 + 底面渐变应为 2 层。
         */
        probeBtn: (() => {
          const mk = (cls) => {
            const d = document.createElement('div');
            d.className = cls;
            d.style.cssText = 'position:fixed;left:-9999px;top:0;width:100px;height:34px';
            document.body.appendChild(d);
            const cs = getComputedStyle(d);
            const img = cs.backgroundImage;
            const out = {
              bg: cs.backgroundColor,
              hatch: /135deg/.test(img),
              layers: (img.match(/gradient/g) || []).length,
            };
            d.remove();
            return out;
          };
          return { def: mk('btn btn-default'), pri: mk('btn btn-primary') };
        })(),
        shellBg: (() => {
          const s = document.querySelector('.app-shell');
          return s ? getComputedStyle(s).backgroundColor : '';
        })(),
        /*
         * body 的背景色。v1.1.18 起这条必须透明：
         * 不透明的 body 会成为卡片 backdrop-filter 的「紧邻不透明层」，
         * 底纹层（网格 / 光晕 / 明暗场）整个被挡在采样范围之外。
         */
        bodyBg: getComputedStyle(document.body).backgroundColor,
        sidebarBgImage: (() => {
          const s = document.querySelector('.sidebar');
          return s ? getComputedStyle(s).backgroundImage : '';
        })(),
        /* 半透明 + 模糊是否真的落到元素上（不能只看 CSS 文件里写了） */
        sidebarBackdrop: (() => {
          const s = document.querySelector('.sidebar');
          if (!s) return '';
          const cs2 = getComputedStyle(s);
          return cs2.backdropFilter || cs2.webkitBackdropFilter || 'none';
        })(),
        cardBackdrop: (() => {
          const c = document.querySelector('.card');
          if (!c) return '';
          const cs2 = getComputedStyle(c);
          return cs2.backdropFilter || cs2.webkitBackdropFilter || 'none';
        })(),
        /* 卡片描边改由 box-shadow 的 spread 画（border 是透明的） */
        cardBorderColor: card ? getComputedStyle(card).borderTopColor : '',
        cardShadow: card ? getComputedStyle(card).boxShadow : '',
        /* 导航选中块的斜切：clip-path 真生效才算数 */
        navActiveClip: (() => {
          const n = document.querySelector('.nav-item.active');
          return n ? getComputedStyle(n).clipPath : '';
        })(),
      };
    })()
  `);
}

/**
 * 用主进程的 nativeImage 读一张 png 的像素（避开 file:// 下的 canvas 跨域限制）。
 * 采样点用相对比例，与具体尺寸无关（同 check-genshin.cjs 的口径）。
 */
function readLogoPixels(win, src) {
  let file;
  if (/^file:\/\//i.test(src)) {
    file = decodeURIComponent(src.replace(/^file:\/\/\/?/i, '')).replace(/\//g, path.sep);
  } else {
    file = path.join(ROOT, 'dist', src.replace(/^\.?\//, ''));
  }
  if (!fs.existsSync(file)) return { error: `找不到 ${file}` };

  const img = electronMain.nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const buf = img.toBitmap(); // BGRA
  const at = (fx, fy) => {
    const x = Math.round(fx * width);
    const y = Math.round(fy * height);
    const i = (y * width + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i]]; // → RGB
  };
  return {
    size: [width, height],
    rimLeft: at(0.256, 0.5),   // 左侧描边中点
    rimBottom: at(0.5, 0.82),  // 底部描边中点
    inner: at(0.5, 0.75),      // 内屏（字形下方，避开 > 与 _）
  };
}

/**
 * 截图。窗口必须一直显示着（隐藏窗口合成器不产新帧，
 * capturePage 会稳定拿到陈旧画面 —— 见 check-genshin.cjs 那段长注释）。
 */
async function shot(win, name, waitMs = 600) {
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
  registerIpc();

  /*
   * 🔴 建窗**之前**把主题钉回浅色 —— 否则这个脚本会在某些机器上整段假 FAIL。
   *
   * 原因：run-electron.py 给的是一次性的 userData，里面那份 settings.json 会
   * 带着**上一次跑剩下的主题**（实测碰到过启动即 glass，第 1 段「默认是浅色」
   * 直接 FAIL 两条）。而更麻烦的是：一旦以 glass 形态建窗，再切主题会让主进程
   * **按新形态重建窗口**（frame 是建窗参数），本脚本持有的 win 立刻失效，
   * 后面 60 多条断言全废。
   *
   * 所以这里在窗口还不存在的时候把沙箱状态清干净。断言本身要验的是
   * 「从一个已知起点出发，每次切换都干净」，而不是「外部残留是什么」。
   */
  const { saveSettings } = require('../dist-electron/electron/services/settings.js');
  saveSettings({ theme: 'light' });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true, // 要出截图，必须真显示（理由见上）
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

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });

  /* 掐掉过渡：读到的必须是终态（同 check-genshin.cjs） */
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }',
  );
  /* 兜底：卡片头 hover 变主题色会干扰标题色断言，断言期间按住它 */
  await win.webContents.insertCSS(
    '.card-head-toggle:hover .card-title { color: var(--text-primary) !important; }',
  );
  await sleep(1500);

  /* ---- 1. 默认（浅色）---- */
  const a = await readTheme(win);
  ok(a.themeAttr === 'light', '默认主题是浅色', `data-theme=${a.themeAttr}`);
  ok(a.accentPicker === 1, '浅色显示主题色选择器', `picker=${a.accentPicker}`);
  ok(a.accent.toLowerCase() === '#3b6ae1', '浅色的 --accent 来自主题色', `accent=${a.accent}`);
  ok(a.cardGradientCount === 0, '浅色卡片没有角标', `gradients=${a.cardGradientCount}`);
  ok(
    JSON.stringify(a.themeModeLabels) ===
      JSON.stringify(['浅色', '深色', '原神', '明日方舟', '透明玻璃']),
    '🔴 主题模式五项同级并列（明日方舟与浅深色同一级）—— DOM 五项都在，脚本靠点击它切主题',
    JSON.stringify(a.themeModeLabels),
  );
  /*
   * v1.1.17：明日方舟还在打磨，设置页**不露出入口**（THEME_MODES 里 hidden: true）。
   * 是「留在 DOM + display:none」而不是从数组删掉，所以上面那条照样是五项；
   * 这里钉的是「用户看不见」本身，以及「藏的是方舟这一项、不是别的」。
   */
  ok(
    a.themeOptionDisplay === 'none',
    '🔴 明日方舟选项在设置页已收起（display:none，入口不露出）',
    `display=${a.themeOptionDisplay}`,
  );
  ok(
    JSON.stringify(a.themeVisibleLabels) ===
      JSON.stringify(['浅色', '深色', '原神', '透明玻璃']),
    '可见的主题选项只有四项（浅色 / 深色 / 原神 / 透明玻璃）',
    JSON.stringify(a.themeVisibleLabels),
  );
  ok(/app-icon/.test(a.brandSrc), '浅色下品牌 logo 仍是主图标', `src=${a.brandSrc}`);
  ok(a.hasBackdrop === 0, '浅色下没有明日方舟的底纹层（不残留）', `nodes=${a.hasBackdrop}`);
  ok(
    a.ghostCount === 10 && a.ghostDisplay === 'none',
    '浅色下底图节点在 DOM 里、但 CSS 关掉（不残留成灰斑）',
    `count=${a.ghostCount} display=${a.ghostDisplay}`,
  );
  const lightLogo = readLogoPixels(win, a.brandSrc);
  ok(
    !lightLogo.error && lightLogo.rimLeft && lightLogo.rimLeft[2] > lightLogo.rimLeft[0],
    '浅色 logo 描边仍是冷色（B > R）',
    lightLogo.error || JSON.stringify(lightLogo.rimLeft),
  );
  await shot(win, 'ark-check-light-settings.png');

  /* ---- 2. 切到明日方舟 ---- */
  const r1 = await clickSeg(win, '主题模式', '明日方舟');
  ok(r1 === 'ok', '能点中「明日方舟」主题选项', `ret=${r1}`);
  await sleep(500);
  const b = await readTheme(win);
  ok(b.themeAttr === 'arknights', 'data-theme 切成 arknights', `data-theme=${b.themeAttr}`);
  ok(b.accentPicker === 0, '明日方舟不给主题色入口', `picker=${b.accentPicker}`);
  ok(/固定配色/.test(b.themeNote), '给出「配色固定」说明', b.themeNote.trim());
  ok(
    b.accent.toLowerCase() === '#1271b8',
    '白底上的 --accent = 深蓝 #1271b8（写死在主题里）',
    `accent=${b.accent}`,
  );
  ok(b.bgApp.toLowerCase() === '#d9dee7', '内容区底色 = 冷白灰（v1.1.18 压暗一档，给亮面板让出层次）', `bg-app=${b.bgApp}`);
  ok(b.radiusLg === '0px', '全直角：--r-lg = 0', `--r-lg=${b.radiusLg}`);
  ok(b.radiusFull === '0px', '全直角：--r-full 也收成 0（徽标不再是胶囊）', `--r-full=${b.radiusFull}`);
  ok(b.radiusLgPx === 0, '卡片实际圆角 0px', `radius=${b.radiusLgPx}px`);
  ok(b.cardGradientCount === 2, '卡片角标 2 层（右上斜切 + 顶部蓝线）', `gradients=${b.cardGradientCount}`);
  ok(b.cardCornerCut, '🔴 右上角斜切角标在位（225deg 那层）', `bgImage=${b.cardGradientCount}层`);
  ok(
    b.headerTitleColor === 'rgb(18, 113, 184)',
    '顶栏标题 = 深蓝（白底可读，#49aefb 只有 2.3:1）',
    `color=${b.headerTitleColor}`,
  );

  /* ---- 品牌行：配套 logo + 名字点蓝 ---- */
  ok(
    b.brandSrc !== a.brandSrc && /logo-arknights/.test(b.brandSrc),
    '🔴 明日方舟下换成配套 logo（同形换色那枚，不是主图标）',
    `src=${b.brandSrc}`,
  );
  const arkLogo = readLogoPixels(win, b.brandSrc);
  ok(!arkLogo.error, '能读到明日方舟 logo 的像素', arkLogo.error || `${arkLogo.size.join('x')}`);
  /*
   * 🔴 换色的核心断言：采到的是**真实像素**，不是「有没有这个文件」。
   * 描边必须偏蓝（B 明显高于 R）—— 原图那里是蓝/绿渐变，绿端 R 会追上来，
   * 所以这条能同时挡住「忘了换色」和「换了但绿端没换」两种情况。
   * 内屏必须是白（三通道都 > 200 且接近中性），避免换成灰或偏青的白。
   */
  ok(
    arkLogo.rimLeft && arkLogo.rimLeft[2] > arkLogo.rimLeft[0] + 20,
    '🔴 明日方舟 logo 描边 = 蓝（B 明显高于 R）',
    JSON.stringify(arkLogo.rimLeft),
  );
  ok(
    arkLogo.rimBottom && arkLogo.rimBottom[2] > arkLogo.rimBottom[0] + 20,
    '底部描边同样是蓝',
    JSON.stringify(arkLogo.rimBottom),
  );
  ok(
    arkLogo.inner &&
      arkLogo.inner.every((c) => c > 200) &&
      Math.abs(arkLogo.inner[2] - arkLogo.inner[0]) < 16,
    'logo 内屏 = 白（中性白，不是灰/偏青）',
    JSON.stringify(arkLogo.inner),
  );
  ok(
    b.brandTextColor === 'rgb(73, 174, 251)',
    '🔴 品牌名 = 标志蓝 #49aefb（改前是继承来的近黑色）',
    `color=${b.brandTextColor}`,
  );
  ok(
    b.sidebarColor === 'rgb(242, 244, 247)',
    '侧栏自身 color 也被显式声明（颜色继承链兜底）',
    `color=${b.sidebarColor}`,
  );

  /*
   * ---- 黑白切割 + 悬浮化（v1.1.17 改）----
   *
   * 🔴 这一组是「悬浮透明」这条需求的**实测部分**，不能只看 CSS 里写了没有：
   *    · 底纹层必须真的在 DOM 里、且 z-index=-1（否则盖住内容或者看不见）；
   *    · .app-shell 必须透明（否则它的实色底把底纹层整个盖掉 —— 这是最容易
   *      悄悄失效的一条：CSS 里明明有底纹，画面上一点都看不到）；
   *    · 侧栏 / 卡片必须是**半透明**（不是纯色），并且 backdrop-filter 真的落到
   *      元素上（写进 CSS 但被别处覆盖掉，是这套东西的经典失败方式）；
   *    · 卡片模糊半径**必须小**：底纹是网格，blur 一大就糊成均匀色，
   *      悬浮感反过来没了（theme-arknights.css 文件头约束 2）。
   */
  ok(b.hasBackdrop === 1, '🔴 底纹层存在（悬浮感的物理前提）', `nodes=${b.hasBackdrop}`);
  /*
   * 🔴 v1.1.18：z-index 从 -1 提到 0。
   * 负 z-index 的元素**不被 backdrop-filter 采样**（实测：卡片内 sd≈1 纯色，
   * 收窄 blur、加粗网格都无效）。提到 0 之后它成了正常绘制内容，卡片才采得到。
   * 代价是内容要显式抬到上面（见下面 body / app-body 两条断言）。
   */
  ok(b.backdropZ === '0', '底纹层是正常绘制层（负 z-index 不被 backdrop 采样）', `z=${b.backdropZ}`);
  ok(
    /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(b.bodyBg),
    '🔴 body 透明（不透明 body 会把底纹挡在卡片的采样范围之外）',
    `bg=${b.bodyBg}`,
  );
  ok(
    /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(b.shellBg),
    '🔴 .app-shell 透明（实色底会把底纹层整个盖掉）',
    `bg=${b.shellBg}`,
  );
  ok(
    b.sidebarBg === 'rgba(16, 19, 26, 0.86)',
    '侧栏 = 半透明暗玻璃（不是一整条平涂近黑）',
    `bg=${b.sidebarBg}`,
  );
  ok(
    /repeating-linear-gradient/.test(b.sidebarBgImage),
    '侧栏自带网点斜纹（大色块被打散）',
    `bgImage=${b.sidebarBgImage.slice(0, 46)}…`,
  );
  ok(
    /blur\(/.test(b.sidebarBackdrop),
    '🔴 侧栏 backdrop-filter 生效（背后光晕会渗上来）',
    `filter=${b.sidebarBackdrop}`,
  );

  /*
   * ---- 每格导航底图（v1.1.17 第二轮）----
   *
   * 需求原话：「左侧 icon 放大后截取上部分、变灰、透明度低一点，作为每一格的底图」。
   * 五条缺一条都不是那个东西：
   *   ① 每格都有一个（10 个导航项 = 10 个）；
   *   ② 真的放大了（72px vs 前景 17px）；
   *   ③ 容器只有 36px 高 —— 图标比容器高，才谈得上「只露上半截」；
   *   ④ 灰 + 低透明度（≤10%），是底纹不是第二个图标；
   *   ⑤ 线宽被 CSS 压回细线：不压的话 1.8 个 viewBox 单位会放大成 5px 粗线，
   *      和前景 2.25px 的细线叠在一起就是「重影」。
   */
  ok(b.ghostCount === 10, '每格导航都有一个放大图标底图（10 个）', `count=${b.ghostCount}`);
  ok(
    b.ghostDisplay === 'block',
    '🔴 明日方舟主题下底图真的显示（其余主题由 CSS 关掉）',
    `display=${b.ghostDisplay}`,
  );
  ok(
    !!b.ghost && b.ghost.w === '84px' && b.ghost.boxH === 36,
    '底图放大约 5 倍，且只露上半截（84px 图标塞进 36px 格子）',
    b.ghost ? `svg=${b.ghost.w} box=${b.ghost.boxH}px` : 'no ghost',
  );
  ok(
    /*
     * v1.1.18：从 7.5% 提到 38%（小杨反馈「过淡」）。
     * 上界 45% —— 再高它就不是底纹了，会跟前景图标抢注意力。
     */
    !!b.ghost && parseFloat(b.ghost.opacity) >= 0.3 && parseFloat(b.ghost.opacity) <= 0.45,
    '底图透明度 30%~45%（显著可见，但不抢前景）',
    b.ghost ? `opacity=${b.ghost.opacity}` : 'no ghost',
  );
  ok(
    !!b.ghost && b.ghost.strokeWidth !== null && b.ghost.strokeWidth < 1.2,
    '🔴 底图线宽被压回细线（否则和前景图标叠成重影）',
    b.ghost ? `stroke-width=${b.ghost.strokeWidth}` : 'no ghost',
  );
  ok(
    !!b.ghost && b.ghost.mask,
    '底图下半截渐隐（硬裁会在每格中间留一条断口）',
    b.ghost ? `mask=${b.ghost.mask}` : 'no ghost',
  );
  ok(
    !!b.ghost && b.ghost.z === '-1',
    '底图在格内背景之上、图标与文字之下（不掉到侧栏后面）',
    b.ghost ? `z=${b.ghost.z}` : 'no ghost',
  );
  ok(
    b.titlebarBg === 'rgba(14, 16, 20, 0.92)',
    '标题栏比侧栏再深一档且半透明（顶部压暗）',
    `bg=${b.titlebarBg}`,
  );
  ok(
    b.titlebarSymbol === '#49aefb' || b.titlebarSymbol === 'var(--a-blue)',
    '右上角窗口按钮符号色 = 标志蓝（深标题栏上不能沿用 --text-primary）',
    `symbol=${b.titlebarSymbol}`,
  );
  ok(
    b.cardBg === 'rgba(255, 255, 255, 0.62)',
    '🔴 卡片 = 毛玻璃面板（α 按参考图反解定为 0.62）',
    `bg=${b.cardBg}`,
  );
  ok(
    /blur\(/.test(b.cardBackdrop),
    '🔴 卡片 backdrop-filter 生效（透上来的是被柔化的底纹）',
    `filter=${b.cardBackdrop}`,
  );
  /*
   * v1.1.18 起卡片是**毛玻璃**，模糊必须够大（≥12px）才像玻璃；
   * 但也不能无上限：上界 20px —— 再大连 110px 的粗网格宽带都会被抹平，
   * 卡片退化成一块实色板。
   * 🔴 这条是「双向」的：小了不是玻璃，大了不是悬浮。
   */
  const cardBlur = Number((b.cardBackdrop.match(/blur\(([\d.]+)px\)/) || [])[1] || 0);
  ok(
    cardBlur >= 12 && cardBlur <= 20,
    '🔴 卡片模糊 12~20px（毛玻璃区间；小了不是玻璃，大了糊成实色板）',
    `blur=${cardBlur}px`,
  );
  ok(
    /*
     * ⚠️ computed 的 box-shadow 把 inset 写在**最后**（`rgba(...) 0 0 0 1px inset`），
     *    不是 CSS 源码里的 `inset 0 0 0 1px rgba(...)` —— 按源码顺序写正则必假 FAIL。
     */
    /rgba\(255, 255, 255, 0\.5\d*\) 0px 0px 0px 1px inset/.test(b.cardShadow),
    '玻璃边缘有一圈内亮线（只有半透明没有高光 = 塑料片）',
    `shadow=${b.cardShadow.slice(0, 62)}…`,
  );
  ok(
    b.cardBorderColor === 'rgba(0, 0, 0, 0)',
    '描边改由 box-shadow 画（border 透明，不吃可用宽度）',
    `borderTopColor=${b.cardBorderColor}`,
  );
  ok(
    /0px 0px 0px 1px/.test(b.cardShadow) && /inset/.test(b.cardShadow),
    '卡片有硬描边 + 顶部内高光 + 悬浮投影（厚度三件套）',
    `shadow=${b.cardShadow.slice(0, 58)}…`,
  );
  ok(b.cardTitleColor === 'rgb(23, 25, 28)', '卡片标题 = 近黑（浅底压深字）', `color=${b.cardTitleColor}`);

  /* 选中态：实心深蓝 + 白字（不能用 --accent-soft，和容器底太接近） */
  ok(
    b.themeSegActive?.text === '明日方舟' && b.themeSegActive?.bg === 'rgb(18, 113, 184)',
    '主题选择器选中项 = 实心深蓝（≠ 容器底 #f1f3f5）',
    JSON.stringify(b.themeSegActive),
  );
  ok(
    b.themeSegActive?.color === 'rgb(255, 255, 255)',
    '主题选择器选中项文字 = 白（蓝底上压白字）',
    `color=${b.themeSegActive?.color}`,
  );

  /*
   * ---- 按钮的工业风条状纹理（v1.1.17 第二轮）----
   *
   * 查的是**层数**而不是「有没有 gradient」——
   * ui.css 里 .btn-primary:hover / .btn-default:hover 用的是 `background:` 简写，
   * 简写会把 background-image 整层清掉。层数从 2 掉到 1 或 0，就是被谁覆盖了。
   *
   * 材质用斜纹（135deg）而不是横纹：横纹在小按钮上读成「百叶窗」，
   * 斜纹才像工业警示带，而且和侧栏的网点斜纹同族。
   */
  const pb = b.probeBtn;
  ok(
    pb.def.hatch && pb.def.layers === 2,
    '白按钮有工业斜纹（135° 条纹 + 底面渐变，共 2 层）',
    `layers=${pb.def.layers} bg=${pb.def.bg}`,
  );
  ok(
    pb.pri.hatch && pb.pri.layers === 2,
    '🔴 深色按钮有工业斜纹（没被 :hover 的 background 简写清掉）',
    `layers=${pb.pri.layers} bg=${pb.pri.bg}`,
  );
  ok(
    /^rgba\(255, 255, 255/.test(pb.def.bg) && pb.pri.bg === 'rgb(18, 113, 184)',
    '两套按钮底色仍各自正确（白 = 近白半透明，深 = 主题蓝）',
    `def=${pb.def.bg} pri=${pb.pri.bg}`,
  );

  await shot(win, 'ark-check-arknights-settings.png');

  /* ---- 3. 锁色：绕过设置页直接改 data-accent，主题仍要压住 ---- */
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-accent', 'ocean')`,
  );
  await sleep(120);
  const c = await readTheme(win);
  ok(
    c.accent.toLowerCase() === '#1271b8',
    '🔴 主题锁色：外改 data-accent=ocean 也压不动 --accent',
    `accent=${c.accent} (accentAttr=${c.accentAttr})`,
  );
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-accent', ${JSON.stringify(a.accentAttr)})`,
  );

  /* ---- 4. 同一级：改成 dark 时整套样式立刻撤离 ---- */
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', 'dark')`,
  );
  await sleep(120);
  const d = await readTheme(win);
  /*
   * ⚠️ 这一段**故意不查 hasBackdrop**：这里是直接改 DOM 属性绕过 React store，
   *    CSS 会立刻撤（选择器不再匹配），但底纹层是 React 按 store.theme 渲染的
   *    节点 —— DOM 属性变了它不会消失。拿它当断言等于测错了东西。
   *    底纹层真正的来去，由第 7 段的切换矩阵（点按钮、走真流程）覆盖。
   */
  ok(
    d.bgApp.toLowerCase() === '#161b28' && d.cardGradientCount === 0,
    '🔴 改成 data-theme=dark 时明日方舟整套样式立刻撤离（同一个属性，天然互斥）',
    `bg-app=${d.bgApp} gradients=${d.cardGradientCount}`,
  );
  /*
   * 底图这一条**可以**在这里查：.nav-ghost 的节点是常驻的（每个主题都渲染），
   * 显示与否完全由 CSS 的 [data-theme] 选择器决定 —— 改属性它就立刻熄灭。
   * 和上面 hasBackdrop 的情况正好相反。
   */
  ok(
    d.ghostDisplay === 'none',
    '🔴 改属性到 dark 后底图立刻熄灭（同一个属性，不会两边同时亮）',
    `display=${d.ghostDisplay}`,
  );
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', 'arknights')`,
  );
  await sleep(120);

  /* ---- 5. 首页实景：侧栏选中态与图标 ---- */
  await goto(win, '/');
  await sleep(600);
  const e = await readTheme(win);
  ok(
    e.navActiveColor === 'rgb(242, 244, 247)',
    '侧栏选中项 = 白字（近黑底上），外加左侧 2px 蓝条',
    `color=${e.navActiveColor}`,
  );
  ok(e.navIconColor === 'rgb(73, 174, 251)', '侧栏图标 = 标志蓝', `color=${e.navIconColor}`);
  ok(
    /polygon/.test(e.navActiveClip),
    '🔴 导航选中块是斜切块（右上角切一刀，clip-path 真生效）',
    `clip=${e.navActiveClip}`,
  );
  if (e.navCountBg) {
    ok(e.navCountBg === 'rgb(73, 174, 251)', '设备数徽标 = 标志蓝底 + 近黑字', `bg=${e.navCountBg}`);
  }
  await shot(win, 'ark-check-arknights-home.png');

  /* ---- 6. 持久化 ---- */
  const s = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s?.data?.theme === 'arknights', '主题状态已写回主进程设置', `theme=${s?.data?.theme}`);

  /* ---- 7. 🔴 主题来回切一圈，谁都不许残留 ----
   * 这是「切换不出问题」这条需求的实测部分：
   * 每切一次都读底色与角标层数，任何一处残留都会在这里暴露。
   * 顺序刻意打乱（不按界面顺序走）：从固定色主题直接跳到另一个固定色主题、
   * 再跳浅深色 —— 这三条是历史上真出过问题的地方。
   *
   * 🔴🔴 矩阵里**故意不包含「透明玻璃」**：切到玻璃会让主进程按新形态
   * **重建主窗口**（frame / titleBarOverlay 是建窗参数，运行期改不回去，
   * 见 electron/main.ts 的 applyGlassWindow）—— 这个脚本持有的 win 会失效，
   * 后面所有断言全废。玻璃主题由 check:theme-ext 单独覆盖，不在这里掺。
   */
  await goto(win, '/settings');
  await sleep(400);
  const expectBg = {
    浅色: '#f5f8fe',
    深色: '#161b28',
    原神: '#ece5da',
    明日方舟: '#d9dee7',
  };
  /*
   * 各主题的卡片「背景图层数」：
   *   原神 8 段（四角 L 形金线），明日方舟 2 层（右上斜切 + 顶部蓝线），
   *   浅色 / 深色 0 层。这个数字是**主题指纹**：切过去没生效、或者上一个主题
   *   的角饰残留，都会让它对不上。
   */
  const expectGrad = { 浅色: 0, 深色: 0, 原神: 8, 明日方舟: 2 };
  for (const label of ['原神', '明日方舟', '深色', '原神', '明日方舟', '浅色']) {
    const r = await clickSeg(win, '主题模式', label);
    await sleep(420);
    const v = await readTheme(win);
    ok(
      r === 'ok' && v.bgApp.toLowerCase() === expectBg[label],
      `切换矩阵：切到「${label}」底色正确`,
      `ret=${r} theme=${v.themeAttr} bg-app=${v.bgApp} gradients=${v.cardGradientCount}`,
    );
    ok(
      v.cardGradientCount === expectGrad[label],
      `切换矩阵：「${label}」的卡片角饰层数正确（${expectGrad[label]} 层）`,
      `gradients=${v.cardGradientCount}`,
    );
    /*
     * 🔴 底纹层必须**跟着主题来去**：
     *    它挂在 theme === 'arknights' 上（App.tsx），切走就该整个移除。
     *    残留的后果不是「多画一层」——它会一直压在 z-index:-1 上，
     *    把别的主题（尤其是玻璃）的底色关系搅浑，且肉眼很难归因。
     */
    ok(
      v.hasBackdrop === (label === '明日方舟' ? 1 : 0),
      `切换矩阵：「${label}」的底纹层数量正确（方舟 1 / 其余 0）`,
      `backdrop=${v.hasBackdrop}`,
    );
  }

  /* ---- 8. 收尾：留在浅色，确认 logo / 品牌色都跟着撤掉 ---- */
  const g = await readTheme(win);
  ok(g.themeAttr === 'light', 'data-theme 回到 light', `theme=${g.themeAttr}`);
  ok(g.brandSrc === a.brandSrc, 'logo 跟着主题切回来了（不是永久换成明日方舟那枚）', `src=${g.brandSrc}`);
  ok(
    g.brandTextColor !== 'rgb(73, 174, 251)',
    '品牌名的标志蓝也撤掉了',
    `color=${g.brandTextColor}`,
  );
  ok(g.accentPicker === 1, '浅色下主题色选择器回来了', `picker=${g.accentPicker}`);

  log('=== ARKNIGHTS CHECK ===');
  for (const r of rows) log(r);
  log(rendererErrors.length ? `=== 渲染层错误 ===\n${rendererErrors.join('\n')}` : '渲染层无错误');
  log('ARKNIGHTS CHECK DONE');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});
