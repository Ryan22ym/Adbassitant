import { useState, useEffect } from 'react';
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
  '1.0.22': '本版本给「应用内增量更新」接上了在线这条腿。以前更新包只能自己从本地挑一个文件，现在新增「更新源」：填一个网址（服务器端就是一个静态目录，里面放 latest.json 和更新包），程序会去读它。你手上这版之后有新版本时，左侧「设置」上会冒一个小红点，进设置页点「检查更新」就能看到版本号、更新说明和发布时间，确认后点「下载并更新」。下载走系统代理，边下边显示进度、随时能取消；下载完仍然要先过原来那套校验（产品名、版本号、包体 SHA-256、逐文件清单），校验不过就地删掉，不会把半个包留在机器上。三点说明：① 服务器还没就绪，所以「更新源」默认是空的，显示为「未配置」这个正常状态、不是报错，离线那条「选择更新包…」的老路一点没动；② 通道只做 stable，beta 先占位；③ 开发模式（未打包）下不提供应用内更新，这是刻意的。',
  '1.0.21': '本版本修一个「明明配好了正式签名，装 AAB 时却又被换成调试签名」的问题：签名配置以前只有在你打开「安装安装包」页、并且选中了 AAB（签名面板这时才出现）之后才会被读进界面，于是「把安装包直接拖到窗口上装」这条最常用的路径永远拿着默认的调试签名去装 —— 后端存的正式签名根本没机会生效，装完应用能跑，但 Facebook / 微信登录当场报 Invalid key hash。现在程序一启动就把签名配置读进来，拖放和按钮两条路径用的是同一份。另外安装结果里会直接写明本次用的是哪种签名：用了调试密钥库时会明确警告「应用签名已被替换，三方登录 / 推送可能失效」，不再只悄悄写进运行日志。',
  '1.0.20': '本版本给 AAB 多开了一条出口：新增「导出通用 APK」—— 不需要任何设备在线，直接把 .aab 转成一个能装在所有安卓机型上的通用 APK（用 Google 官方 bundletool 的 universal 模式），选好保存位置即可。适合把包发给别人，或丢进其它工具与平台使用。要注意体积代价：按设备拆包通常只有几十 MB，通用包会把所有机型的资源与原生库都塞进去（一个 200 MB 的 AAB 出来约 205 MB），所以它和「按设备拆包安装」是并存的两条路，不是替代关系。',
  '1.0.19': '本版本把「拆包」和「安装」拆成两件事：AAB 要装必须先用 bundletool 拆成一组 APK，以前这步和安装绑在一起，于是每换一台设备、每重装一次都要再拆一遍，一个大包要等几十秒。现在「安装安装包」页多了「仅拆包并另存为 .apks」——选好 AAB 与设备，点一下就把拆包产物导出到你指定的位置；这个 .apks 文件之后可以直接拖进程序安装，不再拆包，装得比 AAB 快得多。同时拖放区与文件选择器都开始接受 .apks（本工具拆出来的产物），安装方式（覆盖 / 清洁 / 全新）与装后复核的规矩对它同样适用。',
  '1.0.18': '本版本解决「用本工具装完 AAB 后，Facebook / 微信等三方登录报 Invalid key hash」：AAB 本身不含签名，拆成 APK 时必须重新签一次，而以前固定用调试密钥 —— 于是应用能装能跑，但签名被换掉，凡是按「包名 + 签名」校验的能力（三方登录、推送、地图 key）全部失效。现在「安装安装包」页新增「签名方式」：可用随包调试密钥库（默认，够用但会换签名），也可以指定应用自己的正式密钥库（.jks/.keystore）——填路径与密码后点「应用并测试」即可当场验证，选对了就能保住原签名。页面还能一键算出各平台要的 key hash（Facebook / 微信 QQ / Google / SHA-256），三方后台直接粘。',
  '1.0.17': '本版本新增安装 AAB（Android App Bundle）：.aab 是给应用商店用的「原料」，不能直接安装，本版本用 Google 官方的 bundletool 把它按目标设备的配置拆成一组 APK，再以 install-multiple 装上去。拖放区与「安装安装包」页同时接受 .apk 和 .aab；AAB 会先按所选设备拆包（首次十几秒，同一台设备第二次起复用缓存），装完同样按包名复核。缺 Java 或 bundletool 时页面会直接提示怎么补（bundletool 可一键下载）。',
  '1.0.16': '本版本没有任何功能改动 —— 它是「应用内增量更新」修好之后的第一次完整真机实跑：从 v1.0.15 换上这个小更新包（约 180 KB）后自动重启成新版本，84 MB 的安装包一个字节都没有重下；另外还验证了「新版本装坏时能自动回滚」。',
  '1.0.15': '本版本继续修「应用内更新跑不完」：上一版把更新助手换成了独立进程，这一版修掉它在「启动新版本」那一步的报错 —— 以前助手会把文件替换好、然后在最后一步抛错并立刻把文件还原回去，表现成「更新了一趟、版本却没变」。',
  '1.0.13': '本版本修复「应用内更新启动了、却什么都没发生」：更新助手以前是被应用直接拉起的，而它和主程序同在一个「主进程一退就一起结束」的任务组里，于是主程序一关，助手立刻被带走 —— 表现是更新日志一个字都没有、自动回滚也永远不触发；另外有一种启动方式会让助手悄无声息地不执行。现在改成由系统代建一个独立进程，并且在确认助手真的跑起来之后主程序才退出。',
  '1.0.12': '本版本没有任何功能改动 —— 它是「应用内增量更新」的一次真机实跑：从 v1.0.11 换上这个小更新包（约 180 KB）后重启即成新版本，84 MB 的安装包一个字节都没有重下。',
  '1.0.11': '本版本把「应用内增量更新」修到真机可用。之前它在本机装上后根本走不通，一共三个原因：①解压更新包时，Electron 会把名字以 .asar 结尾的普通文件当成 asar 容器，解压直接失败（纯 Node 环境下不会暴露，所以本地检查全绿也照样炸）；②更新包记录的 Electron 版本取的是 package.json 里的区间声明 ^33.3.1，与实际运行时 33.4.11 不符，包会被自己的校验拒收；③打包后助手脚本在 app.asar 内部，候选路径少算了一层目录，点「立即更新」直接报「找不到更新助手脚本」。',
  '1.0.7': '本版本新增应用内增量更新：不用再重新下载 84 MB 的安装包 —— 选择一个小更新包（约 150 KB），点「立即更新并重启」即可自动替换并重启成新版本；如果新版本启动异常（包括白屏），会自动回滚到上一版。安装版走 app.asar 小包，便携版走整包换 exe。',
  '1.0.6': '本版本修复多台设备同时在线时装错机器：以前启动时会默认选中 adb 列表里的第一台（常常是模拟器），并且一直沿用，于是「显示安装成功、手机上却没有」。现在默认优先选物理设备，并且只要有多台设备在线，开装前一定会先问你装到哪台，同时把选择同步为当前设备。',
  '1.0.5': '本版本修复「界面显示安装成功但手机上找不到应用」：安装会明确装到哪台设备（页面与弹窗都标出设备名和序列号），装完还会按包名在设备上复核，查不到就判失败。同时新增安装方式选择：覆盖安装（保留数据）、清洁安装（先卸载、清除数据）、全新安装（已存在则拒绝）。',
  '1.0.4': '本版本新增拖放安装：把 APK 拖到程序窗口任意位置或「安装 APK」页的拖放区即可安装，过程中弹出弹窗实时显示「正在安装中 / 安装成功 / 安装失败」，安装期间自动拦截重复安装。',
  '1.0.3': '本版本在设备列表每台设备右侧加了「快速投屏」按钮，不用切到投屏页就能直接投屏，运行中的那台会变成「停止投屏」；快速投屏沿用投屏页上次使用的画质参数。',
  '1.0.2': '本版本修复弱网代理残留导致设备断网的问题：清理时先 put :0 触发系统刷新，再清代理真身键，确保手机恢复上网。另新增常用应用收藏与免 Root 弱网模拟（丢包/延迟/限速）。',
  '1.0.1': '本版本新增应用管理页常用应用收藏（跨设备记忆包名），弱网模拟改为免 Root 代理方案（adb reverse + 系统全局代理 + 电脑端注入），无需 Root 即可使用。',
  '1.0.0': '本版本聚焦基础能力：设备管理、投屏、截图录屏、分辨率调节、Monkey、APK 安装、文件传输、命令终端与日志导出。',
};

export default function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
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

      <UpdateSourceCard />
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

/**
 * 更新源设置（v1.0.22）。
 *
 * 服务器还没就绪，所以这里默认是空的 —— 留空即「不启用在线更新」，
 * 点「检查更新」会回一句「还没有配置更新源地址」，这是设计内的**正常**状态，
 * 不是错误：其它功能一律不受影响，离线的手动更新入口也照旧可用。
 * 地址填到目录一级即可（程序自己去拼 latest.json）。
 */
function UpdateSourceCard() {
  const settings = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const toast = useApp((s) => s.toast);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const saved = String(settings?.updateBaseUrl || '');

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const save = async (patch: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    try {
      const r = await call<any>(() => window.adbApi.setSettings(patch), { silent: true });
      if (r) {
        setSettings(r);
        toast('success', okMsg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="更新源"
      subtitle="在线更新从哪里取版本清单与更新包；服务器未就绪时留空即可，不影响其它功能"
    >
      <div className="col">
        <Field
          label="更新源地址"
          hint="填到目录一级，程序会请求该目录下的 latest.json；留空 = 不启用在线更新。例如 https://example.com/adb-assistant/"
        >
          <div className="row">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://example.com/adb-assistant/"
              spellCheck={false}
              data-update-source-input="1"
            />
            <Button
              variant="default"
              onClick={() =>
                save({ updateBaseUrl: draft.trim() }, draft.trim() ? '更新源已保存' : '已清空更新源')
              }
              loading={saving}
              disabled={draft.trim() === saved}
              style={{ flex: 'none' }}
              data-update-source-save="1"
            >
              保存
            </Button>
            {saved && (
              <Button
                variant="ghost"
                onClick={() => save({ updateBaseUrl: '' }, '已清空更新源')}
                style={{ flex: 'none' }}
              >
                清空
              </Button>
            )}
          </div>
        </Field>

        <Field
          label="自动检查更新"
          hint="启动后延迟几秒静默检查一次；有新版本只在侧栏「设置」上挂个提示点，不弹窗"
        >
          <Switch
            checked={!!settings?.autoCheckUpdate}
            onChange={(v) =>
              save({ autoCheckUpdate: v }, v ? '已开启自动检查更新' : '已关闭自动检查更新')
            }
            label={settings?.autoCheckUpdate ? '已开启' : '已关闭'}
            disabled={saving}
          />
        </Field>

        <Field
          label="更新通道"
          hint="通道名由更新源提供，本机只做匹配；当前只开放稳定版，测试版协议已预留"
        >
          <Segmented
            value={settings?.updateChannel ?? 'stable'}
            onChange={(v) => {
              if (v === 'beta') {
                toast('info', '测试版通道暂未开放', '协议已预留，等服务器就绪后再开');
                return;
              }
              void save({ updateChannel: 'stable' }, '更新通道：稳定版');
            }}
            options={[
              { value: 'stable', label: '稳定版' },
              { value: 'beta', label: '测试版（未开放）' },
            ]}
          />
        </Field>

        <div className="text-dim update-note">
          最近检查：{settings?.lastCheckAt || '尚未检查'}。这个地址只影响在线更新这一条路 ——
          「选择更新包…」与「回滚」都不依赖网络。
        </div>
      </div>
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
