/* eslint-disable */
/**
 * 最小 WebSocket 客户端垫片 —— 仅用于 Electron 主进程里的 CDP 连接。
 *
 * Electron 33 内置 Node 20，**没有全局 WebSocket**；CDP 客户端代码用的是标准接口，
 * 于是 `new WebSocket(url)` 抛 "WebSocket is not defined"，脚本表现为「假失败」。
 * 这里不引依赖，手写 RFC 6455 客户端侧最小实现（握手 + 掩码帧 + 分片 + ping/pong）。
 *
 * 用法：在 require 之后、用 WebSocket 之前调用一次：
 *     require('./_ws-shim.cjs').install();
 */
const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 把裸 TCP 连接包装成 WebSocket 客户端。事件模型对齐标准接口。 */
class MiniWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._listeners = { open: [], message: [], error: [], close: [] };
    this._buf = Buffer.alloc(0);
    this._fragOp = 0;
    this._frags = [];
    this._closed = false;

    const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) {
      queueMicrotask(() => this._fail(new Error('不支持的 WebSocket URL: ' + url)));
      return;
    }
    const host = m[1];
    const port = m[2] ? Number(m[2]) : 80;
    const pathPart = m[3] || '/';

    const key = crypto.randomBytes(16).toString('base64');
    this._sock = net.connect({ host, port }, () => {
      this._sock.write(
        'GET ' + pathPart + ' HTTP/1.1\r\n' +
          'Host: ' + host + ':' + port + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    this._sock.setNoDelay(true);
    this._sock.on('error', (e) => this._fail(e));
    this._sock.on('close', () => this._fire('close', {}));
    this._sock.on('data', (d) => this._onData(d, key));
  }

  addEventListener(type, fn) {
    if (this._listeners[type]) this._listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners[type];
    if (a) this._listeners[type] = a.filter((f) => f !== fn);
  }
  _fire(type, ev) {
    for (const fn of this._listeners[type] || []) {
      try {
        fn(ev);
      } catch {
        /* 监听器自己抛错不该带崩连接 */
      }
    }
  }
  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    try {
      this._sock && this._sock.destroy();
    } catch {}
    this.readyState = 3;
    this._fire('error', err);
  }

  _onData(chunk, key) {
    this._buf = Buffer.concat([this._buf, chunk]);

    // ---- 1) 先处理 HTTP 握手响应 ----
    if (this.readyState === 0) {
      const end = this._buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this._buf.slice(0, end).toString('latin1');
      const rest = this._buf.slice(end + 4);
      this._buf = rest;
      if (!/^HTTP\/1\.1\s+101/i.test(head)) {
        return this._fail(new Error('WebSocket 握手被拒: ' + head.split('\r\n')[0]));
      }
      // Sec-WebSocket-Accept 必须匹配（防代理/连错端口）
      const want = crypto
        .createHash('sha1')
        .update(key + GUID)
        .digest('base64');
      const got = /sec-websocket-accept:\s*(\S+)/i.exec(head);
      if (got && got[1] !== want) {
        return this._fail(new Error('Sec-WebSocket-Accept 校验失败'));
      }
      this.readyState = 1; // OPEN
      this._fire('open', {});
    }

    // ---- 2) 再逐帧解析 ----
    for (;;) {
      const f = this._takeFrame();
      if (!f) return;
      this._handleFrame(f);
      if (this._closed) return;
    }
  }

  /** 从缓冲区取出一整帧；不足一帧时返回 null 并保留剩余数据。 */
  _takeFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this._fail(new Error('帧太大')) || null;
      len = Number(big);
      off += 8;
    }
    if (masked) off += 4; // 服务端→客户端理论上不该掩码，但按规范要能解
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (masked) {
      const mk = b.slice(off - 4, off);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mk[i & 3];
      payload = out;
    }
    this._buf = b.slice(off + len);
    return { fin, op, payload };
  }

  _handleFrame(f) {
    if (f.op === OP_CLOSE) {
      this.readyState = 3;
      this._closed = true;
      try {
        this._sock.end(this._makeFrame(OP_CLOSE, Buffer.alloc(0)));
      } catch {}
      this._fire('close', {});
      return;
    }
    if (f.op === OP_PING) {
      try {
        this._sock.write(this._makeFrame(OP_PONG, f.payload));
      } catch {}
      return;
    }
    if (f.op === OP_PONG) return;

    // 数据帧：可能分片
    if (f.op === OP_TEXT || f.op === OP_BIN) {
      this._fragOp = f.op;
      this._frags = [f.payload];
    } else if (f.op === OP_CONT) {
      this._frags.push(f.payload);
    } else {
      return; // 未知 opcode，忽略
    }
    if (!f.fin) return;
    const full = Buffer.concat(this._frags);
    this._frags = [];
    const isText = this._fragOp === OP_TEXT;
    this._fire('message', { data: isText ? full.toString('utf8') : full });
  }

  /** 客户端发出的帧**必须**加掩码（RFC 6455 §5.3）。 */
  _makeFrame(op, payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = crypto.randomBytes(4);
    const len = p.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | op; // FIN + opcode
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket 未处于 OPEN 状态');
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this._sock.write(this._makeFrame(OP_TEXT, payload));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 2;
    try {
      this._sock.write(this._makeFrame(OP_CLOSE, Buffer.alloc(0)));
      this._sock.end();
    } catch {}
    this._closed = true;
  }
}

module.exports = {
  MiniWebSocket,
  /** 只在缺失时挂载，避免覆盖 Node 22 自带的标准实现。 */
  install() {
    if (typeof globalThis.WebSocket === 'undefined') {
      globalThis.WebSocket = MiniWebSocket;
      return true;
    }
    return false;
  },
};
