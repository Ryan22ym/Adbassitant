/**
 * 应用图标链路回归自检（npm run check:icon）。
 *
 * 覆盖四件事：
 *   1. 图标产物齐全且一致 —— make-icon.py 那几个输出少一个，某处的图标就会停在旧版
 *      （exe / 安装程序 / 窗口 / 快捷方式 / 侧栏分别吃不同的文件，缺哪个坏哪个）；
 *   2. 图标**四角是透明的** —— 源图的圆角底色没清掉时，任务栏里就是「四角白方块」；
 *   3. 运行期窗口图标能从 asar 内那份读出来（这是「在线更新也能换图标」的前提）；
 *   4. 快捷方式图标刷新逻辑真的能改 lnk 的 IconLocation，并且幂等、不误伤别人的快捷方式。
 *
 * ⚠️ 第 4 项刻意在**临时目录**里造假的 lnk、并只把临时目录传给 refreshShortcutIcons ——
 *    绝不碰用户桌面上真实的快捷方式。userData 由 run-electron 指向临时目录，
 *    所以写入的 ico 也不会污染真实环境。
 *
 * 用法：python scripts/run-electron.py scripts/check-app-icon.cjs \
 *         --watch ui-shots/_icon.log --until "ICON CHECK DONE"
 */
const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, shell, nativeImage } = electronMain;
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_icon.log');
fs.writeFileSync(LOG, '');
const log = (s) => fs.appendFileSync(LOG, s + '\n');

const rows = [];
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (ok) pass++;
  else fail++;
}

/** 读 ICO 目录，返回里面都塞了哪些边长（0 表示 256） */
function icoSizes(buf) {
  if (buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const n = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    sizes.push(buf[off] === 0 ? 256 : buf[off]);
  }
  return sizes;
}

app.whenReady().then(() => {
  /* ---------- 1. 产物 ---------- */
  const artifacts = {
    'build/icon.png': 'exe / 安装程序 / 通用图标源图',
    'build/icon.ico': 'exe 与安装程序图标',
    'bin/icon.png': '随包资源（scrcpy portable 图标位）',
    'electron/assets/app-icon.png': '运行期窗口 / 任务栏图标',
    'electron/assets/app-icon.ico': '快捷方式图标',
    'src/assets/app-icon.png': '侧栏品牌标记',
  };
  for (const [rel, why] of Object.entries(artifacts)) {
    const p = path.join(ROOT, ...rel.split('/'));
    check(`产物存在 ${rel}`, fs.existsSync(p) && fs.statSync(p).size > 0, why);
  }

  const icoA = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
  const icoB = fs.readFileSync(path.join(ROOT, 'electron', 'assets', 'app-icon.ico'));
  check('两份 ico 字节一致', icoA.equals(icoB));

  const sizes = icoSizes(icoA);
  check('ico 是多尺寸', !!sizes && sizes.length >= 5, sizes ? sizes.join(',') : '解析失败');
  for (const s of [16, 32, 48, 256]) {
    check(`ico 含 ${s}px`, !!sizes && sizes.includes(s));
  }

  // 16px 没有的话任务栏会糊；有 256 才能在大图标视图下清楚 —— 这条是 make-icon.py 的存在理由
  const brand = fs.statSync(path.join(ROOT, 'src', 'assets', 'app-icon.png'));
  check('侧栏图不超过 64KB（别把 1MB 大图打进 bundle）', brand.size < 64 * 1024, brand.size + ' B');

  /*
   * 四角必须透明。
   * 源图是「带底色圆角方块」，四角那圈底色如果没被 punch_background 清掉，
   * Windows 按方形边界渲染 —— 任务栏 / 桌面快捷方式 / 开始菜单里就是「四角白色的小方块」。
   * 这条以前没人守，直到用户报上来才发现，所以固化成断言。
   */
  for (const rel of ['src/assets/app-icon.png', 'electron/assets/app-icon.png']) {
    const im = nativeImage.createFromPath(path.join(ROOT, ...rel.split('/')));
    const sz = im.getSize();
    const bmp = im.isEmpty() ? null : im.toBitmap(); // BGRA，alpha 在 +3
    const alphaAt = (x, y) => (bmp ? bmp[(y * sz.width + x) * 4 + 3] : 255);
    const corners = [
      alphaAt(0, 0),
      alphaAt(sz.width - 1, 0),
      alphaAt(0, sz.height - 1),
      alphaAt(sz.width - 1, sz.height - 1),
    ];
    check(
      `四角透明 ${rel}`,
      !!bmp && corners.every((a) => a < 16),
      `${sz.width}x${sz.height} 四角 alpha=${corners.join(',')}`,
    );
  }

  /* ---------- 2. 编译产物里的图标 ---------- */
  const distPng = path.join(ROOT, 'dist-electron', 'assets', 'app-icon.png');
  const distIco = path.join(ROOT, 'dist-electron', 'assets', 'app-icon.ico');
  check('dist-electron/assets 里有 app-icon.png', fs.existsSync(distPng), 'copy-assets.cjs 是否跑过');
  check('dist-electron/assets 里有 app-icon.ico', fs.existsSync(distIco));

  // 渲染层 bundle 必须带上侧栏那份（否则侧栏 brand-mark 会是裂图）
  const distAssets = path.join(ROOT, 'dist', 'assets');
  const bundled = fs.existsSync(distAssets)
    ? fs.readdirSync(distAssets).filter((f) => /^app-icon-.*\.png$/.test(f))
    : [];
  check('渲染层 bundle 含品牌图标', bundled.length > 0, bundled.join(','));

  // main.ts 就是按这个相对位置找图标的：dist-electron/electron → ../assets
  const fromMain = path.join(ROOT, 'dist-electron', 'electron', '..', 'assets', 'app-icon.png');
  const img = nativeImage.createFromPath(fromMain);
  check('nativeImage 能读出窗口图标', !img.isEmpty(), `${img.getSize().width}x${img.getSize().height}`);

  /* ---------- 3. 快捷方式刷新 ---------- */
  let shortcuts = null;
  try {
    shortcuts = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'shortcuts.js'));
  } catch (e) {
    check('加载 shortcuts.js', false, e.message);
  }

  if (shortcuts) {
    const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'adbi-'));
    const fakeOld = path.join(tmp, 'legacy.ico');
    fs.writeFileSync(fakeOld, Buffer.from([0, 0, 1, 0])); // 随便一个旧图标文件

    const mine = path.join(tmp, 'mine.lnk');
    const other = path.join(tmp, 'other.lnk');
    const nowhere = path.join(tmp, 'nowhere.lnk');
    shell.writeShortcutLink(mine, 'create', { target: process.execPath, icon: fakeOld, iconIndex: 0 });
    shell.writeShortcutLink(other, 'create', {
      target: path.join(app.getPath('temp'), 'definitely-not-this-app.exe'),
      icon: fakeOld,
      iconIndex: 0,
    });
    // 本应用 exe 但图标已经是新的 → 应该被判为「不用改」
    check('造出测试用 lnk', fs.existsSync(mine) && fs.existsSync(other));

    // 先塞一个历史版本的图标文件，验证会被清理
    const iconDir = path.join(app.getPath('userData'), 'icons');
    fs.mkdirSync(iconDir, { recursive: true });
    const stale = path.join(iconDir, 'app-0.0.1.ico');
    fs.writeFileSync(stale, Buffer.from([0, 0, 1, 0]));

    shortcuts.refreshShortcutIcons(path.join(ROOT, 'dist-electron', 'electron'), [tmp]);

    const after = shell.readShortcutLink(mine);
    const want = path.join(iconDir, `app-${app.getVersion()}.ico`);
    check('本应用快捷方式的图标被改写', String(after.icon).toLowerCase() === want.toLowerCase(), after.icon);
    check('图标文件确实落地', fs.existsSync(want), want);
    check('图标文件内容与资源一致', fs.readFileSync(want).equals(fs.readFileSync(distIco)));
    check('target 仍是本进程 exe', String(after.target).toLowerCase() === process.execPath.toLowerCase(), after.target);

    const otherAfter = shell.readShortcutLink(other);
    check('别人的快捷方式没被动', String(otherAfter.icon).toLowerCase() === fakeOld.toLowerCase(), otherAfter.icon);

    check('历史版本的图标被清理', !fs.existsSync(stale), stale);
    check('不存在本应用快捷方式时不报错', (() => {
      try {
        shortcuts.refreshShortcutIcons(path.join(ROOT, 'dist-electron', 'electron'), [path.join(tmp, 'empty')]);
        return true;
      } catch {
        return false;
      }
    })());

    // 幂等：再跑一次不该改变结果（也不该崩）
    shortcuts.refreshShortcutIcons(path.join(ROOT, 'dist-electron', 'electron'), [tmp]);
    const again = shell.readShortcutLink(mine);
    check('重复执行结果不变', String(again.icon).toLowerCase() === want.toLowerCase(), again.icon);

    check('找得到 ico 资源', !!shortcuts.appIconIcoPath(path.join(ROOT, 'dist-electron', 'electron')));
    void nowhere;
  }

  log('=== ICON CHECK ===');
  for (const r of rows) log(r);
  log(`=== ${pass} 通过 / ${fail} 失败 ===`);
  log('ICON CHECK DONE');
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
