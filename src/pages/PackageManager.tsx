import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Notice,
  Segmented,
  Spinner,
  Switch,
} from '@/components/ui';
import { useApp } from '@/store/app';
import { Icon } from '@/components/icons';
import { call, tryCall } from '@/lib/ipc';
import { formatBytes } from '@/lib/format';
import { installApkFiles, kindOf } from '@/lib/install';
import {
  DEFAULT_PACKAGE_DIR_NAMES,
  DEFAULT_PACKAGE_FILTERS,
  PACKAGE_KIND_LABEL,
  PACKAGE_KIND_ORDER,
  PACKAGE_UNKNOWN_VERSION_KEY,
  compareVersionsDesc,
  isEmptyFilters,
  matchesFilters,
  normalizeDirNames,
  normalizeFilters,
} from '@shared/packages';
import type {
  AppSettings,
  PackageChannel,
  PackageDirNames,
  PackageEntry,
  PackageFilters,
  PackageFormat,
  PackageKind,
  PackageOrganizeResult,
  PackageScanResult,
  PackageStructure,
} from '@shared/types';
import './packages.css';

/**
 * 安装包管理（v1.1.6）
 * ============================================================
 * 一个**按目录约定自动归类**的本地安装包仓库：
 *   <工作目录>/<版本>/<官网包|Google包>/<release|test>/xxx.apk
 *   <工作目录>/<版本>/单包/yyy.apk          （认不出官网/Google 的都归这里）
 *
 * 四条产品约定：
 *   1. **进模块就自动整理一次**（幂等，已经在该在位置的文件不动）；
 *   2. 筛选是**多标签**的：版本 × 类型 × 通道 × 格式，每档都可以不选（= 不限），
 *      且**筛选的目的就是安装** —— 每个包一行「安装」，筛出一批就一键装这一批；
 *   3. 选过的筛选条件**记在磁盘上**（settings.json），下次进来直接沿用；
 *   4. 自动识别认错的时候，可以在列表里**手工改标签**（类型 / 通道 / 版本），
 *      手工值优先，改完「立即整理」就按新标签归置。
 *
 * 页面顺序（v1.1.6 调整）：标签筛选 → 包列表 → 工作目录 → 整理规则。
 * 「刷新 / 立即整理」两个动作不在这张页里，而是挂到页内标签栏右侧
 * （由 AppsPage 提供挂载点，见下面的 actionsHost）—— 这两个键是整页的全局动作，
 * 放在仓库卡片里会被后面的列表压到看不见。
 *
 * 归类规则本身在 `shared/packages.ts`（纯函数），磁盘操作在主进程，
 * 这里只负责「展示 + 把用户的意图发下去」。
 */

/** 时间戳 → MM-DD HH:mm（安装包只看「改没改过」，精确到秒没意义） */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 手动版本文本的合法性（与主进程 sanitizeOverrideVersion 同一套口径） */
const MANUAL_VERSION_RE = /^\d+(\.\d+){0,3}$/;

interface Props {
  /**
   * 页内标签栏右侧的挂载点（AppsPage 给）。「刷新 / 立即整理」通过 portal 挂进去，
   * 拿不到挂载点时退化成卡片右上角 —— 这个组件单独用也不会丢按钮。
   */
  actionsHost?: HTMLElement | null;
}

export default function PackageManager({ actionsHost }: Props) {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  /** 安装方式沿用全局默认（和拖放安装同一个值，不另开一套） */
  const installMode = useApp((s) => s.installMode);

  const [scan, setScan] = useState<PackageScanResult | null>(null);
  const [busy, setBusy] = useState<'scan' | 'organize' | null>(null);
  /** 工作目录不可用 / 不存在时主进程给的原因（直接展示给用户） */
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<PackageFilters>({ ...DEFAULT_PACKAGE_FILTERS });
  const [dirNames, setDirNames] = useState<PackageDirNames>({ ...DEFAULT_PACKAGE_DIR_NAMES });
  const [structure, setStructure] = useState<PackageStructure>('version-first');
  const [auto, setAuto] = useState(true);

  /** 正在改标签的那一行（按文件名），null = 没有 */
  const [editName, setEditName] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ kind: PackageKind; channel: PackageChannel | ''; version: string }>({
    kind: 'official',
    channel: 'release',
    version: '',
  });
  const [savingTag, setSavingTag] = useState(false);

  /** 本组件只从 settings 初始化一次，之后以本地状态为准（否则打字会被回写覆盖） */
  const inited = useRef(false);
  /** 「进入时自动整理」只跑一次（React 严格模式下 effect 会跑两遍） */
  const autoRan = useRef(false);
  const lastRoot = useRef('');

  /* ---------------- 配置读写 ---------------- */

  const pending = useRef<Partial<AppSettings>>({});
  const saveTimer = useRef<number | null>(null);

  /**
   * 攒一下再落盘：目录名是一个字一个字敲的，每敲一下存一次会很吵。
   * 存完把主进程合并后的**完整设置**回写进 store —— store 里那份是别的页面
   * 判断「当前目录/筛选」的依据，不刷新的话下次进本模块又会读回旧值。
   */
  const queueSave = useCallback(
    (patch: Partial<AppSettings>) => {
      pending.current = { ...pending.current, ...patch };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        const p = pending.current;
        pending.current = {};
        saveTimer.current = null;
        const merged = await tryCall<AppSettings>(() => window.adbApi.setSettings(p));
        if (merged) setSettings(merged);
      }, 500);
    },
    [setSettings],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  /* ---------------- 扫描 / 整理 ---------------- */

  const refresh = useCallback(
    async (quiet = false) => {
      setBusy('scan');
      try {
        const r = await call<PackageScanResult>(() => window.adbApi.packagesScan(), { silent: true });
        setScan(r);
        setError(null);
      } catch (e) {
        setScan(null);
        setError((e as Error).message);
        if (!quiet) toast('error', '读取安装包目录失败', (e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const organize = useCallback(
    async (quiet = false) => {
      setBusy('organize');
      try {
        // 整理完的返回值里已经带了一份新扫描结果，不用再扫一趟
        const r = await call<PackageOrganizeResult>(() => window.adbApi.packagesOrganize(), {
          silent: true,
        });
        setScan(r.scan);
        setError(null);
        if (!quiet || r.moved > 0 || r.failed.length > 0) {
          const parts = [`移动 ${r.moved} 个`];
          if (r.skipped) parts.push(`跳过 ${r.skipped} 个`);
          if (r.failed.length) parts.push(`失败 ${r.failed.length} 个`);
          toast(r.failed.length ? 'warn' : 'success', '整理完成', parts.join(' · '));
        }
        if (r.failed.length) {
          toast(
            'error',
            `${r.failed.length} 个文件没能移动`,
            r.failed
              .slice(0, 3)
              .map((f) => `${f.name}：${f.error}`)
              .join('\n'),
          );
        }
        return r;
      } catch (e) {
        setScan(null);
        setError((e as Error).message);
        if (!quiet) toast('error', '整理失败', (e as Error).message);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  /* ---------------- 初始化 ---------------- */

  // 必须排在「进入时整理」那个 effect 前面：它负责把 inited 置上
  useEffect(() => {
    if (inited.current || !settings) return;
    inited.current = true;
    setDirNames(normalizeDirNames(settings.packageDirNames));
    setStructure(settings.packageStructure === 'type-first' ? 'type-first' : 'version-first');
    setAuto(settings.packageAutoOrganize !== false);
    setFilters(normalizeFilters(settings.packageFilters));
  }, [settings]);

  // 换工作目录 = 相当于重新进一次模块，自动整理放行
  useEffect(() => {
    const root = settings?.packageRootDir || '';
    if (root && root !== lastRoot.current) {
      lastRoot.current = root;
      autoRan.current = false;
    }
  }, [settings?.packageRootDir]);

  const root = settings?.packageRootDir || '';

  useEffect(() => {
    if (!settings || !root || !inited.current || autoRan.current) return;
    autoRan.current = true;
    // 取设置里的值而不是上面那个 state —— 它在同一次渲染里还是旧值
    if (settings.packageAutoOrganize !== false) {
      void organize(true);
    } else {
      void refresh(true);
    }
  }, [settings, root, organize, refresh]);

  /* ---------------- 用户操作 ---------------- */

  const pickRoot = async () => {
    try {
      const picked = await call<string | null>(() => window.adbApi.pickPackageDir(root), {
        silent: true,
      });
      if (!picked) return;
      // 主进程已经把新目录写进 settings.json，这里把最新那份读回来
      const res = await window.adbApi.getSettings();
      if (res?.ok && res.data) setSettings(res.data);
      toast('success', '工作目录已切换', picked);
      await refresh(true);
      if (settings?.packageAutoOrganize !== false) void organize(true);
    } catch (e) {
      toast('error', '选择目录失败', (e as Error).message);
    }
  };

  const openRoot = async () => {
    if (!root) return;
    if (scan && !scan.exists) {
      toast('warn', '目录还不存在', '点「立即整理」会自动创建');
      return;
    }
    const ok = await tryCall<boolean>(() => window.adbApi.openPath(root));
    if (ok === null) toast('error', '打不开目录', root);
  };

  const revealEntry = async (e: PackageEntry) => {
    try {
      await call(() => window.adbApi.revealPackage(e.absPath, true), { silent: true });
    } catch (err) {
      toast('error', '定位失败', (err as Error).message);
    }
  };

  const copyPath = async (e: PackageEntry) => {
    try {
      await navigator.clipboard.writeText(e.absPath);
      toast('success', '路径已复制', e.absPath);
    } catch {
      toast('warn', '复制失败', e.absPath);
    }
  };

  /* ---------------- 安装（这个模块存在的意义） ---------------- */

  /**
   * 装一个包 / 装一批包，统一走拖放安装那条链路。
   *
   * 不自己拼 adb 命令的理由：那条链路已经处理了「多设备在线时不猜、让用户选」
   * 以及 AAB 拆包、装后复核、进度弹窗等一整套；重复实现一遍必然漏掉某条。
   */
  const installEntries = (list: PackageEntry[]) => {
    if (!list.length) return;
    void installApkFiles(
      list.map((e) => ({ path: e.absPath, name: e.name, size: e.size, kind: kindOf(e.name) })),
      { mode: installMode },
    );
  };

  /* ---------------- 手动标签 ---------------- */

  const startEdit = (e: PackageEntry) => {
    setEditName(e.name);
    setDraft({
      kind: e.kind,
      channel: (e.channel ?? '') as PackageChannel | '',
      version: e.version ?? '',
    });
  };

  const saveTag = async (e: PackageEntry) => {
    const version = draft.version.trim().replace(/^v/i, '');
    if (version && !MANUAL_VERSION_RE.test(version)) {
      toast('warn', '版本号格式不对', '只填数字和点，例如 2.83（留空 = 未识别版本）');
      return;
    }
    setSavingTag(true);
    try {
      const r = await call<PackageScanResult>(
        () =>
          window.adbApi.setPackageTag(e.name, {
            kind: draft.kind,
            channel: draft.kind === 'single' ? '' : draft.channel || 'release',
            version,
          }),
        { silent: true },
      );
      setScan(r);
      setEditName(null);
      toast('success', '标签已保存', '点「立即整理」即可按新标签把它归置过去');
    } catch (err) {
      toast('error', '保存标签失败', (err as Error).message);
    } finally {
      setSavingTag(false);
    }
  };

  const resetTag = async (e: PackageEntry) => {
    setSavingTag(true);
    try {
      const r = await call<PackageScanResult>(() => window.adbApi.setPackageTag(e.name, null), {
        silent: true,
      });
      setScan(r);
      setEditName(null);
      toast('info', '已恢复自动识别', e.name);
    } catch (err) {
      toast('error', '恢复失败', (err as Error).message);
    } finally {
      setSavingTag(false);
    }
  };

  const clearTags = async () => {
    try {
      const r = await call<PackageScanResult>(() => window.adbApi.clearPackageTags(), {
        silent: true,
      });
      setScan(r);
      setEditName(null);
      toast('success', '已清空全部手动标签', '现在全部按文件名自动识别');
    } catch (err) {
      toast('error', '清空失败', (err as Error).message);
    }
  };

  /* ---------------- 筛选 ---------------- */

  const updateFilters = (next: PackageFilters) => {
    setFilters(next);
    queueSave({ packageFilters: next });
  };

  const toggleIn = <T extends string>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const patchDirs = (patch: Partial<PackageDirNames>) => {
    const next = { ...dirNames, ...patch };
    setDirNames(next);
    queueSave({ packageDirNames: next });
  };

  const changeStructure = (v: PackageStructure) => {
    setStructure(v);
    queueSave({ packageStructure: v });
    // 结构变了 = 全部文件都要换位置，顺手扫一次让「待归置」数量准确
    void refresh(true);
  };

  const changeAuto = (v: boolean) => {
    setAuto(v);
    queueSave({ packageAutoOrganize: v });
  };

  /* ---------------- 列表 ---------------- */

  const entries = scan?.entries ?? [];

  const versionChips = useMemo(() => {
    const counts = new Map<string, number>();
    entries.forEach((e) => {
      const k = e.version && e.version.trim() ? e.version : PACKAGE_UNKNOWN_VERSION_KEY;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    const arr = Array.from(counts.entries()).map(([k, n]) => ({
      key: k,
      label: k === PACKAGE_UNKNOWN_VERSION_KEY ? '未识别版本' : `v${k}`,
      count: n,
    }));
    arr.sort((a, b) => {
      if (a.key === PACKAGE_UNKNOWN_VERSION_KEY) return 1;
      if (b.key === PACKAGE_UNKNOWN_VERSION_KEY) return -1;
      return compareVersionsDesc(a.key, b.key);
    });
    return arr;
  }, [entries]);

  const filtered = useMemo(() => entries.filter((e) => matchesFilters(e, filters)), [entries, filters]);

  const groups = useMemo(() => {
    const map = new Map<string, PackageEntry[]>();
    filtered.forEach((e) => {
      const k = e.version && e.version.trim() ? e.version : PACKAGE_UNKNOWN_VERSION_KEY;
      const arr = map.get(k);
      if (arr) arr.push(e);
      else map.set(k, [e]);
    });
    return Array.from(map.entries()).map(([key, list]) => ({
      key,
      list,
      bytes: list.reduce((s, e) => s + e.size, 0),
    }));
  }, [filtered]);

  const noFilter = isEmptyFilters(filters);
  const stats = scan?.stats;
  const working = busy === 'organize';
  const manualCount = entries.filter((e) => e.overridden).length;

  /* ---------------- 渲染 ---------------- */

  /** 「刷新 / 立即整理」：整页的全局动作，默认挂到页内标签栏右侧 */
  const actions = (
    <span className="pkg-actions">
      <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={busy === 'scan'} data-pkg-refresh>
        刷新
      </Button>
      <Button
        size="sm"
        variant="primary"
        onClick={() => void organize()}
        loading={working}
        data-pkg-organize
      >
        立即整理
      </Button>
    </span>
  );

  return (
    <>
      {actionsHost && createPortal(actions, actionsHost)}

      {error && (
        <Notice tone="warn">
          {error}
          <div className="pkg-notice-actions">
            <Button size="sm" onClick={pickRoot}>
              选择工作目录
            </Button>
          </div>
        </Notice>
      )}

      {/* ---------------- 1. 标签筛选 ---------------- */}
      <Card
        title="标签筛选"
        subtitle={
          stats
            ? `共 ${stats.total} 个包 · ${formatBytes(stats.bytes)} · ${
                scan && scan.pending > 0 ? `${scan.pending} 个待归置` : '已全部归类'
              }`
            : '按 版本 / 类型 / 通道 筛出要装的包'
        }
        extra={actionsHost ? undefined : actions}
      >
        <div className="col">
          <div className="pkg-filters" data-pkg-filters>
            <div className="pkg-filter-row">
              <span className="pkg-filter-label">版本</span>
              {versionChips.length === 0 ? (
                <span className="text-dim">—</span>
              ) : (
                versionChips.map((v) => (
                  <button
                    key={v.key}
                    className={`pkg-chip ${filters.versions.includes(v.key) ? 'on' : ''}`}
                    data-pkg-chip="version"
                    data-pkg-value={v.key}
                    onClick={() => updateFilters({ ...filters, versions: toggleIn(filters.versions, v.key) })}
                  >
                    {v.label}
                    <em>{v.count}</em>
                  </button>
                ))
              )}
            </div>

            <div className="pkg-filter-row">
              <span className="pkg-filter-label">类型</span>
              {PACKAGE_KIND_ORDER.map((k: PackageKind) => (
                <button
                  key={k}
                  className={`pkg-chip ${filters.kinds.includes(k) ? 'on' : ''}`}
                  data-pkg-chip="kind"
                  data-pkg-value={k}
                  onClick={() => updateFilters({ ...filters, kinds: toggleIn(filters.kinds, k) })}
                >
                  {PACKAGE_KIND_LABEL[k]}
                  <em>{stats ? stats.byKind[k] : 0}</em>
                </button>
              ))}

              <span className="pkg-filter-gap" />
              <span className="pkg-filter-label">通道</span>
              {(['release', 'test'] as PackageChannel[]).map((c) => (
                <button
                  key={c}
                  className={`pkg-chip ${filters.channels.includes(c) ? 'on' : ''}`}
                  data-pkg-chip="channel"
                  data-pkg-value={c}
                  onClick={() => updateFilters({ ...filters, channels: toggleIn(filters.channels, c) })}
                >
                  {c}
                  <em>{stats ? stats.byChannel[c] : 0}</em>
                </button>
              ))}
            </div>

            <div className="pkg-filter-row">
              <span className="pkg-filter-label">格式</span>
              {(['apk', 'aab'] as PackageFormat[]).map((f) => (
                <button
                  key={f}
                  className={`pkg-chip ${filters.formats.includes(f) ? 'on' : ''}`}
                  data-pkg-chip="format"
                  data-pkg-value={f}
                  onClick={() => updateFilters({ ...filters, formats: toggleIn(filters.formats, f) })}
                >
                  {f}
                  <em>{stats ? stats.byFormat[f] : 0}</em>
                </button>
              ))}

              <Input
                className="pkg-filter-kw"
                placeholder="文件名关键字…"
                value={filters.keyword}
                data-pkg-keyword
                onChange={(e) => updateFilters({ ...filters, keyword: e.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={noFilter}
                onClick={() => updateFilters({ ...DEFAULT_PACKAGE_FILTERS })}
                data-pkg-clear
              >
                清除筛选
              </Button>
            </div>
          </div>

          {scan && scan.exists && (
            <p className="text-dim pkg-hint">
              筛选条件会自动记住，下次进来沿用；共 {entries.length} 个包，当前显示 {filtered.length} 个
              {scan.stats.ignored > 0 ? `（另有 ${scan.stats.ignored} 个非 apk/aab 文件不参与整理）` : ''}
            </p>
          )}
        </div>
      </Card>

      {/* ---------------- 2. 包列表 ---------------- */}
      <Card
        title="包列表"
        subtitle={
          working
            ? '正在整理…'
            : groups.length
              ? `${groups.length} 个版本 · ${filtered.length} 个包 · 点行内「安装」直接装到设备`
              : '还没有可显示的包'
        }
        padding={false}
        className="pkg-list-card"
        extra={
          filtered.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={() => installEntries(filtered)} data-pkg-install-all>
              安装筛出的 {filtered.length} 个
            </Button>
          ) : undefined
        }
      >
        {busy === 'scan' && entries.length === 0 ? (
          <div className="pkg-loading">
            <Spinner size={18} />
            <span>正在扫描工作目录…</span>
          </div>
        ) : error ? (
          /* 目录不合法（盘符根、空路径…）时别显示「点整理会自动建目录」，那条路走不通 */
          <Empty
            title="工作目录不可用"
            desc={error}
            action={
              <Button size="sm" variant="primary" onClick={pickRoot}>
                选择工作目录
              </Button>
            }
          />
        ) : !scan || !scan.exists ? (
          <Empty
            title={scan ? '工作目录还不存在' : '还没有读取目录'}
            desc="点右上角「立即整理」会自动建好目录，并按版本 / 类型 / 通道 建好分类"
            action={
              <Button size="sm" variant="primary" onClick={() => void organize()}>
                创建并整理
              </Button>
            }
          />
        ) : entries.length === 0 ? (
          <Empty
            title="目录里还没有安装包"
            desc="把 .apk / .aab 拷进这个目录，再点「立即整理」，会自动按版本与通道归类"
            action={
              <Button size="sm" onClick={openRoot}>
                打开目录
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <Empty
            title="没有命中筛选条件的包"
            desc="换个版本 / 类型 / 通道，或点「清除筛选」"
            action={
              <Button size="sm" onClick={() => updateFilters({ ...DEFAULT_PACKAGE_FILTERS })}>
                清除筛选
              </Button>
            }
          />
        ) : (
          <div className="pkg-list" data-pkg-list>
            {groups.map((g) => (
              <div className="pkg-group" key={g.key}>
                <div className="pkg-group-head">
                  <strong>{g.key === PACKAGE_UNKNOWN_VERSION_KEY ? '未识别版本' : `v${g.key}`}</strong>
                  <span className="text-dim">
                    {g.list.length} 个 · {formatBytes(g.bytes)}
                  </span>
                </div>
                {g.list.map((e) => (
                  <Fragment key={e.absPath}>
                    <div className={`pkg-row ${e.organized ? '' : 'pending'}`} data-pkg-name={e.name}>
                      <div className="pkg-row-main">
                        <span className="pkg-row-name" title={e.name}>
                          {e.name}
                        </span>
                        <span className="pkg-row-meta mono" title={e.relPath}>
                          {e.targetDir}/
                        </span>
                      </div>
                      <div className="pkg-row-tags">
                        {e.overridden && <Badge tone="accent">手动</Badge>}
                        <Badge tone={e.kind === 'official' ? 'accent' : 'default'}>
                          {PACKAGE_KIND_LABEL[e.kind]}
                        </Badge>
                        {e.channel && <Badge tone="default">{e.channel}</Badge>}
                        <Badge tone="default">{e.format}</Badge>
                        {e.build && <span className="text-dim">build {e.build}</span>}
                        {e.versionFrom === 'folder' && <span className="text-dim">版本取自目录</span>}
                        {e.versionFrom === 'manual' && <span className="text-dim">版本手动填</span>}
                        <span className="text-dim">{formatBytes(e.size)}</span>
                        <span className="text-dim">{fmtDate(e.mtimeMs)}</span>
                        {!e.organized && <Badge tone="warn">待归置</Badge>}
                      </div>
                      <div className="pkg-row-ops">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => installEntries([e])}
                          data-pkg-install={e.name}
                        >
                          安装
                        </Button>
                        <button
                          className={`pkg-op ${editName === e.name ? 'on' : ''}`}
                          title="手动指定类型 / 通道 / 版本"
                          data-pkg-tag={e.name}
                          onClick={() => (editName === e.name ? setEditName(null) : startEdit(e))}
                        >
                          改标签
                        </button>
                        <button className="pkg-op" onClick={() => void revealEntry(e)} title="在资源管理器中定位">
                          <span className="pkg-op-icon">{Icon.folder}</span>
                          定位
                        </button>
                        <button className="pkg-op" onClick={() => void copyPath(e)} title="复制完整路径">
                          复制路径
                        </button>
                      </div>
                    </div>

                    {editName === e.name && (
                      <div className="pkg-row-edit" data-pkg-editor>
                        <div className="pkg-edit-line">
                          <span className="pkg-filter-label">类型</span>
                          {PACKAGE_KIND_ORDER.map((k) => (
                            <button
                              key={k}
                              className={`pkg-chip ${draft.kind === k ? 'on' : ''}`}
                              data-pkg-edit="kind"
                              data-pkg-value={k}
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  kind: k,
                                  channel: k === 'single' ? '' : d.channel || 'release',
                                }))
                              }
                            >
                              {PACKAGE_KIND_LABEL[k]}
                            </button>
                          ))}

                          <span className="pkg-filter-gap" />
                          <span className="pkg-filter-label">通道</span>
                          {(['release', 'test'] as PackageChannel[]).map((c) => (
                            <button
                              key={c}
                              className={`pkg-chip ${draft.channel === c ? 'on' : ''}`}
                              data-pkg-edit="channel"
                              data-pkg-value={c}
                              disabled={draft.kind === 'single'}
                              onClick={() => setDraft((d) => ({ ...d, channel: c }))}
                            >
                              {c}
                            </button>
                          ))}
                        </div>

                        <div className="pkg-edit-line">
                          <span className="pkg-filter-label">版本</span>
                          <Input
                            className="pkg-edit-ver"
                            value={draft.version}
                            placeholder="留空 = 未识别版本"
                            data-pkg-edit-version
                            onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}
                          />
                          <span className="text-dim">只填数字和点（2.83）；留空表示判不出版本</span>
                        </div>

                        <div className="pkg-edit-line">
                          <Button size="sm" variant="primary" onClick={() => void saveTag(e)} loading={savingTag}>
                            保存标签
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditName(null)}>
                            取消
                          </Button>
                          {e.overridden && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void resetTag(e)}
                              data-pkg-tag-reset={e.name}
                            >
                              恢复自动识别
                            </Button>
                          )}
                          <span className="text-dim">保存后点「立即整理」就会按新标签把它搬过去</span>
                        </div>
                      </div>
                    )}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---------------- 3. 工作目录 ---------------- */}
      <Card title="工作目录" subtitle="整理与浏览都只看这一个目录；换目录等于重新进一次模块">
        <div className="pkg-root">
          <Field label="当前工作目录">
            <Input value={root} readOnly placeholder="还没有设置工作目录" data-pkg-root />
          </Field>
          <div className="pkg-root-ops">
            <Button size="sm" onClick={pickRoot} data-pkg-pick>
              选择目录
            </Button>
            <Button size="sm" variant="ghost" onClick={openRoot} disabled={!root}>
              打开目录
            </Button>
          </div>
        </div>
      </Card>

      {/* ---------------- 4. 整理规则 ---------------- */}
      <Card
        title="整理规则"
        subtitle="目录名与结构都可以改；改完点「立即整理」按新规则归置"
        collapsible
        defaultOpen={false}
      >
        <div className="col">
          <div className="pkg-dir-grid">
            <Field label="官网包目录">
              <Input value={dirNames.official} onChange={(e) => patchDirs({ official: e.target.value })} />
            </Field>
            <Field label="Google 包目录">
              <Input value={dirNames.google} onChange={(e) => patchDirs({ google: e.target.value })} />
            </Field>
            <Field label="单包目录">
              <Input value={dirNames.single} onChange={(e) => patchDirs({ single: e.target.value })} />
            </Field>
            <Field label="release 目录">
              <Input value={dirNames.release} onChange={(e) => patchDirs({ release: e.target.value })} />
            </Field>
            <Field label="test 目录">
              <Input value={dirNames.test} onChange={(e) => patchDirs({ test: e.target.value })} />
            </Field>
            <Field label="未识别版本目录">
              <Input
                value={dirNames.unknownVersion}
                onChange={(e) => patchDirs({ unknownVersion: e.target.value })}
              />
            </Field>
          </div>

          <div className="pkg-rule-row">
            <span className="res-label">目录结构</span>
            <Segmented
              size="sm"
              value={structure}
              onChange={changeStructure}
              options={[
                { value: 'version-first', label: '版本 / 类型 / 通道' },
                { value: 'type-first', label: '类型 / 版本 / 通道' },
              ]}
            />
            <span className="text-dim">例如 {structure === 'version-first' ? '2.84/官网包/release' : '官网包/2.84/release'}</span>
          </div>

          <div className="pkg-rule-row">
            <Switch checked={auto} onChange={changeAuto} label="进入模块时自动整理一次" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = { ...DEFAULT_PACKAGE_DIR_NAMES };
                setDirNames(next);
                queueSave({ packageDirNames: next });
              }}
            >
              恢复默认目录名
            </Button>
            {manualCount > 0 && (
              <Button size="sm" variant="ghost" onClick={() => void clearTags()} data-pkg-clear-tags>
                清空手动标签（{manualCount} 个）
              </Button>
            )}
          </div>

          <Notice tone="accent">
            识别规则：文件名含 <b>GW</b> → 官网包，含 <b>dmno / google</b> → Google 包；
            两样都没命中就一律归「单包」，不再按扩展名猜。版本取文件名里的 <b>V2.83</b> 这类写法，
            取不到就往上找目录名，仍没有则进「未识别版本」。判错了在包列表里点「改标签」手工钉死 ——
            手工值优先，标着「手动」的行点「恢复自动识别」可撤销。
            同名文件不会互相覆盖：一样大的按同一个包跳过，不一样大的自动加 (2) 后缀。
            当前筛选条件：{noFilter ? '不限' : countersText(filters)}
          </Notice>
        </div>
      </Card>
    </>
  );
}

/** 把筛选条件说成人话（给规则卡片的说明用） */
function countersText(f: PackageFilters): string {
  const parts: string[] = [];
  if (f.versions.length) parts.push(`版本 ${f.versions.map((v) => (v === PACKAGE_UNKNOWN_VERSION_KEY ? '未识别' : `v${v}`)).join('、')}`);
  if (f.kinds.length) parts.push(`类型 ${f.kinds.map((k) => PACKAGE_KIND_LABEL[k]).join('、')}`);
  if (f.channels.length) parts.push(`通道 ${f.channels.join('、')}`);
  if (f.formats.length) parts.push(`格式 ${f.formats.join('、')}`);
  if (f.keyword.trim()) parts.push(`关键字「${f.keyword.trim()}」`);
  return parts.join(' · ') || '不限';
}
