/**
 * 左侧功能栏收起 / 展开校验（v1.1.8）。
 *
 * 只断言「点了按钮宽度变了」是不够的 —— 收起态的坑都在细节上：
 *   - 文字标签是否真的不参与布局（不是隐形但仍占位，那会让图标偏左）；
 *   - 导航项有没有因为侧栏变窄而横向溢出（.sidebar-nav 是 overflow-y:auto，
 *     规范会把它算成 x 也裁剪，溢出的角标会被切掉）；
 *   - 再点一次能不能原样回到展开态；
 *   - 状态有没有写回主进程设置（下次启动要能保持）。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-sidebar.cjs \
 *     --watch ui-shots/_sidebar.log --until "SIDEBAR CHECK DONE" --timeout 300
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_sidebar.log');
function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等侧栏宽度落到期望值。
 *
 * 🔴 不能「点完 sleep(500) 再读一次」：窗口是 show:false 的隐藏窗口，
 * Chromium 会节流渲染，宽度那条 transition 的动画帧可能压根不推进，
 * 于是读到的是动画起点 —— 看起来像「点了没恢复」，其实是测试环境的假象。
 * 这里轮询到终值（并配合 backgroundThrottling:false），把它和真 bug 区分开。
 */
async function waitWidth(win, expect, timeout = 2500) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeout) {
    last = await win.webContents.executeJavaScript(
      `Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`,
    );
    if (last === expect) return last;
    await sleep(120);
  }
  return last;
}

/** 读一次侧栏的全部关键形态 */
function readSidebar(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const sb = document.querySelector('.sidebar');
      const cs = (el) => getComputedStyle(el);
      const labels = [...document.querySelectorAll('.nav-item .nav-label')];
      const items = [...document.querySelectorAll('.nav-item')];
      const icons = items.map((e) => e.querySelector('.nav-icon svg'));
      const nav = document.querySelector('.sidebar-nav');
      const brandText = document.querySelector('.brand-text');
      const footText = document.querySelector('.foot-text');
      const itemRects = items.map((e) => e.getBoundingClientRect());
      /* --- 像素级对齐用：品牌行 / logo / 首个导航图标盒 / 顶栏标题 的中心线 --- */
      const center = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      };
      const r2 = (n) => Math.round(n * 100) / 100;
      const brandRow = document.querySelector('.sidebar-brand');
      const mark = document.querySelector('.brand-mark');
      const icon0 = items[0] ? items[0].querySelector('.nav-icon') : null;
      const headerTitle = document.querySelector('.header-title');
      return {
        collapsed: sb.classList.contains('collapsed'),
        width: Math.round(sb.getBoundingClientRect().width),
        sidebarRight: Math.round(sb.getBoundingClientRect().right),
        labelCount: labels.length,
        labelVisible: labels.filter((e) => cs(e).display !== 'none').length,
        iconCount: icons.length,
        iconVisible: icons.filter((s) => {
          if (!s) return false;
          const b = s.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        }).length,
        brandTextVisible: brandText ? cs(brandText).display !== 'none' : null,
        /* 收起态品牌文字是「宽归零 + 全透明」（不是 display:none），两个都要看 */
        brandTextW: brandText ? Math.round(brandText.getBoundingClientRect().width) : null,
        brandTextOpacity: brandText ? Number(cs(brandText).opacity) : null,
        /* 过渡接好没有（收起无延迟、展开带延迟；三个属性都要在） */
        brandTextTrans: brandText
          ? [
              cs(brandText).transitionProperty.split(',').map((s) => s.trim()).sort().join('+'),
              cs(brandText).transitionDelay,
              cs(brandText).transitionDuration,
            ]
          : null,
        brandRowCenterY: brandRow ? r2(center(brandRow).y) : null,
        markCenter: mark ? { x: r2(center(mark).x), y: r2(center(mark).y) } : null,
        markBox: mark
          ? [
              Math.round(mark.getBoundingClientRect().width),
              Math.round(mark.getBoundingClientRect().height),
            ]
          : null,
        iconCenter: icon0 ? { x: r2(center(icon0).x), y: r2(center(icon0).y) } : null,
        headerTitleCenterY: headerTitle ? r2(center(headerTitle).y) : null,
        footTextVisible: footText ? cs(footText).display !== 'none' : null,
        toggles: document.querySelectorAll('.sidebar-toggle').length,
        navOverflowX: nav ? nav.scrollWidth - nav.clientWidth : null,
        maxItemRight: itemRects.length ? Math.round(Math.max(...itemRects.map((r) => r.right))) : null,
      };
    })()
  `);
}

/**
 * 取一帧过渡状态：{ 侧栏宽、应用名占几行、应用名盒高、透明度 }。
 *
 * 🔴 「应用名有没有折行」不能用 offsetHeight 或元素自身的 getClientRects 判：
 *    <strong> 是 flex item，display 被块级化，元素自身的 getClientRects() 永远回 1 个矩形。
 *    只有用 Range 包住**文字内容**，它才按行框返回矩形 —— 折行就是 2 个以上。
 *    这正是用户看到「一会双行一会单行」的那个量，必须钉在过渡的每一帧上。
 */
function readTransitionFrame(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const sb = document.querySelector('.sidebar');
      const bt = document.querySelector('.brand-text');
      const strong = document.querySelector('.brand-text strong');
      const r = document.createRange();
      if (strong) r.selectNodeContents(strong);
      return {
        w: Math.round(sb.getBoundingClientRect().width),
        lines: strong ? r.getClientRects().length : -1,
        h: strong ? Math.round(strong.getBoundingClientRect().height) : -1,
        op: bt ? Math.round(Number(getComputedStyle(bt).opacity) * 100) / 100 : -1,
      };
    })()
  `);
}

/**
 * 采样整个过渡过程。
 *
 * 🔴 循环必须在**主进程侧**（每条采样一次 executeJavaScript），
 * 不能写成渲染层里一个 await setTimeout 的循环 —— 实测那样循环里的一整段
 * 读到的都是过渡起点：隐藏窗口不会自己推进动画帧，只有从主进程重新下发一次
 * executeJavaScript 才会推一帧（waitWidth 能跑通就是这个原因）。
 */
async function sampleTransition(win, ms = 460, step = 30) {
  const out = [];
  for (let t = 0; t <= ms; t += step) {
    out.push({ t, ...(await readTransitionFrame(win)) });
    await sleep(step);
  }
  return out;
}

const fmtSamples = (s) => s.map((x) => `${x.w}px/${x.lines}行/${x.h}h/${x.op}`).join(' ');

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
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
      /* 隐藏窗口默认会节流渲染，宽度过渡的帧就不推进了（见 waitWidth 注释） */
      backgroundThrottling: false,
    },
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) rendererErrors.push(msg);
  });

  const rows = [];
  const ok = (cond, name, detail) => rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);

  const click = () => win.webContents.executeJavaScript(`document.querySelector('.sidebar-toggle').click()`);

  await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/' });
  /*
   * 🔴 必须真把窗口显示出来。
   * 隐藏窗口（show:false）里 Chromium 不产生动画帧 —— CSS 过渡的时间轴根本不推进，
   * 连同一次 executeJavaScript 里 await 一圈读到的都是过渡起点（假 FAIL）。
   * 只有 show:true 时才拿得到中间帧，过渡那几条断言才有意义。
   */
  win.show();
  await sleep(1100);

  /* ---- 1. 默认（展开）态 ---- */
  const a = await readSidebar(win);
  ok(a.toggles === 1, '收起开关存在且唯一', `count=${a.toggles}`);
  ok(!a.collapsed, '默认是展开态');
  ok(a.width >= 200, '展开态宽度 = --sidebar-w', `w=${a.width}`);
  ok(a.labelVisible === a.labelCount && a.labelCount > 0, '展开态显示全部文字标签', `${a.labelVisible}/${a.labelCount}`);
  ok(a.brandTextVisible === true && a.brandTextOpacity === 1, '展开态显示应用名与版本', `w=${a.brandTextW} opacity=${a.brandTextOpacity}`);
  ok(a.brandTextW > 60, '展开态应用名与版本是自然宽度（没被挤窄/裁切）', `w=${a.brandTextW}`);
  ok(a.footTextVisible === true, '展开态显示设备状态文字');
  ok(a.iconVisible === a.iconCount && a.iconCount > 0, '展开态图标齐全', `${a.iconVisible}/${a.iconCount}`);

  /* ---- 1b. 像素级对齐（展开态）----
   * 用户反馈「左上角像是没对齐」。三条中线必须重合，阈值 0.6px：
   * 差 1px 以上肉眼就可辨（旧写法上下 padding 16/14，正好把 logo 压低 1px）。
   */
  const gap = (x, y) => (x == null || y == null ? 999 : Math.round(Math.abs(x - y) * 100) / 100);
  const dxCol = gap(a.markCenter?.x, a.iconCenter?.x);
  ok(dxCol <= 0.5, '🔴 logo 盒中心对齐导航图标列的中线（±0.5px）', `logo=${a.markCenter?.x} icon=${a.iconCenter?.x} Δ=${dxCol}`);
  const dyRow = gap(a.markCenter?.y, a.brandRowCenterY);
  ok(dyRow <= 0.6, '🔴 logo 在品牌行内垂直居中（上下 padding 不对称会偏 1px）', `logo=${a.markCenter?.y} row=${a.brandRowCenterY} Δ=${dyRow}`);
  const dyHead = gap(a.markCenter?.y, a.headerTitleCenterY);
  ok(dyHead <= 0.6, '🔴 logo 中线与右侧顶栏标题中线同一条水平线', `logo=${a.markCenter?.y} header=${a.headerTitleCenterY} Δ=${dyHead}`);
  ok(a.markBox && a.markBox[0] === 30 && a.markBox[1] === 30, 'logo 仍是 30×30（对齐靠位置，不改尺寸）', `${a.markBox}`);

  /* 过渡接好没有：三个属性都要在，且时序不对称（展开带延迟 / 收起零延迟） */
  const [tpA, tdA, tdurA] = a.brandTextTrans;
  ok(
    ['max-width', 'opacity', 'transform'].every((p) => tpA.includes(p)),
    '品牌文字的过渡挂在 max-width / opacity / transform 上',
    tpA,
  );
  ok(
    tdA.includes('0.14s') && tdurA !== '0s, 0s, 0s',
    '展开方向：淡入带 0.14s 延迟（等侧栏宽度长开再显字）',
    `delay=${tdA} duration=${tdurA}`,
  );

  /* ---- 2. 收起：全过程采样，应用名不许出现双行 ---- */
  await click();
  const sCollapse = await sampleTransition(win);
  const wCollapsed = await waitWidth(win, 56);
  await sleep(150);
  const b = await readSidebar(win);
  ok(b.collapsed, '点击后进入收起态');
  ok(wCollapsed === 56, '收起后侧栏变窄到 56px', `w=${wCollapsed}`);
  ok(b.labelVisible === 0, '收起后文字标签全部隐藏', `visible=${b.labelVisible}`);
  ok(
    b.brandTextVisible !== false && b.brandTextW === 0 && b.brandTextOpacity === 0,
    '收起后应用名宽归零且全透明（不是 display:none —— 否则没法渐隐）',
    `display!=none:${b.brandTextVisible} w=${b.brandTextW} opacity=${b.brandTextOpacity}`,
  );
  ok(b.footTextVisible === false, '收起后隐藏设备状态文字');
  ok(b.iconVisible === b.iconCount && b.iconCount > 0, '收起后图标仍全部可见', `${b.iconVisible}/${b.iconCount}`);
  ok(b.navOverflowX === 0, '收起后导航无横向溢出', `overflow=${b.navOverflowX}`);
  ok(b.maxItemRight !== null && b.maxItemRight <= b.sidebarRight, '导航项未越出侧栏边界', `item=${b.maxItemRight} / edge=${b.sidebarRight}`);

  /* 🔴 本条钉的就是用户报的「一会双行、一会单行」：过渡每一帧都只能是 1 行 */
  ok(
    sCollapse.every((s) => s.lines === 1),
    '🔴 收起全过程应用名始终单行（不出现双行跳动）',
    fmtSamples(sCollapse),
  );
  ok(
    sCollapse.some((s) => s.op < 1) && sCollapse[sCollapse.length - 1].op === 0,
    '收起时应用名渐隐到全透明（不是硬消失）',
    `opacity 轨迹 ${sCollapse.map((s) => s.op).join(' → ')}`,
  );
  ok(
    sCollapse.some((s) => s.w !== sCollapse[0].w) && sCollapse[sCollapse.length - 1].w === 56,
    '采样覆盖到了宽度过渡全程（末帧宽度 = 收起态宽度）',
    `w ${sCollapse[0].w} → ${sCollapse[sCollapse.length - 1].w}`,
  );
  const dxColB = gap(b.markCenter?.x, b.iconCenter?.x);
  ok(dxColB <= 0.5, '🔴 收起态 logo 与导航图标同样严格共中线（±0.5px）', `logo=${b.markCenter?.x} icon=${b.iconCenter?.x} Δ=${dxColB}`);
  ok(!b.brandTextTrans[1].includes('0.14s'), '收起方向不延迟（先淡出，宽度随后才收）', `delay=${b.brandTextTrans[1]}`);

  const s1 = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s1?.data?.sidebarCollapsed === true, '收起状态已写回主进程设置', `sidebarCollapsed=${s1?.data?.sidebarCollapsed}`);

  /* ---- 3. 再点一次回到展开（同样采样过渡）---- */
  await click();
  const sExpand = await sampleTransition(win);
  const wBack = await waitWidth(win, a.width);
  await sleep(150);
  const c = await readSidebar(win);
  ok(!c.collapsed, '再点一次恢复展开态');
  ok(wBack === a.width, '宽度恢复与初始一致', `${wBack} vs ${a.width}`);
  ok(c.labelVisible === a.labelVisible, '文字标签重新显示', `${c.labelVisible}/${c.labelCount}`);
  ok(c.iconVisible === c.iconCount, '恢复后图标仍齐全', `${c.iconVisible}/${c.iconCount}`);

  ok(
    sExpand.every((s) => s.lines === 1),
    '🔴 展开全过程应用名始终单行（不出现双行跳动）',
    fmtSamples(sExpand),
  );
  ok(
    sExpand[0].op < 1 && sExpand[sExpand.length - 1].op === 1,
    '展开时应用名由透明渐显到不透明（不是硬闪出来）',
    `opacity 轨迹 ${sExpand.map((s) => s.op).join(' → ')}`,
  );
  ok(
    sExpand.some((s) => s.w !== sExpand[0].w) && sExpand[sExpand.length - 1].w === a.width,
    '采样覆盖到了宽度过渡全程（末帧宽度 = 展开态宽度）',
    `w ${sExpand[0].w} → ${sExpand[sExpand.length - 1].w}（期望 ${a.width}）`,
  );
  ok(
    c.brandTextW === a.brandTextW && c.brandTextOpacity === 1,
    '恢复后应用名宽度与初始一致（回到展开态不残留裁切）',
    `${c.brandTextW} vs ${a.brandTextW} / opacity=${c.brandTextOpacity}`,
  );

  const s2 = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s2?.data?.sidebarCollapsed === false, '展开状态已写回主进程设置', `sidebarCollapsed=${s2?.data?.sidebarCollapsed}`);

  log('=== SIDEBAR CHECK ===');
  for (const r of rows) log(r);
  log(errorsLine(rendererErrors));
  log('SIDEBAR CHECK DONE');

  win.hide();
  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});

function errorsLine(errors) {
  return errors.length ? `=== 渲染层错误 ===\n${errors.join('\n')}` : '渲染层无错误';
}
