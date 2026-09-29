import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Button,
  Field,
  Input,
  Segmented,
  Switch,
  Progress,
  Notice,
  Badge,
  Spinner,
} from '@/components/ui';
import { useApp } from '@/store/app';
import { call } from '@/lib/ipc';
import { IPC } from '@shared/types';
import type {
  EnvCheckResult,
  UpdateCheckResult,
  UpdateContext,
  UpdateDownloadProgress,
  UpdateInfo,
} from '@shared/types';

/**
 * 每个版本的一句话亮点，key 为 package.json 的完整版本号。
 * ⚠️ 发版改 package.json version 时，这里同步加一条（漏加会回退到默认文案）。
 */
const VERSION_NOTES: Record<string, string> = {
  '1.1.0':
    '新增：\n' +
    '· 连点器增加「屏幕预览图」：设备画面直接显示在页面上，点预览图任意位置即可把该点坐标填进步骤（为后续在预览图上录制操作打底）。\n' +
    '· 拖拽安装包支持「安装到全部设备」：可多选设备一次装完，安装方式整体选择（清洁或覆盖，不支持逐台各选）。\n' +
    '· 运行日志改为按日期保存到本地文件，只保留最近 24 小时。\n' +
    '· 应用图标换成更扁平简约的新样式。\n' +
    '修复：\n' +
    '· 部分手机（OPPO / 一加 / realme）点「清数据」报权限错误 —— 现在会直接告诉你到「开发者选项 → 禁止权限监控」里打开开关。\n' +
    '· 连点器步骤较多时列表会互相堆叠、点不动，现已改为正常滚动。\n' +
    '· 手机端录制点开始后无法停止、录完也拿不到脚本。\n' +
    '调整：\n' +
    '· 设置页去掉「更新源」入口（改为随程序配置维护）；侧边导航去掉「运行日志」，入口移入设置页。',
  '1.0.33':
    '新增：手机端录制改为电脑全程控制 —— 开始、暂停、结束都在电脑上操作，手机上不需要再点任何东西，录的时候可以随时切到其它应用。\n' +
    '修复：录制出来的坐标整体偏移（只剩正确位置的四成）；录制时间轴全部变成 0；采集端控制端口起不来导致连不上。',
  '1.0.32':
    '新增：自动连点器 —— 录下手机上的操作、编辑成脚本后按倍速回放，支持每步随机偏移以模拟真实点击；同时提供配套的手机端屏幕录制采集 App，随程序内置、需要时自动安装。',
  '1.0.31':
    '新增：在线更新支持跨版本 —— 中间漏更了几版也能用小包升上来，实在对不上基准时会自动改走完整资源包。\n' +
    '修复：新版本需要新增资源文件时，旧版本会把「目录不存在」误判成不可写，从而拒收整个更新包。',
  '1.0.30':
    '修复：点了「启动弱网模拟」没反应（设备侧 VPN 通道刚建好就被误判成已停止并关掉，表现为没开出来或一闪即逝）；弱网正在生效时误报「尚未授权 VPN」。',
  '1.0.29':
    '新增：弱网模拟改用设备侧 VPN 实现，在 IP 层接管全部流量，不理会系统代理的游戏与自研网络库同样被覆盖，也不再修改系统设置。\n' +
    '修复：从更早版本升级时会拒收更新包（新增资源文件落在旧版本不存在的目录里）。',
  '1.0.28':
    '新增：拖入安装包时的设备弹窗里可以直接改安装方式（覆盖 / 清洁 / 全新），且只影响这一次。\n' +
    '修复：AAB 走多设备安装时，界面上选的拆包签名被丢掉。',
  '1.0.27':
    '新增：Logcat 导出目录固定为 D:\\adblogs，按「机型 + 序列号 / 日期」自动分层，导完自动打开目录。\n' +
    '修复：同一秒内连续导出时，后一份会覆盖前一份。',
  '1.0.26':
    '新增：常用工具页增加「Logcat 导出」—— 不用先开抓取，直接把设备已有的日志一次性导出，支持级别 / TAG / 关键字过滤与三个常用预设。',
  '1.0.25': '调整：全应用图标统一为一套细线图标，替换掉原先的 emoji。功能无变化。',
  '1.0.24':
    '新增：设备列表每台的快捷动作（清数据 / 桌面重进 / 杀进程重进等 12 种），可改名、排序、设执行前确认。',
  '1.0.23': '新增：在线更新的默认更新源填成真实地址，装上后无需任何设置，启动时自动静默检查。',
  '1.0.22': '新增：应用内增量更新接入「更新源」，填一个网址即可在线检查、下载、校验并更新。',
  '1.0.21': '修复：拖放安装时正式签名不生效（退回调试签名，导致三方登录报 Invalid key hash）。',
  '1.0.20': '新增：「导出通用 APK」—— 不需要设备在线，把 AAB 转成一个所有机型都能装的通用包。',
  '1.0.19':
    '新增：AAB 的拆包与安装分开，可「仅拆包并另存为 .apks」，之后直接拖入安装、不再重复拆包。',
  '1.0.18':
    '新增：AAB 签名方式可选（随包调试密钥 / 自定义正式密钥），并可一键计算各平台需要的 key hash。\n' +
    '修复：用本工具装完 AAB 后三方登录报 Invalid key hash。',
  '1.0.17': '新增：支持安装 AAB（用 bundletool 按目标设备拆包后安装）。',
  '1.0.16': '本版无功能改动，为应用内增量更新的首次完整真机验证。',
  '1.0.15': '修复：应用内更新在「启动新版本」这一步报错并自动还原（表现为更新一趟、版本没变）。',
  '1.0.13': '修复：应用内更新启动了却什么都没发生（更新助手被主程序一起带走了）。',
  '1.0.12': '本版无功能改动，为应用内增量更新的真机验证。',
  '1.0.11':
    '修复：应用内增量更新在真机上完全走不通（asar 解压失败、Electron 版本校验不符、助手脚本路径少算一层）。',
  '1.0.7': '新增：应用内增量更新 —— 用一个小更新包替换文件并重启，新版本启动异常时自动回滚。',
  '1.0.6': '修复：多台设备同时在线时装错机器（默认选中列表第一台，常常是模拟器）。',
  '1.0.5':
    '新增：安装方式选择（覆盖 / 清洁 / 全新），装完按包名在设备上复核。\n' +
    '修复：界面显示安装成功、手机上却找不到应用。',
  '1.0.4': '新增：拖放安装 APK，安装过程有实时进度弹窗。',
  '1.0.3': '新增：设备行的「快速投屏」按钮，不用切到投屏页。',
  '1.0.2': '新增：常用应用收藏；免 Root 弱网模拟（丢包 / 延迟 / 限速）。\n修复：弱网代理残留导致设备断网。',
  '1.0.1': '新增：应用管理页常用应用收藏；弱网模拟改为免 Root 代理方案。',
  '1.0.0': '首个版本：设备管理、投屏、截图录屏、分辨率调节、Monkey、APK 安装、文件传输、命令终端、日志导出。',
};

export default function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const navigate = useNavigate();
  const [logDir, setLogDir] = useState('');

  /* 运行日志目录：只用于展示与「打开文件夹」（日志按日期落盘、只保留 24 小时） */
  useEffect(() => {
    void window.adbApi.logDir().then((r) => {
      if (r.ok && r.data) setLogDir(String(r.data));
    });
  }, []);
  const theme = useApp((s) => s.theme);
  const applyTheme = useApp((s) => s.applyTheme);
  const toast = useApp((s) => s.toast);

  const [env, setEnv] = useState<EnvCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const checkEnv = async () => {
    setChecking(true);
    try {
      const r = await call<EnvCheckResult>(() => window.adbApi.checkEnv(), { silent: true });
      setEnv(r);
      if (r?.allOk) toast('success', '环境自检通过，所有组件就绪');
      else toast('warn', '部分组件缺失，请查看下方详情');
    } catch (e) {
      toast('error', '自检失败', (e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkEnv();
  }, []);

  const update = async (patch: Partial<NonNullable<typeof settings>>) => {
    const r = await call<any>(() => window.adbApi.setSettings(patch), { silent: true });
    if (r) {
      setSettings(r);
      toast('success', '设置已保存');
    }
  };

  const changeTheme = (t: 'light' | 'dark') => {
    applyTheme(t);
    update({ theme: t });
  };

  const pickDir = async (key: 'screenshotDir' | 'recordDir' | 'pullDir') => {
    const dir = await call<string | null>(() => window.adbApi.pickDir(), { silent: true });
    if (dir) update({ [key]: dir });
  };

  if (!settings) {
    return (
      <Card title="设置">
        <Spinner size={20} />
      </Card>
    );
  }

  return (
    <>
      <Card title="外观">
        <Field label="主题模式" hint="影响整个界面的配色">
          <Segmented
            value={theme}
            onChange={(v) => changeTheme(v as 'light' | 'dark')}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </Field>
      </Card>

      <Card title="默认保存目录" subtitle="截图、录屏、日志导出与文件拉取的默认位置">
        <div className="col">
          <DirRow
            label="截图保存目录"
            value={settings.screenshotDir}
            onPick={() => pickDir('screenshotDir')}
          />
          <DirRow
            label="录屏保存目录"
            value={settings.recordDir}
            onPick={() => pickDir('recordDir')}
          />
          <DirRow
            label="文件拉取目录"
            value={settings.pullDir}
            onPick={() => pickDir('pullDir')}
          />
        </div>
      </Card>

      <Card
        title="环境自检"
        subtitle="检查 adb、scrcpy 等组件是否完整"
        extra={
          <Button size="sm" variant="default" onClick={checkEnv} loading={checking}>
            重新检测
          </Button>
        }
      >
        {!env ? (
          <div className="row">
            <Spinner />
            <span className="text-dim">正在检测…</span>
          </div>
        ) : (
          <div className="col">
            <div className="env-list">
              {env.items.map((it) => (
                <div key={it.name} className="env-row">
                  <span className={`env-dot ${it.ok ? 'ok' : 'bad'}`} />
                  <span className="env-name mono">{it.name}</span>
                  <span className="env-ver text-dim">
                    {it.version ? `v${it.version}` : it.ok ? '已就绪' : it.message || '缺失'}
                  </span>
                  {it.ok ? (
                    <Badge tone="success">正常</Badge>
                  ) : (
                    <Badge tone="danger">异常</Badge>
                  )}
                </div>
              ))}
            </div>

            {!env.allOk && (
              <Notice tone="danger">
                部分组件缺失会导致对应功能不可用。请确认程序的 <span className="mono">bin</span>{' '}
                目录中包含完整的 adb 与 scrcpy 文件。
              </Notice>
            )}
          </div>
        )}
      </Card>

      <Card title="关于">
        <div className="kv-list">
          <About k="程序名称" v="ADB 桌面助手" />
          <About k="版本" v={`v${__APP_VERSION__}`} />
          <About k="UI 技术栈" v="Electron + React 18 + TypeScript" />
          <About k="投屏引擎" v="scrcpy 3.1" />
          <About k="设备通信" v="Android Platform-Tools (adb)" />
        </div>
        <Notice tone="accent">
          {VERSION_NOTES[__APP_VERSION__] ??
            '更多高级功能将在后续版本加入。'}
        </Notice>
      </Card>

      <UpdatePanel />

      <Card title="运行日志" subtitle="操作记录按日期存成本地文件，只保留最近 24 小时">
        <div className="col">
          <div className="kv-list">
            <About k="存放位置" v={logDir || '读取中…'} />
            <About k="保留时长" v="24 小时（启动时自动清理过期日志）" />
          </div>
          <div className="row">
            <Button variant="default" onClick={() => navigate('/logs')}>
              查看运行日志
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (logDir) void window.adbApi.openPath(logDir);
              }}
            >
              打开日志文件夹
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

/**
 * 软件更新面板。
 *
 * 更新这件事的代价很高（装坏了就打不开），所以这里的原则是「拿不准就不做」：
 * 任何一项校验不过，都只提示改用完整安装包，绝不硬来。校验在主进程做
 * （electron/services/update-core.ts），这里只负责展示与确认。
 *
 * v1.0.22 起多了「在线更新」这条入口（检查更新 → 下载 → 复用同一套校验与替换）。
 * 两条入口的关系要摆清楚：
 *   · 在线更新是**主路径**，但它依赖服务器 —— 服务器没就绪时「更新源未配置」是正常状态；
 *   · 「选择更新包…」是**兜底路径**，断网、内网隔离、临时内测包全靠它，永远保留。
 */
const KIND_LABEL: Record<string, string> = {
  asar: '安装版（增量更新）',
  portable: '便携版（整包替换）',
  dev: '开发模式（未打包）',
};

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * 检查更新的六种状态。注意「未配置」不是错误 —— 服务器还没上线时它才是常态，
 * 界面按灰字提示处理，不弹错、不飘红。
 */
type CheckState = 'idle' | 'checking' | 'unconfigured' | 'error' | 'latest' | 'available';

function UpdatePanel() {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const setUpdateAvailable = useApp((s) => s.setUpdateAvailable);

  const [ctx, setCtx] = useState<UpdateContext | null>(null);
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<'' | 'prepare' | 'download' | 'go'>('');
  const [confirming, setConfirming] = useState<null | 'apply' | 'rollback'>(null);
  const [dl, setDl] = useState<UpdateDownloadProgress | null>(null);

  const refresh = async () => {
    const r = await call<UpdateContext>(() => window.adbApi.updateContext(), { silent: true });
    setCtx(r ?? null);
  };

  useEffect(() => {
    void refresh();
    /*
     * 进页面先拿一次结果：主进程有 5 分钟缓存，启动时的静默自检若已跑过就立即返回；
     * 没缓存也只是发一次请求（更新源没配时主进程直接返回，不发网络请求）。
     * 这一次 silent —— 失败原因就摆在面板里，不用弹窗再打扰一遍。
     */
    void runCheck(false, true);

    // 下载进度（主进程推送）
    const off = window.adbApi.on(IPC.PUSH_UPDATE_DOWNLOAD, (p: UpdateDownloadProgress) => setDl(p));
    return () => off();
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async (force: boolean, silent = false) => {
    setChecking(true);
    if (!silent) setConfirming(null);
    try {
      const r = await window.adbApi.checkUpdate(force);
      const res = (r?.data ?? null) as UpdateCheckResult | null;
      setCheck(res);
      if (!res) {
        if (!silent) toast('warn', '检查更新失败', r?.error);
        return;
      }
      // 侧栏红点跟着结果走
      setUpdateAvailable(!!(res.ok && res.hasUpdate));
      /*
       * 主进程会把这次检查时间写进设置（lastCheckAt），但渲染层的 settings 是启动时
       * 读的那一份副本 —— 不同步的话界面上「最近检查」会一直停在旧值。
       */
      void window.adbApi.getSettings().then((s2) => {
        if (s2?.ok && s2.data) setSettings(s2.data);
      });
      if (silent) return;
      if (!res.configured) toast('info', '还没有配置更新源', res.reason);
      else if (!res.ok) toast('warn', '检查更新失败', res.reason);
      else if (res.hasUpdate) toast('success', `发现新版本 v${res.latest?.version ?? ''}`, res.reason);
      else toast('success', '已是最新版本', `当前 v${res.currentVersion}`);
    } finally {
      setChecking(false);
    }
  };

  /** 在线下载（下载完的校验与替换，跟「选择更新包…」走同一条链路） */
  const download = async () => {
    const pkg = check?.latest?.pkg;
    if (!pkg) return;
    setBusy('download');
    setDl(null);
    setConfirming(null);
    try {
      const r = await window.adbApi.downloadUpdate(pkg.url, pkg.sha256);
      if (!r?.ok) {
        toast('error', '下载更新包失败', r?.error);
        return;
      }
      const res = r.data as UpdateInfo;
      setInfo(res);
      if (res.ok) {
        toast(
          'success',
          `更新包已就绪：v${ctx?.version} → v${res.manifest?.version}`,
          res.warning,
        );
      } else {
        toast('warn', '下载到的更新包不能用', res.reason);
      }
    } catch (e) {
      toast('error', '下载更新包失败', (e as Error).message);
    } finally {
      setBusy('');
      setDl(null);
    }
  };

  const cancelDownload = async () => {
    await window.adbApi.cancelUpdateDownload();
    toast('info', '已取消下载');
  };

  const pick = async () => {
    const files = await call<string[]>(
      () => window.adbApi.pickFiles(false, [{ name: '小更新包', extensions: ['zip'] }]),
      { silent: true },
    );
    if (!files?.[0]) return;

    setBusy('prepare');
    setConfirming(null);
    try {
      const r = await call<UpdateInfo>(() => window.adbApi.prepareUpdate(files[0]), { silent: true });
      setInfo(r ?? null);
      if (r?.ok) {
        toast('success', `更新包可用：v${ctx?.version} → v${r.manifest?.version}`, r.warning);
      } else {
        toast('warn', '这个更新包不能用', r?.reason);
      }
    } finally {
      setBusy('');
    }
  };

  const doApply = async () => {
    setConfirming(null);
    setBusy('go');
    try {
      const r = await window.adbApi.applyUpdate();
      if (!r.ok) {
        toast('error', '无法开始更新', r.error);
        setBusy('');
      } else {
        toast('info', '更新助手已启动', '程序即将退出并替换文件，随后自动重启');
      }
    } catch (e) {
      toast('error', '无法开始更新', (e as Error).message);
      setBusy('');
    }
  };

  const doRollback = async () => {
    setConfirming(null);
    setBusy('go');
    try {
      const r = await window.adbApi.rollbackUpdate();
      if (!r.ok) {
        toast('error', '无法回滚', r.error);
        setBusy('');
      } else {
        toast('info', '正在回滚', '程序即将退出并还原上一版本，随后自动重启');
      }
    } catch (e) {
      toast('error', '无法回滚', (e as Error).message);
      setBusy('');
    }
  };

  const busyNow = busy !== '';

  const checkState: CheckState = checking
    ? 'checking'
    : !check
      ? 'idle'
      : !check.configured
        ? 'unconfigured'
        : !check.ok
          ? 'error'
          : check.hasUpdate
            ? 'available'
            : 'latest';

  return (
    <Card
      title="软件更新"
      subtitle="小更新不用重装整个安装包：选择小更新包，程序退出后自动替换文件并重启"
      extra={
        <Button
          size="sm"
          variant="ghost"
          data-update-open-dir="1"
          onClick={() => window.adbApi.openUpdateDir()}
        >
          更新目录
        </Button>
      }
    >
      {!ctx ? (
        <div className="row">
          <Spinner />
          <span className="text-dim">正在读取更新环境…</span>
        </div>
      ) : (
        <div
          className="col"
          data-update-panel="1"
          data-update-kind={ctx.kind}
          /* 检查状态也挂在外层：验收脚本按 [data-update-panel][data-update-check=...] 直接取 */
          data-update-check={checkState}
        >
          <div className="kv-list">
            <About k="当前版本" v={`v${ctx.version}`} />
            <About k="程序形态" v={KIND_LABEL[ctx.kind] ?? ctx.kind} />
            <About
              k="更新源"
              v={check?.sourceDesc ?? (String(settings?.updateBaseUrl || '') ? '读取中…' : '未配置')}
            />
            <About k="最近检查" v={check?.checkedAt || settings?.lastCheckAt || '尚未检查'} />
            <About k="运行时" v={`Electron ${ctx.electronVersion || '未知'}`} />
            {/* 运行库指纹：更新包被「运行库不一致」拒掉时，拿它跟包里记录的一对就知道差在哪 */}
            <About k="运行库指纹" v={ctx.runtimeHash ? `${ctx.runtimeHash.slice(0, 16)}…` : '—'} />
          </div>

          {/* ---------------- 在线检查结果（六态，见 CheckState 注释） ---------------- */}
          <div className="col">
            {checkState === 'checking' && (
              <div className="row">
                <Spinner />
                <span className="text-dim">正在检查更新…</span>
              </div>
            )}

            {checkState === 'idle' && (
              <div className="text-dim update-note">正在读取更新环境…</div>
            )}

            {/* 未配置：服务器没就绪时的**正常**状态，灰字一行，不飘红不弹错 */}
            {checkState === 'unconfigured' && (
              <div className="text-dim update-note" data-update-unconfigured="1">
                {check?.reason ?? '还没有配置更新源地址。'}
              </div>
            )}

            {checkState === 'error' && (
              <div className="text-dim update-note" data-update-error="1">
                检查更新失败：{check?.reason}
                {check?.sourceDesc ? `（${check.sourceDesc}）` : ''}
              </div>
            )}

            {checkState === 'latest' && (
              <div className="text-dim update-note" data-update-latest="1">
                已是最新版本 · 当前 v{check?.currentVersion}
              </div>
            )}

            {checkState === 'available' && check?.latest && (
              <div className="update-ready" data-update-available="1">
                <div className="update-ready-head">
                  <Badge tone="success">新版本</Badge>
                  <span className="update-ver">
                    v{check.currentVersion} → <b>v{check.latest.version}</b>
                  </span>
                  {check.latest.pkg?.size ? (
                    <span className="text-dim">{fmtSize(check.latest.pkg.size)}</span>
                  ) : null}
                  {check.latest.critical ? <Badge tone="warn">重要更新</Badge> : null}
                </div>

                {check.latest.publishedAt ? (
                  <div className="text-dim update-note">发布时间 {check.latest.publishedAt}</div>
                ) : null}

                {/* 跨版本：这张清单里没有适配本机运行库的差分小包，自动改走了完整资源包 */}
                {check.latest.pkgForm === 'full' ? (
                  <div className="text-dim update-note" data-update-full="1">
                    本机版本与最新版跨度较大，本次将下载完整资源包（含全部随包资源），一次升到位。
                  </div>
                ) : null}

                {check.latest.notes ? (
                  <div className="update-notes">{check.latest.notes}</div>
                ) : null}

                {/* 有新版本但没提供本机形态的包（例如便携版只发了安装版增量包） */}
                {!check.latest.pkg && <Notice tone="warn">{check.reason}</Notice>}

                {busy === 'download' && (
                  <div className="col" data-update-progress="1">
                    <Progress value={dl?.percent ?? 0} />
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="text-dim">
                        {dl?.phase === 'verify'
                          ? '正在校验下载内容…'
                          : dl
                            ? `正在下载 ${fmtSize(dl.received)}${
                                dl.total ? ` / ${fmtSize(dl.total)}` : ''
                              }（${dl.percent}%）`
                            : '正在连接更新源…'}
                      </span>
                      <Button variant="ghost" size="sm" onClick={cancelDownload}>
                        取消下载
                      </Button>
                    </div>
                    <div className="text-dim update-note">
                      下载完成后会自动走一遍与本地包完全相同的校验，通过后才会出现「立即更新并重启」。
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {!ctx.canUpdate && (
            <Notice tone="warn">
              当前不支持应用内更新：{ctx.disabledReason}。
              {ctx.kind === 'dev' ? '' : '请直接使用完整安装包。'}
            </Notice>
          )}

          {info && !info.ok && (
            <Notice tone="danger">
              <b>这个更新包不能用：</b>
              {info.reason}
            </Notice>
          )}

          {info?.ok && info.manifest && (
            <div className="update-ready" data-update-ready="1">
              <div className="update-ready-head">
                <Badge tone="success">已就绪</Badge>
                <span className="update-ver">
                  v{ctx.version} → <b>v{info.manifest.version}</b>
                </span>
                <span className="text-dim">
                  {info.zipSize ? `${(info.zipSize / 1024).toFixed(0)} KB` : ''}
                  {info.fileCount ? ` · ${info.fileCount} 个文件` : ''}
                </span>
              </div>
              <div className="text-dim update-note">
                {info.warning ? `${info.warning} ` : ''}
                开始后程序会自动退出，由外部助手替换文件，然后自动重启。
              </div>
            </div>
          )}

          {confirming === 'apply' && (
            <Notice tone="danger">
              确定现在更新到 v{info?.manifest?.version} 吗？
              <b>程序会立即退出</b>，替换完文件后自动重启。更新前的版本会保留一份备份。
              <div className="row" style={{ marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={doApply}>
                  确认更新并重启
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  再想想
                </Button>
              </div>
            </Notice>
          )}

          {confirming === 'rollback' && (
            <Notice tone="danger">
              确定回滚到 <b>v{ctx.backupVersion}</b> 吗？
              <b>程序会立即退出</b>，还原成更新前的版本后重启。
              <div className="row" style={{ marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={doRollback}>
                  确认回滚并重启
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  再想想
                </Button>
              </div>
            </Notice>
          )}

          <div className="row">
            <Button
              variant="default"
              onClick={() => runCheck(true)}
              loading={checking}
              /* 检查更新是只读操作：即使当前形态不支持应用内更新（开发模式等），也允许点 */
              disabled={busyNow}
              data-update-check-btn="1"
            >
              检查更新
            </Button>
            {checkState === 'available' &&
              check?.latest?.pkg &&
              !info?.ok &&
              confirming !== 'apply' && (
                <Button
                  variant="primary"
                  onClick={download}
                  loading={busy === 'download'}
                  disabled={busyNow}
                  data-update-download="1"
                >
                  下载并更新
                </Button>
              )}
            {info?.ok && confirming !== 'apply' && (
              <Button
                variant="primary"
                onClick={() => setConfirming('apply')}
                disabled={busyNow}
              >
                立即更新并重启
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={pick}
              loading={busy === 'prepare'}
              disabled={!ctx.canUpdate || busyNow}
              data-update-pick="1"
            >
              选择更新包…
            </Button>
            {ctx.hasBackup && confirming !== 'rollback' && (
              <Button
                variant="ghost"
                onClick={() => setConfirming('rollback')}
                disabled={busyNow}
                title="把程序还原成上一次更新前的版本"
              >
                回滚到 v{ctx.backupVersion}
              </Button>
            )}
          </div>

          {busy === 'go' && (
            <div className="row">
              <Spinner />
              <span className="text-dim">正在交接给更新助手，程序马上退出…</span>
            </div>
          )}

          <div className="text-dim update-note">
            两条更新入口：<b>在线更新</b>从「更新源设置」里的地址取版本与更新包（下载过程可取消，
            中途断网不会留下坏包）；<b>选择更新包…</b>用于离线 / 内网环境，行为与以前完全一致。
            更新包校验项：产品与版本号、Electron 运行时、运行库指纹（adb / scrcpy 等）、
            每个文件的 SHA-256。任一项不符都会拒绝，并提示改用完整安装包。
            日志与备份在 <span className="mono">{ctx.updateDir}</span>。
          </div>
        </div>
      )}
    </Card>
  );
}


function DirRow({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: () => void;
}) {
  return (
    <Field label={label}>
      <div className="row">
        <Input readOnly value={value} onClick={onPick} style={{ cursor: 'pointer' }} />
        <Button variant="default" onClick={onPick} style={{ flex: 'none' }}>
          更改…
        </Button>
        <Button
          variant="ghost"
          onClick={() => value && window.adbApi.reveal(value)}
          style={{ flex: 'none' }}
          title="在资源管理器中打开"
        >
          打开
        </Button>
      </div>
    </Field>
  );
}

function About({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="kv-key">{k}</span>
      <span className="kv-value">{v}</span>
    </div>
  );
}
