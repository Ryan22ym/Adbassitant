/**
 * 快捷方式图标刷新 —— 让「桌面 / 开始菜单 / 任务栏固定项」的图标跟着版本走。
 *
 * 要解决的问题：
 *   在线更新只替换 app.asar 与 resources/bin，**从不替换 exe**；
 *   而桌面快捷方式默认用的就是 exe 里嵌的那份图标 —— 于是老用户一路在线更新上来，
 *   图标永远停在当初装 exe 时的版本。再加上 Windows 的图标缓存是按**路径**记忆的，
 *   即使 exe 真换了，同一个路径也常常继续显示旧图标。
 *
 * 做法（两步都只在「确实需要」时才动手，平常启动开销是几次文件读）：
 *   1. 把 asar 里的 app-icon.ico 释放到 `<userData>\icons\app-<版本>.ico`。
 *      **文件名带版本号**：版本一变路径就变，Windows 手里没有可复用的缓存可用。
 *   2. 用 shell.writeShortcutLink 把快捷方式的 IconLocation 指到那个文件。
 *      传操作符 'update'，只覆盖我们明确给出的字段，args / 描述等原样保留。
 *
 * 边界：**exe 文件本身**在资源管理器里显示的图标改不了（那是烧进 PE 资源的，
 *   只有重装安装包才会变）。这是 Windows 的限制不是遗漏 ——
 *   但窗口、任务栏、开始菜单、桌面这几处的图标都会是最新的。
 */
import { app, shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { log } from './adb';

/** 与 electron-builder.json 的 appId、main.ts 的 setAppUserModelId 保持一致 */
const APP_USER_MODEL_ID = 'com.xiaoyang.adbassistant';

/* ------------------------------------------------------------------ */
/* 图标资源                                                            */
/* ------------------------------------------------------------------ */

/**
 * 找 app-icon.ico。
 *
 * `here` 由调用方传 __dirname —— 从 main.ts 和从本文件调用时层级不同，
 * 所以两种回退层级都列出来，另外补上「直接跑源码目录」的兜底（开发期未编译时）。
 */
export function appIconIcoPath(here: string): string | null {
  const cwd = process.cwd();
  const cands = [
    join(here, '..', 'assets', 'app-icon.ico'), // here = dist-electron/electron
    join(here, '..', '..', 'assets', 'app-icon.ico'), // here = dist-electron/electron/services
    join(cwd, 'dist-electron', 'assets', 'app-icon.ico'), // cwd = 项目根（已编译）
    join(cwd, 'electron', 'assets', 'app-icon.ico'), // 原始 TS 资源
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/** 把 ico 释放到 userData，返回最终路径；资源缺失时返回 null */
function ensureIconFile(here: string): string | null {
  const src = appIconIcoPath(here);
  if (!src) return null;

  const want = readFileSync(src);
  const dir = join(app.getPath('userData'), 'icons');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `app-${app.getVersion()}.ico`);

  // 内容一致就不重写：避免每次启动都动一次磁盘、也避免无谓地刷新文件时间
  let same = false;
  try {
    same = existsSync(out) && readFileSync(out).equals(want);
  } catch {
    same = false;
  }
  if (!same) writeFileSync(out, want);
  return out;
}

/** 清掉历史版本留下的 ico，别让 userData 越滚越大（只在全部快捷方式都改成功后调用） */
function pruneOldIcons(dir: string, keepPath: string): void {
  const keep = basename(keepPath);
  try {
    for (const name of readdirSync(dir)) {
      if (!/^app-.*\.ico$/i.test(name) || name === keep) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* 被占用就留着，下次再说 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
}

/* ------------------------------------------------------------------ */
/* 快捷方式                                                            */
/* ------------------------------------------------------------------ */

/** 可能出现本应用快捷方式的三个位置（Windows 的桌面路径会被系统重定向，必须用 getPath） */
function shortcutDirs(): string[] {
  const appData = app.getPath('appData');
  return [
    app.getPath('desktop'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    // 任务栏「固定到任务栏」的项就是一个 lnk，改它的图标才能真正换掉任务栏图标
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}function norm(p: string | undefined): string {
  return (p ?? '').replace(/\//g, '\\').toLowerCase();
}

/** 该 lnk 指向的是不是当前这个 exe */
function pointsToUs(linkPath: string): boolean {
  try {
    const d = shell.readShortcutLink(linkPath);
    return norm(d.target) === norm(process.execPath);
  } catch {
    // 坏掉的 / 非法的 lnk：不是我们的，直接跳过
    return false;
  }
}

/** 收集所有指向本应用的快捷方式（dirs 可传，验收脚本用它指向临时目录） */
function findAppLinks(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.lnk$/i.test(name)) continue;
      const p = join(dir, name);
      if (pointsToUs(p)) out.push(p);
    }
  }
  return out;
}

/** 改一个快捷方式；已经是对的返回 false（表示「没动它」） */
function applyIcon(linkPath: string, icoPath: string): boolean {
  const cur = shell.readShortcutLink(linkPath);
  if (norm(cur.icon) === norm(icoPath) && norm(cur.target) === norm(process.execPath)) return false;

  // 注意：只给要改的字段。'update' 会保留未给出的属性（比如用户自己加的启动参数）
  return shell.writeShortcutLink(linkPath, 'update', {
    target: process.execPath,
    cwd: dirname(process.execPath),
    icon: icoPath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 启动时调一次即可（`here` 传 main.ts 的 __dirname）。
 * 任何失败都只写日志，绝不打断启动。
 *
 * `dirs` 是给验收脚本留的口子 —— 平时不传，用默认那三个真实位置；
 * 传了就在指定目录里找（脚本会在临时目录里造一个假快捷方式，免得真去动用户的桌面）。
 */
export function refreshShortcutIcons(here: string, dirs?: string[]): void {
  if (process.platform !== 'win32') return;
  try {
    const links = findAppLinks(dirs ?? shortcutDirs());
    if (!links.length) return; // 没装成快捷方式（比如直接双击 exe），不用管

    const ico = ensureIconFile(here);
    if (!ico) {
      log('warn', '图标', '找不到 app-icon.ico，跳过快捷方式图标刷新');
      return;
    }

    let changed = 0;
    let failed = 0;
    for (const p of links) {
      try {
        if (applyIcon(p, ico)) changed++;
      } catch {
        failed++;
      }
    }

    if (changed || failed) {
      log(
        'info',
        '图标',
        `已刷新 ${changed} 个快捷方式的应用图标${failed ? `，${failed} 个失败（可能被系统占用）` : ''}`,
      );
    }
    // 只有全部改成功才清理旧图标：失败了就说明还有快捷方式指着旧路径
    if (!failed) pruneOldIcons(dirname(ico), ico);
  } catch (e) {
    log('warn', '图标', `刷新快捷方式图标失败：${(e as Error).message}`);
  }
}
