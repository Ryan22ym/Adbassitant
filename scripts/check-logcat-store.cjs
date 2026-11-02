/**
 * LogcatStore（渲染层数据仓，性能优化 B3）单测。
 *
 * 为什么单独写一条、还跑在纯 node 里：
 *   · 这个模块是纯数据逻辑，用真实界面测它既慢又只能间接观察；
 *   · 它最怕的 bug 是「增量维护的结果和全量重算不一致」——
 *     这种偏差在界面上的表现只是「过滤后少了几行 / 计数差 1」，
 *     肉眼回归基本看不出来，必须拿旧实现逐条对拍。
 *
 * 做法：用 typescript 把 `src/lib/logcat-store.ts` 现场转成 CJS 再 require，
 * 不依赖 vite 产物、不需要设备、毫秒级。
 *
 * 跑法：node scripts/check-logcat-store.cjs
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'lib', 'logcat-store.ts');

const ts = require(path.join(ROOT, 'node_modules', 'typescript'));

function loadStore() {
  const src = fs.readFileSync(SRC, 'utf8');
  const out = ts.transpileModule(src, {
    fileName: SRC,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const m = new Module(SRC, module);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(out, SRC);
  return m.exports;
}

/* ---------------- 判定 ---------------- */
const rows = [];
function ok(cond, name, detail) {
  rows.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

/* ---------------- 旧实现（页面改造前的 visible / trimLines） ---------------- */
const MAX = 4000;

function oldTrimLines(list) {
  return list.length > MAX ? list.slice(list.length - MAX) : list;
}

function oldWildOk(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i',
  );
  return re.test(value);
}

function oldVisible(lines, spec) {
  let list = lines;
  const kw = (spec.keyword || '').trim().toLowerCase();
  if (kw) list = list.filter((l) => l.raw.toLowerCase().includes(kw));
  const tags = (spec.tags || '').trim();
  if (tags) {
    const pats = tags.split(',').map((x) => x.trim()).filter(Boolean);
    list = list.filter((l) => pats.some((p) => oldWildOk(p, l.tag || '')));
  }
  const proc = (spec.process || '').trim();
  if (proc) list = list.filter((l) => l.raw.toLowerCase().includes(proc.toLowerCase()));
  return list;
}

function oldCounts(lines) {
  const c = {};
  for (const l of lines) {
    const k = l.level || '?';
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

/* ---------------- 造数据 ---------------- */
const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const TAGS = ['ActivityManager', 'WindowManager', 'Foo', 'aXbYc', 'statsservice', ''];
const WORDS = ['start', 'Error', 'anr', 'crash', 'Exception', 'nothing', 'z'];

function makeLine(seq) {
  const level = LEVELS[seq % LEVELS.length];
  const tag = TAGS[seq % TAGS.length];
  const w1 = WORDS[seq % WORDS.length];
  const w2 = WORDS[(seq * 7) % WORDS.length];
  return {
    seq,
    level,
    tag,
    pid: 1000 + (seq % 5),
    time: '11-02 10:00:00.000',
    message: `${w1} payload ${w2} #${seq}`,
    raw: `11-02 10:00:00.000  100${seq % 5}  100${seq % 5} ${level} ${tag}: ${w1} payload ${w2} #${seq}`,
  };
}

const SPECS = [
  { keyword: '', tags: '', process: '' },
  { keyword: 'error', tags: '', process: '' },
  { keyword: '', tags: 'ActivityManager', process: '' },
  { keyword: '', tags: 'Act*,Window*', process: '' },
  { keyword: '', tags: '*', process: '' },
  { keyword: 'start,anr', tags: 'Foo', process: '' },
  { keyword: '', tags: '', process: 'activitymanager' },
  { keyword: 'crash', tags: 'a*b*', process: 'payload' },
  { keyword: 'nothing-here', tags: '', process: '' },
  { keyword: '', tags: '  ,  ', process: '' }, // 只有分隔符：旧实现拆不出模式 → 全过滤
];

/* ---------------- 用例 ---------------- */
function main() {
  const { LogcatStore, LOG_MAX_LINES } = loadStore();
  ok(LOG_MAX_LINES === MAX, 'S1 容量常量与页面一致（4000）', String(LOG_MAX_LINES));

  /* 1) 基础：reset / push / total / at / slice */
  {
    const st = new LogcatStore();
    st.reset([]);
    ok(st.total === 0 && st.visibleCount === 0 && st.at(0) === undefined, 'S2 空仓读到空');

    st.push([makeLine(1), makeLine(2), makeLine(3)]);
    ok(
      st.total === 3 && st.at(0).seq === 1 && st.at(2).seq === 3 && st.at(3) === undefined,
      'S3 push 后顺序正确、越界安全',
    );
    const s = st.slice(1, 3);
    ok(s.length === 2 && s[0].seq === 2 && s[1].seq === 3, 'S4 slice(start,end) 半开区间');
    ok(st.slice(-5, 2).length === 2, 'S5 slice 负数起点被夹到 0');
  }

  /* 2) 容量与裁剪：超过 MAX 后只留最新，且 at() 顺序不歪 */
  {
    const st = new LogcatStore();
    st.reset([]);
    const ref = [];
    let seq = 0;
    let bad = 0;
    for (let b = 0; b < 60; b += 1) {
      const batch = [];
      for (let i = 0; i < 100; i += 1) batch.push(makeLine((seq += 1)));
      st.push(batch);
      ref.push(...batch);
      if (ref.length > MAX) ref.splice(0, ref.length - MAX);
      if (st.total !== ref.length) bad += 1;
      // 抽查首尾与随机位
      for (const idx of [0, ref.length >> 1, ref.length - 1]) {
        const got = st.at(idx);
        if (!got || got.seq !== ref[idx].seq) bad += 1;
      }
    }
    ok(bad === 0 && st.total === MAX, 'S6 6000 行灌入后恰好保留最新 4000 行且顺序一致', `bad=${bad}`);

    // 内部数组必须被压实，不能随推送无限增长
    const internal = st.all.length;
    ok(internal <= MAX * 2, 'S7 内部数组已压实（不会随推送无限增长）', `all.length=${internal}`);
  }

  /* 3) 过滤：与旧实现逐条对拍（增量 vs 全量重算） */
  {
    const st = new LogcatStore();
    st.reset([]);
    let seq = 0;
    let mismatches = 0;
    let refAll = [];
    let visited = 0;

    for (let round = 0; round < 24; round += 1) {
      const spec = SPECS[round % SPECS.length];
      st.setFilter(spec);

      const batch = [];
      for (let i = 0; i < 60; i += 1) batch.push(makeLine((seq += 1)));
      st.push(batch);
      refAll = oldTrimLines(refAll.concat(batch));

      const want = oldVisible(refAll, spec);
      visited += 1;
      if (st.visibleCount !== want.length) mismatches += 1;
      if (want.length === 0 && st.at(0) !== undefined) mismatches += 1;
      for (const idx of [0, want.length >> 1, want.length - 1]) {
        if (idx < 0 || !want[idx]) continue;
        const got = st.at(idx);
        if (!got || got.seq !== want[idx].seq) mismatches += 1;
      }
    }
    ok(mismatches === 0, `S8 过滤增量维护 = 旧实现全量重算（${visited} 轮，10 组条件）`, `diff=${mismatches}`);

    // 计数：增量维护 vs 全量数一遍
    const wantCounts = oldCounts(refAll);
    const gotKeys = Object.keys(st.counts).sort().join(',');
    const wantKeys = Object.keys(wantCounts).sort().join(',');
    const sameVals = Object.keys(wantCounts).every((k) => st.counts[k] === wantCounts[k]);
    ok(
      gotKeys === wantKeys && sameVals,
      'S9 级别计数增量维护正确（含被裁掉的行要减掉）',
      `${JSON.stringify(st.counts)} vs ${JSON.stringify(wantCounts)}`,
    );
    const sum = Object.values(st.counts).reduce((a, b) => a + b, 0);
    ok(sum === st.total, 'S10 计数之和 = 总行数', `${sum}/${st.total}`);
  }

  /* 4) 过滤条件下裁旧：可见列表不能残留已被丢弃的行 */
  {
    const st = new LogcatStore();
    st.reset([]);
    st.setFilter({ keyword: 'payload', tags: '', process: '' });
    let seq = 0;
    for (let b = 0; b < 60; b += 1) {
      const batch = [];
      for (let i = 0; i < 100; i += 1) batch.push(makeLine((seq += 1)));
      st.push(batch);
    }
    const firstSeq = st.at(0).seq;
    ok(
      st.visibleCount === MAX && firstSeq === seq - MAX + 1,
      'S11 全命中过滤下可见数也停在 4000，且首行是最新 4000 条的第一条',
      `visible=${st.visibleCount} first=${firstSeq}`,
    );
    const last = st.at(st.visibleCount - 1);
    ok(last && last.seq === seq, 'S12 末行是最新一条', `last=${last ? last.seq : 0}`);
  }

  /* 5) 过滤条件反复切换（用户在输入框里打字）：签名不变不重建，变了要正确 */
  {
    const st = new LogcatStore();
    st.reset([]);
    const batch = [];
    for (let i = 1; i <= 500; i += 1) batch.push(makeLine(i));
    st.push(batch);

    st.setFilter({ keyword: 'error', tags: '', process: '' });
    const a = st.visibleCount;
    st.setFilter({ keyword: 'error', tags: '', process: '' }); // 幂等
    const b = st.visibleCount;
    st.setFilter({ keyword: '  error  ', tags: '', process: '' }); // 只是空格不同 → 不同签名但结果相同
    const c = st.visibleCount;
    st.setFilter({ keyword: '', tags: '', process: '' });
    ok(a === b && b === c, 'S13 同条件重复设置幂等（含首尾空格）', `${a}/${b}/${c}`);
    ok(st.visibleCount === st.total, 'S14 清空条件后回到全量', `${st.visibleCount}/${st.total}`);
  }

  /* 6) 性能：8 批/秒 × 4000 行场景，单批成本应在毫秒级 */
  {
    const st = new LogcatStore();
    st.reset([]);
    st.setFilter({ keyword: 'error,anr', tags: 'Act*', process: '' });
    let seq = 0;
    const mk = (n) => {
      const batch = [];
      for (let i = 0; i < n; i += 1) batch.push(makeLine((seq += 1)));
      return batch;
    };
    // 预热到满载
    for (let i = 0; i < 8; i += 1) st.push(mk(500));

    const N = 200;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) st.push(mk(15));
    const ms = Date.now() - t0;
    ok(ms < 1000, `S15 满载下 200 批（每批 15 行）耗时 < 1s`, `${ms}ms（${(ms / N).toFixed(2)}ms/批）`);
  }

  /* 6b) 与旧实现（复制数组 + 两轮全量扫描）在满载下的每批成本对比 */
  {
    const spec = { keyword: 'error,anr', tags: 'Act*', process: '' };
    const st = new LogcatStore();
    st.reset([]);
    st.setFilter(spec);

    let seq = 0;
    const mk = (n) => {
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(makeLine((seq += 1)));
      return out;
    };
    // 预热到满载 4000 行
    for (let i = 0; i < 8; i += 1) st.push(mk(500));

    const N = 200;
    const batches = [];
    for (let i = 0; i < N; i += 1) batches.push(mk(15));

    const tNew = Date.now();
    for (const b of batches) st.push(b);
    const msNew = Date.now() - tNew;

    // 旧实现同一份数据、同一批次数：concat 4000 + 全量过滤 + 全量计数
    let oldLines = [];
    let s2 = 0;
    for (let i = 0; i < 8; i += 1) {
      const b = [];
      for (let j = 0; j < 500; j += 1) b.push(makeLine((s2 += 1)));
      oldLines = oldTrimLines(oldLines.concat(b));
    }
    const tOld = Date.now();
    for (const b of batches) {
      oldLines = oldTrimLines(oldLines.concat(b));
      oldVisible(oldLines, spec);
      oldCounts(oldLines);
    }
    const msOld = Date.now() - tOld;

    ok(
      msNew < msOld,
      'S17 满载 4000 行时每批成本：新实现快于旧实现',
      `新 ${msNew}ms / 旧 ${msOld}ms（${N} 批，${(msOld / Math.max(msNew, 1)).toFixed(0)}×）`,
    );
  }

  /* 7) 与页面契约：reset 后计数清空，避免旧设备的徽标数字残留 */
  {
    const st = new LogcatStore();
    st.reset([makeLine(1), makeLine(2), makeLine(3), makeLine(4)]);
    const before = JSON.stringify(st.counts);
    st.reset([]);
    ok(st.total === 0 && Object.keys(st.counts).length === 0, 'S18 reset 清空数据与计数', `before=${before}`);
  }

  /* ---------------- 汇总 ---------------- */
  console.log('=== LogcatStore 单测 ===');
  for (const r of rows) console.log(r);
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;
  console.log(`汇总：PASS ${rows.length - fail} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
