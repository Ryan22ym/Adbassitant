/**
 * 触摸采集解析器验收（纯逻辑，不需要设备）
 * ============================================================
 *
 * `getevent -lt` 的输出格式是这一版录制的命门：解析错了，
 * 录出来的所有点位都是废的，而且**不会报错** —— 只会静默录到
 * 一堆偏移的坐标。所以这里用构造的事件流把它钉死。
 *
 * 跑法：
 *   node ./node_modules/typescript/lib/tsc.js -p tsconfig.electron.json
 *   node scripts/check-touch-capture.cjs
 *
 * 覆盖：
 *   A. `getevent -pl` 的设备段落解析（含多节点择优）
 *   B. 坐标归一化（真机量程 2879x6447 → 0~1）
 *   C. 时序：坐标先到、DOWN 后到（触摸屏的常见顺序）
 *   D. 手势识别：tap 出 down+up；swipe 出 down+move*+up
 *   E. 多节点串扰（同一台设备别的 event 节点在刷，不能混进来）
 *   F. 坐标去重（手指按住不动时不产出 move 洪水）
 *   G. 边界 clamp（划出屏幕的负坐标 / >1 坐标）
 *   H. 时间单调不减
 *   I. hex / 十进制两种数值格式都能读
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist-electron', 'electron', 'services', 'touch-capture.js');

if (!fs.existsSync(DIST)) {
  console.error(`找不到编译产物：${DIST}\n请先跑：node ./node_modules/typescript/lib/tsc.js -p tsconfig.electron.json`);
  process.exit(2);
}

const { parseNodes, pickNode, GetEventParser } = require(DIST);

const results = [];
function check(name, ok, extra) {
  results.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(name, ok, ok ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ================================================================== */
/* A. 节点解析                                                         */
/* ================================================================== */

const PL_OUTPUT = `add device 1: /dev/input/event0
  name:     "qpnp_pon"
  events:
    KEY (0001): KEY_VOLUMEUP           KEY_VOLUMEDOWN
add device 2: /dev/input/event1
  name:     "gpio-keys"
  events:
    KEY (0001): KEY_POWER
add device 3: /dev/input/event2
  name:     "touchpanel"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 2879, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 6447, fuzz 0, flat 0, resolution 0
    KEY (0001): BTN_TOUCH
`;

const nodes = parseNodes(PL_OUTPUT);
eq('A1 只留下有 ABS_MT 量程的节点', nodes.length, 1);
eq('A2 拿到正确节点路径', nodes[0] && nodes[0].path, '/dev/input/event2');
eq('A3 拿到设备名', nodes[0] && nodes[0].name, 'touchpanel');
eq('A4 X 量程', [nodes[0] && nodes[0].minX, nodes[0] && nodes[0].maxX], [0, 2879]);
eq('A5 Y 量程', [nodes[0] && nodes[0].minY, nodes[0] && nodes[0].maxY], [0, 6447]);
eq('A6 pickNode 选中 touchpanel', pickNode(nodes) && pickNode(nodes).path, '/dev/input/event2');

// 多触摸屏：优先名字含 touch 的
const multi = parseNodes(`add device 1: /dev/input/event3
  name:     "sec_touchscreen"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 2399, fuzz 0, flat 0, resolution 0
add device 2: /dev/input/event4
  name:     "stylus_digitizer"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
`);
const picked = pickNode(multi);
check(
  'A7 多节点时优先名字含 touch 的（而不是量程大的手写笔）',
  picked && picked.name === 'sec_touchscreen',
  picked && picked.name,
);

// 完全没有触摸节点
eq('A8 没有触摸节点时返回空数组', parseNodes('add device 1: /dev/input/event0\n  name: "gpio-keys"\n').length, 0);
eq('A9 pickNode 空数组返回 null', pickNode([]), null);

/* ================================================================== */
/* B~I. 事件流解析                                                     */
/* ================================================================== */

const NODE = { path: '/dev/input/event2', name: 'touchpanel', minX: 0, maxX: 2879, minY: 0, maxY: 6447 };

/** 造一行 getevent -lt 输出 */
function line(t, dev, type, code, val) {
  const ts = t.toFixed(6).padStart(12, ' ');
  return `[${ts}] ${dev}: ${type}       ${code.padEnd(20, ' ')} ${val}`;
}
const EV2 = '/dev/input/event2';
const EV1 = '/dev/input/event1';

function feedAll(parser, lines) {
  for (const l of lines) parser.feed(l);
  return parser.drain();
}

/** 把原始 ABS 值写成 hex（getevent -lt 的默认格式） */
function hex(v) {
  return v.toString(16).padStart(8, '0');
}

/* --- C. 时序：坐标先到、DOWN 后到 --------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    line(100.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(1440)), // 正好中点
    line(100.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)),
    line(100.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(100.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  eq('C1 坐标先到也能拿到 down（不是丢第一点）', got.length >= 1 && got[0].type, 'down');
  check(
    'C2 down 坐标 ≈ 屏幕中心（0.5, 0.5）',
    got[0] && Math.abs(got[0].nx - 0.5) < 0.01 && Math.abs(got[0].ny - 0.5) < 0.01,
    got[0] ? `(${got[0].nx}, ${got[0].ny})` : 'none',
  );
}

/* --- D. tap = down + up ------------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    line(200.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(288)), // 0.1
    line(200.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(645)), // 0.1
    line(200.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(200.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
    line(200.15, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'),
    line(200.151, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  eq('D1 tap 类型序列 = down,up', got.map((x) => x.type), ['down', 'up']);
  check(
    'D2 down 坐标 ≈ (0.1, 0.1)',
    Math.abs(got[0].nx - 0.1) < 0.01 && Math.abs(got[0].ny - 0.1) < 0.01,
    `(${got[0].nx}, ${got[0].ny})`,
  );
  check('D3 up 也带坐标（不悬空）', got[1].nx > 0 && got[1].ny > 0, `(${got[1].nx}, ${got[1].ny})`);
}

/* --- D2. swipe = down + move* + up -------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const steps = [];
  steps.push(line(300.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(288)));
  steps.push(line(300.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
  steps.push(line(300.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'));
  steps.push(line(300.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  // 每 50ms 往右挪 10%
  for (let i = 1; i <= 4; i++) {
    const t = 300 + i * 0.05;
    steps.push(line(t, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(288 + i * 288)));
    steps.push(line(t + 0.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
    steps.push(line(t + 0.002, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  }
  steps.push(line(300.3, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'));
  steps.push(line(300.301, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));

  const got = feedAll(p, steps);
  eq('D4 swipe 首尾类型', [got[0].type, got[got.length - 1].type], ['down', 'up']);
  const moves = got.filter((x) => x.type === 'move');
  check('D5 swipe 中间产出 move', moves.length >= 3, `move=${moves.length}`);
  check('D6 move 的 x 单调右移', moves.every((m, i) => i === 0 || m.nx > moves[i - 1].nx), '');
}

/* --- E. 多节点串扰 ------------------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    // 按键节点在刷 —— 不能被当成触摸
    line(400.0, EV1, 'EV_KEY', 'KEY_POWER', 'DOWN'),
    line(400.001, EV1, 'EV_SYN', 'SYN_REPORT', '00000000'),
    // 触摸节点的正常一击
    line(400.1, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(1440)),
    line(400.101, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)),
    line(400.102, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(400.103, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
    line(400.2, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'),
    line(400.201, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  eq('E1 别的节点的事件被过滤掉', got.length, 2);
  eq('E2 只留下触摸节点的 down,up', got.map((x) => x.type), ['down', 'up']);
}

/* --- F. 按住不动不产 move 洪水 ------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const steps = [];
  steps.push(line(500.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(1440)));
  steps.push(line(500.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
  steps.push(line(500.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'));
  steps.push(line(500.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  // 连续 20 个 SYN，坐标不变（触摸屏按住时的典型输出）
  for (let i = 1; i <= 20; i++) {
    const t = 500 + i * 0.016;
    steps.push(line(t, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(1440)));
    steps.push(line(t + 0.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
    steps.push(line(t + 0.002, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  }
  const got = feedAll(p, steps);
  eq('F1 按住不动时只有 down（无 move 洪水）', got.map((x) => x.type), ['down']);
}

/* --- G. 越界坐标 clamp --------------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    line(600.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(99999)), // 远超 max
    line(600.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)),
    line(600.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(600.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  check('G1 超出 max 的 X 被 clamp 到 1', got[0] && got[0].nx === 1, got[0] && String(got[0].nx));
}

/* --- H. 时间单调不减 ----------------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const steps = [];
  steps.push(line(700.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(288)));
  steps.push(line(700.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
  steps.push(line(700.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'));
  steps.push(line(700.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  // 时间戳故意回退（同一批内浮点差）
  steps.push(line(699.5, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(576)));
  steps.push(line(699.501, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)));
  steps.push(line(699.502, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  steps.push(line(700.4, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'));
  steps.push(line(700.401, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'));
  const got = feedAll(p, steps);
  let mono = true;
  for (let i = 1; i < got.length; i++) if (got[i].t < got[i - 1].t) mono = false;
  check('H1 t 单调不减（时间戳回退被吸收）', mono, got.map((x) => x.t).join(','));
}

/* --- I. hex / 十进制都认 ------------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    line(800.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', '1440'), // 十进制
    line(800.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', '3223'), // 十进制
    line(800.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(800.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  check(
    'I1 十进制数值列也能解析',
    got[0] && Math.abs(got[0].nx - 0.5) < 0.01 && Math.abs(got[0].ny - 0.5) < 0.01,
    got[0] ? `(${got[0].nx}, ${got[0].ny})` : 'none',
  );
}

/* --- J. 暂停时事件被丢弃 ------------------------------------------- */

{
  let paused = true;
  const p = new GetEventParser(NODE, 0, 0, () => paused);
  const got1 = feedAll(p, [
    line(900.0, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(1440)),
    line(900.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)),
    line(900.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(900.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  eq('J1 暂停时不产出事件', got1.length, 0);
  paused = false;
  const got2 = feedAll(p, [
    line(901.0, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'),
    line(901.001, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  check('J2 恢复后 up 仍能发出（手势不悬空）', got2.some((x) => x.type === 'up'), '');
}

/* --- K. 无坐标时的 up 兜底 ----------------------------------------- */

{
  const p = new GetEventParser(NODE, 0, 0);
  const got = feedAll(p, [
    line(950.0, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'),
    line(950.001, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  // 从来没按下过，所以这次 UP 不该产生事件（down 都没记过）
  eq('K1 没按下过的孤立 UP 不产出', got.length, 0);
}

/* --- L. 真实量级的时间戳 -------------------------------------------- */

/*
 * ⚠️ 这一组是回归防线。设备时间戳是**开机以来的秒数**（真机上是
 * `12345.678901` 这种量级），跟电脑墙钟（1.7e12 这种量级）毫无关系。
 * 第一版实现错误地拿 epoch（墙钟）去减设备时间戳，结果每个 t 都变成
 * 巨大的负数、被兜底成 0 —— 表现是「所有触摸点时间戳全是 0」，
 * 而且不报错。用小时间戳（700.0 那种）测是**测不出来的**，
 * 所以这里刻意用真实量级。
 */
{
  const WALL = Date.now(); // 电脑墙钟：1.7e12 量级
  const BOOT = 12345.678901; // 设备开机时间：1.2 万秒

  const p = new GetEventParser(NODE, WALL, 0);
  const got = feedAll(p, [
    line(BOOT, EV2, 'EV_ABS', 'ABS_MT_POSITION_X', hex(288)),
    line(BOOT + 0.001, EV2, 'EV_ABS', 'ABS_MT_POSITION_Y', hex(3223)),
    line(BOOT + 0.002, EV2, 'EV_KEY', 'BTN_TOUCH', 'DOWN'),
    line(BOOT + 0.003, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
    line(BOOT + 0.5, EV2, 'EV_KEY', 'BTN_TOUCH', 'UP'),
    line(BOOT + 0.501, EV2, 'EV_SYN', 'SYN_REPORT', '00000000'),
  ]);
  eq('L1 真实量级时间戳仍产出 2 条', got.length, 2);
  check('L2 第一条 t ≈ 0（不是巨大负数/退化成 0 的假象）', got[0] && got[0].t <= 5, got[0] && String(got[0].t));
  check(
    'L3 第二条 t ≈ 500ms（时间跨度算对）',
    got[1] && Math.abs(got[1].t - 500) < 20,
    got[1] && String(got[1].t),
  );
  check('L4 坐标仍然正确（0.1）', got[0] && Math.abs(got[0].nx - 0.1) < 0.01, got[0] && String(got[0].nx));
}

/* --- M. 无时间戳时的兜底 ------------------------------------------- */

{
  const WALL = Date.now();
  const p = new GetEventParser(NODE, WALL, 0);
  // 故意不写行首时间戳（个别 rom 的 -lt 行为不一致）
  const got = feedAll(p, [
    `${EV2}: EV_ABS       ABS_MT_POSITION_X     ${hex(1440)}`,
    `${EV2}: EV_ABS       ABS_MT_POSITION_Y     ${hex(3223)}`,
    `${EV2}: EV_KEY       BTN_TOUCH            DOWN`,
    `${EV2}: EV_SYN       SYN_REPORT           00000000`,
  ]);
  eq('M1 没有时间戳也能解析出 down', got.length, 1);
  check('M2 退回墙钟兜底（t 很小，不是负数）', got[0] && got[0].t >= 0 && got[0].t < 5000, got[0] && String(got[0].t));
  check('M3 坐标正确（0.5）', got[0] && Math.abs(got[0].nx - 0.5) < 0.01, got[0] && String(got[0].nx));
}

/* ================================================================== */

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('[FAIL]')).length;
console.log(`\n总计 ${results.length} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
