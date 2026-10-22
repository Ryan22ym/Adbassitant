import { ipcMain, dialog, shell, BrowserWindow, app, desktopCapturer, screen } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import {
  IPC,
  TITLEBAR_HEIGHT,
  type MirrorOptions,
  type AppSettings,
  type CommandResult,
  type LogcatFilter,
  type LogcatExportOptions,
  type WeakNetParams,
  type InstallMode,
  type AabEnv,
  type AabSigningConfig,
  type QuickAction,
  type ClickerScript,
  type ClickerStep,
  type RecordedSession,
  type PackageOverride,
} from '../shared/types';
import {
  listDevices,
  runAdb,
  getDeviceDetail,
  adbStartServer,
  adbKillServer,
  ensureDevice,
  ensureDir,
  binDir,
  log,
} from './services/adb';
import {
  getResolution,
  setSize,
  resetSize,
  captureScreen,
  grabScreenFrame,
  startRecord,
  getRecord,
  timestamp,
} from './services/device-ops';
import {
  startMirror,
  stopMirror,
  getMirrorStatus,
} from './services/mirror';
import {
  pushFiles,
  pullFiles,
  installApk,
  listPackages,
  runMonkey,
  listAppsDetailed,
  getAppDetail,
  uninstallApp,
  forceStopApp,
  clearAppData,
  launchApp,
  setAppEnabled,
  extractApk,
} from './services/files';
import {
  installBundle,
  installApksFile,
  convertBundle,
  buildUniversalApk,
  inspectAabEnv,
  downloadBundletool,
  bundletoolJarPath,
  listBundleCache,
  clearBundleCache,
} from './services/aab';
import {
  getSigningInfo,
  setSigningConfig,
  probeKeystore,
  computeKeyHash,
} from './services/aab-signing';
import {
  startLogcat,
  stopLogcat,
  getLogcatStatus,
  getLogcatHistory,
  clearLogcatBuffer,
  saveLogcat,
  listProcesses,
  setLogcatLinesSink,
  setLogcatStatusSink,
} from './services/logcat';
import { exportLogcatToFile, exportLogcatToDir, resolveExportDir, logcatFileName } from './services/logcat-export';
import type { LogcatExportDirInfo } from '../shared/types';
import {
  startWeakNet,
  stopWeakNet,
  getWeakNetStatus,
  listPresets,
  savePreset,
  deletePreset,
  probeDevice,
  cleanupStaleProxy,
  setWeakNetStatusSink,
  requestVpnAuthorize,
  touchSessionParams,
} from './services/weaknet';
import {
  findVpnApk,
  getVpnAppInfo,
  installVpnApp,
  queryVpnState,
  updateVpnParams,
} from './services/weaknet-vpn';
import { listFavorites, toggleFavorite, removeFavorite } from './services/favorites';
import {
  listQuickActions,
  saveQuickActions,
  resetQuickActions,
  runQuickAction,
  foregroundApp,
} from './services/quick-actions';
import {
  clearPackageTags,
  organizePackageDir,
  pickPackageDir,
  revealPackage,
  scanPackageDir,
  setPackageTag,
} from './services/packages';
import {
  aiChat,
  aiConfigDir,
  aiTest,
  cancelAiChat,
  clearSessions,
  deleteSession,
  getAiConfig,
  getSession,
  listSessions,
  saveAiConfig,
} from './services/ai';
import {
  deleteCrashReport,
  getCrashReport,
  getCrashWatchStatus,
  listCrashReports,
  markCrashReportRead,
  runAnalysis,
  setCrashWatchSink,
  syncCrashWatch,
} from './services/crash';
import type { AiAgentStepEvent, AiChatRequest } from '../shared/types';
import { getLogs, clearLogs, exportLogs, setLogPushSink, addLog, getLogDir } from './services/logger';
import { getWallpaperDataURL } from './services/wallpaper';
import { getSettings, saveSettings, resolveDir, DEFAULT_LOGX_ROOT } from './services/settings';
import { getUiConf, resolveUiConfDir } from './services/ui-conf';
import { applyAutoLaunch } from './services/auto-launch';
import {
  applyUpdate,
  cancelOnlineDownload,
  cancelUpdate,
  checkOnlineUpdate,
  getUpdateContext,
  openUpdateDir,
  prepareUpdate,
  prepareUpdateFromUrl,
  rollbackUpdate,
  setUpdateDownloadSink,
  updateHandshake,
} from './services/update';
import { checkEnv } from './env-check';
import { setLogSink } from './services/adb';
import { setMirrorStatusSink } from './services/mirror';
import {
  listScripts,
  saveScript,
  deleteScript,
  resetScripts,
  sessionToSteps,
  startClicker,
  stopClicker,
  clickerStatus,
  runSingleStep,
  setClickerPusher,
  CLICKER_KEYCODES,
} from './services/auto-clicker';
import {
  recorderInfo,
  installRecorder,
  authorizeRecorder,
  openRecorderUi,
  backgroundRecorderUi,
  prepareRecorder,
  startRecording,
  pauseRecording,
  stopRecording,
  resetRecording,
  cancelRecording,
  recorderStatus,
  pullRecording,
  fetchFrame,
} from './services/screen-recorder';

/** 统一包装：捕获异常并转为 { ok, data, error } 结构 */
type Handler = (...args: any[]) => Promise<any> | any;

function wrap(fn: Handler) {
  return async (...args: any[]) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // 兜底记录到日志
      log('error', '系统', msg);
      return { ok: false, error: msg };
    }
  };
}

function send(channel: string, payload: any) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/**
 * 主窗口（可能已销毁 / 还没建）。
 * 自绘窗口按钮用它执行最小化 / 最大化 / 关闭 —— 那些动作属于 BrowserWindow。
 */
function win(): BrowserWindow | null {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  return w ?? null;
}

/*
 * 「切换整窗 Acrylic」的实现由 main.ts 注入（v1.1.13）。
 *
 * 与上面 settingsChangedHook 同一个理由，不直接 import main.ts ——
 * 那会形成 main → ipc → main 的循环依赖。
 */
type GlassWindowHook = (on: boolean) => void;
let glassWindowHook: GlassWindowHook | null = null;

export function setGlassWindowHook(fn: GlassWindowHook) {
  glassWindowHook = fn;
}

/**
 * 设置落盘后的副作用钩子（v1.1.9）。
 *
 * 目前只有一个用途：`autoMirrorOnConnect` 决定托盘图标要不要存在，
 * 而托盘的创建/销毁在 main.ts（那里才拿得到主窗口）。用注入而不是
 * `ipc.ts` 直接 import `main.ts` —— 那会形成 main → ipc → main 的循环依赖。
 */
type SettingsChangedHook = (next: AppSettings) => void;
let settingsChangedHook: SettingsChangedHook | null = null;

export function setSettingsChangedHook(fn: SettingsChangedHook) {
  settingsChangedHook = fn;
}

export function registerIpc() {
  /* ---------------- 日志推送管道 ---------------- */

  setLogSink((p) => {
    // 转交给 logger：统一缓冲 + 广播给渲染进程
    addLog(p.level, p.source, p.message, p.detail);
  });

  setLogPushSink((entry) => send(IPC.PUSH_LOG, entry));

  setMirrorStatusSink((s) => {
    send(IPC.PUSH_MIRROR_STATUS, s);
    /*
     * 投屏一起一停就要重新对齐「崩溃监听器」（v1.1.14）：
     * 崩溃自动分析只在投屏运行期间有意义（需求原话就是「投屏的前台应用」），
     * 所以监听器的生命周期挂在投屏状态上，而不是一个独立的开关定时器。
     */
    syncCrashWatch();
  });

  setLogcatLinesSink((lines) => send(IPC.PUSH_LOGCAT_LINES, lines));

  setLogcatStatusSink((s) => send(IPC.PUSH_LOGCAT_STATUS, s));

  setWeakNetStatusSink((s) => send(IPC.PUSH_WEAKNET_STATUS, s));

  // 在线更新包下载进度（v1.0.22）
  setUpdateDownloadSink((p) => send(IPC.PUSH_UPDATE_DOWNLOAD, p));

  // 连点器回放进度（v1.0.32）—— 回放是长任务，界面靠这个刷新"执行到第几步"
  setClickerPusher((p) => send(IPC.PUSH_CLICKER_PROGRESS, p));

  /*
   * 崩溃分析的两条推送（v1.1.14）。
   * 报告生成时推一份 meta —— 渲染层据此点亮 AI 入口的红点；
   * 监听器状态变化时推状态条（开关 / 投屏 / 当前前台应用）。
   */
  setCrashWatchSink(
    (s) => send(IPC.PUSH_AI_CRASH_STATUS, s),
    (r) => send(IPC.PUSH_AI_CRASH_REPORT, r),
  );

  /* ---------------- 环境 ---------------- */

  ipcMain.handle(
    IPC.ENV_CHECK,
    wrap(() => checkEnv()),
  );

  /* ---------------- 设备 ---------------- */

  ipcMain.handle(
    IPC.DEVICE_LIST,
    wrap(() => listDevices(true)),
  );

  /*
   * 设备详情：采集口径全在 getDeviceDetail 里（一次 shell 调用串起全部采样），
   * 这里只做转发 —— 详情字段的增删改都改 services/adb.ts，别再往 IPC 层塞解析逻辑。
   */
  ipcMain.handle(IPC.DEVICE_DETAIL, wrap((_e, serial: string) => getDeviceDetail(serial)));

  ipcMain.handle(
    IPC.DEVICE_CONNECT_TCP,
    wrap(async (_e, address: string) => {
      const res = await runAdb(['connect', address], { source: '设备', timeout: 20000 });
      const text = (res.stdout + res.stderr).trim();
      if (/cannot|failed|refused|unable/i.test(text)) throw new Error(text);
      return text;
    }),
  );

  ipcMain.handle(
    IPC.DEVICE_DISCONNECT_TCP,
    wrap(async (_e, address: string) => {
      const res = await runAdb(['disconnect', address], { source: '设备' });
      return (res.stdout + res.stderr).trim();
    }),
  );

  ipcMain.handle(IPC.DEVICE_ADB_START, wrap(() => adbStartServer()));
  ipcMain.handle(IPC.DEVICE_ADB_KILL, wrap(() => adbKillServer()));

  /* ---------------- 通用命令 ---------------- */

  ipcMain.handle(
    IPC.ADB_RUN,
    wrap(async (_e, serial: string | undefined, rawCommand: string) => {
      const args = parseCommand(rawCommand);
      if (args.length === 0) throw new Error('命令为空');

      let full: string[];
      const hasDeviceFlag = args[0] === '-s' || args[0] === '-d' || args[0] === '-e';
      if (serial && !hasDeviceFlag) {
        full = ['-s', serial, ...args];
      } else {
        full = args;
      }

      return runAdb(full, { source: '命令', timeout: 5 * 60 * 1000 });
    }),
  );

  /* ---------------- 屏幕 ---------------- */

  ipcMain.handle(IPC.SCREEN_RESOLUTION, wrap((_e, serial?: string) => getResolution(serial)));

  ipcMain.handle(
    IPC.SCREEN_SET_SIZE,
    wrap((_e, serial: string | undefined, size?: string, dpi?: number) =>
      setSize(serial, size, dpi),
    ),
  );

  ipcMain.handle(IPC.SCREEN_RESET, wrap((_e, serial?: string) => resetSize(serial)));

  /* ---------------- 截图 ---------------- */

  ipcMain.handle(
    IPC.SCREENSHOT_CAPTURE,
    wrap(async (_e, serial: string | undefined) => {
      const dir = resolveDir('screenshot');
      ensureDir(dir);
      const out = await captureScreen(serial, dir, `screenshot_${timestamp()}.png`);
      send('push:screenshot', out);
      return out;
    }),
  );

  /* ---------------- 录屏 ---------------- */

  ipcMain.handle(
    IPC.RECORD_START,
    wrap(async (_e, serial: string | undefined, durationSec: number, bitRateMbps: number, sizePx?: number, audio?: boolean) => {
      const dir = resolveDir('record');
      ensureDir(dir);
      const h = await startRecord(serial, dir, durationSec, bitRateMbps, sizePx, audio);
      send(IPC.PUSH_RECORD_STATUS, {
        id: h.id,
        serial: h.serial,
        outputPath: h.localPath,
        startedAt: h.startedAt,
        duration: h.duration,
        status: 'recording',
      });
      return {
        id: h.id,
        serial: h.serial,
        outputPath: h.localPath,
        startedAt: h.startedAt,
        duration: h.duration,
      };
    }),
  );

  ipcMain.handle(
    IPC.RECORD_STOP,
    wrap(async (_e, id: string) => {
      const h = getRecord(id);
      if (!h) throw new Error('录制会话不存在或已结束');
      send(IPC.PUSH_RECORD_STATUS, {
        id: h.id,
        serial: h.serial,
        outputPath: h.localPath,
        startedAt: h.startedAt,
        duration: h.duration,
        status: 'pulling',
      });
      await h.stop();
      send(IPC.PUSH_RECORD_STATUS, {
        id: h.id,
        serial: h.serial,
        outputPath: h.localPath,
        startedAt: h.startedAt,
        duration: h.duration,
        status: 'done',
      });
      return { localPath: h.localPath };
    }),
  );

  /* ---------------- 投屏 ---------------- */

  ipcMain.handle(IPC.MIRROR_START, wrap((_e, options: MirrorOptions) => startMirror(options)));
  ipcMain.handle(IPC.MIRROR_STOP, wrap(() => stopMirror()));
  ipcMain.handle(IPC.MIRROR_STATUS, wrap(() => getMirrorStatus()));

  /* ---------------- 文件 ---------------- */

  ipcMain.handle(
    IPC.FILE_PICK,
    wrap(async (_e, multi = true, filters?: { name: string; extensions: string[] }[]) => {
      const r = await dialog.showOpenDialog({
        properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: filters || [{ name: '所有文件', extensions: ['*'] }],
      });
      if (r.canceled || r.filePaths.length === 0) return [];
      return r.filePaths;
    }),
  );

  ipcMain.handle(
    IPC.FILE_PICK_DIR,
    wrap(async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || r.filePaths.length === 0) return null;
      return r.filePaths[0];
    }),
  );

  ipcMain.handle(
    IPC.FILE_PUSH,
    wrap((_e, serial: string | undefined, localPaths: string[], remoteDir: string) =>
      pushFiles(serial, localPaths, remoteDir),
    ),
  );

  ipcMain.handle(
    IPC.FILE_PULL,
    wrap((_e, serial: string | undefined, remotePaths: string[], localDir: string) =>
      pullFiles(serial, remotePaths, localDir),
    ),
  );

  ipcMain.handle(
    IPC.FILE_REVEAL,
    wrap(async (_e, path: string) => {
      if (!existsSync(path)) throw new Error(`路径不存在：${path}`);
      shell.showItemInFolder(path);
      return true;
    }),
  );

  ipcMain.handle(
    IPC.FILE_OPEN,
    wrap(async (_e, path: string) => {
      if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
      return true;
    }),
  );

  /* ---------------- APK ---------------- */

  ipcMain.handle(
    IPC.APK_INSTALL,
    wrap(
      (
        _e,
        serial: string | undefined,
        apkPath: string,
        mode: InstallMode = 'overwrite',
        grantAll = false,
      ) => installApk(serial, apkPath, mode, grantAll),
    ),
  );

  /* ---------------- AAB（Android App Bundle） ---------------- */

  ipcMain.handle(
    IPC.AAB_INSTALL,
    wrap(
      (
        _e,
        serial: string | undefined,
        aabPath: string,
        mode: InstallMode = 'overwrite',
        grantAll = false,
        // 本次安装的签名覆盖（界面上临时改的签名方式），不传则用设置里那份
        signing?: Partial<AabSigningConfig>,
      ) =>
        installBundle(aabPath, {
          serial: serial || '',
          mode,
          grantAll,
          signing,
          // 拆包进度实时推给界面：一个大 bundle 要跑十几秒，没有输出会像卡死
          onLine: (line) => send(IPC.PUSH_AAB_OUTPUT, { line }),
        }),
    ),
  );

  ipcMain.handle(IPC.AAB_ENV, wrap((_e, force = false) => inspectAabEnv(force) as Promise<AabEnv>));

  ipcMain.handle(
    IPC.AAB_DOWNLOAD_TOOL,
    wrap(async () => {
      const r = await downloadBundletool((p) => send(IPC.PUSH_AAB_DOWNLOAD, p));
      return { ...r, jarPath: bundletoolJarPath() };
    }),
  );

  ipcMain.handle(
    IPC.AAB_OPEN_TOOL_DIR,
    wrap(async () => {
      const dir = dirname(bundletoolJarPath());
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      shell.showItemInFolder(bundletoolJarPath());
      return dir;
    }),
  );

  ipcMain.handle(IPC.AAB_CACHE_LIST, wrap(() => listBundleCache()));
  ipcMain.handle(IPC.AAB_CACHE_CLEAR, wrap(() => clearBundleCache()));

  /*
   * 拆包与安装分离（v1.0.19）
   * ------------------------------------------------------------
   * 「AAB → .apks」是一个独立的动作：不碰设备侧状态（不卸载、不安装），
   * 只按目标设备的配置拆一次，产物既可当场另存，也留在缓存里供反复安装。
   * 这样同一份包换设备 / 重装时不用再跑几十秒的拆包。
   */

  /** 仅拆包：AAB → 缓存目录里的 .apks（不另存、不安装） */
  ipcMain.handle(
    IPC.AAB_CONVERT,
    wrap(
      (
        _e,
        serial: string | undefined,
        aabPath: string,
        signing?: Partial<AabSigningConfig>,
        useCache = true,
      ) =>
        convertBundle(aabPath, {
          serial: serial || '',
          signing,
          useCache,
          onLine: (line) => send(IPC.PUSH_AAB_OUTPUT, { line }),
        }),
    ),
  );

  /**
   * 拆包并「另存为」：先弹保存框让用户定路径，再拆包写过去。
   *
   * 保存框必须在主进程弹（渲染进程拿不到本机绝对路径），
   * 而且要在真正跑 bundletool 之前 —— 用户取消时不该白等几十秒。
   */
  ipcMain.handle(
    IPC.AAB_SAVE_APKS,
    wrap(
      async (
        e,
        serial: string | undefined,
        aabPath: string,
        defaultName: string | undefined,
        signing?: Partial<AabSigningConfig>,
      ) => {
        if (!existsSync(aabPath)) throw new Error(`文件不存在：${aabPath}`);

        const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const suggested =
          (defaultName || '').trim() ||
          `${basename(aabPath).replace(/\.aab$/i, '')}.apks`;

        const r = await dialog.showSaveDialog(win as BrowserWindow, {
          title: '导出拆包产物',
          defaultPath: join(resolveDir('pull'), suggested),
          filters: [{ name: 'APKS 拆包产物', extensions: ['apks'] }],
        });
        // 取消返回 null，由渲染层当作「用户放弃」，不弹错误
        if (r.canceled || !r.filePath) return null;

        const conv = await convertBundle(aabPath, {
          serial: serial || '',
          outPath: r.filePath,
          signing,
          useCache: true,
          onLine: (line) => send(IPC.PUSH_AAB_OUTPUT, { line }),
        });
        log('success', 'AAB', `拆包产物已导出：${conv.apksPath}`);
        return conv;
      },
    ),
  );

  /**
   * 导出通用 APK：AAB → 一个能装进任何设备的 .apk。
   *
   * 与「另存 .apks」最大的区别是**不需要设备**：universal 模式不按设备挑
   * split，全程不碰 adb。所以这里不收 serial，页面上也不要求先选设备 ——
   * 手边几十个 AAB 想批量转成能分发的 APK 时，连手机都不用插。
   */
  ipcMain.handle(
    IPC.AAB_EXPORT_UNIVERSAL,
    wrap(
      async (
        e,
        aabPath: string,
        defaultName: string | undefined,
        signing?: Partial<AabSigningConfig>,
      ) => {
        if (!existsSync(aabPath)) throw new Error(`文件不存在：${aabPath}`);

        const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const base = basename(aabPath).replace(/\.aab$/i, '');
        const suggested = (defaultName || '').trim() || `${base}-universal.apk`;

        const r = await dialog.showSaveDialog(win as BrowserWindow, {
          title: '导出通用 APK',
          defaultPath: join(resolveDir('pull'), suggested),
          filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
        });
        // 取消返回 null，由渲染层当作「用户放弃」，不弹错误
        if (r.canceled || !r.filePath) return null;

        const out = await buildUniversalApk(aabPath, {
          outPath: r.filePath,
          signing,
          useCache: true,
          onLine: (line) => send(IPC.PUSH_AAB_OUTPUT, { line }),
        });

        if (/调试密钥库/.test(out.signingDesc)) {
          log(
            'warn',
            'AAB',
            '这份通用 APK 用的是调试密钥库，签名已与原包不同 —— 分发前请确认对三方登录 / 推送无影响。',
          );
        }
        return out;
      },
    ),
  );

  /** 装一份现成的 .apks（不再拆包） */
  ipcMain.handle(
    IPC.APKS_INSTALL,
    wrap(
      (
        _e,
        serial: string | undefined,
        apksPath: string,
        mode: InstallMode = 'overwrite',
        grantAll = false,
      ) =>
        installApksFile(apksPath, {
          serial: serial || '',
          mode,
          grantAll,
          onLine: (line) => send(IPC.PUSH_AAB_OUTPUT, { line }),
        }),
    ),
  );

  /* AAB 签名：换签名会改 key hash，三方登录 / 推送全靠它 */
  ipcMain.handle(IPC.AAB_SIGNING_GET, wrap(() => getSigningInfo()));

  ipcMain.handle(
    IPC.AAB_SIGNING_SET,
    wrap((_e, patch: Partial<AabSigningConfig>) => {
      setSigningConfig(patch || {});
      return getSigningInfo();
    }),
  );

  /*
   * 让用户挑一个密钥库文件。用 dialog 而不是让前端拿路径 ——
   * 渲染进程拿不到本机绝对路径（沙箱），必须主进程代选。
   */
  ipcMain.handle(
    IPC.AAB_SIGNING_PICK,
    wrap(async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const r = await dialog.showOpenDialog(win as BrowserWindow, {
        title: '选择签名密钥库',
        properties: ['openFile'],
        filters: [
          { name: 'Java 密钥库', extensions: ['jks', 'keystore', 'p12', 'pfx', 'bks'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths.length) return null;
      return r.filePaths[0];
    }),
  );

  /* 探测一个密钥库：能不能打开、有哪些别名、对应什么 key hash */
  ipcMain.handle(
    IPC.AAB_SIGNING_PROBE,
    wrap(async (_e, path: string, storePass: string, alias?: string) => {
      const p = await probeKeystore(path, storePass);
      if (!p.ok) return { ok: false, reason: p.reason, aliases: p.aliases };
      const kh = await computeKeyHash(path, storePass, alias);
      return {
        ok: true,
        aliases: p.aliases,
        keyHash: kh.keyHash,
        reason: kh.reason,
      };
    }),
  );

  /* ---------------- 应用 / Monkey ---------------- */

  ipcMain.handle(
    IPC.MONKEY_RUN,
    wrap(
      async (
        _e,
        serial: string | undefined,
        packageName: string | undefined,
        events: number,
        throttleMs: number,
        seed?: number,
      ) => {
        const child = await runMonkey(
          serial,
          packageName,
          events,
          throttleMs,
          seed,
          (line) => send(IPC.PUSH_MONKEY_OUTPUT, { type: 'line', line }),
          (code) => send(IPC.PUSH_MONKEY_OUTPUT, { type: 'exit', code }),
        );
        send(IPC.PUSH_MONKEY_OUTPUT, { type: 'start' });
        return { pid: child.pid };
      },
    ),
  );

  ipcMain.handle(
    IPC.MONKEY_STOP,
    wrap(async () => {
      await runAdb(['shell', 'pkill', '-f', 'monkey'], { silent: true, timeout: 8000 });
      log('info', 'Monkey', '已发送停止指令');
      return true;
    }),
  );

  /* ---------------- 日志 ---------------- */

  ipcMain.handle(IPC.LOG_CLEAR, wrap(() => {
    clearLogs();
    return true;
  }));

  ipcMain.handle(
    IPC.LOG_EXPORT,
    wrap(async () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const defaultName = `adb-log_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;

      const r = await dialog.showSaveDialog({
        title: '导出操作日志',
        defaultPath: join(resolveDir('pull'), defaultName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (r.canceled || !r.filePath) return null;

      let devices = '';
      try {
        const ds = await listDevices(false);
        devices = ds.map((x) => `${x.serial}(${x.state}${x.model ? `,${x.model}` : ''})`).join(', ');
      } catch {
        devices = '获取失败';
      }

      const result = exportLogs(r.filePath, {
        '程序版本': app.getVersion(),
        '设备信息': devices || '无',
        '系统': `${process.platform} ${process.arch}`,
        '二进制目录': binDir(),
      });

      log('success', '日志', `已导出到 ${r.filePath}`);
      return result;
    }),
  );

  ipcMain.handle(IPC.LOG_LIST_ALL, wrap(() => getLogs()));
  ipcMain.handle(IPC.LOG_DIR, wrap(() => getLogDir()));

/* ---------------- 应用管理（v1.0） ---------------- */

  ipcMain.handle(
    IPC.APP_LIST,
    wrap((_e, serial: string | undefined, includeSystem = true) =>
      listPackages(serial, includeSystem),
    ),
  );

  ipcMain.handle(
    IPC.APP_DETAIL,
    wrap((_e, serial: string | undefined, pkg: string) => getAppDetail(serial, pkg)),
  );

  ipcMain.handle(
    IPC.APP_UNINSTALL,
    wrap((_e, serial: string | undefined, pkg: string, keepData = false) =>
      uninstallApp(serial, pkg, keepData),
    ),
  );

  ipcMain.handle(
    IPC.APP_FORCE_STOP,
    wrap((_e, serial: string | undefined, pkg: string) => forceStopApp(serial, pkg)),
  );

  ipcMain.handle(
    IPC.APP_CLEAR_DATA,
    wrap((_e, serial: string | undefined, pkg: string) => clearAppData(serial, pkg)),
  );

  ipcMain.handle(
    IPC.APP_LAUNCH,
    wrap((_e, serial: string | undefined, pkg: string) => launchApp(serial, pkg)),
  );

  ipcMain.handle(
    IPC.APP_SET_ENABLED,
    wrap((_e, serial: string | undefined, pkg: string, enabled: boolean) =>
      setAppEnabled(serial, pkg, enabled),
    ),
  );

  ipcMain.handle(IPC.APP_EXTRACT_APK, wrap((_e, serial: string | undefined, pkg: string) => {
    const dir = resolveDir('pull');
    ensureDir(dir);
    return extractApk(serial, pkg, dir);
  }));

  /* ---------------- 常用应用（v1.0.1） ---------------- */

  ipcMain.handle(IPC.APP_FAVORITE_LIST, wrap(() => listFavorites()));

  ipcMain.handle(
    IPC.APP_FAVORITE_TOGGLE,
    wrap((_e, pkg: string, label?: string) => toggleFavorite(pkg, label)),
  );

  ipcMain.handle(IPC.APP_FAVORITE_REMOVE, wrap((_e, pkg: string) => removeFavorite(pkg)));

  /* ---------------- 设备快捷动作（v1.0.24） ---------------- */

  ipcMain.handle(IPC.QUICK_ACTION_LIST, wrap(() => listQuickActions()));

  ipcMain.handle(
    IPC.QUICK_ACTION_SAVE,
    wrap((_e, list: QuickAction[]) => saveQuickActions(list)),
  );

  ipcMain.handle(IPC.QUICK_ACTION_RESET, wrap(() => resetQuickActions()));

  ipcMain.handle(
    IPC.QUICK_ACTION_RUN,
    wrap((_e, serial: string | undefined, action: QuickAction) => runQuickAction(serial, action)),
  );

  ipcMain.handle(
    IPC.QUICK_ACTION_FOREGROUND,
    wrap((_e, serial?: string) => foregroundApp(serial)),
  );

  /* ---------------- 安装包管理（v1.1.6） ---------------- */

  // 只扫描、不改动磁盘：界面上的列表与「整理预览」都走它
  ipcMain.handle(IPC.PACKAGES_SCAN, wrap(() => scanPackageDir()));

  // 真整理（移动文件）。幂等：没有该移动的东西时返回 moved=0
  ipcMain.handle(IPC.PACKAGES_ORGANIZE, wrap(() => organizePackageDir()));

  ipcMain.handle(
    IPC.PACKAGES_PICK_DIR,
    wrap((_e, current?: string) => pickPackageDir(current)),
  );

  ipcMain.handle(
    IPC.PACKAGES_REVEAL,
    wrap((_e, path: string, reveal = true) => revealPackage(path, reveal)),
  );

  // 手工改标签（类型/通道/版本）。tag=null → 恢复自动识别。返回新的扫描结果
  ipcMain.handle(
    IPC.PACKAGES_SET_TAG,
    wrap((_e, name: string, tag: PackageOverride | null) => setPackageTag(name, tag)),
  );

  ipcMain.handle(IPC.PACKAGES_CLEAR_TAGS, wrap(() => clearPackageTags()));

  /* ---------------- 实时 Logcat（v1.0） ---------------- */

  ipcMain.handle(
    IPC.LOGCAT_START,
    wrap((_e, serial: string | undefined, filter?: Partial<LogcatFilter>) =>
      startLogcat(serial, filter),
    ),
  );

  ipcMain.handle(IPC.LOGCAT_STOP, wrap(() => stopLogcat()));
  ipcMain.handle(IPC.LOGCAT_STATUS, wrap(() => getLogcatStatus()));

  /*
   * 回放最近抓到的行（v1.1.15）。
   * Logcat 页是路由组件，切走即卸载、lines 也随之销毁 —— 页面回来时靠这个接口
   * 把主进程环形缓冲里的内容铺回去，否则「切走再回来一片空白」。
   */
  ipcMain.handle(
    IPC.LOGCAT_HISTORY,
    wrap((_e, limit?: number) => getLogcatHistory(limit)),
  );

  ipcMain.handle(IPC.LOGCAT_CLEAR, wrap(() => clearLogcatBuffer()));

  ipcMain.handle(
    IPC.LOGCAT_SAVE,
    wrap(async (_e, meta?: Record<string, string>) => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const defaultName = `logcat_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;

      const r = await dialog.showSaveDialog({
        title: '保存 Logcat',
        defaultPath: join(resolveDir('pull'), defaultName),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (r.canceled || !r.filePath) return null;

      const result = saveLogcat(r.filePath, meta);
      log('success', 'Logcat', `已保存到 ${r.filePath}`);
      return result;
    }),
  );

  ipcMain.handle(
    IPC.LOGCAT_PROCESSES,
    wrap((_e, serial?: string) => listProcesses(serial)),
  );

  /* ---------------- Logcat 导出工具（常用工具页，v1.0.26 / 目录模式 v1.0.27） ---------------- */

  ipcMain.handle(
    IPC.LOGX_EXPORT,
    wrap(async (_e, options: LogcatExportOptions = {}) => {
      /*
       * 两种落盘方式：
       *   · 给了 options.dir → **目录模式**：自动建目录、自动起文件名，不弹框。
       *     这是界面默认走的路（导出后要「立即跳转到该目录」，弹框会多一次打断）。
       *   · 没给 dir → 退回老行为：弹保存框让用户挑文件，取消返回 null。
       */
      const dir = (options.dir || '').trim();
      if (dir) {
        return exportLogcatToDir(dir, options);
      }

      // 保存框在主进程弹：渲染进程拿不到本机绝对路径
      const r = await dialog.showSaveDialog({
        title: '导出 Logcat 日志',
        defaultPath: join(resolveDir('pull'), logcatFileName(Date.now())),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      // 取消返回 null，渲染层当作「用户放弃」，不弹错误
      if (r.canceled || !r.filePath) return null;

      return exportLogcatToFile(r.filePath, options);
    }),
  );

  /** 界面上问「默认往哪写」：返回根目录 + 本次会落的目录 + 是否默认值 */
  ipcMain.handle(
    IPC.LOGX_DIR_INFO,
    wrap(async (_e, serial?: string, deviceLabel?: string) => {
      const root = resolveDir('logcatExport');
      const dir = resolveExportDir(root, { splitByDevice: true, deviceLabel, serial });
      const info: LogcatExportDirInfo = {
        root,
        dir,
        isDefault: root.replace(/[\\/]+$/, '').toLowerCase() === DEFAULT_LOGX_ROOT.replace(/[\\/]+$/, '').toLowerCase(),
        exists: existsSync(dir),
      };
      return info;
    }),
  );

  /** 选导出根目录（弹系统的选文件夹框），选定后持久化；取消返回当前设置 */
  ipcMain.handle(
    IPC.LOGX_DIR_PICK,
    wrap(async (_e, current?: string) => {
      const r = await dialog.showOpenDialog({
        title: '选择 Logcat 导出根目录',
        defaultPath: (current || '').trim() || resolveDir('logcatExport'),
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选这个目录',
      });
      if (r.canceled || !r.filePaths.length) return null;
      saveSettings({ logcatExportDir: r.filePaths[0] });
      log('info', 'Logcat导出', `导出根目录改为 ${r.filePaths[0]}`);
      return r.filePaths[0];
    }),
  );

  /** 恢复默认根目录（D:\adblogs） */
  ipcMain.handle(
    IPC.LOGX_DIR_RESET,
    wrap(async () => {
      saveSettings({ logcatExportDir: DEFAULT_LOGX_ROOT });
      return DEFAULT_LOGX_ROOT;
    }),
  );

  /* ---------------- 弱网模拟（v1.0） ---------------- */

  ipcMain.handle(
    IPC.WEAKNET_START,
    wrap((_e, serial: string | undefined, params: WeakNetParams) =>
      startWeakNet(serial, params),
    ),
  );

  ipcMain.handle(IPC.WEAKNET_STOP, wrap(() => stopWeakNet()));
  ipcMain.handle(IPC.WEAKNET_STATUS, wrap(() => getWeakNetStatus()));
  ipcMain.handle(IPC.WEAKNET_PRESET_LIST, wrap(() => listPresets()));

  ipcMain.handle(
    IPC.WEAKNET_PRESET_SAVE,
    wrap((_e, name: string, params: WeakNetParams) => savePreset(name, params)),
  );

  ipcMain.handle(
    IPC.WEAKNET_PRESET_DELETE,
    wrap((_e, id: string) => deletePreset(id)),
  );

  ipcMain.handle(
    IPC.WEAKNET_PROBE,
    wrap((_e, serial?: string) => probeDevice(serial)),
  );

  // 清理设备上可能残留的代理设置（上一次异常退出没恢复干净时用）
  ipcMain.handle(
    IPC.WEAKNET_CLEANUP,
    wrap((_e, serial?: string) => cleanupStaleProxy(serial)),
  );

  /* ---------------- 弱网 v2：VPN 模式 ---------------- */

  // 主动弹一次设备的 VPN 授权框（用户在手机上点「确定」）
  ipcMain.handle(
    IPC.WEAKNET_VPN_AUTHORIZE,
    wrap((_e, serial?: string) => requestVpnAuthorize(serial)),
  );

  // 查设备上配套 App 的安装情况与授权态
  ipcMain.handle(
    IPC.WEAKNET_VPN_APP_INFO,
    wrap(async (_e, serial?: string) => {
      const s = await ensureDevice(serial);
      const info = await getVpnAppInfo(s);
      const st = await queryVpnState();
      return {
        installed: info.installed,
        versionCode: info.versionCode,
        authorized: st?.authorized ?? null,
        vpnActive: st?.vpnActive ?? false,
      };
    }),
  );

  // 安装 / 更新配套 App（不传 apkPath 就用随包 APK）
  ipcMain.handle(
    IPC.WEAKNET_VPN_INSTALL,
    wrap(async (_e, serial?: string, apkPath?: string) => {
      const s = await ensureDevice(serial);
      const apk = apkPath || findVpnApk();
      if (!apk) {
        return {
          ok: false,
          message: '找不到随包 APK（应为 bin/weaknet-vpn.apk）',
        };
      }
      return installVpnApp(s, apk);
    }),
  );

  // 参数热更新（不重建隧道，避免闪断）
  ipcMain.handle(
    IPC.WEAKNET_VPN_PARAMS,
    wrap(async (_e, params: WeakNetParams) => {
      const ok = await updateVpnParams(params);
      // 同时把参数记到会话里，好让 status 返回的是最新值
      if (ok) touchSessionParams(params);
      return { ok };
    }),
  );

  /* ---------------- 自动连点器（v1.0.32） ---------------- */

  ipcMain.handle(IPC.CLICKER_LIST, wrap(() => listScripts()));

  // 返回 { script, list, created } —— script 是后端权威结果（id 由这里分配），
  // 界面拿它回写草稿，避免靠「名字+步数」在列表里猜自己是哪一条
  ipcMain.handle(IPC.CLICKER_SAVE, wrap((_e, script: ClickerScript) => saveScript(script)));

  ipcMain.handle(IPC.CLICKER_DELETE, wrap((_e, id: string) => deleteScript(id)));

  ipcMain.handle(IPC.CLICKER_RESET, wrap(() => resetScripts()));

  // 录制数据 → 步骤预览（不落盘：用户在界面上确认/编辑后才保存）
  ipcMain.handle(
    IPC.CLICKER_FROM_RECORD,
    wrap((_e, session: RecordedSession) => ({
      steps: sessionToSteps(session),
      meta: session?.meta ?? null,
    })),
  );

  ipcMain.handle(
    IPC.CLICKER_RUN,
    wrap((_e, script: ClickerScript, serial?: string) => startClicker(script, serial)),
  );

  ipcMain.handle(IPC.CLICKER_STOP, wrap(() => stopClicker()));

  ipcMain.handle(IPC.CLICKER_STATUS, wrap(() => clickerStatus()));

  ipcMain.handle(IPC.CLICKER_RUN_STEP, wrap((_e, step: ClickerStep, serial?: string) =>
    runSingleStep(step, serial),
  ));

  ipcMain.handle(IPC.CLICKER_KEYCODES, wrap(() => CLICKER_KEYCODES));

  /*
   * 屏幕预览图：抓一帧回渲染层，用 data URL 直接喂 <img>。
   * 故意走 screencap 而不是设备侧采集端的帧 —— 后者要先过一次录屏授权，
   * 而「看一眼屏幕、点一下定位坐标」这件事不该有前置成本。
   */
  ipcMain.handle(
    IPC.CLICKER_PREVIEW,
    wrap(async (_e, serial?: string) => {
      const { png, width, height } = await grabScreenFrame(serial);
      return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width,
        height,
      };
    }),
  );

  /* ---------------- 屏幕录制采集端（v1.0.32） ---------------- */

  ipcMain.handle(IPC.RECORDER_INFO, wrap((_e, serial?: string) => recorderInfo(serial)));

  ipcMain.handle(IPC.RECORDER_INSTALL, wrap((_e, serial?: string) => installRecorder(serial)));

  ipcMain.handle(IPC.RECORDER_AUTHORIZE, wrap((_e, serial?: string) => authorizeRecorder(serial)));

  ipcMain.handle(IPC.RECORDER_OPEN_UI, wrap((_e, serial?: string) => openRecorderUi(serial)));

  ipcMain.handle(IPC.RECORDER_BACKGROUND_UI, wrap((_e, serial?: string) => backgroundRecorderUi(serial)));

  ipcMain.handle(IPC.RECORDER_PREPARE, wrap((_e, serial?: string) => prepareRecorder(serial)));

  ipcMain.handle(IPC.RECORDER_START, wrap((_e, serial?: string) => startRecording(serial)));

  ipcMain.handle(
    IPC.RECORDER_PAUSE,
    wrap((_e, paused: boolean, serial?: string) => pauseRecording(!!paused, serial)),
  );

  ipcMain.handle(IPC.RECORDER_STOP, wrap((_e, serial?: string) => stopRecording(serial)));

  ipcMain.handle(IPC.RECORDER_RESET, wrap((_e, serial?: string) => resetRecording(serial)));

  ipcMain.handle(IPC.RECORDER_CANCEL, wrap((_e, serial?: string) => cancelRecording(serial)));

  ipcMain.handle(IPC.RECORDER_STATUS, wrap((_e, serial?: string) => recorderStatus(serial)));

  ipcMain.handle(IPC.RECORDER_PULL, wrap((_e, serial?: string) => pullRecording(serial)));

  ipcMain.handle(IPC.RECORDER_FRAME, wrap((_e, frameId: number, serial?: string) =>
    fetchFrame(frameId, serial),
  ));

  /* ---------------- AI 助手（v1.1.14） ---------------- */

  // 读配置。force=true 丢掉缓存重读 —— 提示词/key 是用户随手会改的东西，不该逼他重启程序
  ipcMain.handle(IPC.AI_CONFIG_GET, wrap((_e, force = false) => getAiConfig(!!force)));

  ipcMain.handle(
    IPC.AI_CONFIG_SET,
    wrap((_e, patch: Partial<Record<string, unknown>>) => saveAiConfig(patch || {})),
  );

  ipcMain.handle(IPC.AI_CONFIG_DIR, wrap(() => aiConfigDir()));

  /*
   * 一场对话（后端无状态，渲染层每次带全量历史）。
   *
   * v1.1.15 起主进程会在这里跑「模型给命令 → 执行 → 结果回传」的多轮循环，
   * 所以多挂了一条实时推送：每执行完一条 adb 指令就推给发起方那次窗口，
   * 界面上能立刻看到它在干什么，而不是对着一个转圈等一分钟。
   * 用 e.sender 而不是全局广播 —— 推送只和发起这次对话的窗口有关。
   */
  ipcMain.handle(
    IPC.AI_CHAT,
    wrap((e, req: AiChatRequest) =>
      aiChat(req, {
        onStep: (step, index) => {
          if (e.sender.isDestroyed()) return;
          const ev: AiAgentStepEvent = { runId: String(req?.runId || ''), step, index };
          e.sender.send(IPC.PUSH_AI_AGENT_STEP, ev);
        },
      }),
    ),
  );

  /** 停止正在跑的对话。取消粒度是「一条命令」，主进程每轮/每条前检查一次 */
  ipcMain.handle(IPC.AI_CANCEL, wrap((_e, runId?: string) => cancelAiChat(runId)));

  ipcMain.handle(IPC.AI_TEST, wrap((_e, providerId?: string) => aiTest(providerId)));

  ipcMain.handle(IPC.AI_SESSION_LIST, wrap(() => listSessions()));
  ipcMain.handle(IPC.AI_SESSION_GET, wrap((_e, id: string) => getSession(id)));
  ipcMain.handle(IPC.AI_SESSION_DELETE, wrap((_e, id: string) => deleteSession(id)));
  ipcMain.handle(IPC.AI_SESSION_CLEAR, wrap(() => clearSessions()));

  /*
   * 崩溃分析报告。
   * 「立即分析」是手动入口：自动那条路的触发源是 logcat 崩溃监听（见 services/crash.ts），
   * 两者最终调的是同一个 runAnalysis，所以行为完全一致。
   */
  ipcMain.handle(
    IPC.AI_CRASH_ANALYZE,
    wrap((_e, serial?: string, packageName?: string) => runAnalysis(serial, packageName, true)),
  );

  ipcMain.handle(IPC.AI_REPORT_LIST, wrap(() => listCrashReports()));
  ipcMain.handle(IPC.AI_REPORT_GET, wrap((_e, id: string) => getCrashReport(id)));
  ipcMain.handle(
    IPC.AI_REPORT_MARK_READ,
    wrap((_e, id: string, read = true) => markCrashReportRead(id, !!read)),
  );
  ipcMain.handle(IPC.AI_REPORT_DELETE, wrap((_e, id: string) => deleteCrashReport(id)));

  /*
   * 在资源管理器里定位报告。
   * reveal=true 直接选中那个文件；false 只打开所在目录 ——
   * 「一键定位到崩溃分析文件所在的文件夹路径」要的是后者。
   */
  ipcMain.handle(
    IPC.AI_REPORT_REVEAL,
    wrap(async (_e, path: string, reveal = true) => {
      if (!existsSync(path)) throw new Error(`路径不存在：${path}`);
      if (reveal) shell.showItemInFolder(path);
      else await shell.openPath(path);
      return true;
    }),
  );

  ipcMain.handle(IPC.AI_CRASH_STATUS, wrap(() => getCrashWatchStatus()));

  /* ---------------- 设置 ---------------- */

  ipcMain.handle(IPC.SETTINGS_GET, wrap(() => getSettings()));

  /*
   * 界面配置（Conf/*.json）。
   *
   * 只读、带缓存 —— 「改完文件重启生效」是有意的：文件监听要处理半截写入、
   * 编辑器另存为等边角情况，而这类配置本来就很少改。
   * 解析与合并的容错全在 shared/ui-conf.ts，这里不会抛错。
   */
  ipcMain.handle(IPC.CONF_GET, wrap(() => getUiConf()));
  ipcMain.handle(IPC.CONF_DIR, wrap(() => resolveUiConfDir()));

  /*
   * 保存设置。带 `autoLaunch` 的这次要落到系统（注册表启动项），并且**以系统回读为准** ——
   * 写不进去（组策略锁死等）时把开关弹回实际状态，免得界面显示已开启、开机却没动静。
   */
  ipcMain.handle(
    IPC.SETTINGS_SET,
    wrap((_e, patch: Partial<AppSettings>) => {
      let next = saveSettings(patch);
      if (patch && 'autoLaunch' in patch) {
        const actual = applyAutoLaunch(next.autoLaunch);
        if (actual !== next.autoLaunch) next = saveSettings({ autoLaunch: actual });
      }
      /*
       * ⚠️ 这里刻意**不提前 return**（旧写法是 `return saveSettings(...)`）。
       * 提前返回会让下面的钩子被跳过 —— 而钩子要处理的是同一个 patch 里的
       * 其它字段（托盘跟随 autoMirrorOnConnect），跳过就会出现「开关关了托盘还在」。
       */
      try {
        settingsChangedHook?.(next);
      } catch {
        /* 钩子只是副作用（同步托盘），它出错不该让「保存设置」这一步报错 */
      }
      return next;
    }),
  );

  /* ---------------- 自绘标题栏配色（v1.1.3） ---------------- */

  /*
   * 窗口是 titleBarStyle:'hidden' + titleBarOverlay（见 main.ts），
   * 系统那部分标题栏的底色只能由主进程设置，而「当前是什么主题」只有渲染层知道。
   * 所以颜色由渲染层从 CSS 变量里现读（--bg-app / --text-primary）再传过来 ——
   * 主进程不另存一份色表，避免两处配色表长期跑偏（主题色的定义在 global.css 里）。
   *
   * 失败不抛给界面：非 Windows / 老系统不支持 overlay 时，自绘的那条色带照样在，
   * 只是窗口按钮区颜色跟不上，不值得弹错误。
   */
  ipcMain.handle(
    IPC.WINDOW_SET_TITLEBAR,
    wrap((_e, opts: { color?: string; symbolColor?: string; height?: number }) => {
      const color = typeof opts?.color === 'string' ? opts.color.trim() : '';
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`无效的标题栏颜色：${color}`);
      const symbolColor =
        typeof opts?.symbolColor === 'string' && opts.symbolColor.trim()
          ? opts.symbolColor.trim()
          : color;

      let applied = 0;
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
          w.setTitleBarOverlay({
            color,
            symbolColor,
            height: opts.height ?? TITLEBAR_HEIGHT,
          });
          applied += 1;
        } catch {
          /* 不支持就跳过 */
        }
      }
      return applied;
    }),
  );

  /*
   * 透明玻璃主题（v1.1.13）：切换整窗 Acrylic。
   *
   * 为什么要走主进程而不是纯 CSS：CSS 的 backdrop-filter 只能模糊**渲染层
   * 看得见的像素**，看不见桌面壁纸。参考图那种「后面就是桌面、还被磨砂糊住」
   * 的效果只有系统级 backgroundMaterial:'acrylic' 能给。
   *
   * 由 main.ts 的 applyGlassWindow 实现（那里写了「单向可逆但不对称」的约束：
   * 退出玻璃时 transparent/frame 改不回去，只能靠不透明背景色拉回观感）。
   */
  ipcMain.handle(
    IPC.WINDOW_SET_GLASS,
    wrap((_e, on: boolean) => {
      glassWindowHook?.(!!on);
      return true;
    }),
  );

  /*
   * 自绘窗口按钮（v1.1.13）。
   *
   * 玻璃主题是无边框窗口，系统标题栏连带它自带的三个按钮一起没了 ——
   * 渲染层画三个 macOS 风格圆点，点下去调这三个通道执行真实动作。
   * 普通主题下系统按钮仍在，这些通道不会被调用（调了也无害）。
   */
  ipcMain.handle(IPC.WINDOW_MINIMIZE, wrap(() => win()?.minimize() ?? false));
  ipcMain.handle(
    IPC.WINDOW_TOGGLE_MAX,
    wrap(() => {
      const w = win();
      if (!w) return false;
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
      return w.isMaximized();
    }),
  );
  ipcMain.handle(IPC.WINDOW_CLOSE, wrap(() => win()?.close() ?? false));
  ipcMain.handle(IPC.WINDOW_IS_MAX, wrap(() => win()?.isMaximized() ?? false));

  /*
   * 抓一张桌面壁纸（v1.1.13 修正：「模拟玻璃」的底图来源）。
   *
   * 背景与取舍见 shared/types.ts 里 WINDOW_GRAB_DESKTOP 的注释。要点：
   *   · Electron 在 Windows 10 上**不渲染 Acrylic**（上游 #48440），
   *     transparent:true 的结果是「全透明 + 零模糊」，而 CSS backdrop-filter
   *     在透明窗口里也采不到东西 —— 两套模糊全死。
   *   · 所以改由主进程抓一张真实桌面，交给渲染层当页面内的「壁纸层」，
   *     backdrop-filter 背后有实底，模糊才真正生效。
   *
   * 实现细节：
   *   · 按**屏幕逻辑尺寸 × scaleFactor** 取图，保证与 CSS 像素一一对应
   *     （本机 scaleFactor=1.25，取逻辑尺寸会得到模糊的缩略图）。
   *   · 失败重试 3 次、间隔 300ms：DXGI Desktop Duplication 偶发失败，
   *     单次失败不代表不可用。
   *   · 全部失败回 null，渲染层退回纯色背景 —— 不能因为抓不到壁纸就白屏。
   */
  ipcMain.handle(
    IPC.WINDOW_GRAB_DESKTOP,
    wrap(async () => {
      /*
       * v1.1.14 起优先读**壁纸文件本身**（见 services/wallpaper.ts）：
       * 整屏截图会把图标 / 打开的窗口 / 任务栏一起透到玻璃底下，不是用户要的
       * 「当前壁纸」。三级兜底：壁纸文件 → 注册表壁纸 → 整屏截图（旧行为）。
       * 每次启动渲染层都会重新来拿一次，自然满足「每次重启时更新」。
       */
      const wall = await getWallpaperDataURL();
      if (wall) return wall;

      const d = screen.getPrimaryDisplay();
      const w = Math.round(d.size.width * d.scaleFactor);
      const h = Math.round(d.size.height * d.scaleFactor);
      for (let i = 0; i < 3; i++) {
        try {
          const srcs = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: w, height: h },
          });
          const shot = srcs[0]?.thumbnail;
          if (shot && !shot.isEmpty()) {
            return shot.toDataURL();
          }
        } catch {
          /* 单次失败继续重试 */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return null;
    }),
  );

  /* ---------------- 增量更新（v1.0.7） ---------------- */
  ipcMain.handle(IPC.UPDATE_CONTEXT, wrap(() => getUpdateContext()));

  ipcMain.handle(
    IPC.UPDATE_PREPARE,
    wrap((_e, zipPath: string) => prepareUpdate(zipPath)),
  );

  ipcMain.handle(IPC.UPDATE_APPLY, wrap(() => applyUpdate()));
  ipcMain.handle(IPC.UPDATE_CANCEL, wrap(() => cancelUpdate()));
  ipcMain.handle(IPC.UPDATE_ROLLBACK, wrap(() => rollbackUpdate()));
  ipcMain.handle(IPC.UPDATE_HANDSHAKE, wrap(() => updateHandshake()));
  ipcMain.handle(IPC.UPDATE_OPEN_DIR, wrap(() => openUpdateDir()));

  /* ---------------- 在线更新（v1.0.22） ---------------- */

  // 检查更新：force=true 绕过 5 分钟缓存（用户手点的场景）
  ipcMain.handle(
    IPC.UPDATE_CHECK,
    wrap((_e, force?: boolean) => checkOnlineUpdate(!!force)),
  );

  // 下载 + 校验：进度走 push:updateDownload，返回值与「选择本地更新包」完全同构
  ipcMain.handle(
    IPC.UPDATE_DOWNLOAD,
    wrap((_e, pkgUrl: string, sha256?: string) => prepareUpdateFromUrl(pkgUrl, sha256)),
  );

  ipcMain.handle(IPC.UPDATE_CANCEL_DOWNLOAD, wrap(() => cancelOnlineDownload()));
}

/* ------------------------------------------------------------------ */
/* 命令解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把用户输入的命令行切成参数数组，支持引号包裹
 */
export function parseCommand(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let inWord = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
      continue;
    }

    if (/\s/.test(c)) {
      if (inWord) {
        out.push(cur);
        cur = '';
        inWord = false;
      }
      continue;
    }

    cur += c;
    inWord = true;
  }

  if (inWord) out.push(cur);
  return out;
}
