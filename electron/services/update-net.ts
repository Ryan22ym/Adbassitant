/**
 * 在线更新的网络层（v1.0.22）。
 *
 * 传输优先用 **Electron 的 net** —— 它会自动跟随系统代理 / PAC，证书校验走 Chromium。
 * 这一点在真实环境里很关键：`node:https` 不认系统代理，公司网络 / 挂了代理的机器上
 * 会直接连不通，而且报错往往只是「连接超时」，极难排查。
 *
 * 但纯 Node 环境（验收脚本 require dist-electron 里的本文件、离线单测）没有 net 模块，
 * 所以这里留了 node:http(s) 的退路。两条路在本文件收口，上层（update-source.ts）
 * 不需要知道自己跑在哪种传输上。
 *
 * 只做三件事：GET 文本、GET 到文件（带进度 / 可取消 / 校验 sha256）、算文件 sha256。
 * 更新包本身的合法性判定不在这里 —— 那是 update-core.ts 的 manifest 校验。
 */
import { createHash } from 'crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { dirname } from 'path';
import type { UpdateDownloadProgress } from '../../shared/types';

export interface HttpTextResult {
  status: number;
  text: string;
  contentType: string;
  /** 最终 URL（跟随重定向后） */
  url: string;
}

export interface DownloadOptions {
  onProgress?: (p: UpdateDownloadProgress) => void;
  /** 建立连接的超时（毫秒） */
  connectTimeoutMs?: number;
  /** 连接建立后「多久没有新数据」算超时（毫秒）；大包慢速下载靠它兜底 */
  idleTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;
/** 更新包的体积上限，超过直接拒绝（防止指向一个巨大的错误目标把磁盘写满） */
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

/** 下载被用户取消时抛这个，调用方据此区分「取消」与「失败」 */
export class DownloadCancelledError extends Error {
  constructor() {
    super('下载已取消');
    this.name = 'DownloadCancelledError';
  }
}

/* ------------------------------------------------------------------ */
/* 传输层：Electron net 优先，退回 node:http(s)                         */
/* ------------------------------------------------------------------ */

interface OpenedStream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** 数据流（IncomingMessage 或 Electron 的 response） */
  stream: NodeJS.ReadableStream;
  /** 主动放弃这次请求 */
  abort: () => void;
  finalUrl: string;
}

/** Electron 的 net 模块；纯 Node 下返回 null */
function electronNet(): typeof import('electron').net | null {
  try {
    const e = require('electron') as typeof import('electron');
    return e && (e as unknown as { net?: unknown }).net ? e.net : null;
  } catch {
    return null;
  }
}

function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) {
      const v = headers[k];
      return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    }
  }
  return '';
}

/** 用 Electron net 发起请求（自动跟随重定向与系统代理） */
function openWithElectronNet(
  netMod: typeof import('electron').net,
  url: string,
  connectTimeoutMs: number,
): Promise<OpenedStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = netMod.request({ method: 'GET', url, redirect: 'follow' });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        req.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(`连接超时（${Math.round(connectTimeoutMs / 1000)} 秒内没有响应）`));
    }, connectTimeoutMs);

    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers as Record<string, string | string[] | undefined>,
        stream: res as unknown as NodeJS.ReadableStream,
        abort: () => {
          // Electron 的 IncomingMessage 类型里没有声明 destroy（运行时是有的），
          // 这里窄化一下，避免为了它引入 any
          const d = (res as unknown as { destroy?: () => void }).destroy;
          try {
            d?.call(res);
          } catch {
            /* ignore */
          }
        },
        finalUrl: url,
      });
    });

    req.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`网络请求失败：${e.message || String(e)}`));
    });

    req.end();
  });
}

/** 用 node:http(s) 发起请求（纯 Node 环境退路），自己跟随重定向 */
function openWithNodeHttp(
  url: string,
  connectTimeoutMs: number,
  redirectLeft = 5,
): Promise<OpenedStream> {
  return new Promise((resolve, reject) => {
    let mod: typeof import('http');
    try {
      mod = (url.startsWith('https:') ? require('https') : require('http')) as typeof import('http');
    } catch (e) {
      reject(e as Error);
      return;
    }
    const req = mod.get(url, { headers: { 'User-Agent': 'ADBAssistant' } }, (res) => {
      const status = res.statusCode ?? 0;
      const loc = String(res.headers.location || '');
      if (status >= 300 && status < 400 && loc) {
        res.resume();
        if (redirectLeft <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(loc, url).toString();
        openWithNodeHttp(next, connectTimeoutMs, redirectLeft - 1).then(resolve, reject);
        return;
      }
      resolve({
        status,
        headers: res.headers as Record<string, string | string[] | undefined>,
        stream: res,
        abort: () => {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        },
        finalUrl: url,
      });
    });
    req.on('error', (e: Error) => reject(new Error(`网络请求失败：${e.message || String(e)}`)));
    req.setTimeout(connectTimeoutMs, () => {
      req.destroy(new Error(`连接超时（${Math.round(connectTimeoutMs / 1000)} 秒内没有响应）`));
    });
  });
}

function openStream(url: string, connectTimeoutMs: number): Promise<OpenedStream> {
  const netMod = electronNet();
  if (netMod) return openWithElectronNet(netMod, url, connectTimeoutMs);
  return openWithNodeHttp(url, connectTimeoutMs);
}

/* ------------------------------------------------------------------ */
/* 取消                                                                */
/* ------------------------------------------------------------------ */

/** 当前在跑的下载（同一时刻只允许一个更新包下载） */
let activeAbort: (() => void) | null = null;
let activeCancelled = false;

export function isDownloading(): boolean {
  return !!activeAbort;
}

export function cancelActiveDownload(): boolean {
  if (!activeAbort) return false;
  activeCancelled = true;
  const fn = activeAbort;
  activeAbort = null;
  try {
    fn();
  } catch {
    /* ignore */
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 读文本                                                              */
/* ------------------------------------------------------------------ */

/** GET 一段文本（latest.json 用），始终读完再返回，带连接超时 */
export async function httpGetText(url: string, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT): Promise<HttpTextResult> {
  const opened = await openStream(url, connectTimeoutMs);
  if (opened.status !== 200) {
    // 把响应体读掉，避免连接悬着
    try {
      (opened.stream as unknown as { resume: () => void }).resume();
    } catch {
      /* ignore */
    }
    throw new Error(`服务器返回 HTTP ${opened.status}${opened.status === 404 ? '（更新源地址可能不对）' : ''}`);
  }
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    opened.stream.on('data', (c: Buffer | string) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size > 4 * 1024 * 1024) {
        // latest.json 不该这么大，明显拿错东西了
        try {
          (opened.stream as unknown as { destroy: () => void }).destroy();
        } catch {
          /* ignore */
        }
        reject(new Error('更新源返回的内容过大，不像是一个版本清单文件'));
        return;
      }
      chunks.push(b);
    });
    opened.stream.on('end', () => resolve(Buffer.concat(chunks)));
    opened.stream.on('error', (e: Error) => reject(e));
  });
  return {
    status: opened.status,
    text: buf.toString('utf8'),
    contentType: headerOf(opened.headers, 'content-type'),
    url: opened.finalUrl,
  };
}

/* ------------------------------------------------------------------ */
/* 算 sha256（流式，避免整包读进内存）                                   */
/* ------------------------------------------------------------------ */

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 下载到文件                                                          */
/* ------------------------------------------------------------------ */

export interface DownloadResult {
  /** 落盘路径 */
  path: string;
  /** 字节数 */
  size: number;
  /** 实际算出来的 sha256（小写 hex） */
  sha256: string;
}

/**
 * 把 url 下到 destPath。
 *
 * - 先写 `<destPath>.part`，全部校验通过才改名 —— 中途断网 / 校验失败都不会留下
 *   一个「看起来正常」的坏包（照 aab.ts 下 bundletool 的做法）。
 * - `expectedSha256` 给了就必校验；不符直接删文件并抛错。
 * - 取消时抛 DownloadCancelledError，且不留残文件。
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  expectedSha256?: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
  const part = `${destPath}.part`;

  mkdirSync(dirname(destPath), { recursive: true });
  try {
    if (existsSync(part)) rmSync(part, { force: true });
  } catch {
    /* ignore */
  }

  const cleanup = () => {
    try {
      if (existsSync(part)) rmSync(part, { force: true });
    } catch {
      /* ignore */
    }
  };

  activeCancelled = false;
  const opened = await openStream(url, connectTimeoutMs);
  activeAbort = () => {
    opened.abort();
  };
  const wasCancelled = () => activeCancelled;
  const releaseActive = () => {
    activeAbort = null;
  };

  try {
    if (opened.status !== 200) {
      try {
        (opened.stream as unknown as { resume: () => void }).resume();
      } catch {
        /* ignore */
      }
      throw new Error(`下载失败：服务器返回 HTTP ${opened.status}`);
    }

    const total = Number(headerOf(opened.headers, 'content-length') || 0) || 0;
    if (total > MAX_PACKAGE_BYTES) {
      opened.abort();
      throw new Error('更新包体积异常（超过 2 GB），已拒绝下载');
    }

    let received = 0;
    let idleTimer: NodeJS.Timeout | null = null;
    const report = (phase: UpdateDownloadProgress['phase']) => {
      opts.onProgress?.({
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        phase,
      });
    };

    const out = createWriteStream(part);
    await new Promise<void>((resolve, reject) => {
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            opened.abort();
          } catch {
            /* ignore */
          }
          reject(new Error(`下载中断：${Math.round(idleTimeoutMs / 1000)} 秒没有收到新数据`));
        }, idleTimeoutMs);
      };
      armIdle();

      opened.stream.on('data', (chunk: Buffer | string) => {
        received += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (received > MAX_PACKAGE_BYTES) {
          if (idleTimer) clearTimeout(idleTimer);
          try {
            opened.abort();
          } catch {
            /* ignore */
          }
          reject(new Error('更新包体积异常（超过 2 GB），已中止'));
          return;
        }
        armIdle();
        report('download');
      });

      out.on('error', (e) => {
        if (idleTimer) clearTimeout(idleTimer);
        reject(e);
      });
      opened.stream.on('error', (e: Error) => {
        if (idleTimer) clearTimeout(idleTimer);
        reject(wasCancelled() ? new DownloadCancelledError() : e);
      });
      out.on('finish', () => {
        if (idleTimer) clearTimeout(idleTimer);
        resolve();
      });

      opened.stream.pipe(out);
    });

    if (wasCancelled()) throw new DownloadCancelledError();

    const size = statSync(part).size;
    if (size <= 0) throw new Error('下载得到空文件，请稍后重试');
    if (total > 0 && size !== total) {
      throw new Error(`下载不完整：服务器声明 ${total} 字节，实际收到 ${size} 字节`);
    }

    // 校验阶段也报个进度，界面能把「正在校验」显示出来
    report('verify');
    const sha = await sha256File(part);
    if (expectedSha256 && sha.toLowerCase() !== String(expectedSha256).toLowerCase()) {
      throw new Error('更新包校验值不符（下载内容与更新源声明的不一致），已删除，请重试');
    }

    if (existsSync(destPath)) rmSync(destPath, { force: true });
    renameSync(part, destPath);

    return { path: destPath, size, sha256: sha };
  } catch (e) {
    cleanup();
    if (wasCancelled() && !(e instanceof DownloadCancelledError)) throw new DownloadCancelledError();
    throw e;
  } finally {
    releaseActive();
    activeCancelled = false;
  }
}
