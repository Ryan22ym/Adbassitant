/**
 * 设备列表的「是否模拟器」判定验证（纯 Node，直连 dist-electron，秒级）
 *
 * 为什么单独立一个脚本
 * ---------------------------------------------------------------
 * `isEmulator` 是「默认优先物理设备」「多设备弹窗里的 手机/模拟器 标签」
 * 这些决策的唯一依据。它一旦判错，界面和日志全都是正常的样子 ——
 * 用户拖包进来照样显示「安装成功」，只是装到了模拟器上。
 *
 * 真实踩过的坑：常见模拟器把 `model` 伪装成真机型号（我们的两个模拟器报
 * `PGT_AN00` / `SM_S9210`），而最早的判据只看 `model`，于是模拟器被判成手机。
 * 这个脚本把「simulator 前缀 / 型号伪装」两种情形都钉住。
 *
 * 跑法：node scripts/check-device-order.cjs      （或 npm run check:device-order）
 * 需要至少一台设备在线；没有模拟器在线时会明确指出「本机没模拟器，未覆盖该分支」。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const adb = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'adb.js'));

let pass = 0;
let fail = 0;

function check(cond, name, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? '  ::  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? '  ::  ' + detail : ''}`);
  }
}

function info(t) {
  console.log(`INFO  ${t}`);
}

/** 期望的判定：serial 前缀是硬判据 */
const shouldBeEmulator = (d) => /^emulator-/i.test(d.serial);

(async () => {
  console.log('===== 设备判定 CHECK =====');

  const shallow = await adb.listDevices(false);
  const deep = await adb.listDevices(true);

  check(shallow.length > 0, '能读到设备列表（adb 可用）', `共 ${shallow.length} 台`);

  /* 浅查（不补 getprop）：这里曾经把模拟器判成手机 */
  for (const d of shallow) {
    const want = shouldBeEmulator(d);
    check(
      d.isEmulator === want,
      `浅查 isEmulator 正确：${d.serial}`,
      `isEmulator=${d.isEmulator} 期望=${want} model=${d.model ?? '-'}`,
    );
  }

  /* 深查（补了 getprop 之后会 Object.assign 覆盖 isEmulator）*/
  for (const d of deep) {
    const want = shouldBeEmulator(d);
    check(
      d.isEmulator === want,
      `深查 isEmulator 正确：${d.serial}`,
      `isEmulator=${d.isEmulator} 期望=${want} model=${d.model ?? '-'}`,
    );
  }

  /* 两条路径必须给出同一个答案，否则「先列一次再补详情」会前后矛盾 */
  const shallowMap = new Map(shallow.map((d) => [d.serial, d.isEmulator]));
  const mismatch = deep.filter((d) => shallowMap.has(d.serial) && shallowMap.get(d.serial) !== d.isEmulator);
  check(
    mismatch.length === 0,
    '浅查与深查的 isEmulator 一致',
    mismatch.length === 0 ? '全部一致' : JSON.stringify(mismatch.map((d) => d.serial)),
  );

  const emus = deep.filter((d) => d.isEmulator);
  const reals = deep.filter((d) => !d.isEmulator);
  info(`在线设备：物理 ${reals.map((d) => d.serial).join('、') || '（无）'} ｜ 模拟器 ${emus.map((d) => d.serial).join('、') || '（无）'}`);

  if (emus.length === 0) {
    info('本机没有模拟器在线，未覆盖「模拟器判成手机」这一分支（本次判为通过，详情见上）');
  }

  /* 「默认优先物理设备」这条规则必须有可判定的输入 —— 有模拟器时也得有物理设备 */
  if (emus.length > 0) {
    check(
      reals.length > 0,
      '模拟器与物理设备能区分开（默认目标才可能落到手机上）',
      `物理 ${reals.length} 台 / 模拟器 ${emus.length} 台`,
    );
  }

  console.log('===== INFO =====');
  console.log(`结果 ${pass} 通过 / ${fail} 失败`);
  console.log('DEVICE ORDER CHECK DONE');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`FATAL ${e && e.message}`);
  console.log('DEVICE ORDER CHECK DONE');
  process.exit(1);
});
