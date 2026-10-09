import { app } from 'electron';
import { getSettings, saveSettings } from './settings';

/**
 * 开机自启动（v1.1.7）。
 *
 * 走 Electron 自带的 `setLoginItemSettings`，Windows 下就是往
 * `HKCU\...\CurrentVersion\Run` 写一条指向 `process.execPath` 的启动项 ——
 * 不往「启动」文件夹里放快捷方式，卸载时 NSIS 也清得掉。
 *
 * 三条纪律：
 *   1. **写什么，回读什么。** `setLoginItemSettings` 是「尽力而为」调用，
 *      不返回成功与否；而且任务管理器里被用户禁用过的启动项，Windows 会记在
 *      StartupApproved 里，读回来仍是 false。所以设置里存的**永远是回读值**，
 *      界面不会出现「勾着但开机没起」的假象。
 *   2. **失败不抛。** 组策略锁注册表、沙箱环境等情况下写不进去，
 *      那就把开关弹回实际状态，别把「保存设置」整个流程打断。
 *   3. **开发模式要带参数。** 没打包时 `execPath` 是 electron.exe 本身，
 *      裸写一条会导致开机弹出一个空 Electron。必须补上 app 路径作为参数。
 */

/** 登录项指向的目标：打包后就是 exe 自身，开发模式下要显式给 electron.exe + app 路径 */
function target(): { path?: string; args?: string[] } {
  if (app.isPackaged) return {};
  return { path: process.execPath, args: [app.getAppPath()] };
}

function supported(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/** 读当前**系统实际**的自启动状态（写失败 / 被系统禁用时都会如实反映） */
export function readAutoLaunch(): boolean {
  if (!supported()) return false;
  try {
    return !!app.getLoginItemSettings(target()).openAtLogin;
  } catch {
    return false;
  }
}

/** 把开关写进系统，返回写入后回读到的真实状态 */
export function applyAutoLaunch(enabled: boolean): boolean {
  if (!supported()) return false;
  try {
    app.setLoginItemSettings({ ...target(), openAtLogin: enabled });
  } catch {
    /* 写不进去就算了，下面按回读值返回 */
  }
  return readAutoLaunch();
}

/**
 * 启动时对齐一次。
 *
 * 必要性：在线更新只换 app.asar，不动 exe；但用户**重装 / 换目录**之后，
 * 注册表里那条老路径就指向不存在的文件了 —— 开机什么也不会发生。
 * 所以每次启动按设置里的意愿重写一遍（幂等），再把系统实际状态回写设置。
 */
export function syncAutoLaunch(): boolean {
  const want = getSettings().autoLaunch;
  const actual = applyAutoLaunch(want);
  if (actual !== want) {
    try {
      saveSettings({ autoLaunch: actual });
    } catch {
      /* 落盘失败不影响本次运行 */
    }
  }
  return actual;
}
