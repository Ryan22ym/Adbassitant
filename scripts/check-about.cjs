#!/usr/bin/env node
/**
 * 关于页版本号校验 —— 启动安装版，打开设置页，断言「关于」卡片
 * 显示 v<package.json 版本> 且亮点文案与 VERSION_NOTES 匹配，并截图。
 * 纯 Node 脚本（不起 electron），通过 CDP 连接安装版进程。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'ADBAssistant');
const EXE = path.join(INSTALL_DIR, 'ADB桌面助手.exe');
const PORT = 9341;
const SHOT = path.join(__dirname, '..', 'ui-shots', 'about-page.png');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitTarget(retries = 90, interval = 500) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      n++;
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1500 }, (res) => {
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
      }).on('error', () => {
        if (n >= retries) return resolve(null);
        setTimeout(tick, interval);
      });
    };
    tick();
  });
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

(async () => {
  let fails = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) fails++;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
  };

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true, stdio: 'ignore', cwd: require('os').tmpdir(), env,
  });
  child.unref();
  const pid = child.pid;

  try {
    const target = await waitTarget();
    check('安装版可启动', !!target);
    if (!target) return;
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    // 等首屏渲染
    for (let i = 0; i < 30; i++) {
      const n = await cdp.eval(`document.getElementById('root') ? document.getElementById('root').children.length : -1`).catch(() => -1);
      if (n > 0) break;
      await sleep(400);
    }

    // 切到设置页（直接改 hash，绕过点击时序）
    await cdp.eval(`location.hash = '#/settings'; true`);
    await sleep(800);

    const about = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.card, [class*="card"]')];
      const card = cards.find((c) => c.textContent.includes('程序名称'));
      if (!card) return null;
      const rows = [...card.querySelectorAll('.kv-list > *, [class*="kv"]')].map((r) => r.textContent.trim());
      const notice = card.querySelector('.notice, [class*="notice"]');
      return { rows, notice: notice ? notice.textContent.trim() : card.textContent.slice(-200) };
    })()`);

    check('找到「关于」卡片', !!about);
    if (about) {
      console.log('  版本行 :', (about.rows.find((r) => r.includes('版本')) || '?').slice(0, 60));
      console.log('  亮点   :', String(about.notice).slice(0, 80) + '...');
      check(`版本显示 v${VERSION}（不再是写死的 v0.9.0）`,
        about.rows.some((r) => r.replace(/\s/g, '').includes('版本v' + VERSION)));
      check('亮点文案为 1.0.2 版本内容', String(about.notice).includes('弱网代理残留'));
    }

    // 滚动到「关于」卡片再截图
    await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('.card, [class*="card"]')];
      const card = cards.find((c) => c.textContent.includes('程序名称'));
      if (card) card.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);

    // 截图
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) {
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('\n截图 ->', SHOT);
    }
    cdp.close();
  } finally {
    try { process.kill(pid); } catch { /* */ }
  }

  console.log(fails === 0 ? '\nABOUT CHECK: 全部通过' : `\nABOUT CHECK: ${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
