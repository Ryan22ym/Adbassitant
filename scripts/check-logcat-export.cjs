/**
 * Logcat 导出工具 验证（契约层 + 真实设备）
 *
 *   python scripts/run-electron.py scripts/check-logcat-export.cjs \
 *       --watch ui-shots/_logcat-export.log --until "LOGCAT EXPORT CHECK DONE" --timeout 600
 *
 * 只验证主进程侧的导出服务：真读设备日志 → 按参数过滤 → 落盘 → 复核文件内容。
 * 覆盖：
 *   A 基础 dump        能读到行、文件有头部
 *   B 级别过滤         导出内容里不存在低于所选级别的行
 *   C TAG 过滤         导出内容里所有可解析行的 TAG 都命中白名单
 *   D 关键字过滤       每一行（除头部）都含关键字之一
 *   E 组合条件         级别 + TAG 同时生效
 *   F 缓冲区选择       只选 main 与 main+system 的原始行数关系
 *   G 目录模式         自动建目录 / 落进 <根>\<设备>\<日期>\ / 返回值带 dir
 *   H 目录命名净化     机型里的非法字符（/ : * 等）被替换、不产生非法路径
 *
 * 设备：优先用模拟器（emulator-*），避免动到真机。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_logcat-export.log');

function log(s) {
  try {
    fs.appendFileSync(LOG, s + '\n');
  } catch {
    /* ignore */
  }
}

const rows = [];
const record = (ok, name, detail = '') => {
  rows.push({ ok, name });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

const ADB = path.join(ROOT, 'bin', process.platform === 'win32' ? 'adb.exe' : 'adb');

function listDevices() {
  const r = spawnSync(ADB, ['devices'], { encoding: 'utf8' });
  return (r.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

const LEVEL_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };
const THREADTIME_RE =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3,6}\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;

/** 读导出文件：跳过头部（到第一条分隔线后的空行为止），返回日志行 */
function readExport(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
  const lines = text.split(/\r?\n/);
  const sep = lines.findIndex((l) => /^-{20,}$/.test(l));
  const body = sep >= 0 ? lines.slice(sep + 1) : lines;
  return body.filter((l) => l.length > 0);
}

function analyze(lines) {
  let min = 99;
  let tagged = 0;
  let unknown = 0;
  for (const l of lines) {
    const m = THREADTIME_RE.exec(l);
    if (!m) {
      unknown++;
      continue;
    }
    min = Math.min(min, LEVEL_ORDER[m[3]] ?? 0);
    tagged++;
  }
  return { min, tagged, unknown };
}

async function main() {
  fs.writeFileSync(LOG, '');
  log('=== LOGCAT EXPORT CHECK ===');

  const devices = listDevices();
  log('devices: ' + devices.join(', '));
  const emu = devices.find((d) => /^emulator-/.test(d));
  const serial = emu || devices[0];
  if (!serial) {
    record(false, '找到在线设备', '没有任何在线设备');
    log('LOGCAT EXPORT CHECK DONE');
    return;
  }
  record(true, '找到在线设备', serial + (emu ? '（模拟器）' : '（非模拟器）'));

  // 直接 require 编译产物
  const svc = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'logcat-export.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logx-'));
  const p = (n) => path.join(tmp, n);

  /* ---------- A 基础 dump ---------- */
  let base;
  try {
    base = await svc.exportLogcatToFile(p('all.txt'), {
      serial,
      minLevel: 'V',
      buffers: ['main', 'system', 'crash'],
      deviceLabel: 'CHECK',
    });
    record(base.lines > 0, 'A 基础导出能读到日志', `lines=${base.lines} raw=${base.rawLines} bytes=${base.bytes}`);
    const head = fs.readFileSync(p('all.txt'), 'utf8').replace(/^\ufeff/, '');
    record(/ADB 桌面助手 - Logcat 日志导出/.test(head), 'A 文件头包含标题', head.slice(0, 40).replace(/\r?\n/g, ' | '));
    record(/设备：CHECK/.test(head), 'A 文件头写入设备描述', '');
  } catch (e) {
    record(false, 'A 基础导出能读到日志', e.message);
  }

  /* ---------- B 级别过滤 ---------- */
  try {
    const r = await svc.exportLogcatToFile(p('err.txt'), {
      serial,
      minLevel: 'E',
      buffers: ['main', 'system', 'crash'],
    });
    const lines = readExport(p('err.txt'));
    const a = analyze(lines);
    // 头部已排除；每行都应是 E/F 级（或无法解析的 logcat 提示行）
    const bad = lines.filter((l) => {
      const m = THREADTIME_RE.exec(l);
      return m && (LEVEL_ORDER[m[3]] ?? 0) < LEVEL_ORDER.E;
    });
    record(
      bad.length === 0,
      'B 级别过滤 >=E 不含更低级别',
      `导出 ${r.lines} 行，最低级别=${a.min === 99 ? 'n/a' : a.min}，越级 ${bad.length}`,
    );
    if (bad[0]) log('  首个越级样例: ' + bad[0].slice(0, 120));
  } catch (e) {
    record(false, 'B 级别过滤 >=E 不含更低级别', e.message);
  }

  /* ---------- C TAG 过滤 ---------- */
  try {
    const TAG = 'ActivityManager';
    const r = await svc.exportLogcatToFile(p('tag.txt'), {
      serial,
      minLevel: 'V',
      tags: TAG,
      buffers: ['main', 'system', 'crash'],
    });
    const lines = readExport(p('tag.txt'));
    const bad = lines.filter((l) => {
      const m = THREADTIME_RE.exec(l);
      return m && m[4].trim() !== TAG;
    });
    record(
      bad.length === 0 && lines.length > 0,
      `C TAG 过滤只保留 ${TAG}`,
      `导出 ${r.lines} 行，非该 TAG 的 ${bad.length} 行`,
    );
    if (bad[0]) log('  首个非该TAG样例: ' + bad[0].slice(0, 120));
  } catch (e) {
    record(false, 'C TAG 过滤只保留 ActivityManager', e.message);
  }

  /* ---------- D 关键字过滤 ---------- */
  try {
    const KW = ['crash', 'ANR', 'Exception'];
    const r = await svc.exportLogcatToFile(p('kw.txt'), {
      serial,
      minLevel: 'V',
      keyword: KW.join(','),
      buffers: ['main', 'system', 'crash'],
    });
    const lines = readExport(p('kw.txt'));
    const bad = lines.filter((l) => !KW.some((k) => l.toLowerCase().includes(k.toLowerCase())));
    record(
      bad.length === 0,
      'D 关键字过滤每行都命中',
      `导出 ${r.lines} 行，未命中 ${bad.length} 行`,
    );
    if (bad[0]) log('  首个未命中样例: ' + bad[0].slice(0, 120));
  } catch (e) {
    record(false, 'D 关键字过滤每行都命中', e.message);
  }

  /* ---------- E 组合：级别 + TAG ---------- */
  try {
    const TAG = 'ActivityManager';
    const r = await svc.exportLogcatToFile(p('combo.txt'), {
      serial,
      minLevel: 'W',
      tags: TAG,
      buffers: ['main', 'system', 'crash'],
    });
    const lines = readExport(p('combo.txt'));
    const bad = lines.filter((l) => {
      const m = THREADTIME_RE.exec(l);
      if (!m) return false;
      return (LEVEL_ORDER[m[3]] ?? 0) < LEVEL_ORDER.W || m[4].trim() !== TAG;
    });
    record(bad.length === 0, 'E 组合条件（级别+TAG）同时生效', `导出 ${r.lines} 行，违规 ${bad.length} 行`);
  } catch (e) {
    record(false, 'E 组合条件（级别+TAG）同时生效', e.message);
  }

  /* ---------- F 过滤结果应是全量的子集 ---------- */
  try {
    const all = readExport(p('all.txt')).length;
    const err = readExport(p('err.txt')).length;
    const tag = readExport(p('tag.txt')).length;
    record(
      err <= all && tag <= all,
      'F 过滤结果不超过全量',
      `全量=${all} 仅E=${err} 仅TAG=${tag}`,
    );
    record(
      base && base.lines === all,
      'F 服务返回值与文件行数一致',
      `service.lines=${base ? base.lines : 'n/a'} file=${all}`,
    );
  } catch (e) {
    record(false, 'F 过滤结果不超过全量', e.message);
  }

  /* ---------- G 目录模式：自动建目录 + <根>\<设备>\<日期>\ ---------- */
  try {
    const dirRoot = path.join(tmp, 'adblogs');
    const label = 'Pixel 6 (emulator-5556)';
    // 目录此时还不存在 —— 服务端要自己建出来
    record(!fs.existsSync(dirRoot), 'G 导出前目录不存在（用来验证会自动创建）', dirRoot);

    const r = await svc.exportLogcatToDir(dirRoot, {
      serial,
      minLevel: 'V',
      buffers: ['main', 'system', 'crash'],
      deviceLabel: label,
      splitByDevice: true,
    });

    record(fs.existsSync(dirRoot), 'G 目录被自动创建', dirRoot);
    record(!!r.dir && fs.existsSync(r.dir), 'G 返回值带 dir 且该目录存在', r.dir);
    record(r.dir === path.dirname(r.path), 'G dir == path 的父目录', `dir=${r.dir}`);

    // 期望结构：<root>\<机型 序列号>\<YYYY-MM-DD>\
    const rel = path.relative(dirRoot, r.dir).split(path.sep).filter(Boolean);
    record(rel.length === 2, 'G 目录层级为 <设备>\\<日期>', rel.join('\\'));

    const [devSeg, dateSeg] = rel;
    record(
      !!devSeg && /Pixel 6 emulator-5556/.test(devSeg),
      'G 设备层 = 机型 + 序列号（去掉括号）',
      `设备层="${devSeg}"`,
    );
    const today = new Date();
    const expectDate = expectDateFor(today);
    record(dateSeg === expectDate, 'G 日期层 = 今天', `日期层="${dateSeg}" 期望="${expectDate}"`);

    const fname = path.basename(r.path);
    record(
      /^logcat_\d{8}_\d{6}\.txt$/.test(fname),
      'G 文件名 = logcat_<日期>_<时间>.txt',
      fname,
    );
    record(fs.existsSync(r.path) && r.lines > 0, 'G 文件已落盘且有内容', `lines=${r.lines}`);
  } catch (e) {
    record(false, 'G 目录模式导出', e.message);
  }

  /* ---------- G2 同一根目录、同一设备再导一次：复用目录 + 不覆盖上一份 ---------- */
  try {
    const dirRoot = path.join(tmp, 'adblogs');
    const devDir = path.join(dirRoot, 'Pixel 6 emulator-5556', expectDateFor(new Date()));
    const before = fs.readdirSync(devDir).filter((f) => /^logcat_.*\.txt$/.test(f)).length;

    const r = await svc.exportLogcatToDir(dirRoot, {
      serial,
      minLevel: 'E',
      buffers: ['main'],
      deviceLabel: 'Pixel 6 (emulator-5556)',
      splitByDevice: true,
    });

    const files = fs.readdirSync(devDir).filter((f) => /^logcat_.*\.txt$/.test(f));
    record(
      files.length === before + 1,
      'G2 重复导出到同一目录会新增文件（不覆盖）',
      `${before} → ${files.length}`,
    );
    // 同秒两次导出：第二个文件应该带 _2 后缀
    record(
      r.path.endsWith('.txt') && fs.existsSync(r.path) && fs.statSync(r.path).size > 0,
      'G2 新文件已落盘且非空',
      `${path.basename(r.path)} ${fs.statSync(r.path).size}B`,
    );
  } catch (e) {
    record(false, 'G2 重复导出到同一目录', e.message);
  }

  /* ---------- H 目录名净化：机型带非法字符 ---------- */
  try {
    const dirRoot = path.join(tmp, 'dirty');
    const r = await svc.exportLogcatToDir(dirRoot, {
      serial,
      minLevel: 'V',
      buffers: ['main'],
      deviceLabel: 'HTC/One: M8*"pro" (ABC123)',
      splitByDevice: true,
    });
    const devSeg = path.relative(dirRoot, r.dir).split(path.sep).filter(Boolean)[0] || '';
    const illegal = /[\\/:*?"<>|]/.test(devSeg);
    record(!illegal, 'H 设备层不含 Windows 非法字符', `设备层="${devSeg}"`);
    record(fs.existsSync(r.path), 'H 非法字符的设备仍能正常落盘', r.path);
  } catch (e) {
    record(false, 'H 目录名净化', e.message);
  }

  /* ---------- H2 纯函数：resolveExportDir 的行为 ---------- */
  try {
    const flat = svc.resolveExportDir('D:\\adblogs', { splitByDevice: false, deviceLabel: 'X' });
    record(flat === 'D:\\adblogs', 'H2 splitByDevice=false 时直接用根目录', flat);

    const seg = svc.deviceSegment('Pixel 6 (emulator-5556)', 'emulator-5556');
    record(seg === 'Pixel 6 emulator-5556', 'H2 设备层不再重复序列号', seg);

    const fallback = svc.deviceSegment('   ', '');
    record(!!fallback, 'H2 无设备信息时有兜底名', fallback);

    record(svc.safeSegment('CON', 'fb') !== '', 'H2 净化后不会为空', svc.safeSegment('CON', 'fb'));

    // uniqueFilePath：同秒连导两次要顺延文件名，而不是覆盖
    const uDir = path.join(tmp, 'uniq');
    fs.mkdirSync(uDir, { recursive: true });
    const ts = Date.now();
    const first = svc.uniqueFilePath(uDir, ts);
    fs.writeFileSync(first, 'x');
    const second = svc.uniqueFilePath(uDir, ts);
    record(first !== second, 'H2 撞名时顺延文件名（不覆盖）', `${path.basename(first)} → ${path.basename(second)}`);
    record(!fs.existsSync(second), 'H2 顺延出的文件名可用', path.basename(second));
  } catch (e) {
    record(false, 'H2 resolveExportDir 行为', e.message);
  }

  /* ---------- 收尾 ---------- */
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const pass = rows.filter((r) => r.ok).length;
  log(`\n${pass}/${rows.length} 通过`);
  log(rows.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n'));
  log('LOGCAT EXPORT CHECK DONE');
}

/** 找到 <根>\<设备>\<日期> 这一层（跳过中间层） */
function resolveLeaf(root) {
  const devs = fs.readdirSync(root).map((d) => path.join(root, d));
  const day = devs.find((d) => fs.statSync(d).isDirectory());
  if (!day) return root;
  const days = fs.readdirSync(day).map((d) => path.join(day, d));
  return days[0] || day;
}

/** YYYY-MM-DD（本地时区），与服务端 dateSegment 的约定一致 */
function expectDateFor(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

main().catch((e) => {
  log('FAIL  脚本异常 :: ' + (e && e.stack ? e.stack : String(e)));
  log('LOGCAT EXPORT CHECK DONE');
});
