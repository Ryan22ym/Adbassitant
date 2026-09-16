import { useEffect } from 'react';
import { Button, Spinner } from '@/components/ui';
import { useApp, type InstallTask, type PendingInstall } from '@/store/app';
import {
  cancelPendingInstall,
  collectApks,
  dismissInstall,
  installApkFiles,
  isBusy,
  selectableDevices,
  startInstallOn,
} from '@/lib/install';
import { formatBytes } from '@/lib/format';
import { deviceLabel } from '@/components/layout';
import { INSTALL_MODE_LABEL } from '@shared/types';
import './install.css';

/**
 * 整窗拖放安装 + 安装进度弹窗 + 「装到哪台设备」选择弹窗。
 *
 * 为什么拖放区做在这里，而不是投屏窗口：
 * 投屏画面是 scrcpy.exe 的独立原生窗口（SDL2），我们无法往里面注入任何 UI，
 * 所以「拖放反馈」只能由本程序自己的窗口承担。
 *
 * 防重复安装有三道：
 * 1. 安装中/选设备时不显示拖放提示，且 dropEffect 设为 none（光标变禁止符号）；
 * 2. 意外落到窗口上的拖放会被 isBusy() 拦下并提示；
 * 3. 主进程 installApk 里还有一道进程级互斥锁，UI 失效也串不起来。
 */
export default function DragInstallHost() {
  const install = useApp((s) => s.install);
  const pendingInstall = useApp((s) => s.pendingInstall);
  const dragActive = useApp((s) => s.dragActive);

  useEffect(() => {
    // dragenter/dragleave 会在子元素之间反复触发，用计数器判断是否真的离开了窗口
    const state = { depth: 0 };

    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const inDropZone = (e: DragEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.('[data-dropzone]');

    const onDragEnter = (e: DragEvent) => {
      // 无条件 preventDefault：不然拖进窗口的文件会被 Chromium 当成导航，
      // 直接把整个界面替换成那个文件的内容。
      e.preventDefault();
      if (!hasFiles(e)) return;
      state.depth += 1;
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (!hasFiles(e)) return;

      const busy = isBusy();
      if (e.dataTransfer) e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      // 落在页面内专用拖放区上时不再显示整窗提示，避免两层提示打架
      useApp.getState().setDragActive(!busy && !inDropZone(e));
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      state.depth = Math.max(0, state.depth - 1);
      if (state.depth === 0) useApp.getState().setDragActive(false);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      state.depth = 0;
      useApp.getState().setDragActive(false);
      if (!hasFiles(e)) return;
      if (inDropZone(e)) return; // 由页面内的拖放区自行处理
      void handleWindowDrop(Array.from(e.dataTransfer?.files ?? []));
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      useApp.getState().setDragActive(false);
    };
  }, []);

  return (
    <>
      {dragActive && (
        <div className="drop-veil">
          <div className="drop-veil-card">
            <p className="drop-veil-title">松开鼠标即可安装 APK</p>
            <p className="drop-veil-hint">
              可一次拖多个，按顺序安装；非 APK 文件会被忽略。
              多台设备在线时，会先问一下装到哪台
            </p>
          </div>
        </div>
      )}

      {/* 选目标设备的弹窗优先级更高：它是安装的前置步骤 */}
      {pendingInstall ? (
        <PickDeviceDialog pending={pendingInstall} />
      ) : (
        install && <InstallDialog task={install} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 窗口级拖放处理                                                      */
/* ------------------------------------------------------------------ */

async function handleWindowDrop(files: File[]) {
  const st = useApp.getState();

  if (isBusy()) {
    st.toast(
      'warn',
      st.pendingInstall ? '请先选择安装到哪台设备' : '正在安装中，请稍候',
      st.pendingInstall ? undefined : '同一时间只允许一个安装任务',
    );
    return;
  }
  if (files.length === 0) return;

  const { apks, skipped } = collectApks(files);

  if (apks.length === 0) {
    st.toast(
      'warn',
      '没有可安装的文件',
      '拖放安装只支持 .apk 文件；其他文件可拖到投屏窗口，会自动存入设备 Download 目录',
    );
    return;
  }
  if (skipped > 0) st.toast('info', `已忽略 ${skipped} 个非 APK 文件`);

  // 与「安装 APK」页保持同一个安装方式，避免用户选了清洁安装、拖进去却是覆盖安装
  await installApkFiles(apks, { mode: st.installMode });
}

/* ------------------------------------------------------------------ */
/* 选择目标设备                                                        */
/* ------------------------------------------------------------------ */

/**
 * 多台设备同时在线时，先让用户点一下装到哪台。
 *
 * 这一屏是「界面显示安装成功、手机上却没有」的根治办法：
 * 装到别的设备上时，装后复核也照样通过（包真的装上了），
 * 只有把「装哪台」变成用户明确回答过的问题，才不会出错。
 */
function PickDeviceDialog({ pending }: { pending: PendingInstall }) {
  // 订阅设备列表，设备上下线时这一屏要跟着变
  useApp((s) => s.devices);
  const currentSerial = useApp((s) => s.currentSerial);
  const devices = selectableDevices();

  const firstName = pending.files[0]?.name ?? 'APK';
  const label =
    pending.files.length > 1 ? `${firstName} 等 ${pending.files.length} 个文件` : firstName;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelPendingInstall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="install-mask" role="dialog" aria-modal="true" aria-label="选择安装目标">
      <div className="install-card fade-in" data-pick-device="1">
        <div className="install-badge pick">?</div>

        <p className="install-title pick">装到哪台设备？</p>
        <p className="install-file" title={pending.files[0]?.path}>
          {label}
        </p>

        <div className="install-meta">
          <span className="install-chip">{INSTALL_MODE_LABEL[pending.mode]}</span>
          <span className="install-chip ghost">{devices.length} 台设备在线</span>
        </div>

        <div className="install-devices">
          {devices.map((d) => (
            <button
              key={d.serial}
              type="button"
              className="install-device"
              data-install-device={d.serial}
              onClick={() => void startInstallOn(d.serial)}
            >
              <span className={`install-device-kind ${d.isEmulator ? 'emu' : 'phone'}`}>
                {d.isEmulator ? '模拟器' : '手机'}
              </span>
              <span className="install-device-name">{deviceLabel(d)}</span>
              <span className="install-device-serial">
                {d.serial}
                {d.serial === currentSerial ? ' · 当前' : ''}
              </span>
            </button>
          ))}
        </div>

        <p className="install-note">
          多台设备同时在线时不会替你挑一台 —— 点哪台就装到哪台
        </p>

        <div className="install-actions">
          <Button variant="ghost" size="sm" onClick={cancelPendingInstall}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 安装进度弹窗                                                        */
/* ------------------------------------------------------------------ */

function InstallDialog({ task }: { task: InstallTask }) {
  const installing = task.phase === 'installing';
  const isSuccess = task.phase === 'success';

  /* 结果态支持 Esc 关闭；安装中不接受任何关闭操作 */
  useEffect(() => {
    if (installing) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissInstall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [installing]);

  const title = installing ? '正在安装中…' : isSuccess ? '安装成功' : '安装失败';

  return (
    <div className="install-mask" role="dialog" aria-modal="true" aria-label={title}>
      <div className="install-card fade-in">
        <div className={`install-badge ${task.phase}`}>
          {installing ? <Spinner size={22} /> : isSuccess ? '✓' : '×'}
        </div>

        <p className={`install-title ${task.phase}`}>{title}</p>
        <p className="install-file" title={task.apkPath}>
          {task.fileName}
        </p>
        {(task.sizeBytes ?? 0) > 0 && (
          <p className="install-size">{formatBytes(task.sizeBytes)}</p>
        )}

        {/*
          装到哪台机器必须写出来。多设备在线时，「安装成功」本身
          说明不了任何事 —— 用户很可能在另一台手机上找应用。
        */}
        <div className="install-meta">
          {task.modeLabel && <span className="install-chip">{task.modeLabel}</span>}
          {task.device && <span className="install-chip ghost">→ {task.device}</span>}
          {isSuccess && task.verified === true && (
            <span className="install-chip ok">已复核</span>
          )}
        </div>

        {installing ? (
          <p className="install-note">
            安装期间已锁定，重复拖入或重复点击都会被忽略
          </p>
        ) : (
          <>
            {task.message && <pre className="install-detail">{task.message}</pre>}
            <div className="install-actions">
              <Button variant={isSuccess ? 'primary' : 'default'} size="sm" onClick={dismissInstall}>
                {isSuccess ? '知道了' : '关闭'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
