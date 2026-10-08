/**
 * 「安装包管理」界面 + 链路验收（开发态）
 *
 *   python scripts/run-electron.py scripts/check-packages-ui.cjs \
 *       --watch ui-shots/_packages-ui.log --until "PACKAGES UI CHECK DONE"
 *
 * 覆盖：
 *   A 筛选链路 —— 多标签筛选（版本 × 类型 × 通道 × 格式 + 关键字）真的能筛
 *   B 记忆链路 —— 重开应用后沿用上次的筛选条件（需求里明确要的那条）
 *   C 磁盘链路 —— 进模块自动整理，文件真的落到「版本/类型/通道」下
 *   D 规则可配置 —— 目录结构、目录名改完能落盘并按新规则归置
 *   E 安全闸门 —— 盘符根这种危险目录会被拦住
 *   F 手动标签 —— 行内改标签落盘、列表标「手动」、整理按新标签搬、可恢复自动
 *   G 布局与安装 —— 动作键挂在页内标签栏右侧、四张卡片顺序、每行都有「安装」
 *
 * 🔴 全程只在一个**临时工作目录**里干活（os.tmpdir 下自建）。
 *    测试开始前备份 settings 里安装包相关字段，结束时还原：
 *    还原那一刻先把 packageAutoOrganize 关掉再加载真实目录 ——
 *    否则会拿测试去「自动整理」用户真实的安装包仓库（哪怕逻辑是对的，也不该由测试来触发）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_packages-ui.log');

function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try {
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

async function callApi(page, expr) {
  const r = await page.evalJS(`(async () => { return await ${expr}; })()`);
  if (r && typeof r === 'object' && 'ok' in r) return r.ok ? r.data : { __error: r.error };
  return r;
}

async function waitFor(page, expr, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await page.evalJS(`!!(${expr})`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

/** 原生 setter 改 input 的值（否则 React 收不到 input 事件） */
const setInput = (selector, value, index = 0) => `
  (() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`;

const GOTO_TAB = `
  (() => {
    const t = [...document.querySelectorAll('[data-apps-tabs] .segmented-item')]
      .find((b) => b.textContent.includes('安装包管理'));
    if (!t) return false;
    t.click();
    return true;
  })()
`;

const gotoPackageTab = async (page, waitMs = 2500) => {
  await page.evalJS(`window.location.hash = '#/apps'; undefined;`);
  await sleep(900);
  await waitFor(page, `document.querySelector('[data-apps-tabs]')`, 10000);
  await page.evalJS(GOTO_TAB);
  await sleep(waitMs);
};

const rowCount = (page) => page.evalJS(`document.querySelectorAll('[data-pkg-name]').length`);

/** 点某个包行按 data 属性定位的按钮（如 data-pkg-tag / data-pkg-install） */
const clickByName = (page, attr, name) =>
  page.evalJS(`
    (() => {
      const el = document.querySelector('[${attr}="${name}"]');
      if (!el) return false;
      el.click();
      return true;
    })()
  `);

/* ------------------------------------------------------------------ */

async function runChecks(page, ctx) {
  /* ---------- 0. 等 React 挂载 ---------- */
  for (let i = 0; i < 40; i++) {
    const n = await page
      .evalJS(`document.getElementById('root') ? document.getElementById('root').children.length : 0`)
      .catch(() => 0);
    if (n > 0) break;
    await sleep(400);
  }

  await page.evalJS(`window.location.hash = '#/apps'; undefined;`);
  await sleep(1200);

  record(await waitFor(page, `document.querySelector('[data-apps-tabs]')`), 'A1 应用管理页出现页内标签栏');
  record(await page.evalJS(GOTO_TAB), 'A2 能切到「安装包管理」标签');
  record(await waitFor(page, `document.querySelector('[data-pkg-root]')`, 15000), 'A3 安装包仓库卡片渲染出来');

  /* ============ C. 自动整理（磁盘） ============ */
  log('---- C. 磁盘链路 ----');
  record(await waitFor(page, `document.querySelector('[data-pkg-list]')`, 30000), 'C1 进模块自动整理后列表有内容');

  const at = (rel) => fs.existsSync(path.join(ctx.root, ...rel.split('/')));
  record(at('2.83/官网包/release/Domino_GW_V2.83_release_18.apk'), 'C2 官网包 release → 2.83/官网包/release');
  record(at('2.84/官网包/test/Domino_GW_V2.84_test_5.apk'), 'C3 test 包 → 2.84/官网包/test');
  record(
    at('未识别版本/Google包/release/app-dmno_release-release_10.aab'),
    'C4 Google 包（名字里没版本）→ 未识别版本/Google包/release',
  );
  record(at('8.0.50/单包/weixin_8.0.50.apk'), 'C5 单包 → 8.0.50/单包（不分通道）');
  record(at('说明.txt'), 'C6 非安装包文件没有被搬走');

  const scan0 = await callApi(page, `window.adbApi.packagesScan()`);
  record(scan0 && scan0.pending === 0, 'C7 整理后没有待归置的文件', `pending=${scan0 && scan0.pending}`);
  record(scan0 && scan0.entries.length === 4, 'C8 扫到 4 个包', `total=${scan0 && scan0.entries.length}`);
  record(
    scan0 && scan0.dirs.length === 4,
    'C9 目录清单 4 个（含单包那份）',
    JSON.stringify(scan0 && scan0.dirs),
  );
  record((await rowCount(page)) === 4, 'C10 列表行数与扫描结果一致', `rows=${await rowCount(page)}`);

  /* ============ A. 多标签筛选 ============ */
  log('---- A. 筛选链路 ----');
  const chips = await page.evalJS(`
    (() => {
      const q = (k) => document.querySelectorAll('[data-pkg-chip="' + k + '"]').length;
      return { version: q('version'), kind: q('kind'), channel: q('channel'), format: q('format') };
    })()
  `);
  record(
    chips.version === 4 && chips.kind === 3 && chips.channel === 2 && chips.format === 2,
    'A4 四档筛选标签齐全（版本 4 / 类型 3 / 通道 2 / 格式 2）',
    JSON.stringify(chips),
  );

  const clickChip = async (kind, value) => {
    await page.evalJS(`
      (() => {
        const b = document.querySelector('[data-pkg-chip="${kind}"][data-pkg-value="${value}"]');
        if (b) b.click();
        return true;
      })()
    `);
    await sleep(400);
    return rowCount(page);
  };

  record((await clickChip('kind', 'single')) === 1, 'A5 只选「单包」→ 1 行');
  record(
    (await clickChip('channel', 'test')) === 0,
    'A6 叠加「test」→ 单包不属于任何通道，0 行（多档之间是与）',
  );
  record((await clickChip('kind', 'single')) === 1, 'A7 去掉「单包」后只剩 test 那个包');
  record((await clickChip('format', 'aab')) === 0, 'A8 叠加「aab」→ apk 的 test 包被排除，0 行');

  await clickChip('format', 'aab');
  await clickChip('channel', 'test');
  await page.evalJS(setInput('[data-pkg-keyword]', 'domino'));
  await sleep(600);
  record((await rowCount(page)) === 2, 'A9 关键字「domino」筛出 2 个（V2.83 与 V2.84）', `rows=${await rowCount(page)}`);

  /* ============ B. 筛选条件记忆 ============ */
  log('---- B. 记忆链路 ----');
  await sleep(900);
  const saved = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(saved && saved.packageFilters && saved.packageFilters.keyword === 'domino'),
    'B1 关键字落盘到 settings',
    JSON.stringify(saved && saved.packageFilters),
  );

  record((await clickChip('version', '2.83')) === 1, 'B2 再叠加「2.83」→ 只剩 V2.83 那个包', `rows=${await rowCount(page)}`);
  await sleep(900);
  const saved2 = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(saved2 && saved2.packageFilters.versions.includes('2.83')),
    'B3 版本条件也落盘',
    JSON.stringify(saved2 && saved2.packageFilters.versions),
  );

  await page.reload();
  await gotoPackageTab(page, 3000);
  const restored = await page.evalJS(`
    (() => {
      const on = (k, v) => !!document.querySelector('[data-pkg-chip="'+k+'"][data-pkg-value="'+v+'"].on');
      const kw = document.querySelector('[data-pkg-keyword]');
      return { v283: on('version','2.83'), kw: kw ? kw.value : '', rows: document.querySelectorAll('[data-pkg-name]').length };
    })()
  `);
  record(restored.v283, 'B4 重开后「2.83」仍是选中态', JSON.stringify(restored));
  record(restored.kw === 'domino', 'B5 关键字输入框也回填了', restored.kw);
  record(restored.rows === 1, 'B6 列表按记忆的筛选条件渲染（1 行）', `rows=${restored.rows}`);

  await page.evalJS(`(document.querySelector('[data-pkg-clear]')||{}).click?.(); undefined;`);
  await sleep(900);
  record((await rowCount(page)) === 4, 'B7 清除筛选后回到全部 4 行', `rows=${await rowCount(page)}`);

  /* ============ G. 布局：动作位置 / 卡片顺序 / 行内安装 ============ */
  log('---- G. 布局与安装按钮 ----');
  const layout = await page.evalJS(`
    (() => {
      const titles = [...document.querySelectorAll('.card .card-title')]
        .map((el) => (el.textContent || '').replace(/\\s+/g, ''));
      const tabs = document.querySelector('[data-apps-tabs]');
      const org = document.querySelector('[data-pkg-organize]');
      const refresh = document.querySelector('[data-pkg-refresh]');
      return {
        titles,
        organizeInTabs: !!(tabs && org && tabs.contains(org)),
        refreshInTabs: !!(tabs && refresh && tabs.contains(refresh)),
        installs: document.querySelectorAll('[data-pkg-install]').length,
        installAll: !!document.querySelector('[data-pkg-install-all]'),
      };
    })()
  `);
  record(
    layout.organizeInTabs && layout.refreshInTabs,
    'G1 「刷新 / 立即整理」挂在页内标签栏右侧（绿框位置）',
    JSON.stringify({ organize: layout.organizeInTabs, refresh: layout.refreshInTabs }),
  );
  const idx = (t) => layout.titles.indexOf(t);
  record(
    idx('标签筛选') === 0 &&
      idx('标签筛选') < idx('包列表') &&
      idx('包列表') < idx('工作目录') &&
      idx('工作目录') < idx('整理规则'),
    'G2 功能顺序 = 标签筛选 > 包列表 > 工作目录 > 整理规则',
    layout.titles.join(' > '),
  );
  record(layout.installs === 4, 'G3 每个包都有行内「安装」按钮', `count=${layout.installs}`);
  record(layout.installAll, 'G4 有多选批量「安装筛出的 N 个」（筛选的目的就是装）');

  await page.screenshot(path.join(OUT, 'install-packages.png'));

  /* ============ D. 规则可配置 ============ */
  log('---- D. 规则可配置 ----');
  await page.evalJS(`
    (() => {
      const seg = [...document.querySelectorAll('.pkg-rule-row .segmented-item')]
        .find((b) => b.textContent.includes('类型 / 版本'));
      if (seg) seg.click();
      return true;
    })()
  `);
  await sleep(1400);
  const afterStructure = await callApi(page, `window.adbApi.packagesScan()`);
  record(
    afterStructure && afterStructure.pending === 4,
    'D1 切成「类型优先」后 4 个文件都需要重新归置',
    `pending=${afterStructure && afterStructure.pending}`,
  );
  await callApi(page, `window.adbApi.packagesOrganize()`);
  record(at('官网包/2.83/release/Domino_GW_V2.83_release_18.apk'), 'D2 文件真的落到 官网包/2.83/release');
  record(at('单包/8.0.50/weixin_8.0.50.apk'), 'D3 单包落到 单包/8.0.50');

  record(await page.evalJS(setInput('.pkg-dir-grid input', 'official-dev', 0)), 'D4 能改「官网包目录」的名字');
  await sleep(1100);
  const saved3 = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(saved3 && saved3.packageDirNames && saved3.packageDirNames.official === 'official-dev'),
    'D5 目录名改动落盘',
    JSON.stringify(saved3 && saved3.packageDirNames),
  );
  await callApi(page, `window.adbApi.packagesOrganize()`);
  record(at('official-dev/2.83/release/Domino_GW_V2.83_release_18.apk'), 'D6 按新目录名归置到位');

  await page.evalJS(`
    (() => {
      const b = [...document.querySelectorAll('.pkg-rule-row button')]
        .find((x) => x.textContent.includes('恢复默认目录名'));
      if (b) b.click();
      return true;
    })()
  `);
  await sleep(1100);
  const saved4 = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(saved4 && saved4.packageDirNames.official === '官网包'),
    'D7 恢复默认目录名生效',
    String(saved4 && saved4.packageDirNames.official),
  );

  /* ============ F. 手动标签（改划分不对的包） ============ */
  log('---- F. 手动标签 ----');
  // 先切回「版本优先」（上一节切成了类型优先），让后面的目录断言好写
  await page.evalJS(`
    (() => {
      const seg = [...document.querySelectorAll('.pkg-rule-row .segmented-item')]
        .find((b) => b.textContent.includes('版本 / 类型'));
      if (seg) seg.click();
      return true;
    })()
  `);
  await sleep(1400);
  await callApi(page, `window.adbApi.packagesOrganize()`);
  await sleep(600);

  const TARGET = 'weixin_8.0.50.apk';
  record(await clickByName(page, 'data-pkg-tag', TARGET), 'F1 能点开某一行的「改标签」');
  record(
    await waitFor(page, `document.querySelector('[data-pkg-editor]')`, 5000),
    'F2 出现行内标签编辑器（类型 / 通道 / 版本）',
  );

  await page.evalJS(`
    (() => {
      const b = document.querySelector('[data-pkg-editor] [data-pkg-edit="kind"][data-pkg-value="official"]');
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(250);
  await page.evalJS(setInput('[data-pkg-editor] [data-pkg-edit-version]', '9.9.9'));
  await sleep(250);
  await page.evalJS(`
    (() => {
      const b = [...document.querySelectorAll('[data-pkg-editor] button')]
        .find((x) => x.textContent.includes('保存标签'));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(1400);

  const ov = await callApi(page, `window.adbApi.getSettings()`);
  const ovMap = (ov && ov.packageOverrides) || {};
  record(
    !!(ovMap[TARGET] && ovMap[TARGET].kind === 'official' && ovMap[TARGET].version === '9.9.9'),
    'F3 手动标签落盘到 settings.packageOverrides',
    JSON.stringify(ovMap),
  );
  const rowText = await page.evalJS(
    `(() => { const r = document.querySelector('[data-pkg-name="${TARGET}"]'); return r ? r.textContent : ''; })()`,
  );
  record(
    typeof rowText === 'string' && rowText.includes('手动'),
    'F4 行上标出「手动」（一眼看出哪些是人工改过的）',
    String(rowText).slice(0, 80),
  );

  await callApi(page, `window.adbApi.packagesOrganize()`);
  record(at('9.9.9/官网包/release/weixin_8.0.50.apk'), 'F5 整理按手动标签把它搬到 9.9.9/官网包/release');

  await clickByName(page, 'data-pkg-tag', TARGET);
  await sleep(500);
  record(
    await page.evalJS(`
      (() => {
        const b = document.querySelector('[data-pkg-tag-reset]');
        if (!b) return false;
        b.click();
        return true;
      })()
    `),
    'F6 编辑器里提供「恢复自动识别」',
  );
  await sleep(1400);
  const ov2 = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !(ov2 && ov2.packageOverrides && ov2.packageOverrides[TARGET]),
    'F7 恢复自动识别后手动标签被删掉（改错了能回头）',
    JSON.stringify((ov2 && ov2.packageOverrides) || {}),
  );

  /* ============ E. 安全闸门 ============ */
  log('---- E. 安全闸门 ----');
  await callApi(page, `window.adbApi.setSettings({ packageRootDir: 'D:\\\\' })`);
  await page.reload();
  await gotoPackageTab(page, 2000);
  const guard = await page.evalJS(`
    (() => { const n = document.querySelector('.notice'); return n ? n.textContent : ''; })()
  `);
  record(
    typeof guard === 'string' && guard.includes('盘符根'),
    'E1 工作目录设成盘符根时给出明确提示（不会去整理整个磁盘）',
    guard.slice(0, 70),
  );
  await page.screenshot(path.join(OUT, 'install-packages-guard.png'));

  /* ---------- 还原用户设置（只读扫描真实目录，不自动整理） ---------- */
  await callApi(
    page,
    `window.adbApi.setSettings(${JSON.stringify({ ...ctx.backup, packageAutoOrganize: false })})`,
  );
  await page.reload();
  await gotoPackageTab(page, 2500);
  const back = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(back && back.packageRootDir === ctx.backup.packageRootDir),
    'E2 真实工作目录已还原',
    `${back && back.packageRootDir} vs ${ctx.backup.packageRootDir}`,
  );
  await callApi(page, `window.adbApi.setSettings(${JSON.stringify(ctx.backup)})`);
  const finalSettings = await callApi(page, `window.adbApi.getSettings()`);
  record(
    !!(finalSettings && finalSettings.packageAutoOrganize === ctx.backup.packageAutoOrganize),
    'E3 自动整理开关等原设置已还原',
    JSON.stringify({
      auto: finalSettings && finalSettings.packageAutoOrganize,
      filter: finalSettings && finalSettings.packageFilters && finalSettings.packageFilters.keyword,
    }),
  );
  record(
    JSON.stringify((finalSettings && finalSettings.packageOverrides) || {}) ===
      JSON.stringify(ctx.backup.packageOverrides || {}),
    'E4 手动标签表也还原成用户原来那份',
    JSON.stringify((finalSettings && finalSettings.packageOverrides) || {}),
  );
}

async function finish(errors) {
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  log('===== PACKAGES UI CHECK =====');
  for (const r of rows) log(r);
  if (errors.length) {
    log('===== RENDERER ERRORS =====');
    for (const e of errors) log(e);
  } else {
    log('渲染层无错误');
  }
  log(`${pass} 通过 / ${fail} 失败`);
  log('PACKAGES UI CHECK DONE');
  return fail === 0;
}

/* ------------------------------------------------------------------ */

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) {
  log('FATAL 未在 Electron 运行时中执行（请用 run-electron.py 起）');
  process.exit(2);
}
const { app, BrowserWindow } = electronMain;

/** 临时工作目录 + 样例包（真文件，才能验证「真的移动了」） */
function makeFixtureRoot() {
  const root = path.join(os.tmpdir(), `adb-assistant-pkgui-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const put = (name, bytes) => fs.writeFileSync(path.join(root, name), Buffer.alloc(bytes, 7));
  put('Domino_GW_V2.83_release_18.apk', 40 * 1024);
  put('Domino_GW_V2.84_test_5.apk', 30 * 1024);
  put('app-dmno_release-release_10.aab', 60 * 1024);
  put('weixin_8.0.50.apk', 20 * 1024);
  fs.writeFileSync(path.join(root, '说明.txt'), 'not-a-package');
  return root;
}

const TEST_SETTINGS = {
  packageDirNames: {
    official: '官网包',
    google: 'Google包',
    single: '单包',
    release: 'release',
    test: 'test',
    unknownVersion: '未识别版本',
  },
  packageStructure: 'version-first',
  packageAutoOrganize: true,
  packageFilters: { versions: [], kinds: [], channels: [], formats: [], keyword: '' },
  packageOverrides: {},
};

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
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
    if (level >= 2) errors.push(msg);
  });

  const page = {
    evalJS: (expr) => win.webContents.executeJavaScript(expr),
    reload: async () => {
      win.webContents.reload();
      await sleep(3000);
    },
    screenshot: async (file) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
    },
    close: () => {},
  };

  const root = makeFixtureRoot();
  await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
  await sleep(2000);

  // 先备份用户设置，再把工作目录指到临时目录（之后模块才会挂载，真实目录不会被碰）
  const before = await page.evalJS(`(async () => await window.adbApi.getSettings())()`);
  const s = before && before.ok ? before.data : {};
  const backup = {
    packageRootDir: s.packageRootDir,
    packageDirNames: s.packageDirNames,
    packageStructure: s.packageStructure,
    packageAutoOrganize: s.packageAutoOrganize,
    packageFilters: s.packageFilters,
    packageOverrides: s.packageOverrides,
  };
  log('原设置备份:', JSON.stringify(backup));

  await page.evalJS(
    `(async () => await window.adbApi.setSettings(${JSON.stringify({ ...TEST_SETTINGS, packageRootDir: root })}))()`,
  );
  await page.reload();

  try {
    await runChecks(page, { root, backup });
  } catch (e) {
    record(false, '用例执行异常', e.message);
    log('STACK', e.stack || '');
    try {
      await page.evalJS(
        `(async () => await window.adbApi.setSettings(${JSON.stringify({ ...backup, packageAutoOrganize: false })}))()`,
      );
      log('异常退出前已还原用户设置（自动整理暂时关闭，避免动真实目录）');
    } catch {
      log('⚠️ 还原设置失败，请手动检查 settings.json 的 packageRootDir');
    }
  }

  fs.rmSync(root, { recursive: true, force: true });

  const ok = await finish(errors);
  app.exit(ok ? 0 : 1);
});
