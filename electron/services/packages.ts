/**
 * 安装包管理 —— 主进程侧（配置 / 扫描 / 整理 / 选目录）
 * ============================================================
 * 把「配置（settings.json）」和「磁盘层（package-fs）」粘起来，
 * 对上层只暴露这几个动作：scan / organize / pickDir / reveal / setTag / clearTags。
 *
 * 工作目录、目录名、目录结构都存在 settings.json 里（settings.ts），
 * 所以换机器 / 重装后规则还在，界面不需要再存一份。
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { app, dialog, shell } from 'electron';
import { log } from './adb';
import { getSettings, saveSettings } from './settings';
import { checkRootUsable, organizePackages, scanPackages, type PackageConfig } from './package-fs';
import {
  DEFAULT_PACKAGE_KEYWORDS,
  normalizeDirNames,
  normalizeOverride,
  normalizeOverrides,
  normalizeStructure,
} from '../../shared/packages';
import type {
  PackageOrganizeResult,
  PackageOverride,
  PackageScanResult,
} from '../../shared/types';

/** 当前生效的整理配置 */
export function packageConfig(): PackageConfig {
  const s = getSettings();
  return {
    root: resolve(s.packageRootDir),
    dirNames: normalizeDirNames(s.packageDirNames),
    structure: normalizeStructure(s.packageStructure),
    keywords: DEFAULT_PACKAGE_KEYWORDS,
    overrides: normalizeOverrides(s.packageOverrides),
  };
}

function assertRootUsable(cfg: PackageConfig): void {
  const bad = checkRootUsable(cfg.root, app.getPath('home'));
  if (bad) throw new Error(bad);
}

/** 只扫描不改动：界面「整理预览」与列表都用它 */
export function scanPackageDir(): PackageScanResult {
  const cfg = packageConfig();
  assertRootUsable(cfg);
  return scanPackages(cfg);
}

/**
 * 真的整理一次。
 *
 * 目录不存在时**先建好再扫**：首次使用就是这个路径 —— 用户点一下「立即整理」，
 * 得到的是一个已经按规则分好类的空仓库，而不是一句「目录不存在」。
 */
export function organizePackageDir(): PackageOrganizeResult {
  const cfg = packageConfig();
  assertRootUsable(cfg);
  if (!existsSync(cfg.root)) mkdirSync(cfg.root, { recursive: true });

  const r = organizePackages(cfg);
  const tail = r.failed.length ? `，${r.failed.length} 个失败` : '';
  log(
    'success',
    '安装包',
    `整理完成：移动 ${r.moved} 个，跳过 ${r.skipped} 个${tail}`,
    r.failed.map((f) => `${f.name}：${f.error}`).join('；') || undefined,
  );
  if (r.moved === 0 && r.failed.length === 0) {
    log('info', '安装包', '没有需要移动的文件（已是最新分类）');
  }
  return r;
}

/** 选工作目录（系统选文件夹框）；取消返回 null。选完顺手建出来 */
export async function pickPackageDir(current?: string): Promise<string | null> {
  const cur = (current || '').trim() || packageConfig().root;
  const r = await dialog.showOpenDialog({
    title: '选择安装包工作目录',
    defaultPath: cur,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '用这个目录',
  });
  if (r.canceled || !r.filePaths.length) return null;

  const picked = r.filePaths[0];
  const bad = checkRootUsable(picked, app.getPath('home'));
  if (bad) throw new Error(bad);

  if (!existsSync(picked)) mkdirSync(picked, { recursive: true });
  saveSettings({ packageRootDir: picked });
  log('info', '安装包', `工作目录改为 ${picked}`);
  return picked;
}

/**
 * 在资源管理器里定位。`reveal=true` 选中文件本身，否则打开它所在的目录。
 * 只接受真实存在的路径 —— 渲染层传什么进来都先过这一关。
 */
export function revealPackage(path: string, reveal = true): boolean {
  const p = resolve(String(path || ''));
  if (!p || !existsSync(p)) throw new Error('路径不存在，可能已经被移走');
  if (reveal) shell.showItemInFolder(p);
  else shell.openPath(p);
  return true;
}

/* ------------------------------------------------------------------ */
/* 手动标签                                                            */
/* ------------------------------------------------------------------ */

/**
 * 给一个包钉死 类型 / 通道 / 版本（传 null = 恢复自动识别）。
 *
 * 🔴 键用**文件名**而不是路径：整理会把文件搬到别的目录，路径一变覆盖就失效了。
 * 整理不改名（同名冲突才加 `(2)` 后缀），所以文件名在这里是稳的 —— 同一个改动
 * 顺带决定了「下次整理时它该去哪」，不需要用户手动搬文件。
 *
 * 返回重新扫描的结果，界面直接拿它刷新（省一次来回）。
 */
export function setPackageTag(name: string, patch: PackageOverride | null): PackageScanResult {
  const key = String(name || '').trim();
  if (!key || /[\\/]/.test(key)) throw new Error('文件名不合法');

  const next = normalizeOverrides(getSettings().packageOverrides);
  if (patch === null) {
    delete next[key];
  } else {
    const ov = normalizeOverride({ ...patch, at: Date.now() });
    if (!ov) throw new Error('没有要保存的标签');
    next[key] = ov;
  }

  saveSettings({ packageOverrides: next });
  log(
    'info',
    '安装包',
    patch === null ? `已恢复自动识别：${key}` : `已手动指定标签：${key}`,
    patch === null ? undefined : JSON.stringify(next[key]),
  );
  return scanPackageDir();
}

/** 清空全部手动标签（用户把规则捋顺后可以一键回到全自动） */
export function clearPackageTags(): PackageScanResult {
  const before = normalizeOverrides(getSettings().packageOverrides);
  saveSettings({ packageOverrides: {} });
  log('info', '安装包', `已清空 ${Object.keys(before).length} 条手动标签`);
  return scanPackageDir();
}
