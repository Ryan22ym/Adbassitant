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
        footTextVisible: footText ? cs(footText).display !== 'none' : null,
        toggles: document.querySelectorAll('.sidebar-toggle').length,
        navOverflowX: nav ? nav.scrollWidth - nav.clientWidth : null,
        maxItemRight: itemRects.length ? Math.round(Math.max(...itemRects.map((r) => r.right))) : null,
      };
    })()
  `);
}

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
  await sleep(1100);

  /* ---- 1. 默认（展开）态 ---- */
  const a = await readSidebar(win);
  ok(a.toggles === 1, '收起开关存在且唯一', `count=${a.toggles}`);
  ok(!a.collapsed, '默认是展开态');
  ok(a.width >= 200, '展开态宽度 = --sidebar-w', `w=${a.width}`);
  ok(a.labelVisible === a.labelCount && a.labelCount > 0, '展开态显示全部文字标签', `${a.labelVisible}/${a.labelCount}`);
  ok(a.brandTextVisible === true, '展开态显示应用名与版本');
  ok(a.footTextVisible === true, '展开态显示设备状态文字');
  ok(a.iconVisible === a.iconCount && a.iconCount > 0, '展开态图标齐全', `${a.iconVisible}/${a.iconCount}`);

  /* ---- 2. 收起态 ---- */
  await click();
  const wCollapsed = await waitWidth(win, 56);
  await sleep(150);
  const b = await readSidebar(win);
  ok(b.collapsed, '点击后进入收起态');
  ok(wCollapsed === 56, '收起后侧栏变窄到 56px', `w=${wCollapsed}`);
  ok(b.labelVisible === 0, '收起后文字标签全部隐藏', `visible=${b.labelVisible}`);
  ok(b.brandTextVisible === false, '收起后隐藏应用名与版本');
  ok(b.footTextVisible === false, '收起后隐藏设备状态文字');
  ok(b.iconVisible === b.iconCount && b.iconCount > 0, '收起后图标仍全部可见', `${b.iconVisible}/${b.iconCount}`);
  ok(b.navOverflowX === 0, '收起后导航无横向溢出', `overflow=${b.navOverflowX}`);
  ok(b.maxItemRight !== null && b.maxItemRight <= b.sidebarRight, '导航项未越出侧栏边界', `item=${b.maxItemRight} / edge=${b.sidebarRight}`);

  const s1 = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s1?.data?.sidebarCollapsed === true, '收起状态已写回主进程设置', `sidebarCollapsed=${s1?.data?.sidebarCollapsed}`);

  /* ---- 3. 再点一次回到展开 ---- */
  await click();
  const wBack = await waitWidth(win, a.width);
  await sleep(150);
  const c = await readSidebar(win);
  ok(!c.collapsed, '再点一次恢复展开态');
  ok(wBack === a.width, '宽度恢复与初始一致', `${wBack} vs ${a.width}`);
  ok(c.labelVisible === a.labelVisible, '文字标签重新显示', `${c.labelVisible}/${c.labelCount}`);
  ok(c.iconVisible === c.iconCount, '恢复后图标仍齐全', `${c.iconVisible}/${c.iconCount}`);

  const s2 = await win.webContents.executeJavaScript(`window.adbApi.getSettings()`);
  ok(s2?.data?.sidebarCollapsed === false, '展开状态已写回主进程设置', `sidebarCollapsed=${s2?.data?.sidebarCollapsed}`);

  log('=== SIDEBAR CHECK ===');
  for (const r of rows) log(r);
  log(errorsLine(rendererErrors));
  log('SIDEBAR CHECK DONE');

  app.exit(rows.some((r) => r.startsWith('FAIL')) ? 1 : 0);
});

function errorsLine(errors) {
  return errors.length ? `=== 渲染层错误 ===\n${errors.join('\n')}` : '渲染层无错误';
}
