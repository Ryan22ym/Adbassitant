/*
 * 安装版验收（v1.1.19）：入口开关只走配置文件。
 *
 * ⚠️ 这个脚本**不启动应用、不连设备**，只读磁盘上的安装结果 ——
 *    跑它的时候用户往往正开着自己的那份在用（单实例锁会让新进程直接退出，
 *    硬起一个实例还会抢焦点）。纯文件级校验足够回答「装上去的到底是什么」：
 *
 *   I1-I2  安装目录与 app.asar 对得上
 *   I3     版本号是新版
 *   I4     写配置的 IPC（conf:setFeature）已经不在包里
 *   I5     设置页那张「左侧导航入口」卡片已经不在包里
 *   I6-I8  安装目录的 Conf/features.json 出厂 clicker=false，README 写明只能改文件
 *   I9     上新快捷动作「初始化启动」在包里
 *
 * 用法（宿主 node，几秒钟出结果）：
 *   node scripts/check-ui-entries-installed.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_v1119.log');
fs.writeFileSync(LOG, '');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

let pass = 0;
let fail = 0;
function record(ok, name, detail = '') {
  if (ok) pass++;
  else fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
}

const LOCAL = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
const INSTALL_DIR = path.join(LOCAL, 'Programs', 'ADBAssistant');
const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
const ASAR = path.join(INSTALL_DIR, 'resources', 'app.asar');
const CONF_DIR = path.join(INSTALL_DIR, 'Conf');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

record(fs.existsSync(EXE), 'I1 安装目录里有主程序', EXE);

if (!fs.existsSync(ASAR)) {
  record(false, 'I2 app.asar 可读', ASAR);
  log(`合计 ${pass} 通过 / ${fail} 失败`);
  log('V1119 INSTALLED CHECK DONE');
  process.exit(1);
}

/* asar 是二进制容器：用 latin1 做字节级包含判断，避免半个字符导致匹配漏掉 */
const buf = fs.readFileSync(ASAR);
const text = buf.toString('latin1');
const has = (s) => text.includes(Buffer.from(s, 'utf8').toString('latin1'));

record(true, 'I2 app.asar 可读', `${(buf.length / 1048576).toFixed(1)} MB`);

record(has(`"version":"${VERSION}"`) || has(`"version": "${VERSION}"`), `I3 包里版本号是 ${VERSION}`, VERSION);
record(!has('conf:setFeature'), 'I4 包里没有 conf:setFeature（写配置的 IPC 已删）', '');
record(!has('左侧导航入口'), 'I5 包里没有「左侧导航入口」卡片', '');

let conf = null;
try {
  conf = JSON.parse(fs.readFileSync(path.join(CONF_DIR, 'features.json'), 'utf8'));
} catch {
  /* 下面记失败 */
}
record(!!conf, 'I6 安装目录有 Conf/features.json', CONF_DIR);
record(
  !!conf && conf.features && conf.features.nav && conf.features.nav.clicker === false,
  'I7 出厂 nav.clicker = false（连点器默认不显示）',
  JSON.stringify(conf && conf.features && conf.features.nav),
);

let readme = '';
try {
  readme = fs.readFileSync(path.join(CONF_DIR, 'README.md'), 'utf8');
} catch {
  /* 下面记失败 */
}
record(readme.includes('只在这里改'), 'I8 README 写明左侧导航只能在配置文件里改', '');

record(has('初始化启动'), 'I9 包里有「初始化启动」快捷动作', '');

log(`合计 ${pass} 通过 / ${fail} 失败`);
log('V1119 INSTALLED CHECK DONE');
process.exit(fail ? 1 : 0);
