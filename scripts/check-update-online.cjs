#!/usr/bin/env node
/**
 * 在线更新（v1.0.22）纯逻辑与下载器验收。
 *
 * **不需要 Electron、不需要设备、不联网**（只连本机 127.0.0.1 的临时 http 服务），
 * 直接跑 `npm run check:update-online` 即可。脚本会先把主进程编译一遍
 * （被检查的是 dist-electron 里的产物，编译器过期就等于拿旧代码验收），
 * 然后几秒钟出结果。
 *
 * 覆盖：
 *  A 段 manifest 解析（parseLatestJson）15 条 —— 正常 / 版本相等 / 形态不匹配 / schema 过新 /
 *        产品不符 / appId 不符 / 通道不符 / 版本号非法 / 网关卡错误页 / 缺字段 / 空 url
 *  B 段 URL 工具（normalizeBaseUrl / latestUrlFor / resolvePackageUrl）10 条
 *  C 段 落盘文件名推导（safeFileNameFromUrl）5 条
 *  D 段 真跑本地 http 服务：GET 文本、404、拒连、下载 + sha256 校验、校验失败清理、
 *        取消、空闲超时，以及「清单 → 选包 → 下载」整链路
 *
 * 不在本脚本里的（要真 Electron / 真形态）：
 *  · 坏 zip 被 prepareUpdate 拒绝 —— 那条依赖 electron 的 app 路径，见 check-update-online-ui.cjs；
 *  · 「下载 → 替换 → 重启成新版本」端到端 —— 见 e2e-update-apply.cjs（安装版）。
 *
 * 退出码 0 = 全过；非 0 = 有 FAIL（末尾打印 pass/fail 计数）。
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/**
 * 根目录：命令行给了就用给的（兼容旧用法），没给就按脚本位置推。
 * 🔴 以前这里是 `process.argv[2]` 硬取，于是 `npm run check:update-online`
 *    （不带参数）会一路崩在 `path.join(undefined, ...)`；同时也意味着
 *    这个脚本必须由别的脚本带着路径来调，不能独立跑。
 */
const ROOT = process.argv[2] || path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist-electron', 'electron', 'services');

/**
 * 被检查的是 `dist-electron/` 里的编译产物，不是 src。
 * 编译产物过期 = 拿旧代码验收，最容易出现「本地全绿、上车就炸」。
 * 所以这里先自己编一遍（约 5~10 秒），编不过就直接判失败。
 */
function ensureBuilt() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.log('找不到 typescript（' + tsc + '），先 npm install 再跑。');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.electron.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log('主进程编译失败，验收无意义（先修 tsc）：');
    console.log((r.stdout || '') + (r.stderr || ''));
    process.exit(2);
  }
}
ensureBuilt();

const core = require(path.join(DIST, 'update-core.js'));
const net = require(path.join(DIST, 'update-net.js'));
const src = require(path.join(DIST, 'update-source.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}

const GOOD = {
  schema: 1, productName: 'ADB桌面助手', appId: 'com.xiaoyang.adbassistant',
  channel: 'stable', generatedAt: '2026-09-25T10:00:00+08:00',
  latest: {
    version: '1.0.22', publishedAt: '2026-09-25T09:50:00+08:00', notes: '修了一些东西\n第二行',
    critical: false,
    packages: {
      asar: { url: 'ADB桌面助手-v1.0.22-patch.zip', size: 163840, sha256: 'AA' },
      portable: { url: 'https://cdn.example.com/p/ADB桌面助手-v1.0.22-portable-patch.zip', size: 92274688 },
    },
  },
};

console.log('== A. parseLatestJson ==');
const cases = [
  ['正常(安装版, 有新版本)', JSON.stringify(GOOD), '1.0.21', 'asar', 'stable', r => r.ok && r.newer === true && r.pkg && r.pkg.url.endsWith('patch.zip')],
  ['版本相等 → newer=false', JSON.stringify(GOOD), '1.0.22', 'asar', 'stable', r => r.ok && r.newer === false],
  ['本机更高 → newer=false', JSON.stringify(GOOD), '1.1.0', 'asar', 'stable', r => r.ok && r.newer === false],
  ['便携版取 portable 包', JSON.stringify(GOOD), '1.0.21', 'portable', 'stable', r => r.ok && r.pkg && /https:\/\/cdn/.test(r.pkg.url)],
  ['便携版只给 asar → pkg=null', JSON.stringify({ ...GOOD, latest: { ...GOOD.latest, packages: { asar: GOOD.latest.packages.asar } } }), '1.0.21', 'portable', 'stable', r => r.ok && r.pkg === null],
  ['schema 过新 → 拒绝', JSON.stringify({ ...GOOD, schema: 2 }), '1.0.21', 'asar', 'stable', r => !r.ok && /格式版本/.test(r.reason)],
  ['productName 不符 → 拒绝', JSON.stringify({ ...GOOD, productName: '别的软件' }), '1.0.21', 'asar', 'stable', r => !r.ok && /别的软件/.test(r.reason)],
  ['appId 不符 → 拒绝', JSON.stringify({ ...GOOD, appId: 'com.other.app' }), '1.0.21', 'asar', 'stable', r => !r.ok],
  ['channel 不符 → 拒绝', JSON.stringify({ ...GOOD, channel: 'beta' }), '1.0.21', 'asar', 'stable', r => !r.ok && /通道/.test(r.reason)],
  ['版本号非法 → 拒绝', JSON.stringify({ ...GOOD, latest: { ...GOOD.latest, version: 'v1.0.22' } }), '1.0.21', 'asar', 'stable', r => !r.ok && /版本号/.test(r.reason)],
  ['非 JSON(网关错误页) → 拒绝', '<html>502 Bad Gateway</html>', '1.0.21', 'asar', 'stable', r => !r.ok && /JSON/.test(r.reason)],
  ['空内容 → 拒绝', '   ', '1.0.21', 'asar', 'stable', r => !r.ok],
  ['缺 latest → 拒绝', JSON.stringify({ ...GOOD, latest: undefined }), '1.0.21', 'asar', 'stable', r => !r.ok],
  ['缺 packages → 拒绝', JSON.stringify({ ...GOOD, latest: { ...GOOD.latest, packages: undefined } }), '1.0.21', 'asar', 'stable', r => !r.ok],
  ['包 url 为空 → pkg=null', JSON.stringify({ ...GOOD, latest: { ...GOOD.latest, packages: { asar: { url: '' } } } }), '1.0.21', 'asar', 'stable', r => r.ok && r.pkg === null],
];
for (const [name, text, ver, kind, ch, check] of cases) {
  const r = core.parseLatestJson(text, ver, kind, ch);
  ok(name, check(r), r);
}

console.log('== B. URL 工具 ==');
ok('normalizeBaseUrl 补协议+斜杠', core.normalizeBaseUrl('upd.example.com/adb') === 'https://upd.example.com/adb/');
ok('normalizeBaseUrl 保留 http', core.normalizeBaseUrl('http://127.0.0.1:8080/') === 'http://127.0.0.1:8080/');
ok('normalizeBaseUrl 丢 query', core.normalizeBaseUrl('https://a.com/x?y=1') === 'https://a.com/x/');
ok('normalizeBaseUrl 非法 → null', core.normalizeBaseUrl('not a url at all ::::') === null);
ok('normalizeBaseUrl 空 → null', core.normalizeBaseUrl('') === null);
ok('latestUrlFor', core.latestUrlFor('https://a.com/x') === 'https://a.com/x/latest.json');
ok('resolvePackageUrl 相对', core.resolvePackageUrl('p.zip', 'https://a.com/x/') === 'https://a.com/x/p.zip');
ok('resolvePackageUrl 绝对', core.resolvePackageUrl('https://b.com/p.zip', 'https://a.com/x/') === 'https://b.com/p.zip');
ok('resolvePackageUrl 非法协议 → null', core.resolvePackageUrl('ftp://b.com/p.zip', 'https://a.com/x/') === null);
ok('noPackageReason 便携版', /便携版/.test(core.noPackageReason('portable', '1.0.22')));

console.log('== C. safeFileNameFromUrl ==');
ok('普通名', src.safeFileNameFromUrl('https://a.com/x/ADB助手-v1.0.22-patch.zip') === 'ADB助手-v1.0.22-patch.zip');
ok('带 query', src.safeFileNameFromUrl('https://a.com/x/p.zip?a=1&b=2') === 'p.zip');
ok('无文件名 → 补 .zip', src.safeFileNameFromUrl('https://a.com/x/') === 'update-patch.zip');
ok('无扩展名 → 补 .zip', src.safeFileNameFromUrl('https://a.com/x/latest') === 'latest.zip');
ok('describeSource', /a\.com/.test(src.describeSource('https://a.com/x/')));

/* ---- D. 本地假服务器 + 下载器 ---- */
const PAYLOAD = Buffer.from('PK\x03\x04 fake patch payload 一丁点内容'.repeat(50));
const GOOD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/latest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...GOOD, latest: { ...GOOD.latest, packages: { asar: { url: 'pkg.zip', size: PAYLOAD.length, sha256: GOOD_SHA } } } }));
    return;
  }
  if (u.pathname === '/pkg.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(PAYLOAD.length) });
    res.end(PAYLOAD);
    return;
  }
  if (u.pathname === '/slow') { // 只发头部不结束 → 触发空闲超时
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.write('PK\x03\x04');
    return;
  }
  res.writeHead(404); res.end('nope');
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adba-selftest-'));

  console.log('== D. httpGetText ==');
  const t = await net.httpGetText(base + 'latest.json');
  ok('200 + 文本', t.status === 200 && /ADB桌面助手/.test(t.text));
  let notFoundErr = null;
  try { await net.httpGetText(base + 'missing.json'); } catch (e) { notFoundErr = e.message; }
  ok('404 → 明确报错', !!notFoundErr && /404/.test(notFoundErr), notFoundErr);
  let connErr = null;
  try { await net.httpGetText('http://127.0.0.1:1/x', 1500); } catch (e) { connErr = e.message; }
  ok('拒连 → 报错不崩', !!connErr, connErr);

  console.log('== D. downloadToFile ==');
  const d1 = path.join(tmp, 'ok.zip');
  let lastPct = -1, sawVerify = false;
  const r1 = await net.downloadToFile(base + 'pkg.zip', d1, GOOD_SHA, {
    onProgress: (p) => { if (p.phase === 'verify') sawVerify = true; else lastPct = p.percent; },
  });
  ok('下载成功且大小对', r1.size === PAYLOAD.length && fs.existsSync(d1));
  ok('sha256 一致', r1.sha256 === GOOD_SHA);
  ok('进度回调到过 100 且报过 verify', lastPct === 100 && sawVerify, { lastPct, sawVerify });
  ok('无 .part 残留', !fs.existsSync(d1 + '.part'));

  const d2 = path.join(tmp, 'bad.zip');
  let shaErr = null;
  try { await net.downloadToFile(base + 'pkg.zip', d2, 'deadbeef'); } catch (e) { shaErr = e.message; }
  ok('sha256 不符 → 报错', !!shaErr && /校验值不符/.test(shaErr), shaErr);
  ok('校验失败不留文件（含 .part）', !fs.existsSync(d2) && !fs.existsSync(d2 + '.part'));

  const d3 = path.join(tmp, 'cancel.zip');
  const p = net.downloadToFile(base + 'slow', d3, undefined, { idleTimeoutMs: 60000 });
  setTimeout(() => net.cancelActiveDownload(), 300);
  let cancelErr = null;
  try { await p; } catch (e) { cancelErr = e.name + ': ' + e.message; }
  ok('取消 → DownloadCancelledError', !!cancelErr && /DownloadCancelled/.test(cancelErr), cancelErr);
  ok('取消不留残文件', !fs.existsSync(d3) && !fs.existsSync(d3 + '.part'));

  let idleErr = null;
  try { await net.downloadToFile(base + 'slow', path.join(tmp, 'idle.zip'), undefined, { idleTimeoutMs: 1200 }); } catch (e) { idleErr = e.message; }
  ok('空闲超时 → 报错', !!idleErr && /没有收到新数据/.test(idleErr), idleErr);

  console.log('== D. 整链路（清单→选包→下载） ==');
  const s = src.httpSource({ baseUrl: base, localVersion: '1.0.21', kind: 'asar', channel: 'stable', downloadDir: tmp });
  const info = await s.check();
  ok('check: newer + pkg 绝对 URL', info.newer === true && info.pkg && info.pkg.url.startsWith('http://127.0.0.1'));
  const got = await s.fetch();
  ok('fetch 落盘且内容正确', fs.existsSync(got) && crypto.createHash('sha256').update(fs.readFileSync(got)).digest('hex') === GOOD_SHA);
  const s2 = src.httpSource({ baseUrl: base, localVersion: '1.0.22', kind: 'asar', channel: 'stable', downloadDir: tmp });
  const info2 = await s2.check();
  ok('已是最新时不 newer', info2.newer === false);
  let cfgErr = null;
  const s3 = src.httpSource({ baseUrl: '', localVersion: '1.0.21', kind: 'asar', channel: 'stable' });
  try { await s3.check(); } catch (e) { cfgErr = e.message; }
  ok('空地址 → 明确报错', !!cfgErr && /更新源地址/.test(cfgErr), cfgErr);
  ok('localFileSource.describe', /本地文件/.test(src.localFileSource('D:/x/y-patch.zip').describe()));

  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
});
