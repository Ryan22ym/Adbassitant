/**
 * Java 运行时探测。
 *
 * AAB 安装必须借助 Google 官方的 bundletool（一个 jar），而 jar 需要 Java。
 * 本程序自己不捆 JDK（体积与授权都不合适），所以策略是：
 *   1. 先找随包目录 `resources/bin/jre/`（用户手动放进去的便携 JRE，优先；
 *      放进去就能在完全没装 Java 的机器上用）；
 *   2. 再找 JAVA_HOME；
 *   3. 再看 PATH 里的 java；
 *   4. 最后扫几个常见安装位置（Oracle / Adoptium / Zulu / Android Studio 自带 JBR）。
 *
 * 找到之后缓存起来 —— 探测一次要跑好几个进程，不能每次安装都重来。
 */
import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { binDir } from './adb';

export interface JavaInfo {
  /** java 可执行文件绝对路径 */
  path: string;
  /** 版本字符串（如 11.0.9 / 17.0.11） */
  version?: string;
  /** 来源，用于界面提示与排查 */
  source: 'bundled' | 'java_home' | 'path' | 'scan';
  /** 大版本号（8 / 11 / 17 …），bundletool 1.18 需要 11+ */
  major?: number;
}

const WIN = process.platform === 'win32';
const JAVA_BIN = WIN ? 'java.exe' : 'java';

let cache: JavaInfo | null | undefined;

/** 清空缓存（设置页「重新检测」时用） */
export function resetJavaCache(): void {
  cache = undefined;
}

function candidates(): { path: string; source: JavaInfo['source'] }[] {
  const out: { path: string; source: JavaInfo['source'] }[] = [];

  /* 1. 随包 JRE：binDir() 是 resources/bin，找 jre/<...>/bin/java 与 jre/bin/java */
  const bundled = join(binDir(), 'jre');
  out.push({ path: join(bundled, 'bin', JAVA_BIN), source: 'bundled' });
  if (existsSync(bundled)) {
    try {
      for (const d of readdirSync(bundled)) {
        const p = join(bundled, d, 'bin', JAVA_BIN);
        if (existsSync(p)) out.push({ path: p, source: 'bundled' });
      }
    } catch {
      /* ignore */
    }
  }

  /* 2. JAVA_HOME */
  const home = process.env.JAVA_HOME;
  if (home) out.push({ path: join(home, 'bin', JAVA_BIN), source: 'java_home' });

  /* 3. PATH —— 交给 spawn 用裸名解析（Windows 下会补 .exe） */
  out.push({ path: WIN ? 'java.exe' : 'java', source: 'path' });

  /* 4. 常见安装位置 */
  const roots = WIN
    ? [
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Zulu',
        'C:\\Program Files\\Microsoft\\jdk',
        'C:\\Program Files\\Android\\Android Studio\\jbr',
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
      ]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    // Android Studio 的 JBR 是 <root>/bin/java，其他是 <root>/<版本>/bin/java
    const direct = join(root, 'bin', JAVA_BIN);
    if (existsSync(direct)) out.push({ path: direct, source: 'scan' });
    try {
      for (const d of readdirSync(root)) {
        const p = join(root, d, 'bin', JAVA_BIN);
        if (existsSync(p)) out.push({ path: p, source: 'scan' });
        // macOS: <root>/<版本>/Contents/Home/bin/java
        const mac = join(root, d, 'Contents', 'Home', 'bin', JAVA_BIN);
        if (existsSync(mac)) out.push({ path: mac, source: 'scan' });
      }
    } catch {
      /* ignore */
    }
  }

  return out;
}

/** 跑 `java -version`，从 stderr 里抠版本号（java 历来把版本打到 stderr） */
function probe(path: string): Promise<JavaInfo | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, ['-version'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }

    let text = '';
    const onData = (d: Buffer) => {
      text += d.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 && !/version/i.test(text)) {
        resolve(null);
        return;
      }
      // 形如：openjdk version "17.0.11" 2024-04-16 / java version "1.8.0_281"
      const m = text.match(/version\s+"([^"]+)"/i);
      const raw = m?.[1] ?? '';
      let major: number | undefined;
      if (raw) {
        const parts = raw.split(/[._]/);
        major = parts[0] === '1' ? parseInt(parts[1], 10) : parseInt(parts[0], 10);
        if (!Number.isFinite(major)) major = undefined;
      }
      resolve({ path, version: raw || undefined, source: 'scan', major });
    });
  });
}

/**
 * 找到一个可用的 java。找不到返回 null（调用方负责给用户看怎么装）。
 */
export async function findJava(force = false): Promise<JavaInfo | null> {
  if (!force && cache !== undefined) return cache;

  for (const c of candidates()) {
    // PATH 里的裸名不做 existsSync 预检，交给 spawn 解析
    if (c.source !== 'path' && !existsSync(c.path)) continue;
    // Windows 的扫描目录里偶尔会有 JDK 的 java.exe（jdk/bin），直接用即可
    const found = await probe(c.path);
    if (found) {
      cache = { ...found, source: c.source };
      return cache;
    }
  }

  cache = null;
  return null;
}

/**
 * bundletool 1.18.3 需要 Java 11 及以上。
 * 版本读不出来时按「可用」处理（宁可让 bundletool 自己报错，也不要误报挡住用户）。
 */
export function javaVersionOk(java: JavaInfo | null): boolean {
  if (!java) return false;
  if (java.major === undefined) return true;
  return java.major >= 11;
}

/** 界面提示用的一句话 */
export function describeJava(java: JavaInfo | null): string {
  if (!java) return '未检测到 Java 运行时';
  const ver = java.version ? ` ${java.version}` : '';
  switch (java.source) {
    case 'bundled':
      return `随包 Java${ver}`;
    case 'java_home':
      return `JAVA_HOME 中的 Java${ver}`;
    case 'path':
      return `系统 Java${ver}`;
    default:
      return `已安装的 Java${ver}`;
  }
}

/** 目录是否存在且是目录（给设置页展示随包 JRE 位置用） */
export function bundledJreDir(): string {
  return join(binDir(), 'jre');
}

export function bundledJreExists(): boolean {
  const p = bundledJreDir();
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
