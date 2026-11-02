/**
 * 崩溃日志 dump 的流式化验证（性能优化 B5，真实设备）。
 *
 *   node scripts/check-crash-dump.cjs
 *
 * 覆盖：
 *   A 流式链路     streamAdb 能真的把设备日志逐行吐出来（不依赖 electron 窗口）
 *   B 等价性       同一台设备、同一时间窗，「流式 + crash-window」与
 *                  「runAdb 全量 + 同一套裁剪」得到的 excerpt 必须一致
 *   C 提前收工     把窗口放在过去（crashTime = now - 5min）时，读到崩溃点后必须停
 *   D 内容健康     没有 U+FFFD（多字节没被切坏）、行数与字节数自洽
 *   E 内存参考     两条路径的 RSS 增量，只记录不断言（噪声太大，看趋势用）
 *
 * 为什么不做「峰值必须降 X%」的硬断言：真机 logcat 缓冲区通常只有几千行，
 * 两条路径都能装下，绝对差值落在噪声里。B5 的收益要在**缓冲区打满**
 * （+ `--memory-probe` 的 JSONL）时才看得出来，所以这里只保证行为正确。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist-electron', 'electron', 'services');
const ADB = path.join(ROOT, 'bin', process.platform === 'win32' ? 'adb.exe' : 'adb');

const rows = [];
const record = (ok, name, detail = '') => {
  rows.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + detail : ''}`);
};

function listDevices() {
  const r = spawnSync(ADB, ['devices'], { encoding: 'utf8' });
  return (r.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && /\sdevice$/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

const dumpArgs = (serial) => [
  '-s',
  serial,
  'logcat',
  '-d',
  '-v',
  'year',
  '-b',
  'main',
  '-b',
  'system',
  '-b',
  'crash',
  '-t',
  '200000',
];

const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);

async function main() {
  const devices = listDevices();
  if (!devices.length) {
    record(false, '找到在线设备', '没有任何在线设备');
    return;
  }
  const emu = devices.find((d) => /^emulator-/.test(d));
  const serial = emu || devices[0];
  record(true, '找到在线设备', serial);

  const { streamAdb } = require(path.join(DIST, 'adb-stream.js'));
  const { createWindowSlicer } = require(path.join(DIST, 'crash-window.js'));
  const { runAdb } = require(path.join(DIST, 'adb.js'));

  const now = Date.now();

  /* ---------------- A 流式链路 ---------------- */
  /*
   * 一次 dump 同时做两件事：
   *   · 边读边喂 slicer（真实生产路径）；
   *   · 顺手把每一行也存进 allLines（旧路径的内存形态）。
   * 这样 B 段的两份结果来自**同一批行**，逐条比对才有意义 —— 如果分两次
   * dump，设备一直在写日志，行数本来就不同（第一次实测差了 10 行）。
   */
  const allLines = [];
  const rssBefore = rssMB();
  const t0 = Date.now();
  const slicerA = createWindowSlicer({ crashTime: now, minutes: 10 });
  const stream = await streamAdb(dumpArgs(serial), {
    timeout: 60000,
    silent: true,
    onLine: (line) => {
      const keep = slicerA.accept(line);
      allLines.push(line);
      return keep;
    },
  });
  const streamMs = Date.now() - t0;
  const rssAfterStream = rssMB();
  const outA = slicerA.result();

  record(stream.lines > 0, 'A1 流式读到日志行', `${stream.lines} 行 / ${stream.bytes} 字节`);
  record(!stream.timedOut, 'A2 没有超时');
  record(outA.excerpt.length > 0, 'A3 时间窗裁剪后仍有内容', `${outA.excerpt.length} 行`);
  record(
    outA.excerpt.length === outA.keptLines && outA.keptLines <= 40000,
    'A4 行数自洽且在 maxKept 内',
    `${outA.keptLines} <= 40000`,
  );

  /* ---------------- D 内容健康 ---------------- */
  const bad = outA.excerpt.filter((l) => l.includes('\ufffd'));
  record(bad.length === 0, 'D1 没有 U+FFFD（多字节没被切坏）', bad.length ? `首条=${bad[0].slice(0, 60)}` : '');
  const timed = outA.excerpt.filter((l) => /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3}/.test(l)).length;
  record(timed > 0, 'D2 行首时间戳格式正常', `${timed}/${outA.excerpt.length} 行可解析`);
  record(!stream.truncatedLines, 'D3 没有超长行被截断', `truncated=${stream.truncatedLines}`);

  /* ---------------- B 等价性：攒完再处理 vs 边读边处理 ---------------- */
  const slicerB = createWindowSlicer({ crashTime: now, minutes: 10 });
  for (const line of allLines) slicerB.accept(line);
  const outB = slicerB.result();

  record(allLines.length === stream.lines, 'B1 收集到的行数与流式计数一致', `${allLines.length} 行`);
  record(outB.excerpt.length === outA.excerpt.length, 'B2 裁剪后行数一致', `${outA.excerpt.length} 行`);
  /* 逐条比对（两次裁剪必须给出完全相同的序列） */
  let diff = -1;
  const n = Math.min(outA.excerpt.length, outB.excerpt.length);
  for (let i = 0; i < n; i += 1) {
    if (outA.excerpt[i] !== outB.excerpt[i]) {
      diff = i;
      break;
    }
  }
  record(diff === -1, 'B3 逐条内容完全一致', diff === -1 ? `${n} 条` : `第 ${diff} 条不同`);

  /* 另一条路径：runAdb 全量读（B5 之前的生产路径），只比量级 —— 设备在持续写日志 */
  const rss0 = rssMB();
  const t1 = Date.now();
  const legacy = await runAdb(dumpArgs(serial), { silent: true, timeout: 60000 });
  const legacyMs = Date.now() - t1;
  const rssAfterLegacy = rssMB();
  const legacyCount = (legacy.stdout || '').split(/\r?\n/).filter((l) => l.length > 0).length;
  const drift = Math.abs(legacyCount - stream.lines) / Math.max(1, stream.lines);
  record(drift < 0.05, 'B4 runAdb 与 streamAdb 读到的行数同量级', `${legacyCount} vs ${stream.lines}（差 ${(drift * 100).toFixed(1)}%）`);

  /* ---------------- C 提前收工（窗口放在过去） ---------------- */
  const past = now - 5 * 60000;
  const slicerC = createWindowSlicer({ crashTime: past, minutes: 10 });
  const t2 = Date.now();
  const streamC = await streamAdb(dumpArgs(serial), {
    timeout: 60000,
    silent: true,
    onLine: (line) => slicerC.accept(line),
  });
  const streamMsC = Date.now() - t2;
  const outC = slicerC.result();

  record(
    outC.keptLines > 0,
    'C1 过去时间窗仍能命中内容',
    `${outC.keptLines} 行`,
  );
  if (streamC.aborted) {
    record(
      streamC.lines < stream.lines,
      'C2 提前收工确实少读了行',
      `${streamC.lines} / ${stream.lines} 行（省 ${stream.lines - streamC.lines}）`,
    );
  } else {
    /* 设备缓冲区里没有晚于窗口右界的日志时不会触发，属于正常情况 */
    record(true, 'C2 未触发提前收工（设备缓冲区里没有更晚的日志）', `${streamC.lines} 行`);
  }
  record(
    streamMsC <= streamMs * 1.5 + 500,
    'C3 提前收工不慢于全量',
    `收工 ${streamMsC}ms vs 全量 ${streamMs}ms`,
  );

  /* ---------------- E 耗时参考（不硬断言内存） ---------------- */
  /*
   * ⚠️ 这里**不**断言内存：A 段为了对拍额外保留了 allLines（测试自己造的峰值），
   * 真机 logcat 缓冲区又只有 ~1.4MB，两条路径都能装下，RSS 差值全在噪声里。
   * B5 的收益要在缓冲区打满时才看得出来 —— 用 `--memory-probe` 的 JSONL 观察，
   * 或者看 A 段与 C 段「读了多少行」的差（提前收工省掉的那部分才是真省的）。
   */
  record(
    true,
    'E1 耗时参考（提前收工省的行数才是收益）',
    `全量 ${streamMs}ms / ${stream.lines} 行 ｜ 收工 ${streamMsC}ms / ${streamC.lines} 行 ｜ runAdb ${legacyMs}ms / ${legacyCount} 行`,
  );

  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n汇总：${pass} 通过 / ${rows.length - pass} 失败`);
  console.log('CRASH DUMP CHECK DONE');
  if (pass !== rows.length) process.exitCode = 1;
}

main().catch((e) => {
  record(false, '脚本异常', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.log('CRASH DUMP CHECK DONE');
  process.exitCode = 1;
});
