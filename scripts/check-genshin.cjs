/**
 * 「原神」主题校验（v1.1.11）。
 *
 * 只断言「点了按钮 data-theme 变了」是不够的 —— 这套东西的坑都在别处：
 *   - 主题变量块与 global.css 的 [data-accent] 是**同级选择器**（都是 0,2,0），
 *     靠加载顺序分胜负。顺序被改动过（比如有人把 import 提到 global.css 前面），
 *     界面会**静默**退化成「主题色生效、原神不生效」，看着像没事；
 *   - 「主题色固定」是需求硬要求，必须验证真的压得住 [data-accent] ——
 *     不是靠设置页藏个入口就算数（别处照样能改 data-accent）；
 *   - 「原神和浅色/深色同一级、且没有深色变体」也要钉住：
 *     它是 data-theme 的第三个取值，不存在独立的皮肤属性，也不能与 dark 叠加；
 *   - 角饰是 8 段 background-image 拼的，很容易被别的规则覆盖掉；
 *   - 侧栏品牌行：logo 要随主题换成配套那枚（**同形换色的真实像素**，
 *     不是「文件存在」就算数），名字要从「继承下来的近黑色」变成淡金；
 *   - 主题状态要写回主进程，下次启动才能保持。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-genshin.cjs \
 *     --watch ui-shots/_genshin.log --until "GENSHIN CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_genshin.log');
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
 *
 * 🔴 为什么必须做：这个脚本用的是 show:true 的真实窗口，而**用户的光标停在哪儿是随机的**。
 *    卡片头是整块可点区域，鼠标压在上面时 `.card-title` 会变成 --accent
 *    （ui.css：`.card-head-toggle:hover .card-title`）。曾经因此报「卡片标题 = 白」FAIL ——
 *    实际读到的是原神下的金色 --accent，去查主题变量查了半天，其实是光标正好停在那行标题上。
 *    断言要测的是「深色容器里的正文色」，跟光标无关，所以先把它钉住。
 *    （另有兜底：下面 insertCSS 把这条 hover 规则改成不变量，见 app.whenReady 里。）
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
async function readGenshin(win) {
  await parkMouse(win);
  return win.webContents.executeJavaScript(`
    (() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const card = document.querySelector('.card');
      const title = document.querySelector('.header-title');
      const themeField = () => [...document.querySelectorAll('.field')]
        .find((x) => x.textContent.includes('主题模式'));
      return {
        themeAttr: root.getAttribute('data-theme'),
        skinAttr: root.getAttribute('data-skin'),
        accentAttr: root.getAttribute('data-accent'),
        accent: cs.getPropertyValue('--accent').trim(),
        bgApp: cs.getPropertyValue('--bg-app').trim(),
        radiusLg: cs.getPropertyValue('--r-lg').trim(),
        radiusLgPx: card ? parseFloat(getComputedStyle(card).borderTopLeftRadius) : null,
        accentPicker: document.querySelectorAll('.accent-picker').length,
        themeNote: (document.querySelector('.accent-field .text-dim') || {}).textContent || '',
        cardGradientCount: card ? (getComputedStyle(card).backgroundImage.match(/linear-gradient/g) || []).length : 0,
        headerTitleColor: title ? getComputedStyle(title).color : '',
        /*
         * 「深色容器」实测值 —— 这次复刻的核心：
         * 卡片必须是深靛蓝、卡片里的字必须翻成浅色（否则深底压深字 = 不可读）。
         * 这两个值成对断言，单看任一个都发现不了问题。
         */
        cardBg: card ? getComputedStyle(card).backgroundColor : '',
        cardTitleColor: (() => {
          const t = document.querySelector('.card-title');
          return t ? getComputedStyle(t).color : '';
        })(),
        cardLabelColor: (() => {
          const l = document.querySelector('.card .field-label');
          return l ? getComputedStyle(l).color : '';
        })(),
        cardTextVar: card ? getComputedStyle(card).getPropertyValue('--text-primary').trim() : '',
        sidebarBg: (() => {
          const s = document.querySelector('.sidebar');
          return s ? getComputedStyle(s).backgroundColor : '';
        })(),
        themeModeLabels: (() => {
          const f = themeField();
          return f ? [...f.querySelectorAll('.segmented-item')].map((b) => b.textContent.trim()) : [];
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
        /*
         * 品牌行：logo 与名字。
         *
         * logo 只取 src —— 颜色不在渲染层验，改由主进程直接读那张 png 的像素
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
         * 🔴 侧栏自身的 color（不是变量值）。
         * 颜色是「继承已计算值」的属性：祖先算好的深色会被子孙直接继承下来，
         * 容器里重定义 --text-primary 对它**无效**，除非容器自己声明了 color。
         * 品牌名当时就是这么变成近黑色的，所以这条要单独钉住。
         */
        sidebarColor: (() => {
          const s = document.querySelector('.sidebar');
          return s ? getComputedStyle(s).color : '';
        })(),
      };
    })()
  `);
}

/**
 * 用主进程的 nativeImage 读一张 png 的像素（避开 file:// 下的 canvas 跨域限制）。
 *
 * src 是渲染层给的相对路径（vite base = './'），映射到 dist/ 下。
 * 采样点用**相对比例**而不是绝对像素：plate 在 1024 源图里是 x 231..792 / y 151..879，
 * 换算成比例后与具体尺寸无关（现在是 128，将来换尺寸也不用改）。
 */
function readLogoPixels(win, src) {
  /*
   * img.src 取出来是**解析后的绝对 URL**（file:///D:/...%E6%89%8B...），
   * 不是标签里那个相对路径 —— 得先还原成本地路径。
   * 两种形态都兼容：相对路径（理论上 vite base='./' 时可能拿到）与 file:// URL。
   */
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
    // 左侧描边中点（描边带 x 比例 0.226~0.286）
    rimLeft: at(0.256, 0.5),
    // 底部描边中点（描边带 y 比例 0.79~0.85）
    rimBottom: at(0.5, 0.82),
    // 内屏（字形下方那块，避开 > 与 _）
    inner: at(0.5, 0.75),
  };
}

/**
 * 截图。
 *
 * 🔴 窗口必须**一直显示着**（见下面 show 的注释）：
 * 隐藏窗口的合成器不产新帧，capturePage 会稳定地拿到一张陈旧画面 ——
 * 曾经因此拍到「刚切浅色、画面还是深色」的假象，害得去查一个根本不存在的颜色 bug。
 * 断言不受影响（computed style 是现算的），但截图必须眼见为实。
 *
 * 过渡已经被 insertCSS 掐掉了，所以拍到的必然是终态。
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

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    /*
     * 🔴 必须真显示（show:true），不能只是 showInactive()。
     * 实测：showInactive 下窗口虽然可见，但合成器仍可能返回**陈旧帧** ——
     * 同一控件，showInactive 截出来是深色、show 截出来是浅米色，
     * 差点让我去修一个根本不存在的颜色 bug。
     * 这个脚本要出截图，所以牺牲一点「静默」（窗口会闪一下）。
     */
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏窗口默认节流渲染，过渡帧不推进 → 截图会拍到中间态
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

  /*
   * 🔴 关掉所有过渡再断言。
   *
   * 隐藏窗口里 CSS transition 的帧不一定推进（和 check-sidebar 的 waitWidth 是同一个坑），
   * 于是「刚点完读到的还是过渡起点的值」—— 症状很像「点了没生效」。
   * 这里直接把过渡掐掉，读到的就是终态（主题本来就是瞬时切换，没有过渡需求）。
   */
  await win.webContents.insertCSS(
    '*, *::before, *::after { transition: none !important; animation: none !important; }',
  );
  /*
   * 🔴 兜底：把「卡片头 hover 就变主题色」这条规则钉成不变量。
   *
   * 卡片头（.card-head-toggle）是整块可点区域，鼠标压在上面时
   * `.card-title` 会变成 --accent —— 原神下那正好是淡金，于是
   * 「卡片标题 = 白 #fdfcf8」这条断言会随**用户光标位置**随机 FATL。
   * 它测的是「深色容器里的正文色」，与光标无关，所以在断言期间按住它。
   * 真正的 hover 行为不缺这一条覆盖（那是交互态，不是配色态）。
   */
  await win.webContents.insertCSS(
    '.card-head-toggle:hover .card-title { color: var(--text-primary) !important; }',
  );
  await sleep(1500);

  /* ---- 1. 默认（浅色）---- */
  const a = await readGenshin(win);
  ok(a.themeAttr === 'light', '默认主题是浅色', `data-theme=${a.themeAttr}`);
  ok(a.skinAttr === null, '已无独立的 data-skin 轴（原神并进了 data-theme）', `data-skin=${a.skinAttr}`);
  ok(a.accentPicker === 1, '浅色显示主题色选择器', `picker=${a.accentPicker}`);
  ok(a.accent.toLowerCase() === '#3b6ae1', '浅色的 --accent 来自主题色', `accent=${a.accent}`);
  ok(a.cardGradientCount === 0, '浅色卡片没有角饰', `gradients=${a.cardGradientCount}`);
  /*
   * 🔴 「原神和浅色、深色同一级」——这条就靠分段控件的选项表钉住：
   * 并列在同一行，而不是「主题模式」之外另开一行「外观皮肤」。
   * ⚠️ v1.1.13 起多了「透明玻璃」，名单要跟着加 —— 否则这条会因为脚本自己过期而假 FAIL。
   */
  ok(
    JSON.stringify(a.themeModeLabels) === JSON.stringify(['浅色', '深色', '原神', '透明玻璃']),
    '🔴 主题模式是「浅色 / 深色 / 原神 / 透明玻璃」同级并列',
    JSON.stringify(a.themeModeLabels),
  );
  /* 浅色下必须还是原来那枚冷色图标（主题 logo 不能无差别地全局替换） */
  ok(/app-icon/.test(a.brandSrc), '浅色下品牌 logo 仍是主图标', `src=${a.brandSrc}`);
  const lightLogo = readLogoPixels(win, a.brandSrc);
  ok(
    !lightLogo.error && lightLogo.rimLeft && lightLogo.rimLeft[2] > lightLogo.rimLeft[0],
    '浅色 logo 描边仍是冷色（B > R）',
    lightLogo.error || JSON.stringify(lightLogo.rimLeft),
  );
  await shot(win, 'genshin-check-light-settings.png');

  /* ---- 2. 切到原神 ---- */
  const r1 = await clickSeg(win, '主题模式', '原神');
  ok(r1 === 'ok', '能点中「原神」主题选项', `ret=${r1}`);
  await sleep(500);
  const b = await readGenshin(win);
  ok(b.themeAttr === 'genshin', 'data-theme 切成 genshin', `data-theme=${b.themeAttr}`);
  ok(b.skinAttr === null, '原神下依然没有 data-skin 属性', `data-skin=${b.skinAttr}`);
  ok(b.accentPicker === 0, '原神不给主题色入口', `picker=${b.accentPicker}`);
  ok(/固定配色/.test(b.themeNote), '原神给出「配色固定」说明', b.themeNote.trim());
  ok(
    b.accent.toLowerCase() === '#a8853c',
    '米白底上的 --accent = 金（写死在主题里）',
    `accent=${b.accent}`,
  );
  ok(b.bgApp.toLowerCase() === '#ece5da', '内容区底色 = 米白', `bg-app=${b.bgApp}`);
  ok(b.radiusLg === '6px', '原神圆角收到 6px', `--r-lg=${b.radiusLg}`);
  ok(b.radiusLgPx === 6, '卡片实际圆角也是 6px', `radius=${b.radiusLgPx}px`);
  ok(b.cardGradientCount === 8, '卡片角饰 8 段全在', `gradients=${b.cardGradientCount}`);
  ok(
    b.headerTitleColor === 'rgb(168, 133, 60)',
    '顶栏标题跟进金色',
    `color=${b.headerTitleColor}`,
  );

  /* ---- 品牌行：配套 logo + 名字点金 ---- */
  ok(
    b.brandSrc !== a.brandSrc && /logo-genshin/.test(b.brandSrc),
    '🔴 原神下换成配套 logo（同形换色那枚，不是主图标）',
    `src=${b.brandSrc}`,
  );
  const genLogo = readLogoPixels(win, b.brandSrc);
  ok(!genLogo.error, '能读到原神 logo 的像素', genLogo.error || `${genLogo.size.join('x')}`);
  /*
   * 🔴 换色的核心断言：采到的是**真实像素**，不是「有没有这个文件」。
   * 描边必须偏金（R 明显高于 B）—— 原图标那里是蓝/绿，B 是高于 R 的，
   * 所以这条能同时挡住「忘了换色」和「换了但换错端」两种情况。
   * 内屏必须是暖白：R > B 且 B 仍很高（米白），避免换成了灰或冷白。
   */
  ok(
    genLogo.rimLeft && genLogo.rimLeft[0] > genLogo.rimLeft[2] + 20,
    '🔴 原神 logo 描边 = 金（R 明显高于 B）',
    JSON.stringify(genLogo.rimLeft),
  );
  ok(
    genLogo.rimBottom && genLogo.rimBottom[0] > genLogo.rimBottom[2] + 20,
    '底部描边同样是金',
    JSON.stringify(genLogo.rimBottom),
  );
  ok(
    genLogo.inner && genLogo.inner[0] > genLogo.inner[2] && genLogo.inner[2] > 200,
    'logo 内屏 = 米白（暖白而不是冷白/灰）',
    JSON.stringify(genLogo.inner),
  );
  ok(
    b.brandTextColor === 'rgb(211, 188, 142)',
    '🔴 品牌名 = 淡金（改前是继承来的近黑色）',
    `color=${b.brandTextColor}`,
  );
  ok(
    b.sidebarColor === 'rgb(242, 237, 224)',
    '侧栏自身 color 也被显式声明（颜色继承链兜底，别只重定义变量）',
    `color=${b.sidebarColor}`,
  );

  /* ---- 复刻的三色分工：米白底 / 深靛蓝容器 / 白字（截图逐点取样值）---- */
  ok(
    b.cardBg === 'rgb(80, 88, 107)',
    '卡片 = 深靛蓝 #50586b（图3 卡片底实测）',
    `bg=${b.cardBg}`,
  );
  ok(
    b.cardTitleColor === 'rgb(253, 252, 248)',
    '卡片标题 = 白 #fdfcf8（深底上翻白）',
    `color=${b.cardTitleColor}`,
  );
  ok(
    b.cardLabelColor === 'rgb(216, 210, 194)',
    '卡片内次要文字 = 米白 #d8d2c2',
    `color=${b.cardLabelColor}`,
  );
  /*
   * 🔴 这条是整次复刻最容易出错、且最容易「看着没事」的地方：
   * 卡片换成深底之后，只要有一处文字没跟着翻白，就是深底压深字 = 不可读。
   * 所以直接比亮度，而不是逐个元素去数颜色。
   */
  ok(
    b.cardTextVar.toLowerCase() === '#fdfcf8',
    '🔴 深色容器内 --text-primary 被重定义成白色（后代靠变量继承翻白）',
    `--text-primary=${b.cardTextVar}`,
  );

  /*
   * 🔴 选中底色必须**明显区别于控件自己的容器底（卡内 --bg-inset #454c5c）**。
   * 一开始用的 --accent-soft 和容器底明度接近，选中项看不出来 ——
   * 缩略图上完全分不出，得放大截图才发现，所以这条专门钉住它。
   * 现在改成实心淡金填充，对比最强，也正好是「淡黄为衬色」最直白的用法。
   */
  ok(
    b.themeSegActive?.text === '原神' && b.themeSegActive?.bg === 'rgb(211, 188, 142)',
    '主题选择器选中项 = 实心淡金（≠ 容器底 #454c5c）',
    JSON.stringify(b.themeSegActive),
  );
  ok(
    b.themeSegActive?.color === 'rgb(69, 76, 92)',
    '主题选择器选中项文字 = 深靛蓝（金底上压深字）',
    `color=${b.themeSegActive?.color}`,
  );
  await shot(win, 'genshin-check-genshin-settings.png');

  /* ---- 3. 锁色：绕过设置页直接改 data-accent，主题仍要压住 ---- */
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-accent', 'ocean')`,
  );
  await sleep(120);
  const c = await readGenshin(win);
  ok(
    c.accent.toLowerCase() === '#a8853c',
    '🔴 主题锁色：外改 data-accent=ocean 也压不动 --accent',
    `accent=${c.accent} (accentAttr=${c.accentAttr})`,
  );
  // 还原（真值在主进程设置里，这里手工回填免得污染后续断言）
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-accent', ${JSON.stringify(a.accentAttr)})`,
  );

  /* ---- 4. 同一级：原神就是 data-theme 的一个取值，不叠加在 dark 之上 ---- */
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', 'dark')`,
  );
  await sleep(120);
  const d = await readGenshin(win);
  ok(
    d.bgApp.toLowerCase() === '#161b28' && d.cardGradientCount === 0,
    '🔴 改成 data-theme=dark 时原神整套样式立刻撤离（二者是同一个属性，天然互斥）',
    `bg-app=${d.bgApp} gradients=${d.cardGradientCount}`,
  );
  // 回到原神，继续后面的断言
  await win.webContents.executeJavaScript(
    `document.documentElement.setAttribute('data-theme', 'genshin')`,
  );
  await sleep(120);

  /* ---- 5. 原神下的其它页面（看点中态）---- */
  await goto(win, '/');
  await sleep(500);
  const e = await readGenshin(win);
  ok(
    e.sidebarBg === 'rgb(79, 81, 93)',
    '侧栏 = 深靛蓝 #4f515d（图3 左栏实测）',
    `bg=${e.sidebarBg}`,
  );
  ok(
    e.navActiveColor === 'rgb(211, 188, 142)',
    '侧栏选中项 = 淡金 #d3bc8e（侧栏内 --accent 被换成亮金）',
    `color=${e.navActiveColor}`,
  );
  await shot(win, 'genshin-check-genshin-device.png');

  /* ---- 6. 持久化 ---- */
  const s = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s?.data?.theme === 'genshin', '主题状态已写回主进程设置', `theme=${s?.data?.theme}`);

  /* ---- 7. 深色 / 浅色照旧可用，切回去后原神样式全撤 ---- */
  await goto(win, '/settings');
  await sleep(400);
  const r2 = await clickSeg(win, '主题模式', '深色');
  ok(r2 === 'ok', '能切回深色模式', `ret=${r2}`);
  await sleep(500);
  const f = await readGenshin(win);
  ok(f.themeAttr === 'dark', 'data-theme=dark', `theme=${f.themeAttr}`);
  ok(f.bgApp.toLowerCase() === '#161b28', '深色底色未被原神污染', `bg-app=${f.bgApp}`);
  ok(f.cardGradientCount === 0, '原神的角饰已撤掉', `gradients=${f.cardGradientCount}`);
  ok(f.accentPicker === 1, '深色下主题色选择器回来了', `picker=${f.accentPicker}`);

  await clickSeg(win, '主题模式', '浅色');
  await sleep(500);
  const g = await readGenshin(win);
  ok(g.themeAttr === 'light', 'data-theme 回到 light', `theme=${g.themeAttr}`);
  ok(g.accent.toLowerCase() === '#3b6ae1', '浅色的 --accent 回到苍穹蓝', `accent=${g.accent}`);
  ok(g.brandSrc === a.brandSrc, 'logo 跟着主题切回来了（不是永久换成原神那枚）', `src=${g.brandSrc}`);
  ok(
    g.brandTextColor !== 'rgb(211, 188, 142)',
    '品牌名的金色也撤掉了',
    `color=${g.brandTextColor}`,
  );

  log('=== GENSHIN CHECK ===');
  for (const r of rows) log(r);
  log(errorsLine(rendererErrors));
  log('GENSHIN CHECK DONE');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});

function errorsLine(errors) {
  return errors.length ? `=== 渲染层错误 ===\n${errors.join('\n')}` : '渲染层无错误';
}
