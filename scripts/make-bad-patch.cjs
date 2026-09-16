/**
 * 把一个真实的更新小包改造成「校验能过、但换上去起不来」的坏包，用来验自动回滚。
 *
 * 为什么不能简单粗暴地改几个字节：
 *   改字节会破坏 deflate 流 → 报「解压更新包失败」→ prepareUpdate 直接拒绝 →
 *   **根本走不到替换环节**，也就测不到回滚。那测的是校验，不是回滚。
 *
 * 所以这里重写整个 zip（method=0 stored，自己算 CRC32），做到：
 *   · app.asar 的内容换成一堆垃圾字节（长度保持不变，让 manifest 的 size 依然对得上）
 *   · manifest 里 app.asar 的 sha256 同步改成垃圾内容的摘要
 *   → checkZipContents 通过 → 解压通过 → 助手真的把坏 asar 换上去 →
 *     新版本起不来 / 白屏 → 30 秒健康超时 → 自动回滚
 *
 * 用法：
 *   node scripts/make-bad-patch.cjs --zip out-v1.0.10/update/ADB桌面助手-v1.0.10-patch.zip
 *   # 产出同目录下的 ADB桌面助手-v1.0.10-patch.bad.zip
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ZIP = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'zip.js'));

const argOf = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : null;
};

const ZIP_IN = argOf('--zip');
if (!ZIP_IN) {
  console.error('用法: node scripts/make-bad-patch.cjs --zip <真实小包.zip> [--out <坏包.zip>]');
  process.exit(2);
}
const inPath = path.resolve(ROOT, ZIP_IN);
if (!fs.existsSync(inPath)) {
  console.error('小包不存在：' + inPath);
  process.exit(2);
}
const outPath = argOf('--out') ? path.resolve(ROOT, argOf('--out')) : inPath.replace(/\.zip$/, '.bad.zip');

/* ---------------- ZIP 写入（stored） ---------------- */
const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12); // 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ---------------- 主流程 ---------------- */
const buf = fs.readFileSync(inPath);
const entries = ZIP.listZipEntries(buf);
const manifestEntry = entries.find((e) => e.name === 'manifest.json');
if (!manifestEntry) {
  console.error('小包里没有 manifest.json');
  process.exit(2);
}
const manifest = JSON.parse(ZIP.readZipEntry(buf, manifestEntry).toString('utf8'));

const out = [];
const newEntries = [];

// 第一趟：先把 app.asar 换成垃圾、并把 manifest 里的 sha256/size 改对。
// 注意必须分两趟 —— manifest.json 在 zip 里的位置可能排在 app.asar **之前**，
// 一边遍历一边序列化 manifest 会写出「旧 sha256」（第一次就栽在这上面：
// 应用侧报「更新包已损坏：app.asar 校验值不匹配」，连替换环节都进不去）。
const appEntry = entries.find((e) => e.name === 'app.asar');
if (!appEntry) {
  console.error('小包里没有 app.asar');
  process.exit(2);
}
const appData = ZIP.readZipEntry(buf, appEntry);
const pattern = Buffer.from('BADPATCH-NOT-A-REAL-ASAR-ARCHIVE!', 'utf8');
const junk = Buffer.alloc(appData.length);
for (let i = 0; i < junk.length; i++) junk[i] = pattern[i % pattern.length];
const junkSha = crypto.createHash('sha256').update(junk).digest('hex');
{
  const f = (manifest.files || []).find((x) => x.path === 'app.asar');
  if (!f) {
    console.error('manifest 里没有 app.asar 条目');
    process.exit(2);
  }
  f.sha256 = junkSha;
  f.size = junk.length;
}
out.push(`app.asar: ${appData.length} B → 垃圾内容 ${junk.length} B（等长）, sha256 ${junkSha.slice(0, 16)}…`);

// 第二趟：按原顺序写新 zip（manifest 已改好）
for (const e of entries) {
  if (e.name === 'app.asar') {
    newEntries.push({ name: e.name, data: junk });
  } else if (e.name === 'manifest.json') {
    newEntries.push({ name: e.name, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  } else {
    newEntries.push({ name: e.name, data: ZIP.readZipEntry(buf, e) });
  }
}

const bad = buildZip(newEntries);
fs.writeFileSync(outPath, bad);

console.log('坏包已生成');
for (const l of out) console.log('  ' + l);
console.log('  版本(v)   : ' + manifest.version + '（与真实小包一致，所以版本校验会过）');
console.log('  输出      : ' + outPath + '  (' + (bad.length / 1024).toFixed(1) + ' KB)');
console.log('  ⚠️ 这个包**只用于验证自动回滚**，不要发给任何人');
console.log('MAKE BAD PATCH DONE');
