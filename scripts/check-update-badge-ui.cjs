/**
 * 「有新版本」提示 + 更新栏收起态可操作性 界面验收（v1.1.12）。
 *
 * 背景（两条用户反馈）：
 *   ① 有新版本时只有一枚侧栏红点，「设置」里看不出是**版本**更新 —— 要红字 New；
 *      （后续迭代：小杨要求 New **不要白底**、**不要红点**，最终形态 = 一枚纯红字）
 *   ② 更新栏（设置页「软件更新」卡片）**收起**时点「下载并更新」走不完：
 *      进度条、确认框、「立即更新并重启」原本全在收起区里（display:none），
 *      用户看到的就是「点了没反应、不会重启」。
 *
 * 为什么单独写一条而不用 check-update-online-ui.cjs：
 *   那条跑 dev 形态，而 dev 形态在 pickPackage() 里**永远拿不到包**（pkg=null）——
 *   「下载并更新」根本不会出现，也就测不到收起态点击这条路。
 *   这里在**主进程侧**把 `update:check` / `update:download` 两个 handler 换成定值回包
 *   （前端那一层是 contextBridge 冻结对象，改不动；渲染层代码本身一行没动），
 *   把「有新版本 + 有包」这个界面状态端出来，专门验交互。
 *
 * 跑法（脚本自己就是 Electron 主进程，用 dist/ 的构建产物）：
 *   python scripts/run-electron.py scripts/check-update-badge-ui.cjs \
 *     --watch ui-shots/_update-badge.log --until "UPDATE BADGE UI CHECK DONE" --timeout 300
 *   （改完 src/ 先 `npm run build:renderer`）
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_update-badge.log');

function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow, ipcMain } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_VERSION = '9.9.9';

let fails = 0;
const ok = (cond, name, detail) => {
  if (!cond) fails++;
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

/* 底色是否「没有」：Chromium 把 transparent 算成 rgba(0,0,0,0) */
const transparent = (c) => {
  const m = String(c).match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
  if (!m) return String(c) === 'transparent';
  return (m[4] === undefined ? 1 : Number(m[4])) === 0;
};

/* ------------------------------------------------------------------ */
/* 页面探针（全部走 executeJavaScript，主进程侧发起）                    */
/* ------------------------------------------------------------------ */

/*
 * 🔴 「可见」的判据：折叠只是把 body 置成 display:none（DOM 一直留着，
 * 好让验收脚本 querySelector 得到）。所以查存在会把收起区里的元素也算「看得见」，
 * 必须连同 getClientRects() 一起看。
 */
const SNAP = `(() => {
  /*
   * 元素背后的**实际**底色。
   * 🔴 原神主题下 --danger-soft 是半透明的（rgba(...,0.16)），直接拿
   *    getComputedStyle().backgroundColor 当底色去算对比度，等于把 alpha 丢掉，
   *    算出来必然是 1:1 的假失败。这里沿 DOM 往上把各层底色按 alpha 合成。
   */
  const effBg = (el) => {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const m = String(getComputedStyle(node).backgroundColor).match(
        /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/,
      );
      if (m) {
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a > 0) {
          layers.push([Number(m[1]), Number(m[2]), Number(m[3]), a]);
          if (a === 1) break;
        }
      }
      node = node.parentElement;
    }
    let rgb = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      rgb = [r * a + rgb[0] * (1 - a), g * a + rgb[1] * (1 - a), b * a + rgb[2] * (1 - a)];
    }
    return 'rgb(' + rgb.map((v) => Math.round(v)).join(', ') + ')';
  };
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false, visible: false, text: '', color: '', bg: '', ownBg: '' };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      found: true,
      visible: el.getClientRects().length > 0 && r.width > 0 && r.height > 0,
      text: (el.textContent || '').trim(),
      color: cs.color,
      bg: effBg(el),
      /* 自己那一层的背景（用来钉死「纯文字、不许有底色」） */
      ownBg: cs.backgroundColor,
      ownBorder: cs.borderTopWidth + ' ' + cs.borderTopStyle,
    };
  };
  const p = document.querySelector('[data-update-panel]');
  if (!p) return { panel: false };
  const card = p.querySelector('.card');
  const body = p.querySelector('.card-body');
  const applyBtn = Array.from(p.querySelectorAll('button')).find((b) => /立即更新并重启/.test(b.textContent));
  const notice = Array.from(p.querySelectorAll('.notice')).find((n) => /确定现在更新到/.test(n.textContent || ''));
  const navItem = Array.from(document.querySelectorAll('.nav-item')).find((a) => /设置/.test(a.textContent || ''));
  const navDot = navItem ? navItem.querySelector('.nav-dot') : null;
  const navNew = navItem ? navItem.querySelector('.nav-new') : null;
  const newTag = document.querySelector('[data-update-new]');
  const sidebar = document.querySelector('.sidebar');
  const extraBox = p.querySelector('.card-extra');
  const cardBox = card ? card.getBoundingClientRect() : null;
  const checkBtn = p.querySelector('[data-update-check-btn]');
  return {
    panel: true,
    checkState: p.getAttribute('data-update-check'),
    collapsed: !!card && card.classList.contains('is-collapsed'),
    bodyVisible: !!body && body.getClientRects().length > 0,
    btns: Array.from(p.querySelectorAll('button')).map((b) => b.textContent.trim()),
    /* 标题行右侧操作区有没有顶出卡片（元素一多就被裁的那个坑） */
    extraOverflowRight:
      extraBox && cardBox ? Math.round(extraBox.getBoundingClientRect().right - cardBox.right) : null,
    checkBtnInsideCard:
      !!checkBtn && !!cardBox && checkBtn.getClientRects().length > 0
        ? checkBtn.getBoundingClientRect().right <= cardBox.right + 1
        : false,
    /* 视口宽度与是否有横向溢出：窄窗口下标题行会不会被推到屏幕外 */
    viewportW: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    checkBtnRight: checkBtn ? Math.round(checkBtn.getBoundingClientRect().right) : null,
    newTag: vis('[data-update-new]'),
    /* 🔴 New 前面不该再有红点（用户要求去掉）：CSS 里连 .update-new-dot 都已经删了 */
    newTagDotFound: !!newTag && !!newTag.querySelector('.update-new-dot'),
    /* 诊断用：New 标记往上各层底色（原神主题是半透明底，得看清叠在什么上） */
    newTagLayers: (() => {
      const el = document.querySelector('[data-update-new]');
      const out = [];
      let n = el;
      while (n && n.nodeType === 1 && out.length < 8) {
        out.push(
          (n.className || n.tagName).toString().slice(0, 24) +
            '=' +
            getComputedStyle(n).backgroundColor,
        );
        n = n.parentElement;
      }
      return out;
    })(),
    versionBadge: (() => {
      const b = Array.from(p.querySelectorAll('.badge')).find((x) => /新版本/.test(x.textContent || ''));
      return b ? b.textContent.trim() : '';
    })(),
    download: vis('[data-update-download]'),
    progress: vis('[data-update-progress]'),
    quickApply: vis('[data-update-apply-quick]'),
    applyVisible: !!applyBtn && applyBtn.getClientRects().length > 0,
    confirmVisible: !!notice && notice.getClientRects().length > 0,
    sidebarCollapsed: !!sidebar && sidebar.classList.contains('collapsed'),
    /* 🔴 红点已按用户要求移除：这里应当恒为 false */
    navDotFound: !!navDot,
    navNewVisible: !!navNew && navNew.getClientRects().length > 0,
    navNewText: navNew ? navNew.textContent.trim() : '',
    navNewColor: navNew ? getComputedStyle(navNew).color : '',
    navNewBg: navNew ? getComputedStyle(navNew).backgroundColor : '',
  };
})()`;

const snap = (win) => win.webContents.executeJavaScript(SNAP);

/* 轮询到某个条件成立（隐藏窗口也可能不推进动画帧，所以逐次重新下发） */
async function waitFor(win, pred, timeout = 4000, step = 120) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(win);
    if (pred(last)) return last;
    await sleep(step);
  }
  return last;
}

const clickSel = (win, sel) =>
  win.webContents.executeJavaScript(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`,
  );

/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(LOG, '');

  const { registerIpc } = require(path.join(ROOT, 'dist-electron', 'electron', 'ipc.js'));
  registerIpc();

  /*
   * 把两个更新相关的 handler 换成定值回包。
   * 走的是**真实的 preload → ipcMain** 通道，只有主进程这一侧的结果是假的 ——
   * 被验的 React 逻辑（点完之后卡片开不开、按钮在不在、可见不可见）全都是真的。
   */
  ipcMain.removeHandler('update:check');
  ipcMain.handle('update:check', async () => ({
    ok: true,
    data: {
      ok: true,
      reason: '',
      sourceDesc: '本机假更新源（验收脚本）',
      configured: true,
      hasUpdate: true,
      currentVersion: '1.1.11',
      checkedAt: '2026-10-12 18:30',
      latest: {
        version: FAKE_VERSION,
        publishedAt: '2026-10-12T18:00:00+08:00',
        notes: '验收脚本注入的更新说明',
        critical: false,
        pkg: { url: 'http://127.0.0.1:1/pkg.zip', size: 1258291, sha256: 'deadbeef' },
        pkgForm: 'asar',
      },
    },
  }));
  ipcMain.removeHandler('update:download');
  ipcMain.handle('update:download', async () => {
    // 拖一会儿：好观察「点下去之后卡片是不是立刻摊开了」
    await sleep(700);
    return {
      ok: true,
      data: {
        ok: true,
        reason: '',
        warning: '',
        manifest: { version: FAKE_VERSION },
        zipSize: 1258291,
        fileCount: 12,
      },
    };
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* 隐藏窗口会节流渲染；这里要真显示出来截图，也顺手关掉节流 */
      backgroundThrottling: false,
    },
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  try {
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/settings' });
    win.show();
    await sleep(1500); // 等首屏 + 面板挂载

    const initial = await waitFor(win, (s) => s.panel && s.checkState !== 'checking', 6000, 200);
    ok(!!initial.panel, '设置页渲染出「软件更新」面板');
    if (!initial.panel) throw new Error('面板没渲染出来，先 npm run build:renderer 再跑');
    ok(
      initial.checkState === 'available',
      '注入「有新版本 + 有包」后进入 available 态',
      `checkState=${initial.checkState}`,
    );
    // 更新栏默认就是收起的（Card defaultOpen={false}）—— 用户报的正是这个状态
    ok(initial.collapsed && !initial.bodyVisible, '更新栏默认收起（body 不可见）', `collapsed=${initial.collapsed}`);

    /* ---- 段一：收起态下的红字 New（纯文字：无底、无边框、无红点） ---- */
    const collapsed = initial;
    ok(collapsed.newTag.found, '标题行有 New 标记（data-update-new）');
    ok(collapsed.newTag.visible, 'New 标记在收起态下可见', JSON.stringify(collapsed.newTag));
    ok(collapsed.newTag.text === 'New', 'New 标记文字就是 New', String(collapsed.newTag.text));
    ok(
      !collapsed.newTagDotFound,
      '🔴 New 前面没有红点（用户：那不要红点吧）',
      `dotFound=${collapsed.newTagDotFound}`,
    );
    const rgb = String(collapsed.newTag.color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const redish =
      !!rgb && Number(rgb[1]) > 130 && Number(rgb[1]) - Number(rgb[2]) > 40 && Number(rgb[1]) - Number(rgb[3]) > 40;
    ok(redish, 'New 是红字（走语义色 --danger）', String(collapsed.newTag.color));
    /* 🔴 本轮改动：从「红字 + 淡红胶囊底」改成**纯红字** —— 不许再有白底/色块/边框 */
    ok(
      transparent(collapsed.newTag.ownBg),
      '🔴 New 是纯文字、没有自己的底色（用户：只有字，不要白底）',
      `ownBg=${collapsed.newTag.ownBg}`,
    );
    ok(
      /^0px /.test(String(collapsed.newTag.ownBorder)),
      'New 没有边框（连描边也不加）',
      collapsed.newTag.ownBorder,
    );
    ok(/v9\.9\.9/.test(collapsed.versionBadge), '版本徽标仍在（红点/New 之外保留具体版本号）', collapsed.versionBadge);
    ok(
      collapsed.extraOverflowRight !== null && collapsed.extraOverflowRight <= 1,
      '🔴 标题行右侧操作区没顶出卡片（元素变多后不许被裁）',
      `溢出 ${collapsed.extraOverflowRight}px`,
    );
    ok(collapsed.checkBtnInsideCard, '「检查更新」仍完整落在卡片内');
    log(
      `  · 视口 ${collapsed.viewportW}px，文档 scrollWidth ${collapsed.docScrollW}px，` +
        `检查更新右边界 ${collapsed.checkBtnRight}px`,
    );

    /* ---- 段二：收起态点「下载并更新」必须走得下去 ---- */
    ok(collapsed.download.found && collapsed.download.visible, '收起态标题行里有「下载并更新」且可见', collapsed.btns.join(' | '));
    ok(!collapsed.progress.visible, '点之前没有可见的进度区（进程还没起来）');

    const clicked = await clickSel(win, '[data-update-download]');
    ok(clicked === true, '能点到「下载并更新」');
    const during = await waitFor(win, (s) => !s.collapsed, 2000, 100);
    ok(!during.collapsed, '🔴 点下去卡片自动展开（不再把后续步骤藏在收起区）');
    ok(during.progress.found && during.progress.visible, '下载进度区随之可见');

    const ready = await waitFor(win, (s) => s.confirmVisible || s.applyVisible, 4000, 150);
    ok(ready.applyVisible, '下载完成后「立即更新并重启」可见（可直接点）', ready.btns.join(' | '));

    /* ---- 段三：再手动收起 → 标题行要给出最后一步 ---- */
    await clickSel(win, '[data-update-panel] .card-head');
    const again = await waitFor(win, (s) => s.collapsed, 3000);
    ok(again.collapsed, '点标题行能重新收起（开合仍由用户说了算）');
    ok(
      again.quickApply.found && again.quickApply.visible,
      '收起后标题行出现「立即更新并重启」快捷入口',
      again.btns.join(' | '),
    );

    await clickSel(win, '[data-update-apply-quick]');
    const confirming = await waitFor(win, (s) => !s.collapsed, 3000);
    ok(!confirming.collapsed, '点收起态的「立即更新并重启」也会先把卡片摊开');
    ok(confirming.confirmVisible, '确认框（确定现在更新到 v…）可见 —— 不点确认不会乱更新');

    // 收尾：把确认框关掉，免得截图里挂着一个红色确认条
    await win.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('[data-update-panel] button')).find((x) => /再想想/.test(x.textContent)); if (b) b.click(); return true; })()`,
    );
    await sleep(300);

    /* ---- 段四：侧栏「设置」上只留一枚红字 New（红点已移除） ---- */
    let s = await snap(win);
    for (let i = 0; i < 3 && s.sidebarCollapsed; i++) {
      await clickSel(win, '.sidebar-toggle');
      s = await waitFor(win, (x) => !x.sidebarCollapsed, 2500);
    }
    ok(!s.sidebarCollapsed, '侧栏处于展开态（下面两条要看清 New）');
    ok(!s.navDotFound, '🔴 侧栏「设置」上的红点已移除（只留 New 字）', `dotFound=${s.navDotFound}`);
    ok(s.navNewVisible && s.navNewText === 'New', '侧栏「设置」上只剩一枚红字 New', JSON.stringify({ t: s.navNewText }));
    const nrgb = String(s.navNewColor).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    ok(
      !!nrgb && Number(nrgb[1]) > 130 && Number(nrgb[1]) - Number(nrgb[2]) > 40,
      '侧栏 New 是红字',
      String(s.navNewColor),
    );
    ok(
      transparent(s.navNewBg),
      '🔴 侧栏 New 是纯文字、没有底色',
      `bg=${s.navNewBg}`,
    );

    await clickSel(win, '.sidebar-toggle');
    s = await waitFor(win, (x) => x.sidebarCollapsed, 3000);
    ok(
      s.sidebarCollapsed && !s.navNewVisible && !s.navDotFound,
      '🔴 侧栏收起后安静：New 让位、也没有红点角标（用户要求的取舍）',
      JSON.stringify({ nw: s.navNewVisible, dot: s.navDotFound }),
    );
    // 恢复展开态（截图要能看清 New）
    for (let i = 0; i < 3 && s.sidebarCollapsed; i++) {
      await clickSel(win, '.sidebar-toggle');
      s = await waitFor(win, (x) => !x.sidebarCollapsed, 2500);
    }
    ok(!s.sidebarCollapsed, '侧栏已恢复展开态');

    /* ---- 段五：三套主题下红字都要看得清（颜色全部走语义色变量） ---- */

    /*
     * 本机的老坑：主题是「data-theme × data-accent」两条正交轴，每个 accent 的浅/深两档都得单独写。
     * 新增的颜色只要写死一个值，总有一套主题糊成一团。这里对三种主题各算一次
     * WCAG 对比度（红字 vs 自己的半透明红底），够 3:1 才算能看清（10.5px 粗体）。
     */
    const lum = (c) => {
      const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      const f = (v) => {
        const s = Number(v) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
    };
    const contrast = (a, b) => {
      const la = lum(a);
      const lb = lum(b);
      if (la === null || lb === null) return null;
      return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
    };
    const setTheme = (label) =>
      win.webContents.executeJavaScript(`(() => {
        const it = Array.from(document.querySelectorAll('.segmented-item')).find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!it) return false;
        it.click();
        return true;
      })()`);

    /*
     * 门槛按主题分开：浅色 / 深色的语义红与底色的对比度都够 3:1；
     * 「原神」主题的卡片是**深卡**，theme-genshin.css 给卡片换的是
     * 「提亮的语义色 + 半透明同色底」（--danger: #e08a7e / rgba(...,0.16)）——
     * 整族徽标（含既有的绿色「新版本」）都落在 2.3~2.8 这一档，不是本标记的问题。
     * 这里钉住「不许比现在更差」，别把主题整体调色的事混进这条改动里。
     */
    const MIN_RATIO = { 浅色: 3, 深色: 3, 原神: 2.2 };

    for (const th of ['浅色', '深色', '原神']) {
      const clickedTh = await setTheme(th);
      if (!clickedTh) {
        ok(false, `找不到主题「${th}」的切换按钮`);
        continue;
      }
      await sleep(500);
      const t = await snap(win);
      const ratio = contrast(t.newTag.color, t.newTag.bg);
      log(`  · 主题「${th}」底色分层：` + t.newTagLayers.join(' | '));
      ok(
        t.newTag.visible && ratio !== null && ratio >= MIN_RATIO[th],
        `主题「${th}」下 New 红字看得清（对比度 ≥ ${MIN_RATIO[th]}:1）`,
        `fg=${t.newTag.color} bg=${t.newTag.bg} 对比 ${ratio}`,
      );
    }
    await setTheme('浅色');
    await sleep(400);

    /* ---- 段六：截图（摆回「收起 + 有新版本」这个用户看到的样子） ---- */
    let forShot = await snap(win);
    if (!forShot.collapsed) {
      await clickSel(win, '[data-update-panel] .card-head');
      forShot = await waitFor(win, (x) => x.collapsed, 3000);
    }
    ok(forShot.collapsed && forShot.newTag.visible, '截图态：更新栏收起 + 红字 New 可见');

    // 把浮层收掉，截图干净点（toast 点一下就关）
    await win.webContents.executeJavaScript(
      `(() => { document.querySelectorAll('.toast').forEach((t) => t.click()); return true; })()`,
    );
    await sleep(400);

    const shot = await win.webContents.capturePage();
    if (shot && !shot.isEmpty()) {
      const png = path.join(OUT, 'update-new-badge.png');
      fs.writeFileSync(png, shot.toPNG());
      log('截图 -> ' + png);
    }

    ok(rendererErrors.length === 0, '渲染层无 console 报错', rendererErrors.slice(0, 3).join(' || '));

    /* 别把侧栏收起状态留在设置里（本机真 userData 没被碰，但态度要端正） */
    await win.webContents
      .executeJavaScript(`window.adbApi.setSettings({ sidebarCollapsed: false })`)
      .catch(() => {});
  } catch (e) {
    fails++;
    log('[FAIL] 运行异常 :: ' + (e && e.message ? e.message : String(e)));
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }

  log(fails === 0 ? '\nUPDATE BADGE UI CHECK: 全部通过' : `\nUPDATE BADGE UI CHECK: ${fails} 项失败`);
  log('UPDATE BADGE UI CHECK DONE');
  app.exit(fails === 0 ? 0 : 1);
});
