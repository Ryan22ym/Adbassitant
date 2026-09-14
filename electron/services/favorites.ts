import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { log } from './adb';
import type { FavoriteApp } from '../../shared/types';

/**
 * 常用应用（收藏）
 * ============================================================
 * 设备上的应用有几百个，而调试时真正反复操作的就是那几个。
 * 这里把「常用应用」按包名持久化到本地，与设备列表解耦：
 *   - 换设备 / 重插线 / 重启应用后依然记得
 *   - 设备上没装该应用时也保留，不丢收藏
 *
 * 存储位置：<userData>/favorite-apps.json
 */

const FILE_NAME = 'favorite-apps.json';

function storeFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, FILE_NAME);
}

export function listFavorites(): FavoriteApp[] {
  try {
    const f = storeFile();
    if (!existsSync(f)) return [];
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is FavoriteApp => !!x && typeof x.packageName === 'string')
      .map((x) => ({
        packageName: x.packageName,
        label: typeof x.label === 'string' ? x.label : undefined,
        addedAt: Number(x.addedAt) || 0,
      }));
  } catch {
    return [];
  }
}

function persist(list: FavoriteApp[]): FavoriteApp[] {
  writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf8');
  return list;
}

/**
 * 收藏 / 取消收藏（幂等切换）。返回最新列表。
 */
export function toggleFavorite(packageName: string, label?: string): FavoriteApp[] {
  const pkg = (packageName || '').trim();
  if (!pkg) throw new Error('包名不能为空');

  const list = listFavorites();
  const idx = list.findIndex((x) => x.packageName === pkg);

  if (idx >= 0) {
    list.splice(idx, 1);
    log('info', '应用管理', `已取消常用：${pkg}`);
  } else {
    // 最近收藏的排在前面，符合"常用"的使用直觉
    list.unshift({ packageName: pkg, label: label?.trim() || undefined, addedAt: Date.now() });
    log('success', '应用管理', `已加入常用：${pkg}`);
  }
  return persist(list);
}

export function removeFavorite(packageName: string): FavoriteApp[] {
  const pkg = (packageName || '').trim();
  const list = listFavorites().filter((x) => x.packageName !== pkg);
  return persist(list);
}
