import { useState, useEffect } from 'react';
import { Card, Button, Field, Input, Segmented, Notice, Badge, Spinner } from '@/components/ui';
import { useApp } from '@/store/app';
import { call } from '@/lib/ipc';
import type { EnvCheckResult } from '@shared/types';

/**
 * 每个版本的一句话亮点，key 为 package.json 的完整版本号。
 * ⚠️ 发版改 package.json version 时，这里同步加一条（漏加会回退到默认文案）。
 */
const VERSION_NOTES: Record<string, string> = {
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
    </>
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
