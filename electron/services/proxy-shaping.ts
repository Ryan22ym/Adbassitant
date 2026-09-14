import { createServer, connect, type Server, type Socket } from 'net';
import type { WeakNetDirectionParams, WeakNetParams } from '../../shared/types';

/**
 * 代理式弱网模拟（免 Root）
 * ============================================================
 *
 * 为什么需要它
 * ------------------------------------------------------------
 * 内核级 `tc + netem` 需要 Root，而绝大多数零售机拿不到 Root。
 * 免 Root 下要精细控制，唯一可行路径是**把设备的流量引到电脑上的代理**：
 *
 *     手机 App  ──►  手机 127.0.0.1:PORT  ──adb reverse──►  PC 代理  ──►  真实服务器
 *                    （系统全局 HTTP 代理）        （USB 通道，不依赖同网段）
 *
 * 这条链路的两个环节都**不需要 Root**：
 *   1. `adb reverse tcp:PORT tcp:PORT`     —— 把手机的 loopback 端口反打到电脑
 *   2. `settings put global http_proxy`    —— 设置全局 HTTP 代理（adb shell 自带权限）
 *
 * 这也是 Charles / Proxyman 弱网功能的同款原理。
 *
 * 参数保真度（必须如实告知用户）
 * ------------------------------------------------------------
 * 代理工作在**应用层**，而 netem 工作在**网络层**，两者对"丢包/乱序/重复"
 * 的语义天然不同：网络层丢包会由 TCP 重传兜住，应用层丢包则等于数据永久丢失、
 * 直接破坏协议。所以这里对这些参数做**等效近似**，追求的是"用户可感知的
 * 弱网体验一致"，而不是逐包语义一致：
 *
 *   延迟 / 抖动 / 带宽   —— 精确实现（定时投递 + 令牌桶）
 *   丢包                 —— 以「队头阻塞」近似：命中后这一段推迟一个 RTO 投递，
 *                          并把**后续数据一起拖后**（真实丢包在 TCP 上就是这个现象：
 *                          后面的包要等重传完才能交付），同时触发一段拥塞惩罚，
 *                          体验等同真实丢包触发的慢启动，且不会把协议打断
 *   乱序                 —— 同上，以「附加抖动 + 队头阻塞」近似。注意**不能真的
 *                          打乱字节顺序** —— TCP 会把包重排后交给应用层，
 *                          应用看到的永远是字节流；在代理里真乱序等于篡改内容
 *   错报                 —— 真篡改字节。明文 HTTP 会看到内容损坏；
 *                          HTTPS（CONNECT 隧道内是 TLS）会导致校验失败、连接中断，
 *                          这也正是弱信号下的真实现象
 *   重复包               —— 以「带宽占用」近似：重复包在真实网络里并不增加有效
 *                          吞吐，只会白占链路容量，所以这里按比例折算进限速
 *
 * 生效范围：只作用于**遵循系统代理的应用**（OkHttp / HttpURLConnection / 浏览器等）。
 * 不走系统代理的流量（原生 socket、QUIC/UDP、部分游戏）不受影响。
 */

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface ShapingStats {
  /** 累计接入的连接数 */
  connections: number;
  /** 当前活跃连接数 */
  active: number;
  /** 上行字节（设备发出） */
  upBytes: number;
  /** 下行字节（设备接收） */
  downBytes: number;
  /** 上行被丢（重传近似）的次数 */
  upRetrans: number;
  /** 下行被丢（重传近似）的次数 */
  downRetrans: number;
  /** 上行乱序命中次数 */
  upReorder: number;
  /** 下行乱序命中次数 */
  downReorder: number;
  /** 上行错报命中次数 */
  upCorrupt: number;
  /** 下行错报命中次数 */
  downCorrupt: number;
}

function emptyStats(): ShapingStats {
  return {
    connections: 0,
    active: 0,
    upBytes: 0,
    downBytes: 0,
    upRetrans: 0,
    downRetrans: 0,
    upReorder: 0,
    downReorder: 0,
    upCorrupt: 0,
    downCorrupt: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/** 默认监听端口，选一个不常见的值，降低撞车概率 */
const DEFAULT_PORT = 17890;
/** 单机最大并发连接，防止代理被打爆 */
const MAX_CONNECTIONS = 256;
/** HTTP 头部最大字节数，超过视为异常流量 */
const MAX_HEAD_BYTES = 64 * 1024;
/** 模拟 TCP 重传的等待时间（RTO 近似） */
const RETRANSMIT_MS = 320;
/** 丢包后拥塞惩罚：这段时间内所有包额外延迟，模拟拥塞窗口收缩 */
const CONGESTION_PENALTY_MS = 600;
/**
 * 限速时的分片大小。
 *
 * 这一项是限速能否生效的关键：socket 的一次 'data' 可能是几百 KB，
 * 而投递是按"块"原子进行的 —— 如果不分片，整块只会被投递一次，
 * 令牌桶的首次投递不收费，等于把大块数据免费放过，限速形同虚设。
 * 切成 16KB 后，首片立即发、后续片依次排队，整体耗时才等于 size / rate。
 */
const SLICE_BYTES = 16 * 1024;
/** 队列积压高/低水位，用于对源 socket 做背压，防止限速时内存爆掉 */
const HIGH_WATER = 1 * 1024 * 1024;
const LOW_WATER = 256 * 1024;

let server: Server | null = null;
let listenPort = 0;
let params: WeakNetParams | null = null;
let stats: ShapingStats = emptyStats();

/* ------------------------------------------------------------------ */
/* 令牌桶限速                                                          */
/* ------------------------------------------------------------------ */

/**
 * 平滑限速器：保证长期平均速率不超过 bytesPerSec，
 * 但允许突发一个小额度，避免把 TCP 流切成均匀的小碎片（那样反而失真）。
 */
class RateLimiter {
  private nextFreeAt = 0;

  constructor(private bytesPerSec: number) {}

  /** 返回发送 size 字节需要额外等待的毫秒数 */
  reserve(size: number): number {
    if (this.bytesPerSec <= 0) return 0;
    const now = Date.now();
    const start = Math.max(now, this.nextFreeAt);
    const cost = (size / this.bytesPerSec) * 1000;
    this.nextFreeAt = start + cost;
    return Math.max(0, start - now);
  }

  reset() {
    this.nextFreeAt = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 单向注入管道                                                        */
/* ------------------------------------------------------------------ */

interface Pending {
  data: Buffer;
  at: number;
}

/**
 * 把一个方向上的字节流按弱网参数"重新投递"到对端 socket。
 *
 * 数据不直接 write，而是先算出一个投递时间点放进小队列，
 * 由单个定时器按时间顺序统一 flush —— 避免为每个数据块创建定时器。
 */
class Shaper {
  private queue: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private limiter: RateLimiter;
  /** 拥塞惩罚截止时间戳 */
  private penaltyUntil = 0;
  /** 已分配的最大投递时间，用于保证字节顺序不被破坏（见 schedule） */
  private lastAt = 0;
  private closed = false;
  /** 背压状态：积压过多时暂停上游读取 */
  private paused = false;

  constructor(
    private readonly dir: 'up' | 'down',
    private readonly getParams: () => WeakNetDirectionParams,
    private readonly sink: Socket,
    /** 数据来源（上行 = client，下行 = upstream），用于背压 */
    private readonly source: Socket,
  ) {
    this.limiter = new RateLimiter(0);
  }

  /** 参数变了就重建限速器（带宽可能改了），顺带重估背压 */
  refresh() {
    const p = this.getParams();
    this.limiter = new RateLimiter(this.effectiveBytesPerSec(p));
    this.lastAt = 0;
    this.applyBackpressure();
  }

  /**
   * 有效带宽：重复包在真实链路里白占容量，所以按比例折算进来。
   * 例：设了 20% 重复包，有效吞吐降到 1/1.2。
   */
  private effectiveBytesPerSec(p: WeakNetDirectionParams): number {
    const mbps = p.bandwidthMbps ?? 0;
    if (mbps <= 0) return 0;
    const dup = Math.min(100, Math.max(0, p.duplicatePercent ?? 0)) / 100;
    const base = (mbps * 1_000_000) / 8;
    return base / (1 + dup);
  }

  /**
   * 入队入口。
   * 有限速时把大块切成小片依次排队（见 SLICE_BYTES 说明），
   * 否则整块按一次投递处理。
   */
  push(chunk: Buffer) {
    if (this.closed || chunk.length === 0) return;
    const p = this.getParams();
    const bps = this.effectiveBytesPerSec(p);

    if (bps > 0 && chunk.length > SLICE_BYTES) {
      for (let off = 0; off < chunk.length; off += SLICE_BYTES) {
        this.pushOne(chunk.subarray(off, Math.min(off + SLICE_BYTES, chunk.length)), p);
      }
      return;
    }
    this.pushOne(chunk, p);
  }

  private pushOne(chunk: Buffer, p: WeakNetDirectionParams) {
    if (this.closed) return;

    let extraDelay = 0;

    /* ---- 丢包：以重传延迟近似（命中后延迟 RTO + 一段拥塞惩罚） ---- */
    const loss = Math.min(100, Math.max(0, p.lossPercent ?? 0));
    if (loss > 0 && Math.random() * 100 < loss) {
      extraDelay += RETRANSMIT_MS;
      this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + CONGESTION_PENALTY_MS);
      if (this.dir === 'up') stats.upRetrans++;
      else stats.downRetrans++;
    }

    /* ---- 乱序：以附加抖动近似，使相邻块投递顺序可能颠倒 ---- */
    const reorder = Math.min(100, Math.max(0, p.reorderPercent ?? 0));
    if (reorder > 0 && Math.random() * 100 < reorder) {
      extraDelay += 40 + Math.random() * 220;
      if (this.dir === 'up') stats.upReorder++;
      else stats.downReorder++;
    }

    /* ---- 错报：真篡改一个 bit，用于验证客户端的容错与校验 ---- */
    const corrupt = Math.min(100, Math.max(0, p.corruptPercent ?? 0));
    if (corrupt > 0 && Math.random() * 100 < corrupt && chunk.length > 0) {
      const idx = Math.floor(Math.random() * chunk.length);
      const bit = 1 << Math.floor(Math.random() * 8);
      chunk[idx] = chunk[idx] ^ bit;
      if (this.dir === 'up') stats.upCorrupt++;
      else stats.downCorrupt++;
    }

    /* ---- 基础延迟 + 抖动 ---- */
    const base = Math.max(0, p.delayMs ?? 0);
    const jitter = Math.max(0, p.jitterMs ?? 0);
    // 三角分布更接近真实的抖动形态
    const j = jitter > 0 ? (Math.random() - Math.random()) * jitter : 0;
    extraDelay += Math.max(0, base + j);

    /* ---- 拥塞惩罚（丢包后的连带减速） ---- */
    const now = Date.now();
    if (this.penaltyUntil > now) extraDelay += 30;

    /* ---- 带宽限速 ---- */
    extraDelay += this.limiter.reserve(chunk.length);

    if (this.dir === 'up') stats.upBytes += chunk.length;
    else stats.downBytes += chunk.length;

    this.schedule(chunk, extraDelay);
  }

  private schedule(data: Buffer, delayMs: number) {
    let at = Date.now() + delayMs;

    /*
     * 投递时间必须单调不减。
     *
     * 这是整个设计的正确性前提：TCP 交给应用层的是**字节流**，
     * 网络层的乱序/丢包会被 TCP 重排、重传兜住，应用永远看到有序字节。
     * 如果我们在代理里让后面的块"超车"先发，那等于直接篡改内容 ——
     * 一个 HTTP 响应会变成乱码，TLS 会直接握手失败。
     *
     * 所以命中丢包/乱序的块，只能把**它自己和它后面所有块一起拖后**，
     * 表现出的就是队头阻塞（head-of-line blocking），
     * 而这恰好就是真实丢包/乱序在 TCP 上的可观测效果。
     */
    if (at < this.lastAt) at = this.lastAt;
    this.lastAt = at;

    // at 单调不减 ⇒ 新块永远排在队尾，插队逻辑可以简化掉
    this.queue.push({ data, at });
    this.applyBackpressure();
    this.arm();
  }

  /**
   * 背压：限速参数一开，来源数据会远快于投递速度（比如 100Mbps 的局域网 vs 0.5Mbps），
   * 不暂停读取的话队列会无限膨胀直到把内存吃光。
   */
  private applyBackpressure() {
    const pending = this.pendingBytes;
    if (!this.paused && pending > HIGH_WATER) {
      this.paused = true;
      try {
        this.source.pause();
      } catch {
        /* ignore */
      }
    } else if (this.paused && pending < LOW_WATER) {
      this.paused = false;
      try {
        this.source.resume();
      } catch {
        /* ignore */
      }
    }
  }

  private arm() {
    if (this.timer || this.closed || this.queue.length === 0) return;
    const wait = Math.max(0, this.queue[0].at - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    // 不要让定时器拖住进程退出
    this.timer.unref?.();
  }

  private flush() {
    if (this.closed) return;
    const now = Date.now();
    while (this.queue.length > 0 && this.queue[0].at <= now) {
      // 注意：**先判断再出队**。反过来的话，一旦 sink 暂时不可写，
      // 数据已经被 shift 出来却写不出去，就白白丢了。
      if (this.sink.destroyed) {
        this.queue = [];
        return;
      }
      if (!this.sink.writable) {
        // sink 正在关闭，等 drain() 统一收尾，别在这里空转
        this.armRetry();
        return;
      }
      const item = this.queue.shift()!;
      try {
        this.sink.write(item.data);
      } catch {
        this.queue.unshift(item);
        this.armRetry();
        return;
      }
    }
    this.applyBackpressure();
    this.arm();
  }

  /** 投递受阻时的短延迟重试，避免 while 忙等把 CPU 打满 */
  private armRetry() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 25);
    this.timer.unref?.();
  }

  /** 对端关闭后把积压数据尽快放出去，然后停掉 */
  drain() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const left: Pending[] = [];
    for (const item of this.queue) {
      if (this.sink.destroyed || !this.sink.writable) {
        left.push(item);
        continue;
      }
      try {
        this.sink.write(item.data);
      } catch {
        left.push(item);
      }
    }
    this.queue = left;
    if (this.paused) {
      this.paused = false;
      try {
        this.source.resume();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 等队列投递完（或超时）。
   *
   * 这个是必需的：源站 close 时响应可能还堵在队列里，
   * 这时候如果直接销毁 socket 就会把最后一段响应截断（大文件下载尤其明显）。
   */
  drained(maxWaitMs = 8000): Promise<void> {
    if (this.closed || this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + maxWaitMs;
      const tick = () => {
        if (this.closed || this.queue.length === 0 || Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 20);
      };
      setTimeout(tick, 20);
    });
  }

  get pendingBytes(): number {
    return this.queue.reduce((n, i) => n + i.data.length, 0);
  }
}

/* ------------------------------------------------------------------ */
/* 单个客户端连接的处理                                                */
/* ------------------------------------------------------------------ */

/**
 * 优雅关闭兜底：正常情况下对端收到 FIN 后自己会关，兜底定时器不会触发。
 * 只有对端赖着不走时才会强制销毁，避免连接泄漏。
 */
function closeLater(sock: Socket, ms: number) {
  if (sock.destroyed) return;
  if (ms <= 0) {
    sock.destroy();
    return;
  }
  const t = setTimeout(() => {
    if (!sock.destroyed) sock.destroy();
  }, ms);
  t.unref?.();
  sock.once('close', () => clearTimeout(t));
}

function onClient(client: Socket) {
  if (stats.connections >= MAX_CONNECTIONS) {
    client.end('HTTP/1.1 503 Too Many Connections\r\n\r\n');
    return;
  }
  stats.connections++;
  stats.active++;

  client.setNoDelay(true);

  let finished = false;
  let upstream: Socket | null = null;
  let upShaper: Shaper | null = null;
  let downShaper: Shaper | null = null;

  /**
   * 收尾。
   *
   * 关键点：**先把已投递的数据刷出去再关，而且不能急着 destroy()**。
   * destroy() 是「中止式关闭」，会连内核发送缓冲里没发完的数据一起丢掉
   * （实测表现：丢包参数一开，大响应就被截断成 60%）。
   * 所以这里只做 end()（发 FIN，让内核把缓冲发完），
   * destroy 只作为对端赖着不走的兜底，且留足够长的时间。
   */
  const finish = () => {
    if (finished) return;
    finished = true;
    stats.active = Math.max(0, stats.active - 1);

    upShaper?.drain();
    downShaper?.drain();
    if (upstream && !upstream.destroyed) upstream.destroy();

    if (client.destroyed) return;
    if (!client.writable) {
      closeLater(client, 0);
      return;
    }
    // 让内核把发送缓冲发完（FIN 之后对端会自己关，正常路径下不会走到兜底）
    client.end();
    closeLater(client, 10000);
  };

  client.on('error', finish);
  client.on('close', finish);
  client.on('timeout', finish);

  let head = Buffer.alloc(0);

  const onHead = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    if (head.length > MAX_HEAD_BYTES) {
      client.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
      finish();
      return;
    }
    const sep = head.indexOf('\r\n\r\n');
    if (sep < 0) return;

    const headerText = head.subarray(0, sep).toString('latin1');
    const remainder = head.subarray(sep + 4);
    client.removeListener('data', onHead);

    const firstLine = headerText.split('\r\n')[0] || '';
    const m = firstLine.match(/^([A-Za-z]+)\s+(\S+)\s+(HTTP\/\d\.\d)$/);
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      finish();
      return;
    }

    const method = m[1].toUpperCase();
    const target = m[2];

    let host: string;
    let port: number;
    /** CONNECT 走隧道；明文 HTTP 需要把绝对 URI 改写成 origin-form */
    let rewrittenHeader: string | null = null;

    if (method === 'CONNECT') {
      const { h, p } = splitHostPort(target, 443);
      host = h;
      port = p;
    } else {
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
      } catch {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        finish();
        return;
      }
      host = u.hostname;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      // 代理收到的是绝对 URI，源站只认 origin-form
      rewrittenHeader = headerText.replace(
        firstLine,
        `${method} ${u.pathname}${u.search} ${m[3]}`,
      );
    }

    upstream = connect({ host, port }, () => {
      if (!upstream) return;
      upstream.setNoDelay(true);

      // 双向注入管道：client→upstream 记为「上行」，upstream→client 记为「下行」
      // 末参是数据来源，用于背压（限速时来源会远快于投递速度）
      upShaper = new Shaper('up', () => params?.up ?? {}, upstream!, client);
      downShaper = new Shaper('down', () => params?.down ?? {}, client, upstream!);
      upShaper.refresh();
      downShaper.refresh();

      if (method === 'CONNECT') {
        // 200 响应也走下行管道，这样「延迟」参数在握手阶段就能被观察到
        downShaper.push(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n', 'latin1'));
      } else {
        const payload = Buffer.from(
          (rewrittenHeader ?? headerText) + '\r\n\r\n',
          'latin1',
        );
        upShaper.push(payload);
        if (remainder.length) upShaper.push(Buffer.from(remainder));
      }

      upstream!.on('data', (d: Buffer) => downShaper?.push(d));
      client.on('data', (d: Buffer) => upShaper?.push(d));

      upstream!.on('error', finish);
      upstream!.on('close', () => {
        // 源站关了不代表响应发完了 —— 还堵在管道里的那段必须等它投递出去。
        // 这里等队列真正排空，而不是固定睡一会儿（固定等待会让每个请求都白等）。
        void (async () => {
          await downShaper?.drained();
          finish();
        })();
      });
    });

    upstream.on('error', () => {
      if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      finish();
    });
  };

  client.on('data', onHead);
}

function splitHostPort(v: string, fallbackPort: number): { h: string; p: number } {
  // 兼容 [::1]:8080 这类 IPv6 写法
  const m = v.match(/^\[(.+)\]:(\d+)$/);
  if (m) return { h: m[1], p: Number(m[2]) };
  const i = v.lastIndexOf(':');
  if (i < 0) return { h: v, p: fallbackPort };
  const p = Number(v.slice(i + 1));
  if (!Number.isFinite(p) || p <= 0) return { h: v.slice(0, i), p: fallbackPort };
  return { h: v.slice(0, i), p };
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export function isShapingProxyRunning(): boolean {
  return !!server;
}

export function getShapingProxyPort(): number {
  return listenPort;
}

export function getShapingStats(): ShapingStats {
  return { ...stats };
}

export function setShapingParams(p: WeakNetParams | null) {
  params = p;
}

export function resetShapingStats() {
  const active = stats.active;
  stats = emptyStats();
  stats.active = active;
}

/**
 * 启动代理。优先用 preferredPort，被占用则退回系统分配的空闲端口。
 * 返回实际监听端口。
 */
export function startShapingProxy(preferredPort = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(listenPort);
      return;
    }

    const attempt = (port: number, allowFallback: boolean) => {
      const srv = createServer(onClient);
      srv.once('error', (err: NodeJS.ErrnoException) => {
        srv.removeAllListeners();
        if (allowFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          attempt(0, false);
          return;
        }
        reject(err);
      });
      srv.listen(port, '127.0.0.1', () => {
        server = srv;
        const addr = srv.address();
        listenPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve(listenPort);
      });
    };

    stats = emptyStats();
    attempt(preferredPort, true);
  });
}

export function stopShapingProxy(): Promise<void> {
  return new Promise((resolve) => {
    const srv = server;
    server = null;
    listenPort = 0;
    params = null;
    if (!srv) {
      resolve();
      return;
    }
    srv.close(() => resolve());
    // close 只能停止接受新连接，已建立的连接由各自的 finish 逻辑收尾
    setTimeout(resolve, 500).unref?.();
  });
}
