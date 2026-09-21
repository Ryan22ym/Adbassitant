import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import {
  IPC,
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
} from '../shared/types';
import {
  listDevices,
  runAdb,
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
import { getLogs, clearLogs, exportLogs, setLogPushSink, addLog } from './services/logger';
import { getSettings, saveSettings, resolveDir, DEFAULT_LOGX_ROOT } from './services/settings';
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

export function registerIpc() {
  /* ---------------- 日志推送管道 ---------------- */

  setLogSink((p) => {
    // 转交给 logger：统一缓冲 + 广播给渲染进程
    addLog(p.level, p.source, p.message, p.detail);
  });

  setLogPushSink((entry) => send(IPC.PUSH_LOG, entry));

  setMirrorStatusSink((s) => send(IPC.PUSH_MIRROR_STATUS, s));

  setLogcatLinesSink((lines) => send(IPC.PUSH_LOGCAT_LINES, lines));

  setLogcatStatusSink((s) => send(IPC.PUSH_LOGCAT_STATUS, s));

  setWeakNetStatusSink((s) => send(IPC.PUSH_WEAKNET_STATUS, s));

  // 在线更新包下载进度（v1.0.22）
  setUpdateDownloadSink((p) => send(IPC.PUSH_UPDATE_DOWNLOAD, p));

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

  ipcMain.handle(
    IPC.DEVICE_DETAIL,
    wrap(async (_e, serial: string) => {
      const [res, battery, mem] = await Promise.all([
        runAdb(
          ['-s', serial, 'shell', 'getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.serialno; getprop ro.product.name; getprop ro.product.device; getprop ro.build.display.id'],
          { silent: true, timeout: 10000 },
        ),
        runAdb(['-s', serial, 'shell', 'dumpsys', 'battery'], { silent: true, timeout: 10000 }),
        runAdb(['-s', serial, 'shell', 'cat', '/proc/meminfo'], { silent: true, timeout: 10000 }),
      ]);

      const p = res.stdout.split(/\r?\n/).map((x) => x.trim());
      const batteryLevel = battery.stdout.match(/level:\s*(\d+)/)?.[1];
      const batteryTemp = battery.stdout.match(/temperature:\s*(\d+)/)?.[1];
      const memTotal = mem.stdout.match(/MemTotal:\s*(\d+)/)?.[1];
      const memAvail = mem.stdout.match(/MemAvailable:\s*(\d+)/)?.[1];

      return {
        brand: p[0],
        model: p[1],
        androidVersion: p[2],
        sdk: parseInt(p[3], 10) || undefined,
        serialno: p[4],
        product: p[5],
        device: p[6],
        buildId: p[7],
        battery: batteryLevel ? parseInt(batteryLevel, 10) : undefined,
        batteryTemp: batteryTemp ? parseInt(batteryTemp, 10) / 10 : undefined,
        memTotalKB: memTotal ? parseInt(memTotal, 10) : undefined,
        memAvailKB: memAvail ? parseInt(memAvail, 10) : undefined,
      };
    }),
  );

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

  /* ---------------- 实时 Logcat（v1.0） ---------------- */

  ipcMain.handle(
    IPC.LOGCAT_START,
    wrap((_e, serial: string | undefined, filter?: Partial<LogcatFilter>) =>
      startLogcat(serial, filter),
    ),
  );

  ipcMain.handle(IPC.LOGCAT_STOP, wrap(() => stopLogcat()));
  ipcMain.handle(IPC.LOGCAT_STATUS, wrap(() => getLogcatStatus()));

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
          message: '找不到随包 APK（应为 bin/weaknet/weaknet-vpn.apk）',
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

  /* ---------------- 设置 ---------------- */

  ipcMain.handle(IPC.SETTINGS_GET, wrap(() => getSettings()));

  ipcMain.handle(
    IPC.SETTINGS_SET,
    wrap((_e, patch: Partial<AppSettings>) => saveSettings(patch)),
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
