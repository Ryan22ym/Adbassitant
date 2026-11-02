/**
 * 流式 dump 的两个纯逻辑模块单测（性能优化 B5）。
 *
 * 覆盖：
 *   A. line-splitter.ts —— 文本流切行（CRLF / 空行 / 跨块半行 / 多字节断裂 /
 *      超长行截断 / 中止 / flush）
 *   B. crash-window.ts  —— 崩溃日志时间窗裁剪（与旧实现逐条对拍 + 提前收工
 *      的安全性：时钟错位时绝不能提前停）
 *
 * 为什么两条都要对拍旧实现：这两个模块都在「日志少了一行」这个层面上出错，
 * 界面上看不出来，但交给 AI 的现场证据就缺了关键几行 —— 只能靠逐条比对抓。
 *
 * 跑法：node scripts/check-dump-stream.cjs
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

/** 让 require 能直接解析 .ts（现场转成 CJS，不依赖 tsc 产物） */
require.extensions['.ts'] = function (mod, filename) {
  const src = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(src, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  mod._compile(out, filename);
};

const { createLineSplitter } = require(path.join(ROOT, 'electron', 'services', 'line-splitter.ts'));
const { createWindowSlicer, parseLogTime } = require(path.join(
  ROOT,
  'electron',
  'services',
  'crash-window.ts',
));

/* ---------------- 判定 ---------------- */
const rows = [];
function ok(cond, name, detail) {
  rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function eq(actual, expected, name, detail) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, name, a === e ? detail : `实际=${a} 期望=${e}`);
}

/* ================================================================== */
/* A. line-splitter                                                    */
/* ================================================================== */

/** 一次性喂完，收集所有交付的行 */
function runSplitter(text, maxLineChars) {
  const sp = createLineSplitter(maxLineChars);
  const got = [];
  sp.push(text, (l) => {
    got.push(l);
    return true;
  });
  sp.flush((l) => {
    got.push(l);
    return true;
  });
  return { got, truncated: sp.truncated };
}

eq(runSplitter('a\nb\nc\n').got, ['a', 'b', 'c'], 'A1 基本切分');
eq(runSplitter('a\nb\nc').got, ['a', 'b', 'c'], 'A2 末行无换行由 flush 交出');
eq(runSplitter('a\r\nb\r\n').got, ['a', 'b'], 'A3 CRLF 去掉行尾 \\r');
eq(runSplitter('a\n\n\nb\n').got, ['a', 'b'], 'A4 空行跳过');
eq(runSplitter('').got, [], 'A5 空输入');

/* 跨块半行：真实场景里一个 chunk 结束在行中间 */
{
  const sp = createLineSplitter();
  const got = [];
  const emit = (l) => {
    got.push(l);
    return true;
  };
  sp.push('hel', emit);
  const mid = got.slice();
  sp.push('lo\nworld\npart', emit);
  ok(mid.length === 0, 'A6a 半行在换行到达前不交付', `前半段=${JSON.stringify(mid)}`);
  eq(got, ['hello', 'world'], 'A6b 跨块拼接正确');
  ok(sp.pendingChars === 4, 'A6c 残余长度可观测', `pending=${sp.pendingChars}`);
}

/* 多字节断裂：必须配 StringDecoder 才不会出 U+FFFD */
{
  const { StringDecoder } = require('string_decoder');
  const text = '崩溃日志：应用闪退\n第二行\n';
  const buf = Buffer.from(text, 'utf8');
  /* 每 3 字节切一刀 —— 汉字正好 3 字节，必然有字符被切断 */
  const sp = createLineSplitter();
  const dec = new StringDecoder('utf8');
  const got = [];
  const emit = (l) => {
    got.push(l);
    return true;
  };
  for (let i = 0; i < buf.length; i += 3) {
    sp.push(dec.write(buf.subarray(i, i + 3)), emit);
  }
  sp.push(dec.end(), emit);
  sp.flush(emit);
  eq(got, ['崩溃日志：应用闪退', '第二行'], 'A7 多字节字符跨块不断裂');
  ok(
    got.every((l) => !l.includes('\ufffd')),
    'A7b 没有出现替换符 U+FFFD',
  );
}

/* 超长行（没有换行的二进制垃圾） */
{
  const r = runSplitter('x'.repeat(50) + '\n', 10);
  ok(r.got.length === 1 && r.got[0].length === 10, 'A8 超长行被截到上限', `len=${r.got[0] && r.got[0].length}`);
  ok(r.truncated === 1, 'A8b 截断计数为 1', `truncated=${r.truncated}`);
}
{
  /* 分块喂同样的内容，结果必须一致（否则「边界在哪」会影响输出） */
  const sp = createLineSplitter(10);
  const got = [];
  const emit = (l) => {
    got.push(l);
    return true;
  };
  const body = 'x'.repeat(50) + '\nafter\n';
  for (let i = 0; i < body.length; i += 7) sp.push(body.slice(i, i + 7), emit);
  sp.flush(emit);
  eq(got, ['x'.repeat(10), 'after'], 'A9 超长行分块喂结果一致');
  ok(sp.truncated === 1, 'A9b 分块喂也只算一次截断', `truncated=${sp.truncated}`);
}

/* 中止 */
{
  const sp = createLineSplitter();
  const got = [];
  const alive = sp.push('a\nb\nc\n', (l) => {
    got.push(l);
    return l !== 'a';
  });
  ok(alive === false, 'A10 emit 返回 false 时 push 返回 false');
  eq(got, ['a'], 'A10b 中止后不再交付后续行');
}

/* ================================================================== */
/* B. crash-window                                                     */
/* ================================================================== */

const p2 = (n, l = 2) => String(n).padStart(l, '0');
function fmt(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`
  );
}
/** 造一行 `-v year` 格式的 logcat */
const mk = (ms, msg) => `${fmt(ms)}  1234  1234 I TestTag : ${msg}`;

/**
 * 旧实现（B5 之前 crash.ts 里的那段循环）—— 对拍基准。
 * 逐字复刻，包括「解析不出时间的行只要 kept 非空就保留」和尾部退化。
 */
function legacySlice(lines, crashTime, minutes, opt = {}) {
  const afterMs = opt.afterMs ?? 5000;
  const maxKept = opt.maxKept ?? 40000;
  const fallbackTail = opt.fallbackTail ?? 3000;
  const from = crashTime - minutes * 60000;
  const to = crashTime + afterMs;
  const kept = [];
  for (const line of lines) {
    const t = parseLogTime(line, crashTime);
    if (t === null) {
      if (kept.length > 0 && kept.length < maxKept) kept.push(line);
      continue;
    }
    if (t >= from && t <= to) {
      if (kept.length < maxKept) kept.push(line);
    }
  }
  return kept.length > 0 ? kept : lines.slice(-fallbackTail);
}

/**
 * 跑新实现，返回它实际读了多少行、结果是什么，
 * 以及「只喂到提前收工那一点时」旧实现的结果（这才是合法对拍对象）。
 */
function runNew(lines, crashTime, minutes, opt = {}) {
  const slicer = createWindowSlicer({ crashTime, minutes, ...opt });
  let consumed = 0;
  let stopped = false;
  for (const l of lines) {
    consumed += 1;
    if (!slicer.accept(l)) {
      stopped = true;
      break;
    }
  }
  const res = slicer.result();
  const partial = legacySlice(lines.slice(0, consumed), crashTime, minutes, opt);
  return { res, consumed, stopped, partial, total: lines.length };
}

const T0 = new Date(2026, 10, 2, 11, 30, 0, 0).getTime();

/* B1：普通时间窗 —— 完全一致 */
{
  const lines = [];
  for (let i = 0; i < 1200; i += 1) lines.push(mk(T0 + i * 1000, `msg ${i}`));
  const crashTime = T0 + 900 * 1000;
  const r = runNew(lines, crashTime, 10);
  const want = legacySlice(lines, crashTime, 10);
  eq(r.partial, want, 'B1 与旧实现逐条一致（普通时间窗）');
  eq(r.res.excerpt, want, 'B1b 结果与旧实现相同');
  /* 窗口 = [crash-10min, crash+5s] = [T0+300s, T0+905s]，每秒一行 → 606 行（含两端） */
  ok(r.res.keptLines === 606, 'B1c 窗口内行数正确（10 分钟 + 5 秒收尾）', `${r.res.keptLines} 行`);
}

/* B2：提前收工 —— 崩溃点在早期，后面全越界 */
{
  const lines = [];
  for (let i = 0; i < 20000; i += 1) lines.push(mk(T0 + i * 100, `msg ${i}`)); // 每 100ms 一行
  const crashTime = T0 + 600 * 100; // 第 600 行附近
  const r = runNew(lines, crashTime, 5);
  ok(r.stopped, 'B2 越界后提前收工', `读了 ${r.consumed}/${r.total} 行`);
  ok(r.consumed < r.total / 2, 'B2b 只读了不到一半', `${r.consumed} 行`);
  eq(r.res.excerpt, r.partial, 'B2c 收工前的裁剪结果与旧实现一致');
  ok(
    r.res.excerpt.every((l) => parseLogTime(l, crashTime) <= crashTime + 5000),
    'B2d 收工后没有混入窗口外的行',
  );
}

/* B3：时钟错位（设备比主机快 30 分钟）—— 绝不能提前收工，必须退化到尾部 */
{
  const lines = [];
  for (let i = 0; i < 8000; i += 1) lines.push(mk(T0 + 1800000 + i * 100, `msg ${i}`));
  const crashTime = T0; // 全部行都比窗口右界晚
  const r = runNew(lines, crashTime, 10);
  ok(!r.stopped, 'B3 时钟错位时不提前收工（kept 为空是关键前提）', `读了 ${r.consumed}/${r.total}`);
  ok(r.res.keptLines === 3000, 'B3b 退化成尾部 3000 行', `${r.res.keptLines} 行`);
  eq(r.res.excerpt, lines.slice(-3000), 'B3c 尾部内容与旧实现相同');
}

/* B4：整批无时间戳（个别 ROM 的 -v year 不生效）*/
{
  const lines = [];
  for (let i = 0; i < 5000; i += 1) lines.push(`    堆栈行 ${i}  at com.foo.Bar(Bar.java:${i})`);
  const r = runNew(lines, T0, 10);
  ok(!r.stopped, 'B4 无时间戳时不提前收工');
  ok(r.res.keptLines === 3000, 'B4b 退化成尾部 3000 行', `${r.res.keptLines} 行`);
  eq(r.res.excerpt, lines.slice(-3000), 'B4c 内容与旧实现相同');
  ok(r.res.timedLines === 0, 'B4d timedLines 为 0（可据此告警）');
}

/* B5：堆栈续行就近跟随 */
{
  const lines = [
    mk(T0 - 3600000, 'old'),
    mk(T0, 'FATAL EXCEPTION: main'),
    '        at com.foo.Bar.run(Bar.java:42)',
    '        at com.foo.Baz.run(Baz.java:7)',
    mk(T0 + 2000, 'Force finishing activity'),
  ];
  const r = runNew(lines, T0, 10);
  eq(
    r.res.excerpt,
    [
      mk(T0, 'FATAL EXCEPTION: main'),
      '        at com.foo.Bar.run(Bar.java:42)',
      '        at com.foo.Baz.run(Baz.java:7)',
      mk(T0 + 2000, 'Force finishing activity'),
    ],
    'B5 无时间戳的堆栈行跟随保留，窗口外的老日志被丢',
  );
}

/* B6：崩溃后 5 秒内的收尾日志要保留，6 秒后的不要 */
{
  const lines = [mk(T0, 'FATAL'), mk(T0 + 5000, '刚好右界'), mk(T0 + 5001, '右界外')];
  const r = runNew(lines, T0, 1);
  ok(r.res.keptLines === 2, 'B6a 右界 5000ms 包含、5001ms 排除', `${r.res.keptLines} 行`);
  ok(r.res.excerpt[1].endsWith('刚好右界'), 'B6b 5000ms 那行被保留');
}

/* B7：maxKept 上限 */
{
  const lines = [];
  for (let i = 0; i < 500; i += 1) lines.push(mk(T0 + i, `m${i}`));
  const r = runNew(lines, T0 + 499, 10, { maxKept: 100 });
  ok(r.res.keptLines === 100, 'B7 maxKept 生效', `${r.res.keptLines} 行`);
  eq(r.res.excerpt, r.partial, 'B7b 截断后仍与旧实现一致');
}

/* B8：跨年（12 月的日志 + 1 月的参考时间，应判定为上一年）*/
{
  const dec = new Date(2025, 11, 31, 23, 59, 0, 0).getTime();
  const ref = new Date(2026, 0, 1, 0, 1, 0, 0).getTime();
  const line = mk(dec, 'new year eve');
  const t = parseLogTime(line, ref);
  ok(t === dec, 'B8 跨年时间解析正确', `${new Date(t).toLocaleString()} vs ${new Date(dec).toLocaleString()}`);
}

/* B9：result() 幂等 */
{
  const slicer = createWindowSlicer({ crashTime: T0, minutes: 1 });
  slicer.accept(mk(T0, 'x'));
  const a = slicer.result();
  const b = slicer.result();
  ok(a === b, 'B9 result() 幂等（同一对象）');
  ok(a.excerpt.length === 1 && b.excerpt.length === 1, 'B9b 内容未被清空');
}

/* B10：提前收工后，窗口外那段无时间戳的行确实被丢弃（这是有意的取舍）*/
{
  const lines = [mk(T0, 'FATAL')];
  for (let i = 0; i < 250; i += 1) lines.push(mk(T0 + 60000 + i, `later ${i}`)); // 全部越界
  lines.push('        at com.foo.Late.run(Late.java:1)'); // 收工点之后的堆栈行
  const r = runNew(lines, T0, 10);
  ok(r.stopped, 'B10 越界 200 行后提前收工');
  ok(
    !r.res.excerpt.some((l) => l.includes('com.foo.Late')),
    'B10b 收工后的堆栈行不再收集（属于更晚的事件，有意为之）',
  );
}

/* ---------------- 汇总 ---------------- */
const pass = rows.filter((r) => r.startsWith('PASS')).length;
const fail = rows.length - pass;
console.log(rows.join('\n'));
console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  process.exitCode = 1;
}
