/* 验证 _ws-shim.cjs：能不能连上安装版真身的 CDP 端点并跑通命令。
 *
 * 目的单一 —— **只验垫片本身**（Electron 主进程没有全局 WebSocket）。
 * 签名面板是否存在的验收另有 `check-aab-ui.cjs -- ... --installed` 负责，
 * 那里有完整的「选设备 + 注入 .aab + 点标签」流程，不要在这里重复实现
 * （面板要选中 .aab 才渲染，裸搜 body.innerHTML 只会得到假失败）。
 *
 * 在 Electron 主进程里跑：electron.exe scripts/_ws-shim-test.cjs
 */
const shim = require('./_ws-shim.cjs');
const installed = shim.install();
console.log('[shim] installed =', installed, '| WebSocket =', typeof WebSocket);

const url = require('fs').readFileSync('ui-shots/_cdpurl.txt', 'utf8').trim();
console.log('[shim] url =', url);

let fail = 0;
function chk(ok, name, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  ::  ' + detail : ''));
  if (!ok) fail++;
}

(async () => {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e && e.message))));
    setTimeout(() => rej(new Error('open 超时')), 10000);
  });
  chk(true, 'WebSocket 完成握手并 OPEN');

  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId);
          reject(new Error('timeout ' + method));
        }
      }, 15000);
    });

  // 1) 基本 RPC
  await send('Runtime.enable');
  chk(true, 'Runtime.enable 往返成功');

  const r = await send('Runtime.evaluate', {
    expression: 'document.title + "|" + (location.hash || "none")',
    returnByValue: true,
  });
  const val = r.result && r.result.value;
  chk(typeof val === 'string' && val.length > 0, '能 eval 出页面标题与路由', JSON.stringify(val));

  // 2) 分片/大消息：DOM.getDocument 的返回体远超一个 TCP 段，
  //    能正确拼回说明帧解析（含长度扩展与缓冲区累积）没问题。
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: 2 });
  chk(!!(doc && doc.root && doc.root.nodeName), '大响应能完整拼回（DOM.getDocument）', String(doc && doc.root && doc.root.nodeName));

  // 3) 连续多次 RPC：验证 id 匹配不会串台
  const results = await Promise.all([
    send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
    send('Runtime.evaluate', { expression: '"a"+"b"', returnByValue: true }),
    send('Runtime.evaluate', { expression: '[1,2,3].length', returnByValue: true }),
  ]);
  const vals = results.map((x) => x.result && x.result.value);
  chk(
    vals[0] === 2 && vals[1] === 'ab' && vals[2] === 3,
    '并发 RPC 的请求/响应 id 不串台',
    JSON.stringify(vals),
  );

  // 4) 安装版里确实有「安装安装包」标签（轻量确认，不作功能验收）
  const tabs = await send('Runtime.evaluate', {
    expression: `(function(){ window.location.hash='#/tools'; return true; })()`,
    returnByValue: true,
  });
  await new Promise((rr) => setTimeout(rr, 900));
  const names = await send('Runtime.evaluate', {
    expression: `JSON.stringify(Array.from(document.querySelectorAll('.tab')).map(function(x){return x.textContent.trim();}))`,
    returnByValue: true,
  });
  const list = JSON.parse(names.result.value);
  chk(list.some((n) => /安装安装包/.test(n)), '安装版的标签已改名「安装安装包」', JSON.stringify(list));

  ws.close();
  chk(true, 'close 正常不抛错');

  console.log(fail === 0 ? '\nWS SHIM TEST OK' : '\nWS SHIM TEST FAILED');
  console.log('WS SHIM TEST DONE');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FAIL  异常  ::  ' + e.message);
  console.log('WS SHIM TEST DONE');
  process.exit(1);
});
