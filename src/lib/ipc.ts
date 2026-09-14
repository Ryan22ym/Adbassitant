import { useApp } from '@/store/app';

/**
 * IPC 调用统一封装
 * 主进程返回 { ok, data, error }，这里统一拆分：
 * - 成功：返回 data
 * - 失败：弹出 toast 并抛出异常，调用方只需处理成功路径
 */
export async function call<T = any>(
  fn: () => Promise<{ ok: boolean; data?: T; error?: string }>,
  options: { silent?: boolean; successMessage?: string } = {},
): Promise<T> {
  const res = await fn();

  if (!res || typeof res !== 'object') {
    const msg = 'IPC 通信异常：返回结构无效';
    if (!options.silent) useApp.getState().toast('error', msg);
    throw new Error(msg);
  }

  if (!res.ok) {
    const msg = res.error || '操作失败';
    if (!options.silent) useApp.getState().toast('error', msg);
    throw new Error(msg);
  }

  if (options.successMessage) {
    useApp.getState().toast('success', options.successMessage);
  }

  return res.data as T;
}

/** 便捷包装：静默调用，失败返回 null */
export async function tryCall<T = any>(
  fn: () => Promise<{ ok: boolean; data?: T; error?: string }>,
): Promise<T | null> {
  try {
    return await call<T>(fn, { silent: true });
  } catch {
    return null;
  }
}
