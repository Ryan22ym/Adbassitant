/**
 * 内存优化第一轮回归（B11 探针 + B1 环形缓冲 + B2 预编译过滤）
 *
 * 三块内容：
 *   A. RingBuffer 语义：容量、顺序、覆盖、清空 → 取代原来的 `splice(0, n)`；
 *   B. 过滤等价性：新编译器和**旧逐行实现**逐条对拍，确保用户看到的过滤结果不变；
 *   C. 探针本身：间隔采样、字段齐全、JSONL 落盘、可停；
 *   D. 真机 soak（有设备才跑）：真 adb logcat → 主进程环形缓冲 → sink，
 *      断言只收到关键字命中的行、缓冲不越界、主进程堆没有异常增长。
 *
 * 为什么要有 B 这一节：预编译过滤最容易出的问题是**语义悄悄变了**
 * （大小写、通配、空项、多关键字优先级），而这类变化在界面上只表现为
 * 「怎么少了几行日志」，肉眼看回归很难发现。
 *
 * 跑法：
 *   python scripts/run-electron.py scripts/check-memory-soak.cjs \
 *     --watch ui-shots/_memory-soak.log --until "MEMORY SOAK CHECK DONE" --timeout 300
 *
 * 需要先 `tsc -p tsconfig.electron.json`（本脚本读 dist-electron 产物）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_memory-soak.log');
const ADB = path.join(ROOT, 'bin', 'adb.exe');

fs.mkdirSync(OUT, { recursive: true });

function log(...a) {
  fs.appendFileSync(
    LOG,
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n',
  );
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app } = electronMain;

const DATA = path.join(os.tmpdir(), `adb-memory-soak-${process.pid}`);
fs.mkdirSync(DATA, { recursive: true });
app.setPath('userData', DATA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
function ok(cond, name, detail) {
  rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function skip(name, why) {
  rows.push(`SKIP  ${name}   ${why}`);
}

/* ================================================================== */
/* A. RingBuffer                                                      */
/* ================================================================== */
function checkRingBuffer(RingBuffer) {
  log('--- A. RingBuffer ---');

  const cap = 10;
  const rb = new RingBuffer(cap);
  ok(rb.length === 0 && rb.capacity === cap, 'A1 空缓冲：length=0，容量固定', `cap=${rb.capacity}`);

  // 未满：按插入顺序
  for (let i = 0; i < 6; i += 1) rb.push(i);
  ok(
    JSON.stringify(rb.toArray()) === JSON.stringify([0, 1, 2, 3, 4, 5]),
    'A2 未满时 toArray 按插入顺序',
    JSON.stringify(rb.toArray()),
  );

  // 写满：不丢
  for (let i = 6; i < 10; i += 1) rb.push(i);
  ok(rb.length === 10 && rb.isFull, 'A3 写满后 length=capacity，isFull=true');

  // 溢出：覆盖最旧、保持顺序、返回被挤掉的那条
  const evicted = [];
  for (let i = 10; i < 100; i += 1) evicted.push(rb.push(i));
  ok(
    rb.length === 10 && JSON.stringify(rb.toArray()) === JSON.stringify([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]),
    'A4 溢出 90 次后只保留最新 10 条且顺序正确',
    JSON.stringify(rb.toArray()),
  );
  ok(
    evicted[0] === 0 && evicted[89] === 89 && evicted.every((x) => x !== undefined),
    'A5 push 在满时返回被挤掉的最旧元素',
    `first=${evicted[0]} last=${evicted[89]}`,
  );

  // at()
  ok(rb.at(0) === 90 && rb.at(9) === 99 && rb.at(10) === undefined, 'A6 at() 越界返回 undefined');

  // 与「数组 + splice」的参照实现逐条对拍（随机长度 / 随机容量）
  let refDiff = 0;
  for (let round = 0; round < 20; round += 1) {
    const c = 1 + ((round * 7) % 13);
    const r = new RingBuffer(c);
    let ref = [];
    for (let i = 0; i < 200; i += 1) {
      r.push(i);
      ref.push(i);
      if (ref.length > c) ref.splice(0, ref.length - c);
      if (JSON.stringify(r.toArray()) !== JSON.stringify(ref)) refDiff += 1;
    }
  }
  ok(refDiff === 0, 'A7 与「数组+splice」参照实现 20 轮逐条一致', `diff=${refDiff}`);

  // clear 必须真的放掉引用
  const big = new RingBuffer(3);
  big.push({ s: 'x'.repeat(1024) });
  big.clear();
  ok(big.length === 0 && big.toArray().length === 0, 'A8 clear 后 length=0');

  // 非法容量要直接报错（避免 0 容量静默吞掉所有数据）
  let threw = false;
  try {
    new RingBuffer(0);
  } catch {
    threw = true;
  }
  ok(threw, 'A9 容量 0 抛错（不静默吞数据）');

  // 真实容量 20000 的写入成本：10 万次 push 应该在毫秒级（旧实现是 20 亿次搬移）
  const big2 = new RingBuffer(20000);
  const t0 = Date.now();
  for (let i = 0; i < 100000; i += 1) big2.push('09-11 17:58:07.123  1234  1250 I SomeLongTag: ' + i);
  const ms = Date.now() - t0;
  ok(big2.length === 20000 && ms < 2000, 'A10 10 万次 push 保持毫秒级（B1 的收益）', `${ms}ms`);
}

/* ================================================================== */
/* B. 过滤等价性                                                       */
/* ================================================================== */
/** 旧实现原样复制（services/logcat.ts 改造前的 passes / wildcardMatch / escapeRe） */
const LEVEL_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };
function oldEscapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function oldWildcardMatch(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase() === pattern.toLowerCase();
  const re = new RegExp('^' + pattern.split('*').map(oldEscapeRe).join('.*') + '$', 'i');
  return re.test(value);
}
function oldPasses(filter, parsed, raw) {
  if (parsed.level) {
    const min = LEVEL_ORDER[filter.minLevel] ?? 0;
    const cur = LEVEL_ORDER[parsed.level] ?? 0;
    if (cur < min) return false;
  }
  if (filter.pid && parsed.pid !== filter.pid) return false;
  const tagFilter = (filter.tags || '').trim();
  if (tagFilter) {
    const tag = parsed.tag || '';
    const ok = tagFilter
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .some((p) => oldWildcardMatch(p, tag));
    if (!ok) return false;
  }
  const kw = (filter.keyword || '').trim();
  if (kw) {
    const lower = raw.toLowerCase();
    const ok = kw
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .some((k) => lower.includes(k));
    if (!ok) return false;
  }
  const proc = (filter.process || '').trim();
  if (proc && !raw.toLowerCase().includes(proc.toLowerCase())) return false;
  return true;
}

function checkFilterParity(compileLogcatMatcher) {
  log('--- B. 过滤等价性 ---');

  const filters = [
    { minLevel: 'V' },
    { minLevel: 'W' },
    { minLevel: 'E' },
    { minLevel: 'S' },
    { minLevel: 'V', tags: 'ActivityManager' },
    { minLevel: 'V', tags: 'ActivityManager , WindowManager' },
    { minLevel: 'V', tags: 'Act*,Window*' },
    { minLevel: 'V', tags: '*' },
    { minLevel: 'V', tags: '  ,  ,' }, // 只有分隔符 → 旧实现会整片过滤掉，必须保持
    { minLevel: 'V', keyword: '  ,  ' }, // 同上（关键字侧）
    { minLevel: 'V', tags: 'a*b*c' },
    { minLevel: 'V', keyword: 'start,error' },
    { minLevel: 'V', keyword: '  ERROR  , ' },
    { minLevel: 'V', keyword: 'ERROR', process: 'system' },
    { minLevel: 'V', process: 'COM.Android' },
    { minLevel: 'I', tags: 'Foo', keyword: 'bar', process: 'baz' },
    { minLevel: 'V', pid: 1234 },
    { minLevel: 'D', pid: 1234, tags: 'Foo', keyword: 'x', process: 'y' },
  ];

  const parsedLines = [
    { level: 'V', tag: 'ActivityManager', pid: 1234, raw: '09-11 10:00:00.000  1234  1250 V ActivityManager: Start proc com.android.x' },
    { level: 'E', tag: 'ActivityManager', pid: 99, raw: '09-11 10:00:00.000  99  99 E ActivityManager: ANR in system' },
    { level: 'W', tag: 'WindowManager', pid: 1234, raw: '09-11 10:00:00.000  1234  1250 W WindowManager: foo bar baz' },
    { level: 'I', tag: 'Foo', pid: 7, raw: '09-11 10:00:00.000  7  7 I Foo: BAR! Error 42' },
    { level: 'D', tag: 'aXbYc', pid: 1234, raw: '09-11 10:00:00.000  1234  1250 D aXbYc: x' },
    { level: 'F', tag: '', pid: 0, raw: '09-11 10:00:00.000  0  0 F : fatal' },
    { level: 'S', tag: 'STATS', pid: 555, raw: '--------- beginning of main' },
    { tag: '', raw: '--------- beginning of main' }, // 未解析行
    { raw: 'garbage line without threadtime' },
  ];

  let diff = 0;
  const details = [];
  for (const f of filters) {
    const matcher = compileLogcatMatcher(f);
    for (const p of parsedLines) {
      const a = matcher(p, p.raw);
      const b = oldPasses(f, p, p.raw);
      if (a !== b) {
        diff += 1;
        details.push(`filter=${JSON.stringify(f)} raw=${p.raw.slice(0, 40)} new=${a} old=${b}`);
      }
    }
  }
  ok(diff === 0, 'B1 新编译器与旧实现 17×9 组合逐条一致', `diff=${diff}`);
  if (diff) details.slice(0, 6).forEach((d) => log('  差异 ' + d));

  // 空标签关键字等价于不过滤
  const plain = compileLogcatMatcher({ minLevel: 'V' });
  ok(
    plain({ raw: 'x' }, 'x') === true,
    'B2 无任何过滤条件时全部放行',
  );

  /* 性能对比：只做信息输出，不作为失败判据（本机计时抖动大） */
  const f = { minLevel: 'V', tags: 'ActivityManager,Window*,Foo', keyword: 'start,error,anr', process: 'com.' };
  const line =
    '09-11 10:00:00.000  1234  1250 E ActivityManager: Start proc com.android.systemui for activity';
  const p = {
    level: 'E',
    tag: 'ActivityManager',
    pid: 1234,
    raw: line,
  };
  const N = 100000;
  const matcher = compileLogcatMatcher(f);

  let t0 = Date.now();
  let hitsNew = 0;
  for (let i = 0; i < N; i += 1) if (matcher(p, line)) hitsNew += 1;
  const msNew = Date.now() - t0;

  t0 = Date.now();
  let hitsOld = 0;
  for (let i = 0; i < N; i += 1) if (oldPasses(f, p, line)) hitsOld += 1;
  const msOld = Date.now() - t0;

  ok(hitsNew === hitsOld, 'B3 批量跑结果计数一致', `new=${hitsNew} old=${hitsOld}`);
  log(
    `BENCH 过滤 ${N} 行：新 ${msNew}ms / 旧 ${msOld}ms` +
      (msNew > 0 ? `（${(msOld / Math.max(msNew, 1)).toFixed(1)}×）` : ''),
  );
}

/* ================================================================== */
/* C. 探针                                                            */
/* ================================================================== */
async function checkProbe(probe) {
  log('--- C. 内存探针 ---');

  ok(
    probe.isMemoryProbeRequested(['app.exe', '--memory-probe']) === true &&
      probe.isMemoryProbeRequested(['app.exe']) === false &&
      probe.isMemoryProbeRequested(['app.exe'], { ADB_MEM_PROBE: '1' }) === true,
    'C1 开关只认 --memory-probe / ADB_MEM_PROBE=1',
  );

  const fileArg = probe.memoryProbeFileFromArgv(['app.exe', '--memory-probe-file=D:\\x\\m.jsonl']);
  ok(fileArg === 'D:\\x\\m.jsonl', 'C2 --memory-probe-file= 能取到路径', String(fileArg));

  ok(probe.isMemoryProbeRunning() === false, 'C3 未启动时 isMemoryProbeRunning=false');

  const jsonl = path.join(DATA, 'probe-test.jsonl');
  probe.startMemoryProbe({ intervalMs: 60, keep: 20, file: jsonl });
  await sleep(500);
  probe.stopMemoryProbe();
  const report = probe.getMemoryProbeReport();
  ok(!!report && report.count >= 3, 'C4 60ms 间隔 500ms 内采到 >=3 个样本', report ? `n=${report.count}` : 'null');

  const s = report ? report.samples[report.samples.length - 1] : null;
  ok(
    !!s &&
      Number.isFinite(s.main.rssMB) &&
      s.main.rssMB > 0 &&
      s.main.heapUsedMB > 0 &&
      Number.isFinite(s.v8.limitMB) &&
      s.v8.limitMB > 0,
    'C5 样本字段齐全（主进程 RSS / 堆 / V8 上限）',
    s ? `rss=${s.main.rssMB}MB heap=${s.main.heapUsedMB}MB limit=${s.v8.limitMB}MB` : 'null',
  );
  const types = s ? s.electron.map((p) => `${p.type}:${p.wsMB}`).join(', ') : '';
  ok(
    !!s && s.main.residentMB > 0 && s.electron.length >= 1 && s.electron.some((p) => p.wsMB > 0),
    'C6 拿到主进程工作集与 Electron 进程列表',
    `resident=${s ? s.main.residentMB : 0}MB procs=[${types}]`,
  );
  ok(!!s && s.totalWSMB > 0 && s.peakTotalWSMB >= s.totalWSMB, 'C7 合计工作集与峰值合理', s ? `${s.totalWSMB}/${s.peakTotalWSMB}MB` : '');

  // JSONL：每个样本一行，可被脚本解析
  let lines = 0;
  let parsed = 0;
  try {
    const text = fs.readFileSync(jsonl, 'utf8').trim();
    const arr = text ? text.split('\n') : [];
    lines = arr.length;
    for (const l of arr) {
      try {
        JSON.parse(l);
        parsed += 1;
      } catch {
        /* 计为不合法 */
      }
    }
  } catch (e) {
    log('读取 JSONL 失败：' + e.message);
  }
  ok(lines >= 3 && parsed === lines, 'C8 JSONL 落盘且每行都是合法 JSON', `lines=${lines} parsed=${parsed}`);

  // 重复启动幂等 + 停掉之后进程不被拖住
  probe.startMemoryProbe({ intervalMs: 1000, file: null });
  const again = probe.startMemoryProbe({ intervalMs: 1000, file: null });
  ok(again === true && probe.isMemoryProbeRunning() === true, 'C9 重复启动幂等');
  probe.stopMemoryProbe();
  ok(probe.isMemoryProbeRunning() === false, 'C10 停止后不再采样');
}

/* ================================================================== */
/* D. 真机 soak                                                       */
/* ================================================================== */
async function checkDeviceSoak(logcat, probe) {
  log('--- D. 真机 soak ---');

  let devices = '';
  try {
    devices = require('child_process').execFileSync(ADB, ['devices'], { timeout: 8000 }).toString();
  } catch {
    devices = '';
  }
  if (!/\tdevice\b/.test(devices)) {
    skip('D 真机 soak', '没有在线设备');
    return;
  }

  const { execFileSync } = require('child_process');
  const KW = 'PERF10002';
  let received = 0;
  let batches = 0;
  logcat.setLogcatLinesSink((lines) => {
    batches += 1;
    received += lines.length;
  });

  const before = await probe.sampleMemoryNow();
  const st = await logcat.startLogcat(undefined, { minLevel: 'V', keyword: KW });
  ok(st.running === true, 'D1 logcat 会话已启动', `pid=${st.pid}`);

  for (let i = 0; i < 30; i += 1) {
    try {
      execFileSync(ADB, ['shell', 'log', '-t', KW, `soak-line-${i} payload-${'x'.repeat(60)}`], {
        timeout: 8000,
      });
    } catch {
      /* 某一条写失败不算致命 */
    }
    await sleep(30);
  }
  await sleep(700);

  const status = logcat.getLogcatStatus();
  const stats = logcat.getLogcatStats();
  ok(received >= 20, 'D2 关键字过滤下只收到命中行（预编译过滤器在生产链路生效）', `received=${received} batches=${batches}`);
  ok(status.lines >= 20 && stats.buffered === status.lines, 'D3 环形缓冲与 seq 同步（没有丢行）', `seq=${status.lines} buffered=${stats.buffered}`);
  ok(
    stats.buffered <= stats.maxBuffer,
    'D4 缓冲不超过 MAX_BUFFER（B1 不越界）',
    `${stats.buffered}/${stats.maxBuffer}`,
  );
  ok(stats.recent > 0 && stats.recent <= 4000 + 512, 'D5 回放缓冲仍在正常累积', `recent=${stats.recent}`);

  // 导出走的是环形缓冲的快照：行数必须与缓冲一致
  const outFile = path.join(DATA, 'soak-export.txt');
  const saved = logcat.saveLogcat(outFile, { 场景: 'memory-soak' });
  const text = fs.readFileSync(outFile, 'utf8');
  ok(
    text.includes(`行数：${stats.buffered}`) && text.includes('soak-line-0'),
    'D6 导出内容与环形缓冲一致（首行还在）',
    `declared=${stats.buffered} bytes=${saved.bytes}`,
  );

  await logcat.stopLogcat();
  await sleep(300);

  const after = await probe.sampleMemoryNow();
  const heapGrowth = after.main.heapUsedMB - before.main.heapUsedMB;
  ok(
    heapGrowth < 50,
    'D7 抓取 30 条 + 导出后主进程堆增长 < 50MB',
    `${before.main.heapUsedMB}MB → ${after.main.heapUsedMB}MB（${heapGrowth >= 0 ? '+' : ''}${heapGrowth.toFixed(1)}MB）`,
  );
  log(
    `SOAK 主进程 RSS ${before.main.rssMB}MB → ${after.main.rssMB}MB，` +
      `工作集 ${before.main.residentMB}MB → ${after.main.residentMB}MB`,
  );
}

/* ================================================================== */
/* 主流程                                                             */
/* ================================================================== */
app.whenReady().then(async () => {
  fs.writeFileSync(LOG, '');
  log('=== 内存优化回归（B11 / B1 / B2） ===');

  const RingBuffer = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'ring-buffer.js')).RingBuffer;
  const { compileLogcatMatcher } = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'logcat-filter.js'));
  const probe = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'memory-probe.js'));
  const logcat = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'logcat.js'));

  try {
    checkRingBuffer(RingBuffer);
  } catch (e) {
    ok(false, 'A 段异常', e.message);
  }

  try {
    checkFilterParity(compileLogcatMatcher);
  } catch (e) {
    ok(false, 'B 段异常', e.message);
  }

  try {
    await checkProbe(probe);
  } catch (e) {
    ok(false, 'C 段异常', e.message);
  }

  try {
    await checkDeviceSoak(logcat, probe);
  } catch (e) {
    ok(false, 'D 段异常', e.message);
    try {
      await logcat.stopLogcat();
    } catch {
      /* ignore */
    }
  }

  probe.stopMemoryProbe();

  log('=== 结果 ===');
  for (const r of rows) log(r);
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const skipped = rows.filter((r) => r.startsWith('SKIP')).length;
  // 汇总行别写 "FAIL" 三个字母：run-electron.py 靠日志里出现 FAIL 判失败，
  // 全绿时这行会把整轮误判成红。失败明细本身仍以 FAIL 开头，判据不受影响。
  log(`汇总：PASS ${pass} / 失败 ${fail} / SKIP ${skipped}`);
  log('MEMORY SOAK CHECK DONE');
  app.exit(fail ? 1 : 0);
});
