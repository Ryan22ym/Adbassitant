import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import {
  IPC,
  type MirrorOptions,
  type AppSettings,
  type CommandResult,
  type LogcatFilter,
  type WeakNetParams,
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
  startLogcat,
  stopLogcat,
  getLogcatStatus,
  clearLogcatBuffer,
  saveLogcat,
  listProcesses,
  setLogcatLinesSink,
  setLogcatStatusSink,
} from './services/logcat';
import {
  startWeakNet,
  stopWeakNet,
  getWeakNetStatus,
  listPresets,
  savePreset,
  deletePreset,
  probeDevice,
  setWeakNetStatusSink,
} from './services/weaknet';
import { getLogs, clearLogs, exportLogs, setLogPushSink, addLog } from './services/logger';
import { getSettings, saveSettings, resolveDir } from './services/settings';
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
    wrap((_e, serial: string | undefined, apkPath: string, reinstall = true, grantAll = false) =>
      installApk(serial, apkPath, reinstall, grantAll),
    ),
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

  /* ---------------- 设置 ---------------- */

  ipcMain.handle(IPC.SETTINGS_GET, wrap(() => getSettings()));

  ipcMain.handle(
    IPC.SETTINGS_SET,
    wrap((_e, patch: Partial<AppSettings>) => saveSettings(patch)),
  );
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
