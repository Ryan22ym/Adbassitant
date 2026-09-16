/**
 * 「更新助手能不能启动」的行为检查 —— 阶段一（跑在真 Electron 主进程里）。
 *
 * 为什么单独查这一环
 * ------------------------------------------------------------
 * 这是「本地静态检查全绿、真机才炸」的重灾区，而且两种坏法都不报错：
 *   · 直接 spawn(powershell) → 应用在带 KILL_ON_JOB_CLOSE 的作业对象里，宿主一退就被连坐，
 *     helper.log 一行都没有；
 *   · detached:true（DETACHED_PROCESS）→ PowerShell 退出码 0 但一行都不执行。
 * 所以这里不查源码写法，查**行为**：走一遍生产代码的 stageHelperScript + spawnHelper。
 *
 * 阶段一（本文件）
 *   造一个「什么都不用动」的 job.json（targets 空、launchExe 空、healthTimeoutSec 0），
 *   调 update.spawnHelperForCheck()，等助手落下第一行日志，记录宿主退出时刻，然后 app.exit(0)。
 * 阶段二（scripts/check-helper-launch.py）
 *   宿主死掉之后再断言助手把活干完了（result.json ok=true + helper exit），
 *   并且完成时刻晚于宿主退出时刻 —— 这一条才是「没被连坐」的硬证据。
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'ui-shots', '_helper-launch.log');

const rows = [];
const record = (ok, name, detail = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`;
  rows.push(line);
  fs.appendFileSync(LOG, line + '\n');
};

const STAMP = Date.now();
const STAGE = path.join(os.tmpdir(), `adba-hl-stage-${STAMP}`);
const STATE = path.join(os.tmpdir(), `adba-hl-state-${STAMP}`);
const BACKUP = path.join(STATE, 'backup');

const JOB = {
  schema: 1,
  mode: 'apply',
  kind: 'asar',
  pid: process.pid, // 助手会等这个 pid 退出；宿主一退它就往下走
  staging: STAGE,
  resultPath: path.join(STATE, 'result.json'),
  pendingPath: path.join(STATE, 'pending.json'),
  healthPath: path.join(STATE, 'health.ok'),
  backupDir: BACKUP,
  logPath: path.join(STATE, 'helper.log'),
  fromVersion: '9.9.8',
  toVersion: '9.9.9',
  targets: [], // 空 → 不备份、不替换，只走「启动 → 落结果 → 退出」
  launchExe: '', // 空 → 不启动任何程序（避免真的拉起一个实例）
  launchArgs: [],
  workDir: '',
  healthTimeoutSec: 0, // 0 → 跳过健康检查，直接判成功
};

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(STATE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(path.join(STAGE, 'job.json'), JSON.stringify(JOB, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const started = { STAGE, STATE, JOB };

  let update = null;
  try {
    // 走生产代码：dist-electron/electron/services/update.js
    update = require(path.join(ROOT, 'dist-electron', 'electron', 'services', 'update.js'));
    record(typeof update.spawnHelperForCheck === 'function', '生产代码导出了 spawnHelperForCheck', typeof update.spawnHelperForCheck);
  } catch (e) {
    record(false, '加载 dist-electron 里的 update.js', String(e && e.message));
  }

  if (update && typeof update.spawnHelperForCheck === 'function') {
    let res = null;
    try {
      res = update.spawnHelperForCheck(STAGE);
      record(!!res && res.pid > 0, 'spawnHelper 返回了 pid', JSON.stringify(res));
    } catch (e) {
      record(false, 'spawnHelper 未抛异常', String(e && e.message));
    }

    if (res) {
      record(fs.existsSync(res.scriptPath), '助手脚本已落到暂存目录', res.scriptPath);
      let head = '';
      try {
        head = fs.readFileSync(res.scriptPath, 'utf8');
      } catch {
        /* ignore */
      }
      record(head.charCodeAt(0) === 0xfeff, '落地的 .ps1 带 UTF-8 BOM（PowerShell 5.1 才不乱码）', '0x' + head.charCodeAt(0).toString(16));
      record(!head.includes('__STAGING__'), '占位符 __STAGING__ 已被替换成真实路径', '');
      record(head.includes(STAGE), '脚本里能看到暂存目录真实路径', '');

      // 等助手落第一行日志（= 它真的被 PowerShell 执行了）
      let waited = -1;
      const t0 = Date.now();
      let logText = '';
      while (Date.now() - t0 < 20_000) {
        try {
          logText = fs.readFileSync(JOB.logPath, 'utf8');
        } catch {
          logText = '';
        }
        if (/helper start/.test(logText)) {
          waited = Date.now() - t0;
          break;
        }
        await sleep(200);
      }
      record(waited >= 0, '助手在 20 秒内落下第一行日志（说明 PowerShell 真的执行了）', waited >= 0 ? `${waited} ms` : '超时');
      fs.appendFileSync(LOG, `INFO  宿主 app.exit() 时刻: ${new Date().toISOString()}\n`);
      fs.appendFileSync(LOG, `INFO  helper.log(截至退出前): ${JSON.stringify(logText)}\n`);
    }
  }

  fs.writeFileSync(path.join(ROOT, 'ui-shots', '_helper-launch-state.json'), JSON.stringify(started, null, 2), 'utf8');
  fs.appendFileSync(LOG, 'HELPER LAUNCH PHASE1 DONE\n');
  setTimeout(() => app.exit(0), 300);
});
