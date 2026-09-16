/**
 * 探针：在真 Electron 运行时里，往磁盘写一个「名字以 .asar 结尾」的文件会怎样？
 *
 * 起因：prepareUpdate 解压小包到 %TEMP%\adba-update-<ts>\ 时，app.asar 这一步报
 *       「解压更新包失败：Invalid package C:\...\adba-update-<ts>\app.asar」。
 *       同一份代码在纯 Node 下（check-update.cjs 的 B/C 段）完全正常，
 *       所以怀疑是 Electron 的 asar fs shim 把「*.asar」当成了容器路径。
 *
 * 结论用于决定 update-core/zip 的落盘策略。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(os.tmpdir(), 'probe-asar-write-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const out = [];
out.push('electron      = ' + (process.versions.electron || '(not electron)'));
out.push('runningAsElectron = ' + (!!process.versions.electron));
out.push('dir           = ' + dir);
out.push('');

const cases = [
  ['a.bin', 'writeFileSync → a.bin'],
  ['app.asar', 'writeFileSync → app.asar'],
  ['payload.asar.new', 'writeFileSync → payload.asar.new'],
  ['x.asar.txt', 'writeFileSync → x.asar.txt'],
];

for (const [name, label] of cases) {
  const p = path.join(dir, name);
  try {
    fs.writeFileSync(p, Buffer.from('hello-' + name));
    const back = fs.readFileSync(p);
    out.push(`OK   ${label}  (${back.length}B, 读回="${back.toString()}")`);
  } catch (e) {
    out.push(`FAIL ${label}  :: ${e.message}`);
  }
}

// 目录名以 .asar 结尾时，往里写普通文件会不会也中招？
try {
  const d2 = path.join(dir, 'sub.asar');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'inner.txt'), 'hi');
  out.push('OK   writeFileSync → sub.asar/inner.txt（目录名带 .asar）');
} catch (e) {
  out.push('FAIL writeFileSync → sub.asar/inner.txt  :: ' + e.message);
}

// 低层 fd：openSync/writeSync 是否绕开 shim？
try {
  const p = path.join(dir, 'fd.asar');
  const fd = fs.openSync(p, 'w');
  fs.writeSync(fd, Buffer.from('fd-write'));
  fs.closeSync(fd);
  out.push('OK   openSync+writeSync → fd.asar  (读回="' + fs.readFileSync(p).toString() + '")');
} catch (e) {
  out.push('FAIL openSync+writeSync → fd.asar  :: ' + e.message);
}

// 大小写/后缀变体：Electron 判定是否只看后缀小写？
try {
  fs.writeFileSync(path.join(dir, 'upper.ASAR'), Buffer.from('x'));
  out.push('OK   writeFileSync → upper.ASAR（大写后缀）');
} catch (e) {
  out.push('FAIL writeFileSync → upper.ASAR  :: ' + e.message);
}

out.push('');
out.push('PROBE ASAR WRITE DONE');
fs.writeFileSync(path.join(os.tmpdir(), 'probe-asar-write.txt'), out.join('\n'), 'utf8');
console.log(out.join('\n'));
process.exit(0);
