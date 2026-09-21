import { useEffect, useState, useCallback } from 'react';
import { Card, Button, Badge, Empty, Notice, Input, Field, Segmented, Spinner } from '@/components/ui';
import { DevicePicker, deviceLabel } from '@/components/layout';
import { QuickActionBar, QuickActionsDialog } from '@/components/QuickActions';
import { useApp, useOnlineCount } from '@/store/app';
import { call, tryCall } from '@/lib/ipc';
import { formatBytes } from '@/lib/format';
import { mirrorOptionsFor, isMirroringDevice } from '@/lib/mirror';
import type { QuickAction } from '@shared/types';

interface DeviceDetail {
  brand?: string;
  model?: string;
  androidVersion?: string;
  sdk?: number;
  serialno?: string;
  product?: string;
  device?: string;
  buildId?: string;
  battery?: number;
  batteryTemp?: number;
  memTotalKB?: number;
  memAvailKB?: number;
}

export default function DevicePage() {
  const devices = useApp((s) => s.devices);
  const currentSerial = useApp((s) => s.currentSerial);
  const setDevices = useApp((s) => s.setDevices);
  const setScanning = useApp((s) => s.setScanning);
  const scanning = useApp((s) => s.scanning);
  const toast = useApp((s) => s.toast);

  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  /* 无线连接 */
  const [tcpMode, setTcpMode] = useState<'connect' | 'usb'>('connect');
  const [tcpAddress, setTcpAddress] = useState('');
  const [tcpBusy, setTcpBusy] = useState(false);

  /* 快捷动作（本机配置，全设备共用） */
  const [qActions, setQActions] = useState<QuickAction[]>([]);
  const [qCfgOpen, setQCfgOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await tryCall<QuickAction[]>(() => window.adbApi.quickActions());
      if (alive && list) setQActions(list);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setScanning(true);
    try {
      const res = await window.adbApi.listDevices();
      if (res.ok && res.data) setDevices(res.data);
      else if (res.error) toast('error', '扫描设备失败', res.error);
    } finally {
      setScanning(false);
    }
  }, [setDevices, setScanning, toast]);

  /* 加载设备详情 */
  useEffect(() => {
    let alive = true;
    if (!currentSerial) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    (async () => {
      const d = await tryCall<DeviceDetail>(() => window.adbApi.deviceDetail(currentSerial));
      if (alive) {
        setDetail(d);
        setLoadingDetail(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentSerial]);

  /* 无线连接：USB 一键切 TCP */
  const switchToTcp = async () => {
    if (!currentSerial) return;
    setTcpBusy(true);
    try {
      // 1. 拿到设备 IP
      const ipRes = await call<{ ok: boolean; data?: any }>(
        () => window.adbApi.runAdb(currentSerial, 'shell ip route'),
        { silent: true },
      );
      const route = (ipRes as any)?.stdout as string | undefined;
      const ip = route?.match(/src\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
      if (!ip) throw new Error('无法获取设备 IP，请确认手机与电脑在同一 WiFi');

      // 2. 切到 tcpip 模式
      await call(() => window.adbApi.runAdb(currentSerial, 'tcpip 5555'), {
        successMessage: undefined,
      });

      await new Promise((r) => setTimeout(r, 1200));

      // 3. 连接
      const target = `${ip}:5555`;
      await call(() => window.adbApi.connectTcp(target), {
        successMessage: `已切换到无线：${target}`,
      });
      setTcpAddress(target);
      await refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setTcpBusy(false);
    }
  };

  const connectTcp = async () => {
    if (!tcpAddress.trim()) {
      toast('warn', '请输入 IP:端口，例如 192.168.1.5:5555');
      return;
    }
    setTcpBusy(true);
    try {
      await call(() => window.adbApi.connectTcp(tcpAddress.trim()), {
        successMessage: '连接成功',
      });
      await refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setTcpBusy(false);
    }
  };

  const restartAdb = async () => {
    try {
      await call(() => window.adbApi.adbKill(), { silent: true });
      await call(() => window.adbApi.adbStart(), { successMessage: 'ADB 服务已重启' });
      await refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const onlineCount = useOnlineCount();
  const hasProblem = devices.some((d) => d.state === 'unauthorized' || d.state === 'offline');

  /* 快速投屏：不切页直接起投屏窗口 */
  const mirror = useApp((s) => s.mirror);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);

  const quickMirror = async (serial: string) => {
    setQuickBusy(serial);
    try {
      // 沿用投屏页上次用的参数（未调过则是默认均衡档）
      await call(() => window.adbApi.startMirror(mirrorOptionsFor(serial)), {
        successMessage: '投屏窗口已启动',
      });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setQuickBusy(null);
    }
  };

  const quickStopMirror = async () => {
    setQuickBusy('__stop__');
    try {
      await call(() => window.adbApi.stopMirror(), { successMessage: '投屏已停止' });
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setQuickBusy(null);
    }
  };

  return (
    <>
      {/* 设备列表 */}
      <Card
        title="已连接设备"
        subtitle={`共 ${devices.length} 台，其中 ${onlineCount} 台就绪`}
        extra={
          <>
            <DevicePicker />
            <Button
              size="sm"
              variant="ghost"
              onClick={restartAdb}
              title="重启 ADB 服务（设备识别异常时使用）"
            >
              重启 ADB
            </Button>
          </>
        }
        padding={false}
      >
        {devices.length === 0 ? (
          <Empty
            title="未检测到设备"
            desc="请用 USB 连接手机，在手机上开启「开发者选项」和「USB 调试」，然后在弹出窗口中点击「允许」"
            action={
              <>
                <Button variant="primary" onClick={refresh} loading={scanning}>
                  重新扫描
                </Button>
              </>
            }
          />
        ) : (
          <div className="device-list">
            {devices.map((d) => {
              const ready = d.state === 'device';
              const thisMirroring = isMirroringDevice(d.serial, mirror.running ? mirror.serial : undefined);
              const otherMirroring = mirror.running && !thisMirroring;
              return (
                <div
                  key={d.serial}
                  className={`device-row ${d.serial === currentSerial ? 'selected' : ''} ${ready ? '' : 'disabled'}`}
                  role="button"
                  tabIndex={ready ? 0 : -1}
                  aria-disabled={!ready}
                  onClick={() => ready && useApp.getState().setCurrentSerial(d.serial)}
                  onKeyDown={(e) => {
                    if (!ready) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      useApp.getState().setCurrentSerial(d.serial);
                    }
                  }}
                >
                  <span className={`device-avatar ${ready ? 'ok' : ''}`}>
                    {d.isEmulator ? 'E' : 'A'}
                  </span>
                  <span className="device-main">
                    <span className="device-name">{deviceLabel(d)}</span>
                    <span className="device-serial mono">{d.serial}</span>
                  </span>
                  <span className="device-tags">
                    <Badge tone={d.connection === 'tcp' ? 'accent' : 'default'}>
                      {d.connection === 'tcp' ? '无线' : 'USB'}
                    </Badge>
                    {d.isEmulator && <Badge tone="default">模拟器</Badge>}
                    <Badge tone={stateTone(d.state)} dot={d.state === 'device'}>
                      {stateLabel(d.state)}
                    </Badge>
                  </span>
                  {/* 快捷动作：清数据 / 回桌面再进 / 杀进程重进…（本机可配置，见「更多」菜单） */}
                  {ready && (
                    <QuickActionBar
                      serial={d.serial}
                      ready={ready}
                      actions={qActions}
                      onConfigure={() => setQCfgOpen(true)}
                    />
                  )}
                  {/* 快速投屏：无需切到投屏页；正在投屏的这台变成「停止投屏」 */}
                  <span className="device-actions">
                    {thisMirroring ? (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={quickBusy === '__stop__'}
                        title="停止投屏窗口"
                        onClick={(e) => {
                          e.stopPropagation();
                          quickStopMirror();
                        }}
                      >
                        停止投屏
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={quickBusy === d.serial}
                        disabled={!ready || !!otherMirroring}
                        title={
                          otherMirroring
                            ? `已有投屏在运行（${mirror.serial}），请先停止`
                            : `直接投屏这台设备（沿用投屏页的画质设置）`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          useApp.getState().setCurrentSerial(d.serial);
                          quickMirror(d.serial);
                        }}
                      >
                        投屏
                      </Button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {hasProblem && (
        <Notice tone="warn">
          <strong>设备未就绪</strong>
          ：如果状态显示「未授权」，请在手机屏幕上确认 USB 调试授权弹窗；若显示「离线」，
          尝试重新插拔数据线或点击右上角「重启 ADB」。
        </Notice>
      )}

      {/* 设备详情 */}
      {currentSerial && (
        <Card
          title="设备详情"
          subtitle={currentSerial}
          extra={loadingDetail ? <Spinner /> : undefined}
        >
          {!detail ? (
            <div className="text-dim">正在读取设备信息…</div>
          ) : (
            <div className="kv-list">
              <KV label="品牌" value={detail.brand} />
              <KV label="型号" value={detail.model} />
              <KV label="Android 版本" value={detail.androidVersion} />
              <KV label="SDK 等级" value={detail.sdk} />
              <KV label="产品名" value={detail.product} />
              <KV label="设备代号" value={detail.device} />
              <KV label="系统版本号" value={detail.buildId} />
              <KV
                label="电量"
                value={
                  detail.battery !== undefined
                    ? `${detail.battery}%${detail.batteryTemp ? ` · ${detail.batteryTemp.toFixed(1)}°C` : ''}`
                    : undefined
                }
              />
              <KV
                label="内存"
                value={
                  detail.memTotalKB
                    ? `${formatBytes((detail.memTotalKB - (detail.memAvailKB || 0)) * 1024)} / ${formatBytes(detail.memTotalKB * 1024)}`
                    : undefined
                }
              />
            </div>
          )}
        </Card>
      )}

      {/* 无线连接 */}
      <Card title="无线连接" subtitle="通过 WiFi 连接设备，摆脱数据线">
        <div className="col">
          <Segmented
            value={tcpMode}
            onChange={setTcpMode}
            options={[
              { value: 'usb', label: 'USB 一键转无线' },
              { value: 'connect', label: '手动输入地址' },
            ]}
          />

          {tcpMode === 'usb' ? (
            <div className="col">
              <p className="text-dim">
                需先通过 USB 连接设备，且手机与电脑处于同一 WiFi 网络。执行后将自动开启
                TCP/IP 模式并连接。
              </p>
              <div className="row">
                <Button
                  variant="primary"
                  onClick={switchToTcp}
                  loading={tcpBusy}
                  disabled={!currentSerial || isTcpSerial(currentSerial)}
                >
                  开启无线连接
                </Button>
                {!currentSerial && <span className="text-dim">请先连接 USB 设备</span>}
                {currentSerial && isTcpSerial(currentSerial) && (
                  <span className="text-dim">当前已是无线连接</span>
                )}
              </div>
            </div>
          ) : (
            <div className="col">
              <Field label="设备地址" hint="格式：IP:端口，默认端口 5555">
                <Input
                  placeholder="192.168.1.100:5555"
                  value={tcpAddress}
                  onChange={(e) => setTcpAddress(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && connectTcp()}
                />
              </Field>
              <div className="row">
                <Button variant="primary" onClick={connectTcp} loading={tcpBusy}>
                  连接
                </Button>
                {tcpAddress && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await tryCall(() => window.adbApi.disconnectTcp(tcpAddress));
                      await refresh();
                    }}
                  >
                    断开
                  </Button>
                )}
              </div>
              <p className="text-dim">
                提示：Android 11 及以上若需配对码连接，先在设备「无线调试」中获取配对地址，
                或使用 USB 一键切换功能。
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* 快捷动作配置（设备行左侧那块按钮的来源） */}
      <QuickActionsDialog
        open={qCfgOpen}
        actions={qActions}
        onClose={() => setQCfgOpen(false)}
        onSaved={(list) => setQActions(list)}
      />
    </>
  );
}

function KV({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="kv">
      <span className="kv-key">{label}</span>
      <span className="kv-value">{value ?? '—'}</span>
    </div>
  );
}

function stateLabel(s: string): string {
  switch (s) {
    case 'device':
      return '就绪';
    case 'unauthorized':
      return '未授权';
    case 'offline':
      return '离线';
    case 'bootloader':
      return 'Bootloader';
    case 'recovery':
      return 'Recovery';
    default:
      return '未知';
  }
}

function stateTone(s: string): 'success' | 'warn' | 'danger' | 'default' {
  switch (s) {
    case 'device':
      return 'success';
    case 'unauthorized':
      return 'warn';
    case 'offline':
      return 'danger';
    default:
      return 'default';
  }
}

/** 判断序列号是否为 TCP 地址形式（IP:端口） */
function isTcpSerial(serial: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) || serial.startsWith('adb-');
}
