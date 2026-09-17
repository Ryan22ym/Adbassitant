import { useState, useEffect } from 'react';
import { Card, Button, Field, Input, Segmented, Notice, Badge, Spinner } from '@/components/ui';
import { useApp } from '@/store/app';
import { call } from '@/lib/ipc';
import type { EnvCheckResult, UpdateContext, UpdateInfo } from '@shared/types';

/**
 * 每个版本的一句话亮点，key 为 package.json 的完整版本号。
 * ⚠️ 发版改 package.json version 时，这里同步加一条（漏加会回退到默认文案）。
 */
const VERSION_NOTES: Record<string, string> = {
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
    </>
  );
}

/**
 * 软件更新面板。
 *
 * 更新这件事的代价很高（装坏了就打不开），所以这里的原则是「拿不准就不做」：
 * 任何一项校验不过，都只提示改用完整安装包，绝不硬来。校验在主进程做
 * （electron/services/update-core.ts），这里只负责展示与确认。
 */
const KIND_LABEL: Record<string, string> = {
  asar: '安装版（增量更新）',
  portable: '便携版（整包替换）',
  dev: '开发模式（未打包）',
};

function UpdatePanel() {
  const toast = useApp((s) => s.toast);
  const [ctx, setCtx] = useState<UpdateContext | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState<'' | 'prepare' | 'go'>('');
  const [confirming, setConfirming] = useState<null | 'apply' | 'rollback'>(null);

  const refresh = async () => {
    const r = await call<UpdateContext>(() => window.adbApi.updateContext(), { silent: true });
    setCtx(r ?? null);
  };

  useEffect(() => {
    void refresh();
  }, []);

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
        <div className="col" data-update-panel="1" data-update-kind={ctx.kind}>
          <div className="kv-list">
            <About k="当前版本" v={`v${ctx.version}`} />
            <About k="程序形态" v={KIND_LABEL[ctx.kind] ?? ctx.kind} />
            <About k="运行时" v={`Electron ${ctx.electronVersion || '未知'}`} />
            {/* 运行库指纹：更新包被「运行库不一致」拒掉时，拿它跟包里记录的一对就知道差在哪 */}
            <About k="运行库指纹" v={ctx.runtimeHash ? `${ctx.runtimeHash.slice(0, 16)}…` : '—'} />
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
              variant="primary"
              onClick={pick}
              loading={busy === 'prepare'}
              disabled={!ctx.canUpdate || busyNow}
            >
              选择更新包…
            </Button>
            {info?.ok && confirming !== 'apply' && (
              <Button
                variant="default"
                onClick={() => setConfirming('apply')}
                disabled={busyNow}
              >
                立即更新并重启
              </Button>
            )}
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
