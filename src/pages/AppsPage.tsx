import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Card,
  Button,
  Badge,
  Empty,
  Input,
  Segmented,
  Notice,
  Spinner,
} from '@/components/ui';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import { formatBytes, formatTime } from '@/lib/format';
import type { AppDetail, AppInfo } from '@shared/types';

type FilterKey = 'all' | 'user' | 'system' | 'running';

export default function AppsPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('user');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);

  /* ---------- 读取列表 ---------- */
  const load = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setLoading(true);
    try {
      const r = await call<AppInfo[]>(
        () => window.adbApi.listApps(current.serial, true),
        { silent: true },
      );
      setApps(r || []);
      toast('success', `已读取 ${r?.length || 0} 个应用`);
    } catch (e) {
      toast('error', '读取失败', (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /* 换设备自动重载 */
  useEffect(() => {
    setApps([]);
    setSelected(null);
    setDetail(null);
    if (current?.serial) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.serial]);

  /* ---------- 详情 ---------- */
  const openDetail = async (pkg: string) => {
    if (!current) return;
    setSelected(pkg);
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await call<AppDetail>(
        () => window.adbApi.appDetail(current.serial, pkg),
        { silent: true },
      );
      setDetail(r);
    } catch (e) {
      toast('error', '读取详情失败', (e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  /* ---------- 单应用操作 ---------- */
  const doAction = async (
    pkg: string,
    action: 'forceStop' | 'clearData' | 'launch' | 'uninstall' | 'extract' | 'enable' | 'disable',
  ) => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(`${pkg}:${action}`);

    const wrap = async () => {
      switch (action) {
        case 'forceStop':
          await call(() => window.adbApi.forceStopApp(current.serial, pkg), {
            successMessage: '已强制停止',
          });
          break;
        case 'clearData':
          await call(() => window.adbApi.clearAppData(current.serial, pkg), {
            successMessage: '已清除应用数据',
          });
          break;
        case 'launch':
          await call(() => window.adbApi.launchApp(current.serial, pkg), {
            successMessage: '已启动应用',
          });
          break;
        case 'enable':
          await call(() => window.adbApi.setAppEnabled(current.serial, pkg, true), {
            successMessage: '已启用',
          });
          break;
        case 'disable':
          await call(() => window.adbApi.setAppEnabled(current.serial, pkg, false), {
            successMessage: '已停用',
          });
          break;
        case 'extract': {
          const r = await call<{ localPath: string; size: number }>(
            () => window.adbApi.extractApk(current.serial, pkg, ''),
            { silent: true },
          );
          toast('success', 'APK 已提取', r.localPath);
          window.adbApi.reveal(r.localPath);
          break;
        }
        case 'uninstall':
          await call(() => window.adbApi.uninstallApp(current.serial, pkg), {
            successMessage: '已卸载',
          });
          setApps((list) => list.filter((a) => a.packageName !== pkg));
          if (selected === pkg) {
            setSelected(null);
            setDetail(null);
          }
          break;
      }
    };

    try {
      await wrap();
      if (action !== 'uninstall') {
        // 刷新详情，反映状态变化
        if (selected === pkg) await openDetail(pkg);
      }
    } catch (e) {
      toast('error', '操作失败', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /* ---------- 列表过滤 ---------- */
  const filtered = useMemo(() => {
    let list = apps;
    if (filter === 'user') list = list.filter((a) => !a.system);
    else if (filter === 'system') list = list.filter((a) => a.system);
    else if (filter === 'running') list = list.filter((a) => a.running);

    const k = keyword.trim().toLowerCase();
    if (k) {
      list = list.filter(
        (a) =>
          a.packageName.toLowerCase().includes(k) ||
          (a.label || '').toLowerCase().includes(k),
      );
    }
    return list;
  }, [apps, filter, keyword]);

  const counts = useMemo(() => {
    const user = apps.filter((a) => !a.system).length;
    return {
      all: apps.length,
      user,
      system: apps.length - user,
      running: apps.filter((a) => a.running).length,
    };
  }, [apps]);

  const currentApp = apps.find((a) => a.packageName === selected);

  return (
    <>
      {!current && (
        <Notice tone="warn">
          当前没有可用设备，请先在「设备」页面连接手机并授权 USB 调试。
        </Notice>
      )}

      <div className="apps-layout">
        {/* ---------------- 左：应用列表 ---------------- */}
        <Card
          title="应用列表"
          subtitle={loading ? '正在读取…' : `共 ${counts.user} 个第三方应用 · ${counts.system} 个系统应用`}
          extra={
            <Button size="sm" variant="ghost" onClick={load} loading={loading} disabled={!current}>
              刷新
            </Button>
          }
          padding={false}
          className="apps-list-card"
        >
          <div className="apps-toolbar">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'user', label: `用户 ${counts.user}` },
                { value: 'system', label: `系统 ${counts.system}` },
                { value: 'all', label: `全部 ${counts.all}` },
              ]}
            />
            <Input
              placeholder="搜索应用名或包名…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ height: 28 }}
            />
          </div>

          <div className="apps-list" ref={listRef}>
            {loading && apps.length === 0 ? (
              <div className="apps-loading">
                <Spinner size={18} />
                <span>正在读取应用列表…</span>
              </div>
            ) : filtered.length === 0 ? (
              <Empty
                title={apps.length === 0 ? '还没有应用数据' : '没有匹配的应用'}
                desc={
                  apps.length === 0
                    ? '点击右上角「刷新」读取设备上的应用'
                    : '换个筛选条件或清空搜索关键字试试'
                }
              />
            ) : (
              filtered.map((a) => (
                <button
                  key={a.packageName}
                  className={`app-row ${selected === a.packageName ? 'selected' : ''}`}
                  onClick={() => openDetail(a.packageName)}
                >
                  <div className={`app-avatar ${a.system ? 'sys' : ''}`}>
                    {(a.label || a.packageName).replace(/^com\./, '').charAt(0).toUpperCase()}
                  </div>
                  <div className="app-main">
                    <span className="app-name">{a.label || a.packageName}</span>
                    <span className="app-pkg mono">{a.packageName}</span>
                  </div>
                  <div className="app-tags">
                    {a.system && <Badge tone="default">系统</Badge>}
                    {a.disabled && <Badge tone="warn">已停用</Badge>}
                    {a.versionName && <span className="text-dim">v{a.versionName}</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </Card>

        {/* ---------------- 右：详情与操作 ---------------- */}
        <Card
          title="应用详情"
          subtitle={selected ? selected : '从左侧选择应用查看详情'}
          padding={false}
          className="apps-detail-card"
        >
          {!selected ? (
            <Empty title="未选择应用" desc="点击左侧任意应用，查看版本、大小、权限并执行操作" />
          ) : detailLoading ? (
            <div className="apps-loading">
              <Spinner size={18} />
              <span>正在读取应用信息…</span>
            </div>
          ) : (
            <div className="app-detail">
              <div className="app-detail-head">
                <div className={`app-avatar lg ${detail?.system ? 'sys' : ''}`}>
                  {(currentApp?.label || selected).replace(/^com\./, '').charAt(0).toUpperCase()}
                </div>
                <div className="app-detail-title">
                  <h4>{currentApp?.label || selected}</h4>
                  <span className="mono text-dim">{selected}</span>
                </div>
              </div>

              <div className="app-info-grid">
                <InfoItem label="版本" value={detail?.versionName || '—'} />
                <InfoItem label="版本号" value={detail?.versionCode ?? '—'} />
                <InfoItem
                  label="占用空间"
                  value={currentApp?.sizeBytes ? formatBytes(currentApp.sizeBytes) : '—'}
                />
                <InfoItem
                  label="安装时间"
                  value={detail?.installedAt ? formatTime(detail.installedAt) : '—'}
                />
                <InfoItem
                  label="更新时间"
                  value={detail?.updatedAt ? formatTime(detail.updatedAt) : '—'}
                />
                <InfoItem label="类型" value={detail?.system ? '系统应用' : '用户应用'} />
                <InfoItem
                  label="状态"
                  value={detail?.enabled === false ? '已停用' : '已启用'}
                />
                <InfoItem label="Activity 数" value={detail?.activities ?? '—'} />
              </div>

              {detail?.apkPath && (
                <div className="record-out">
                  <span className="text-dim">APK 路径</span>
                  <span className="mono">{detail.apkPath}</span>
                </div>
              )}

              <div className="app-actions">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => doAction(selected, 'launch')}
                  loading={busy === `${selected}:launch`}
                  disabled={detail?.enabled === false}
                >
                  启动
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => doAction(selected, 'forceStop')}
                  loading={busy === `${selected}:forceStop`}
                >
                  强制停止
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => doAction(selected, 'extract')}
                  loading={busy === `${selected}:extract`}
                >
                  提取 APK
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() =>
                    doAction(selected, detail?.enabled === false ? 'enable' : 'disable')
                  }
                  loading={busy === `${selected}:${detail?.enabled === false ? 'enable' : 'disable'}`}
                  disabled={detail?.system}
                >
                  {detail?.enabled === false ? '启用' : '停用'}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => doAction(selected, 'clearData')}
                  loading={busy === `${selected}:clearData`}
                >
                  清除数据
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (confirm(`确定卸载 ${selected}？该操作会删除应用及其数据。`)) {
                      void doAction(selected, 'uninstall');
                    }
                  }}
                  loading={busy === `${selected}:uninstall`}
                  disabled={detail?.system}
                >
                  卸载
                </Button>
              </div>

              {detail?.system && (
                <Notice tone="warn">
                  这是系统应用。强制停止与清除数据仍可用，但卸载 / 停用已被禁用，
                  避免破坏设备基本功能。
                </Notice>
              )}

              {detail?.permissions && detail.permissions.length > 0 && (
                <div className="app-perms">
                  <span className="field-label">
                    申请权限 <em className="field-hint">{detail.permissions.length} 项</em>
                  </span>
                  <div className="perm-list">
                    {detail.permissions.map((p) => (
                      <span key={p} className="perm-chip mono" title={p}>
                        {p.replace(/^android\.permission\./, '')}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function InfoItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="app-info-item">
      <span className="res-label">{label}</span>
      <strong className="app-info-value">{value}</strong>
    </div>
  );
}
