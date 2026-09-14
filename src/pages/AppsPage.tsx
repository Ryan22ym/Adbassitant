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
import type { AppDetail, AppInfo, FavoriteApp } from '@shared/types';

type FilterKey = 'fav' | 'user' | 'system' | 'all' | 'running';

/**
 * 列表行：把「设备上装了的应用」和「收藏里但当前设备没装的包名」统一成一种形状，
 * 这样收藏项在换设备 / 卸载后依然留在列表里，不会凭空消失。
 */
interface Row {
  packageName: string;
  label: string;
  system: boolean;
  disabled?: boolean;
  versionName?: string;
  running?: boolean;
  sizeBytes?: number;
  /** 当前设备上是否存在 */
  installed: boolean;
}

export default function AppsPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [favorites, setFavorites] = useState<FavoriteApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('user');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  /* ---------- 常用应用（本机持久化，与设备无关） ---------- */
  const loadFavorites = async () => {
    try {
      const list = await call<FavoriteApp[]>(() => window.adbApi.favoriteApps(), {
        silent: true,
      });
      setFavorites(list || []);
    } catch {
      /* 读取失败不打扰用户，收藏功能降级为不可用 */
    }
  };

  const favMap = useMemo(() => {
    const m = new Map<string, FavoriteApp>();
    favorites.forEach((f) => m.set(f.packageName, f));
    return m;
  }, [favorites]);

  const toggleFav = async (pkg: string, label?: string) => {
    try {
      const list = await call<FavoriteApp[]>(
        () => window.adbApi.toggleFavorite(pkg, label),
        { silent: true },
      );
      setFavorites(list || []);
      const nowFav = (list || []).some((f) => f.packageName === pkg);
      toast(nowFav ? 'success' : 'info', nowFav ? '已固定为常用' : '已取消固定', pkg);
    } catch (e) {
      toast('error', '操作失败', (e as Error).message);
    }
  };

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

  /* 进页面读一次收藏 */
  useEffect(() => {
    void loadFavorites();
  }, []);

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

  /* ---------- 统一行数据 ---------- */
  const rows: Row[] = useMemo(() => {
    const out: Row[] = apps.map((a) => ({
      packageName: a.packageName,
      label: a.label || a.packageName,
      system: a.system,
      disabled: a.disabled,
      versionName: a.versionName,
      running: a.running,
      sizeBytes: a.sizeBytes,
      installed: true,
    }));
    // 收藏里当前设备没装的包，也补一行，方便清理或换设备后回来看
    favorites.forEach((f) => {
      if (!apps.some((a) => a.packageName === f.packageName)) {
        out.push({
          packageName: f.packageName,
          label: f.label || f.packageName,
          system: false,
          installed: false,
        });
      }
    });
    return out;
  }, [apps, favorites]);

  /* ---------- 列表过滤 + 收藏置顶 ---------- */
  const filtered = useMemo(() => {
    let list = rows;
    if (filter === 'user') list = list.filter((r) => r.installed && !r.system);
    else if (filter === 'system') list = list.filter((r) => r.installed && r.system);
    else if (filter === 'running') list = list.filter((r) => r.running);
    else if (filter === 'fav') list = list.filter((r) => favMap.has(r.packageName));

    const k = keyword.trim().toLowerCase();
    if (k) {
      list = list.filter(
        (r) => r.packageName.toLowerCase().includes(k) || r.label.toLowerCase().includes(k),
      );
    }

    // 「常用」页签本身已经全是收藏；其他页签把收藏顶到最前面
    if (filter === 'fav') return list;
    const fav = list.filter((r) => favMap.has(r.packageName));
    const rest = list.filter((r) => !favMap.has(r.packageName));
    return [...fav, ...rest];
  }, [rows, filter, keyword, favMap]);

  const counts = useMemo(() => {
    const user = apps.filter((a) => !a.system).length;
    return {
      all: apps.length,
      user,
      system: apps.length - user,
      running: apps.filter((a) => a.running).length,
      fav: favorites.length,
    };
  }, [apps, favorites]);

  const currentApp = apps.find((a) => a.packageName === selected);
  const currentRow = rows.find((r) => r.packageName === selected);
  const selectedIsFav = !!selected && favMap.has(selected);
  const selectedLabel = currentApp?.label || currentRow?.label || selected || '';

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
          subtitle={
            loading
              ? '正在读取…'
              : `共 ${counts.user} 个第三方应用 · ${counts.system} 个系统应用 · 已固定 ${counts.fav} 个常用`
          }
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
                { value: 'fav', label: `★ 常用 ${counts.fav}` },
                { value: 'user', label: `用户 ${counts.user}` },
                { value: 'system', label: `系统 ${counts.system}` },
                { value: 'running', label: `运行中 ${counts.running}` },
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
                title={
                  filter === 'fav'
                    ? '还没有固定的常用应用'
                    : apps.length === 0
                      ? '还没有应用数据'
                      : '没有匹配的应用'
                }
                desc={
                  filter === 'fav'
                    ? '点击任意应用右侧的 ☆ 把它固定到常用，下次进来直接点'
                    : apps.length === 0
                      ? '点击右上角「刷新」读取设备上的应用'
                      : '换个筛选条件或清空搜索关键字试试'
                }
              />
            ) : (
              filtered.map((r) => {
                const isFav = favMap.has(r.packageName);
                return (
                  <div
                    key={r.packageName}
                    className={`app-row ${selected === r.packageName ? 'selected' : ''} ${
                      isFav ? 'is-fav' : ''
                    } ${r.installed ? '' : 'not-installed'}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!r.installed) {
                        toast('warn', '该应用未安装在当前设备', r.packageName);
                        return;
                      }
                      void openDetail(r.packageName);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && r.installed) void openDetail(r.packageName);
                    }}
                  >
                    <div className={`app-avatar ${r.system ? 'sys' : ''}`}>
                      {(r.label || r.packageName).replace(/^com\./, '').charAt(0).toUpperCase()}
                    </div>
                    <div className="app-main">
                      <span className="app-name">{r.label}</span>
                      <span className="app-pkg mono">{r.packageName}</span>
                    </div>
                    <div className="app-tags">
                      {isFav && <Badge tone="accent">常用</Badge>}
                      {!r.installed && <Badge tone="warn">未安装</Badge>}
                      {r.system && <Badge tone="default">系统</Badge>}
                      {r.disabled && <Badge tone="warn">已停用</Badge>}
                      {r.versionName && <span className="text-dim">v{r.versionName}</span>}
                      <button
                        className={`app-star ${isFav ? 'on' : ''}`}
                        title={isFav ? '取消固定' : '固定为常用'}
                        aria-label={isFav ? '取消固定' : '固定为常用'}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleFav(r.packageName, r.label);
                        }}
                      >
                        {isFav ? '★' : '☆'}
                      </button>
                    </div>
                  </div>
                );
              })
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
            favorites.length > 0 ? (
              <div className="fav-quick">
                <div className="fav-quick-head">
                  <strong>常用应用</strong>
                  <span className="text-dim">一键启动，不用再重新找包名</span>
                </div>
                <div className="fav-quick-list">
                  {rows
                    .filter((r) => favMap.has(r.packageName))
                    .map((r) => (
                      <div key={r.packageName} className="fav-quick-item">
                        <div className={`app-avatar ${r.system ? 'sys' : ''}`}>
                          {(r.label || r.packageName).replace(/^com\./, '').charAt(0).toUpperCase()}
                        </div>
                        <div className="app-main" onClick={() => r.installed && openDetail(r.packageName)}>
                          <span className="app-name">{r.label}</span>
                          <span className="app-pkg mono">{r.packageName}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!current || !r.installed}
                          loading={busy === `${r.packageName}:launch`}
                          onClick={() => doAction(r.packageName, 'launch')}
                        >
                          启动
                        </Button>
                      </div>
                    ))}
                </div>
                {!current && (
                  <Notice tone="warn">连接设备后即可直接从这里启动常用应用。</Notice>
                )}
              </div>
            ) : (
              <Empty
                title="未选择应用"
                desc="点击左侧任意应用，查看版本、大小、权限并执行操作；点 ☆ 可固定到常用"
              />
            )
          ) : detailLoading ? (
            <div className="apps-loading">
              <Spinner size={18} />
              <span>正在读取应用信息…</span>
            </div>
          ) : (
            <div className="app-detail">
              <div className="app-detail-head">
                <div className={`app-avatar lg ${detail?.system ? 'sys' : ''}`}>
                  {(selectedLabel || selected).replace(/^com\./, '').charAt(0).toUpperCase()}
                </div>
                <div className="app-detail-title">
                  <h4>{selectedLabel || selected}</h4>
                  <span className="mono text-dim">{selected}</span>
                </div>
                <button
                  className={`app-star lg ${selectedIsFav ? 'on' : ''}`}
                  style={{ marginLeft: 'auto' }}
                  title={selectedIsFav ? '取消固定' : '固定为常用'}
                  onClick={() => void toggleFav(selected, selectedLabel)}
                >
                  {selectedIsFav ? '★ 已固定' : '☆ 固定为常用'}
                </button>
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
