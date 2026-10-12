/**
 * 「插入手机自动投屏」判定回归（纯 Node，不用 Electron）
 *
 *   node scripts/check-auto-connect.cjs
 *
 * 测的是 `shared/auto-connect-core.ts` 里那套规则 —— 它决定「什么时候该自动投屏」。
 *
 * 为什么值得单独回归：这套逻辑的失败方式是**安静的**。
 * 门槛少判一条 → 插上线就乱投屏（用户只觉得烦，不会来报 bug）；
 * 上升沿写错 → 授权完那一下不触发（表现为「功能时灵时不灵」）；
 * 基线没建 → 程序一启动就补投一次（用户以为中招了）。
 * 这些都不会抛异常，只能靠用例钉住。
 *
 * 规则是纯函数，所以这里能直接喂设备数组，不需要 adb、不需要真机、不碰磁盘。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_auto-connect.log');

const C = require('../dist-electron/shared/auto-connect-core.js');

const rows = [];
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

/* 真机 serial 取自本机常插的那台；模拟器那台常年在线，必须被拦住 */
const REAL = 'aaab4f58';
const OTHER_REAL = 'b1c2d3e4';
const EMU = 'emulator-5556';
const TCP = '192.168.1.20:5555';

/** 造一台设备，只覆盖关心的字段 */
const dev = (over = {}) => ({
  serial: REAL,
  state: 'device',
  connection: 'usb',
  isEmulator: false,
  ...over,
});

const st = () => C.createAutoConnectState();
const opts = (over = {}) => ({ enabled: true, mirrored: [REAL], now: 1000, ...over });

/* ------------------------------------------------------------------ */
/* A 三重门槛（isEligible）                                            */
/* ------------------------------------------------------------------ */

function checkGate() {
  const M = new Set([REAL, OTHER_REAL]);

  record(C.isEligible(dev(), M) === true, 'A1 USB 真机 + 已授权 + 在白名单 → 命中', REAL);
  record(
    C.isEligible(dev({ connection: 'tcp' }), M) === false,
    'A2 无线设备（tcp）→ 拦住',
    'connection=tcp',
  );
  record(
    C.isEligible(dev({ isEmulator: true, serial: EMU }), new Set([EMU])) === false,
    'A3 模拟器 → 拦住（即便它也在白名单里）',
    EMU,
  );
  record(
    C.isEligible(dev({ state: 'unauthorized' }), M) === false,
    'A4 未授权 → 拦住（投了必然失败）',
    'unauthorized',
  );
  record(C.isEligible(dev({ state: 'offline' }), M) === false, 'A5 offline → 拦住', 'offline');
  record(
    C.isEligible(dev({ serial: 'zzz99999' }), M) === false,
    'A6 不在白名单（没手动投屏成功过）→ 拦住',
    'zzz99999',
  );
  record(
    C.isEligible(dev({ serial: OTHER_REAL }), new Set([REAL])) === false,
    'A7 白名单只有别的设备 → 拦住',
    OTHER_REAL,
  );
}

/* ------------------------------------------------------------------ */
/* B 触发时序（pickTarget）                                            */
/* ------------------------------------------------------------------ */

function checkTiming() {
  /* ---- B1 首轮只建基线：程序启动时已经插着的设备不该补投 ---- */
  {
    const s = st();
    const r = C.pickTarget([dev()], s, opts());
    record(r === null, 'B1 首轮只建基线，不触发（启动时已插着不算插入）', String(r));
    record(s.armed.has(REAL), 'B1b 但基线记住了它（之后不会重复触发）', [...s.armed].join(','));
  }

  /* ---- B2 同一台设备一直在，不该反复投 ---- */
  {
    const s = st();
    C.pickTarget([dev()], s, opts({ now: 1000 }));
    let fired = 0;
    for (let t = 1200; t < 60000; t += 200) {
      if (C.pickTarget([dev()], s, opts({ now: t }))) fired++;
    }
    record(fired === 0, 'B2 设备一直插着 → 不重复触发', `fired=${fired}`);
  }

  /* ---- B3 拔掉再插回来（超过冷却）→ 触发 ---- */
  {
    const s = st();
    C.pickTarget([dev()], s, opts({ now: 1000 })); // 基线
    C.pickTarget([], s, opts({ now: 2000 })); // 拔掉
    const r = C.pickTarget([dev()], s, opts({ now: 20000 })); // 隔一会儿插回来
    record(r && r.serial === REAL, 'B3 拔掉再插回来（已过冷却）→ 触发', r ? r.serial : 'null');
  }

  /* ---- B4 拔插太快（冷却期内）→ 不触发 ---- */
  {
    const s = st();
    C.pickTarget([dev()], s, opts({ now: 1000 }));
    C.pickTarget([], s, opts({ now: 2000 }));
    const r = C.pickTarget([dev()], s, opts({ now: 2500 }));
    record(r === null, 'B4 拔插间隔小于冷却 → 不触发（防 adb 抖动）', String(r));
    const later = C.pickTarget([dev()], s, opts({ now: 90000 }));
    record(later === null, 'B4b 冷却过后也不补触发（它已经算「在插着」了）', String(later));
  }

  /* ---- B5 关键路径：插上时未授权 → 用户点授权 → 该触发 ---- */
  {
    const s = st();
    C.pickTarget([dev({ state: 'unauthorized' })], s, opts({ now: 1000 })); // 基线
    const still = C.pickTarget([dev({ state: 'unauthorized' })], s, opts({ now: 2000 }));
    record(still === null, 'B5a 未授权期间不触发', String(still));
    const r = C.pickTarget([dev({ state: 'device' })], s, opts({ now: 9000 }));
    record(r && r.serial === REAL, 'B5b 授权完成的那一刻触发（上升沿）', r ? r.serial : 'null');
  }

  /* ---- B6 开关关着：什么都不做 ---- */
  {
    const s = st();
    C.pickTarget([dev()], s, opts({ enabled: false, now: 1000 }));
    const r = C.pickTarget([dev()], s, opts({ enabled: false, now: 9000 }));
    record(r === null, 'B6 开关关闭 → 不触发', String(r));
    record(s.armed.size === 0, 'B6b 开关关闭时 armed 为空（没在偷偷记账）', `${s.armed.size}`);
  }

  /* ---- B7 刚打开开关的那一轮不触发 ---- */
  {
    const s = st();
    C.pickTarget([dev()], s, opts({ enabled: false, now: 1000 })); // 关着
    const r = C.pickTarget([dev()], s, opts({ enabled: true, now: 2000 })); // 刚开
    record(r === null, 'B7 刚打开开关不立刻投屏', String(r));
    C.pickTarget([], s, opts({ enabled: true, now: 3000 })); // 拔掉
    const again = C.pickTarget([dev()], s, opts({ enabled: true, now: 30000 }));
    record(again && again.serial === REAL, 'B7b 开完开关之后真的拔插才投', again ? again.serial : 'null');
  }

  /* ---- B8 混杂现场：只有符合三条件的真机被挑中 ---- */
  {
    const s = st();
    const list = [
      dev({ serial: EMU, isEmulator: true }),
      dev({ serial: TCP, connection: 'tcp' }),
      dev({ serial: OTHER_REAL }), // USB 真机但没在白名单
      dev({ serial: REAL, state: 'unauthorized' }),
    ];
    C.pickTarget(list, s, opts({ now: 1000 }));
    record(s.armed.size === 0, 'B8 混杂现场：四台都不符合，armed 为空', `${s.armed.size}`);

    const r = C.pickTarget([...list.slice(0, 3), dev()], s, opts({ now: 30000 }));
    record(r && r.serial === REAL, 'B8b 授权完成后只挑中目标真机', r ? r.serial : 'null');
  }

  /* ---- B9 同时插上两台符合条件的 → 只挑一台（不猜、不并发投屏）---- */
  {
    const s = st();
    C.pickTarget([], s, opts({ mirrored: [REAL, OTHER_REAL], now: 1000 }));
    const r = C.pickTarget(
      [dev({ serial: REAL }), dev({ serial: OTHER_REAL })],
      s,
      opts({ mirrored: [REAL, OTHER_REAL], now: 30000 }),
    );
    record(!!r && (r.serial === REAL || r.serial === OTHER_REAL), 'B9 两台同时满足 → 挑一台', r ? r.serial : 'null');
    record(s.armed.size === 2, 'B9b 两台都记进 armed（不会下一轮再投另一台）', `${s.armed.size}`);
  }

  /* ---- B10 白名单为空 → 永远不触发 ---- */
  {
    const s = st();
    C.pickTarget([], s, opts({ mirrored: [], now: 1000 }));
    const r = C.pickTarget([dev()], s, opts({ mirrored: [], now: 30000 }));
    record(r === null, 'B10 白名单为空（从没手动投过屏）→ 不触发', String(r));
  }
}

/* ------------------------------------------------------------------ */

log(`\n===== auto connect check @ ${new Date().toISOString()} =====`);
checkGate();
checkTiming();

rows.forEach((r) => log(r));

const failed = rows.filter((r) => r.startsWith('FAIL'));
log(`\n共 ${rows.length} 项，失败 ${failed.length} 项`);
log('AUTO CONNECT CHECK DONE');

console.log(rows.join('\n'));
console.log(`\n共 ${rows.length} 项，失败 ${failed.length} 项`);
console.log('AUTO CONNECT CHECK DONE');
process.exit(failed.length ? 1 : 0);
