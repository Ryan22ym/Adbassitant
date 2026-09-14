#!/usr/bin/env node
/**
 * 生产包验收 · Stage 1 —— 环境与启动自检
 *
 * 目的：在【真实生产构建】(win-unpacked) 下验证交付物可用性，而不是开发期跑脚本。
 *
 * 做法：
 *   1. 从 dist-release/win-unpacked/ADB桌面助手.exe 启动生产版
 *      —— 加 --remote-debugging-port，用 CDP 驱动（零新依赖，Node 22 自带 WebSocket）
 *   2. 验证进程真实存活、窗口打开、页面渲染、preload 桥接就绪
 *   3. 在生产环境内调用 IPC，验证随包 adb 枚举设备
 *
 * 注意：必须用 detached 方式启动，父进程退出不能带走子进程。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// 产物目录可通过 ADB_OUT_DIR 覆盖（历史上输出目录被句柄锁住时需要换名打包）
const OUT_DIR = process.env.ADB_OUT_DIR || 'out-v1';
const EXE = path.join(ROOT, OUT_DIR, 'win-unpacked', 'ADB桌面助手.exe');
const PORT = 9333;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询 CDP /json 端点，直到拿到页面目标 */
function fetchTargets(retries = 40, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const list = JSON.parse(body);
              const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
              if (page) return resolve(page);
            } catch { /* ignore */ }
            if (n >= retries) return resolve(null);
            setTimeout(tick, interval);
          });
        })
        .on('error', () => {
          if (n >= retries) return resolve(null);
          setTimeout(tick, interval);
        });
    };
    tick();
  });
}

/** 极简 CDP 客户端（基于 Node 22 内置 WebSocket） */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }

  /** 在页面上下文求值，返回 JSON 值 */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

(async () => {
  console.log('=== 生产包验收 · Stage 1：启动与环境 ===\n');

  if (!fs.existsSync(EXE)) {
    check('生产 exe 存在', false, EXE);
    process.exit(1);
  }
  const exeSize = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  check('生产 exe 存在', true, `${exeSize} MB  ${EXE}`);

  // 生产环境 bin 目录（extraResources 落地位置）
  const binDir = path.join(ROOT, OUT_DIR, 'win-unpacked', 'resources', 'bin');
  const need = ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'scrcpy.exe', 'scrcpy-server',
    'SDL2.dll', 'avcodec-61.dll', 'avformat-61.dll', 'avutil-59.dll', 'swresample-5.dll', 'libusb-1.0.dll'];
  const missing = need.filter((f) => !fs.existsSync(path.join(binDir, f)));
  check('随包二进制齐全', missing.length === 0, missing.length ? '缺失：' + missing.join(', ') : `${need.length} 个文件`);

  // —— 启动生产版（detached，父进程退出不影响它）——
  // 注意 1：cwd 必须是中性目录。若设为 win-unpacked，本进程会持有该目录句柄，
  //         导致后续打包时 electron-builder 无法删除/重建 win-unpacked。
  // 注意 2：必须清掉 ELECTRON_RUN_AS_NODE。若该变量为 1，任何 Electron 二进制
  //         都会强制以纯 Node 模式运行 —— 表现为 `--version` 打印 Node 版本、
  //         不识别 --remote-debugging-port、无参数时静默退出（退出码 0），
  //         极易被误判为"打包成功但启动即退出"。
  console.log('\n启动生产版（带远程调试端口）...');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
    cwd: require('os').tmpdir(),
    env: childEnv,
  });
  child.unref();
  const pid = child.pid;
  console.log(`  pid = ${pid}`);

  await sleep(1500);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  check('生产进程启动', alive, `pid=${pid}`);

  // —— 等 CDP 就绪 ——
  const target = await fetchTargets();
  check('远程调试端点就绪', !!target, target ? target.url : `端口 ${PORT} 无响应`);
  if (!target) {
    try { process.kill(pid); } catch { /* ignore */ }
    summarize();
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  // —— 生产环境关键断言 ——
  // 注意：CDP 端点就绪 ≠ 渲染进程已完成首屏。首屏（React 挂载 + 异步路由加载）
  //       需要额外时间，因此这里轮询等待，而不是一次性求值。曾因一次性求值
  //       误报 "React 已挂载 = 0 子节点"。
  const snapshot = `(() => {
    const w = window;
    const api = w.adbApi;
    const root = document.getElementById('root');
    return {
      href: location.href,
      readyState: document.readyState,
      hasBridge: !!api,
      bridgeKeys: api ? Object.keys(api).length : 0,
      bridgeMethods: api ? Object.keys(api).sort().join(',') : '',
      title: document.title,
      rootChild: root ? root.children.length : -1,
      bodyText: (document.body.innerText || '').slice(0, 200),
    };
  })()`;
  let info = null;
  for (let i = 0; i < 30; i++) {
    try { info = await cdp.eval(snapshot); } catch { info = null; }
    if (info && info.rootChild > 0) break;
    await sleep(400);
  }
  if (!info) info = { href: '', readyState: '', hasBridge: false, bridgeKeys: 0, title: '', rootChild: -1, bodyText: '' };

  console.log('\n--- 生产环境快照 ---');
  console.log('  location :', info.href);
  console.log('  title    :', info.title);
  console.log('  root 子节点:', info.rootChild);
  console.log('  preload 方法数:', info.bridgeKeys);
  console.log('  页面文本 :', JSON.stringify(info.bodyText.slice(0, 120)));

  check('页面从 asar 加载成功', /index\.html/i.test(info.href), info.href);
  check('React 已挂载', info.rootChild > 0, `root 子节点 ${info.rootChild}`);
  check('preload 桥接就绪', info.hasBridge && info.bridgeKeys >= 30, `${info.bridgeKeys} 个方法`);

  // —— 在生产环境内调用 IPC：设备枚举 ——
  // 首次调用可能撞上 adb server 冷启动（前一次 kill-server 之后），因此重试几次。
  let devsRaw = '[]';
  let list = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    devsRaw = await cdp.eval(`(async () => {
      try {
        const r = await window.adbApi.listDevices();
        return JSON.stringify(r);
      } catch (e) { return JSON.stringify({ __err: String(e) }); }
    })()`);
    let devs = null;
    try {
      devs = JSON.parse(devsRaw);
    } catch { /* ignore */ }
    list = Array.isArray(devs) ? devs : (devs && devs.data) || [];
    if (Array.isArray(list) && list.length > 0) break;
    if (attempt < 3) {
      console.log(`  (设备枚举第 ${attempt} 次为空，1.5s 后重试)`);
      await sleep(1500);
    }
  }
  const ready = list.filter((d) => (d.state || d.status || '') === 'device');
  check('随包 adb 枚举设备', Array.isArray(list) && list.length > 0,
    Array.isArray(list) ? `${list.length} 台（就绪 ${ready.length}）: ${list.map((d) => d.serial || d.id || '?').join(', ')}` : String(devsRaw).slice(0, 200));

  // —— 环境自检（生产路径解析）——
  const envRaw = await cdp.eval(`(async () => {
    try {
      const r = await window.adbApi.checkEnv();
      return JSON.stringify(r);
    } catch (e) { return JSON.stringify({ __err: String(e) }); }
  })()`);
  console.log('\n--- 环境自检原始返回 ---');
  console.log(' ', String(envRaw).slice(0, 800));
  let env = null;
  try { env = JSON.parse(envRaw); } catch { /* ignore */ }
  const envData = env && env.data ? env.data : env;
  if (envData && typeof envData === 'object') {
    const items = Array.isArray(envData) ? envData : envData.items || [];
    for (const it of items) {
      console.log(`    · ${it.name || it.label || '?'}: ${it.ok ? 'OK' : 'FAIL'} ${it.detail || it.info || ''}`);
    }
    check('环境自检项存在', items.length > 0, `${items.length} 项`);
  }

  // —— 页面路由可达性 ——
  const routes = ['#/', '#/mirror', '#/tools', '#/apps', '#/logcat', '#/weaknet',
    '#/command', '#/logs', '#/settings'];
  const routeOk = await cdp.eval(`(async () => {
    const out = [];
    for (const h of ${JSON.stringify(routes)}) {
      location.hash = h;
      await new Promise(r => setTimeout(r, 260));
      const root = document.getElementById('root');
      out.push({ h, nodes: root ? root.children.length : -1 });
    }
    return JSON.stringify(out);
  })()`);
  let rlist = [];
  try { rlist = JSON.parse(routeOk); } catch { /* ignore */ }
  console.log('\n--- 路由渲染 ---');
  for (const r of rlist) console.log(`    ${r.h.padEnd(12)} root 子节点 ${r.nodes}`);
  const badRoutes = rlist.filter((r) => r.nodes <= 0);
  check('全部页面可渲染', rlist.length > 0 && badRoutes.length === 0,
    badRoutes.length ? '空白页: ' + badRoutes.map((r) => r.h).join(', ') : `${rlist.length} 个路由`);

  // —— 生产日志落地（userData 目录）——
  const userDataRaw = await cdp.eval(`(async () => {
    try { return JSON.stringify(await window.adbApi.getAllLogs()); } catch (e) { return '[]'; }
  })()`);
  console.log('\n--- 运行日志尾部 ---');
  try {
    const logs = JSON.parse(userDataRaw);
    const arr = Array.isArray(logs) ? logs : (logs && logs.data) || [];
    for (const l of arr.slice(-8)) {
      console.log(`    [${l.level}] ${l.scope || ''} ${String(l.message || l.msg || '').slice(0, 90)}`);
    }
    check('运行日志有内容', arr.length > 0, `${arr.length} 条`);
  } catch {
    check('运行日志有内容', false, String(userDataRaw).slice(0, 120));
  }

  cdp.close();
  try { process.kill(pid); } catch { /* ignore */ }
  await sleep(600);
  let dead = true;
  try { process.kill(pid, 0); dead = false; } catch { dead = true; }
  check('生产进程可正常退出', dead, dead ? '已退出' : `pid ${pid} 仍存活`);

  summarize();

  function summarize() {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n=== 结果：${pass}/${results.length} 通过 ===`);
    const fails = results.filter((r) => !r.ok);
    if (fails.length) {
      console.log('失败项：');
      for (const f of fails) console.log(`  - ${f.name} :: ${f.detail}`);
    }
    const outFile = path.join(ROOT, 'docs', 'test-packaged-stage1.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, [
      `生产包验收 Stage 1 · ${new Date().toISOString()}`,
      `exe: ${EXE}`,
      '',
      ...results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' :: ' + r.detail : ''}`),
      '',
      `合计：${pass}/${results.length} 通过`,
    ].join('\n'), 'utf8');
    console.log(`结果已写入 ${outFile}`);
    process.exit(fails.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(1);
});
