import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Card,
  Button,
  Badge,
  Field,
  Input,
  Select,
  Switch,
  Notice,
  Empty,
  Segmented,
  Spinner,
  Progress,
} from '@/components/ui';
import { Icon, StepIcon } from '@/components/icons';
import { useApp, useCurrentDevice } from '@/store/app';
import { call } from '@/lib/ipc';
import type {
  ClickerScript,
  ClickerStatus,
  ClickerStep,
  ClickerStepKind,
  ClickerProgress,
  ClickerRecordMeta,
  RecorderInfo,
  RecorderStatus,
  RecordedSession,
  RecordedFrame,
} from '@shared/types';
import { CLICKER_STEP_LABEL } from '@shared/types';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 新建脚本时的空白模板 */
function emptyScript(): ClickerScript {
  const now = new Date().toISOString();
  return {
    id: '',
    name: '新脚本',
    steps: [{ kind: 'tap', nx: 0.5, ny: 0.5, count: 1 }],
    loop: 1,
    speed: 1,
    jitterPx: 6,
    createdAt: now,
    updatedAt: now,
    source: 'manual',
  };
}

/** 新建步骤时的默认值（每种类型给一个合理的起点，不要都是 0） */
function newStep(kind: ClickerStepKind): ClickerStep {
  switch (kind) {
    case 'tap':
      return { kind: 'tap', nx: 0.5, ny: 0.5, count: 1 };
    case 'longPress':
      return { kind: 'longPress', nx: 0.5, ny: 0.5, ms: 800 };
    case 'swipe':
      return { kind: 'swipe', nx1: 0.5, ny1: 0.7, nx2: 0.5, ny2: 0.3, durationMs: 300 };
    case 'key':
      return { kind: 'key', code: 3 };
    case 'wait':
      return { kind: 'wait', ms: 1000 };
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'shell':
      return { kind: 'shell', cmd: 'input keyevent 3' };
    case 'launch':
      return { kind: 'launch', pkg: '' };
    case 'note':
      return { kind: 'note', text: '' };
    default:
      return { kind: 'tap', nx: 0.5, ny: 0.5, count: 1 };
  }
}

const STEP_KIND_OPTIONS: { value: ClickerStepKind; label: string }[] = (
  ['tap', 'longPress', 'swipe', 'key', 'wait', 'screenshot', 'shell', 'launch', 'note'] as ClickerStepKind[]
).map((k) => ({ value: k, label: CLICKER_STEP_LABEL[k] }));

/** 倍速档位 */
const SPEED_CHIPS = [0.25, 0.5, 1, 1.5, 2, 4];

/** 偏移档位（像素） */
const JITTER_CHIPS = [0, 3, 6, 12, 24];

type Tab = 'script' | 'record';

export default function AutoClickerPage() {
  const current = useCurrentDevice();
  const toast = useApp((s) => s.toast);

  const [tab, setTab] = useState<Tab>('script');
  const [scripts, setScripts] = useState<ClickerScript[]>([]);
  const [draft, setDraft] = useState<ClickerScript>(emptyScript);
  const [selectedId, setSelectedId] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keycodes, setKeycodes] = useState<{ code: number; label: string }[]>([]);
  const [status, setStatus] = useState<ClickerStatus | null>(null);
  const [progress, setProgress] = useState<ClickerProgress | null>(null);

  /* ---------------- 录制面板状态 ---------------- */
  const [recInfo, setRecInfo] = useState<RecorderInfo | null>(null);
  const [recStatus, setRecStatus] = useState<RecorderStatus | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [session, setSession] = useState<RecordedSession | null>(null);
  const [frameUrl, setFrameUrl] = useState<string>('');
  const [framePick, setFramePick] = useState<number>(-1);

  /* ---------------- 初始化 ---------------- */
  useEffect(() => {
    (async () => {
      const [list, keys, st] = await Promise.all([
        call<ClickerScript[]>(() => window.adbApi.clickerList(), { silent: true }),
        call<{ code: number; label: string }[]>(() => window.adbApi.clickerKeycodes(), {
          silent: true,
        }),
        call<ClickerStatus>(() => window.adbApi.clickerStatus(), { silent: true }),
      ]);
      if (list) setScripts(list);
      if (keys) setKeycodes(keys);
      if (st) setStatus(st);
    })();
  }, []);

  /* ---------------- 推送订阅 ---------------- */
  useEffect(() => {
    const off = window.adbApi.on('push:clickerProgress', (p: ClickerProgress) => {
      setProgress(p);
      if (p.failed) toast('error', '回放中断', p.error || p.label);
    });
    const offRec = window.adbApi.on('push:recorderStatus', (s: RecorderStatus) => setRecStatus(s));
    return () => {
      off();
      offRec();
    };
  }, [toast]);

  /* ---------------- 回放中：轮询状态 ---------------- */
  useEffect(() => {
    if (!status?.running) return;
    const id = window.setInterval(async () => {
      const st = await call<ClickerStatus>(() => window.adbApi.clickerStatus(), { silent: true });
      if (st) setStatus(st);
    }, 900);
    return () => window.clearInterval(id);
  }, [status?.running]);

  /* ---------------- 录制中：轮询采集端状态 ---------------- */
  useEffect(() => {
    if (tab !== 'record' || !current?.serial) return;
    void refreshRecInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, current?.serial]);

  useEffect(() => {
    if (tab !== 'record' || !recStatus?.recording) return;
    const id = window.setInterval(async () => {
      const st = await call<RecorderStatus>(() => window.adbApi.recorderStatus(current?.serial), {
        silent: true,
      });
      if (st) setRecStatus(st);
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, recStatus?.recording, current?.serial]);

  const refreshRecInfo = useCallback(async () => {
    if (!current?.serial) {
      setRecInfo(null);
      return;
    }
    const r = await call<RecorderInfo>(() => window.adbApi.recorderInfo(current.serial), {
      silent: true,
    });
    if (r) setRecInfo(r);
  }, [current?.serial]);

  /* ------------------------------------------------------------------ */
  /* 脚本：选择 / 编辑 / 保存                                            */
  /* ------------------------------------------------------------------ */

  const selectScript = (s: ClickerScript) => {
    if (dirty && !confirm('当前脚本有未保存的修改，切换后将丢失，继续？')) return;
    setDraft(JSON.parse(JSON.stringify(s)));
    setSelectedId(s.id);
    setDirty(false);
  };

  const newScript = () => {
    if (dirty && !confirm('当前脚本有未保存的修改，继续将丢失修改，确定？')) return;
    setDraft(emptyScript());
    setSelectedId('');
    setDirty(false);
  };

  const patchDraft = (patch: Partial<ClickerScript>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const patchStep = (idx: number, patch: Partial<ClickerStep>) => {
    setDraft((d) => {
      const steps = d.steps.slice();
      steps[idx] = { ...steps[idx], ...patch } as ClickerStep;
      return { ...d, steps };
    });
    setDirty(true);
  };

  /**
   * 换步骤类型 = 换整条数据。
   *
   * 不能只改 kind 字段 —— 每种步骤的字段集不同（swipe 有 4 个坐标、key 只有 code），
   * 保留旧字段会让 sanitize 在保存时把不属于这个类型的值一起带下去。
   * 所以直接换成该类型的空白模板。
   */
  const changeStepKind = (idx: number, kind: ClickerStepKind) => {
    setDraft((d) => {
      const steps = d.steps.slice();
      steps[idx] = newStep(kind);
      return { ...d, steps };
    });
    setDirty(true);
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= draft.steps.length) return;
    setDraft((d) => {
      const steps = d.steps.slice();
      [steps[idx], steps[j]] = [steps[j], steps[idx]];
      return { ...d, steps };
    });
    setDirty(true);
  };

  const removeStep = (idx: number) => {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== idx) }));
    setDirty(true);
  };

  const insertStep = (idx: number, kind: ClickerStepKind) => {
    setDraft((d) => {
      const steps = d.steps.slice();
      steps.splice(idx, 0, newStep(kind));
      return { ...d, steps };
    });
    setDirty(true);
  };

  const save = async () => {
    if (draft.steps.length === 0) return toast('warn', '脚本至少要有一个步骤');
    setBusy(true);
    try {
      const r = await call<{ script: ClickerScript; list: ClickerScript[]; created: boolean }>(
        () => window.adbApi.clickerSave(draft),
        { silent: true },
      );
      if (!r) return;
      setScripts(r.list || []);
      // 后端回传的是权威结果（新建时 id 由它分配），直接用它替换草稿 ——
      // 这样不必靠「名字 + 步数」去列表里猜自己刚存的是哪一条
      setDraft(JSON.parse(JSON.stringify(r.script)));
      setSelectedId(r.script.id);
      setDirty(false);
      toast(
        'success',
        r.created ? `脚本「${r.script.name}」已创建` : `脚本「${r.script.name}」已更新`,
        `${r.script.steps.length} 个步骤`,
      );
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: ClickerScript) => {
    if (!confirm(`删除脚本「${s.name}」？此操作不可撤销。`)) return;
    try {
      const list = await call<ClickerScript[]>(() => window.adbApi.clickerDelete(s.id), {
        silent: true,
      });
      setScripts(list || []);
      if (selectedId === s.id) {
        setDraft(emptyScript());
        setSelectedId('');
        setDirty(false);
      }
      toast('success', '脚本已删除');
    } catch (e) {
      toast('error', '删除失败', (e as Error).message);
    }
  };

  /* ------------------------------------------------------------------ */
  /* 回放控制                                                            */
  /* ------------------------------------------------------------------ */

  const startRun = async () => {
    if (!current) return toast('warn', '请先连接设备');
    if (draft.steps.filter((s) => s.kind !== 'note').length === 0) {
      return toast('warn', '脚本里没有可执行的步骤');
    }
    setBusy(true);
    try {
      const st = await call<ClickerStatus>(() => window.adbApi.clickerRun(draft, current.serial), {
        silent: true,
      });
      if (st) setStatus(st);
      setProgress(null);
      toast(
        'success',
        '开始回放',
        `${draft.loop === 0 ? '无限循环' : `${draft.loop} 轮`} · ${draft.speed}× · 偏移 ${draft.jitterPx}px`,
      );
    } catch (e) {
      toast('error', '启动失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stopRun = async () => {
    setBusy(true);
    try {
      const st = await call<ClickerStatus>(() => window.adbApi.clickerStop(), { silent: true });
      if (st) setStatus(st);
      toast('info', '已请求停止');
    } finally {
      setBusy(false);
    }
  };

  /** 单步调试：把这一步立刻在设备上执行一次（排查脚本问题最有效的手段） */
  const runOne = async (step: ClickerStep) => {
    if (!current) return toast('warn', '请先连接设备');
    setBusy(true);
    try {
      const label = await call<string>(() => window.adbApi.clickerRunStep(step, current.serial), {
        silent: true,
      });
      toast('success', '已执行', label || '');
    } catch (e) {
      toast('error', '执行失败', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /* 采集端操作                                                          */
  /* ------------------------------------------------------------------ */

  const installRecorder = async () => {
    if (!current) return toast('warn', '请先连接设备');
    setRecBusy(true);
    try {
      const r = await call<{ ok: boolean; message: string }>(
        () => window.adbApi.recorderInstall(current.serial),
        { silent: true },
      );
      if (r?.ok) {
        toast('success', '采集端已安装', r.message);
        void refreshRecInfo();
      } else {
        toast('error', '安装失败', r?.message || '未知原因');
      }
    } finally {
      setRecBusy(false);
    }
  };

  const authorizeRecorder = async () => {
    setRecBusy(true);
    try {
      const ok = await call<boolean>(() => window.adbApi.recorderAuthorize(current?.serial), {
        silent: true,
      });
      if (ok) {
        toast('info', '已在手机上打开采集端', '请在手机上点「授权录屏」并在系统弹窗里确认');
        // 授权是手动的，轮询几次把结果收回来
        let n = 0;
        const id = window.setInterval(async () => {
          n += 1;
          await refreshRecInfo();
          if (n >= 15) window.clearInterval(id);
        }, 2000);
      } else {
        toast('warn', '没能拉起采集端', '请先在手机上打开一次「屏幕录制」App');
      }
    } finally {
      setRecBusy(false);
    }
  };

  const startRec = async () => {
    setRecBusy(true);
    try {
      const st = await call<RecorderStatus>(() => window.adbApi.recorderStart(current?.serial), {
        silent: true,
      });
      if (st) setRecStatus(st);
      setSession(null);
      toast('success', '开始录制', '现在请在手机上的采集端窗口里操作，操作会被完整记录');
      void openRecorderUi();
    } catch (e) {
      toast('error', '开始录制失败', (e as Error).message);
    } finally {
      setRecBusy(false);
    }
  };

  const openRecorderUi = async () => {
    await call<boolean>(() => window.adbApi.recorderOpenUi(current?.serial), { silent: true });
  };

  const togglePause = async () => {
    if (!recStatus) return;
    setRecBusy(true);
    try {
      const st = await call<RecorderStatus>(
        () => window.adbApi.recorderPause(!recStatus.paused, current?.serial),
        { silent: true },
      );
      if (st) setRecStatus(st);
    } finally {
      setRecBusy(false);
    }
  };

  const stopRec = async () => {
    setRecBusy(true);
    try {
      const st = await call<RecorderStatus>(() => window.adbApi.recorderStop(current?.serial), {
        silent: true,
      });
      if (st) setRecStatus(st);
      toast('success', '录制已停止', '接下来点「拉取并转成脚本」');
    } catch (e) {
      toast('error', '停止失败', (e as Error).message);
    } finally {
      setRecBusy(false);
    }
  };

  /**
   * 拉取录制数据 + 转成脚本步骤。
   *
   * 转换在主进程做（`sessionToSteps`）：归并手势、生成 wait、插 note —— 这套逻辑
   * 必须和回放引擎用同一套阈值，放渲染层会漂移。
   * 转出来的结果是**草稿**，用户看过/改过之后才落盘。
   */
  const pullAndConvert = async () => {
    if (!current) return;
    setRecBusy(true);
    try {
      const sess = await call<RecordedSession>(() => window.adbApi.recorderPull(current.serial), {
        silent: true,
      });
      if (!sess) return;
      setSession(sess);

      const conv = await call<{ steps: ClickerStep[]; meta: ClickerRecordMeta | null }>(
        () => window.adbApi.clickerFromRecord(sess),
        { silent: true },
      );
      if (!conv || conv.steps.length === 0) {
        toast('warn', '没转出可用的步骤', '录制里可能只有触摸点而没有完整手势，试试在采集端窗口里点击一次');
        return;
      }

      const now = new Date().toISOString();
      setDraft((d) => ({
        ...d,
        id: '',
        name: d.name === '新脚本' ? `录制脚本 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` : d.name,
        steps: conv.steps,
        source: 'record',
        recordedMeta: conv.meta ?? undefined,
        createdAt: now,
        updatedAt: now,
      }));
      setSelectedId('');
      setDirty(true);
      setTab('script');
      toast(
        'success',
        '已转成脚本草稿',
        `触摸 ${sess.touches.length} 条 → ${conv.steps.length} 步（已归并手势并还原操作间隔）`,
      );
    } catch (e) {
      toast('error', '拉取失败', (e as Error).message);
    } finally {
      setRecBusy(false);
    }
  };

  /** 点关键帧缩略图 → 取原图（用来看清当时屏幕上的内容，定位坐标） */
  const loadFrame = async (f: RecordedFrame) => {
    setFramePick(f.id);
    setFrameUrl('');
    const url = await call<string>(() => window.adbApi.recorderFrame(f.id, current?.serial), {
      silent: true,
    });
    if (url) setFrameUrl(url);
  };

  /* ------------------------------------------------------------------ */
  /* 派生值                                                              */
  /* ------------------------------------------------------------------ */

  const running = !!status?.running;

  const runPercent = useMemo(() => {
    if (!status || status.total === 0) return 0;
    const perRound = status.total;
    const totalRounds = draft.loop <= 0 ? 0 : draft.loop;
    if (totalRounds === 0) {
      // 无限循环：进度按「当前轮已走多少」显示，不假装知道总进度
      return Math.round(((status.index + 1) / perRound) * 100);
    }
    const totalSteps = perRound * totalRounds;
    return Math.min(100, Math.round((status.done / totalSteps) * 100));
  }, [status, draft.loop]);

  /** 步骤列表的展示文案（不依赖设备分辨率，用比例换一个估算像素供人读） */
  const stepText = useCallback(
    (s: ClickerStep): string => {
      const meta = draft.recordedMeta;
      const w = meta?.width || 0;
      const h = meta?.height || 0;
      const px = (n: number, dim: number) => (dim ? `${Math.round(n * dim)}` : n.toFixed(3));
      switch (s.kind) {
        case 'tap':
          return `点击 (${px(s.nx, w)}, ${px(s.ny, h)})${s.count && s.count > 1 ? ` ×${s.count}` : ''}`;
        case 'longPress':
          return `长按 (${px(s.nx, w)}, ${px(s.ny, h)}) ${s.ms}ms`;
        case 'swipe':
          return `滑动 (${px(s.nx1, w)},${px(s.ny1, h)}) → (${px(s.nx2, w)},${px(s.ny2, h)}) ${s.durationMs}ms`;
        case 'key': {
          const k = keycodes.find((x) => x.code === s.code);
          return k ? k.label : `keycode ${s.code}`;
        }
        case 'wait':
          return `${s.ms}ms`;
        case 'screenshot':
          return '保存到截图目录';
        case 'shell':
          return s.cmd;
        case 'launch':
          return s.pkg || '（未填包名）';
        case 'note':
          return s.text || '（空说明）';
        default:
          return '';
      }
    },
    [draft.recordedMeta, keycodes],
  );

  /* ------------------------------------------------------------------ */

  return (
    <>
      {!current && (
        <Notice tone="warn">
          当前没有可用设备，请先在「设备」页面连接手机并授权 USB 调试。
        </Notice>
      )}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'script', label: '脚本编辑与回放' },
          { value: 'record', label: '手机端录制' },
        ]}
      />

      {tab === 'record' ? (
        <RecordPanel
          info={recInfo}
          status={recStatus}
          busy={recBusy}
          hasDevice={!!current}
          session={session}
          frameUrl={frameUrl}
          framePick={framePick}
          onInstall={installRecorder}
          onAuthorize={authorizeRecorder}
          onOpenUi={openRecorderUi}
          onStart={startRec}
          onPause={togglePause}
          onStop={stopRec}
          onPull={pullAndConvert}
          onRefresh={refreshRecInfo}
          onPickFrame={loadFrame}
        />
      ) : (
        <>
          {/* ================= 回放控制条 ================= */}
          <Card className={`ck-run ${running ? 'running' : ''}`}>
            <div className="ck-run-inner">
              <div className="ck-run-info">
                <div className="ck-run-title">
                  {running && <span className="wn-pulse" />}
                  <strong>{running ? status?.note || '运行中' : '连点回放'}</strong>
                  <Badge tone={running ? 'accent' : 'default'}>
                    {running
                      ? `第 ${status?.round ?? 1} 轮 · 第 ${(status?.index ?? 0) + 1}/${status?.total ?? 0} 步`
                      : `${draft.steps.length} 步`}
                  </Badge>
                  {dirty && <Badge tone="warn">未保存</Badge>}
                </div>
                <p className="text-dim ck-run-desc">
                  {running
                    ? `已完成 ${status?.done ?? 0} 步 · ${draft.speed}× 倍速 · 随机偏移 ${draft.jitterPx}px`
                    : draft.recordedMeta
                      ? `录制来源 · 录制屏 ${draft.recordedMeta.width}×${draft.recordedMeta.height} · 坐标按比例存储，换分辨率也能用`
                      : '坐标以 0~1 比例存储；回放时自动换算到目标设备分辨率'}
                </p>
              </div>
              <div className="ck-run-actions">
                {running ? (
                  <Button variant="danger" size="lg" onClick={stopRun} loading={busy}>
                    停止回放
                  </Button>
                ) : (
                  <>
                    <Button variant="default" onClick={save} loading={busy}>
                      保存脚本
                    </Button>
                    <Button
                      variant="primary"
                      size="lg"
                      onClick={startRun}
                      loading={busy}
                      disabled={!current}
                      icon={Icon.clicker}
                    >
                      开始回放
                    </Button>
                  </>
                )}
              </div>
            </div>

            {running && (
              <div className="ck-progress">
                <Progress value={runPercent} />
                <span className="text-dim ck-progress-text">
                  {draft.loop <= 0 ? '无限循环 · 当前轮进度' : `总进度 ${runPercent}%`}
                </span>
              </div>
            )}

            {/*
              最近一步的实际执行说明。
              与上面的 `status.note` 不同：那个是每 900ms 轮询来的**当前状态**，
              这里是主进程在每一步**开始前**推过来的事件流 —— 没有它，短步骤
              （比如几十毫秒的 tap）会被轮询完全跳过，用户看到进度条在动但读不出在做什么。
            */}
            {running && progress && (
              <div className="ck-live">
                <span className={`ck-live-dot ${progress.failed ? 'bad' : ''}`} />
                <span className="ck-live-text mono">
                  第 {progress.round} 轮 · {progress.index + 1}/{progress.total} · {progress.label}
                </span>
              </div>
            )}
          </Card>

          <div className="ck-layout">
            {/* ---------------- 左：步骤表 ---------------- */}
            <div className="ck-col">
              <Card
                title="步骤"
                subtitle="从上到下依次执行"
                extra={
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="ghost" onClick={newScript}>
                      新建
                    </Button>
                    <Button size="sm" variant="default" onClick={() => insertStep(draft.steps.length, 'tap')}>
                      + 添加步骤
                    </Button>
                  </div>
                }
              >
                <div className="col ck-steps-col">
                  <Input
                    value={draft.name}
                    placeholder="脚本名称"
                    onChange={(e) => patchDraft({ name: e.target.value })}
                  />

                  {draft.steps.length === 0 ? (
                    <Empty
                      title="还没有步骤"
                      desc="可以手动添加，也可以在「手机端录制」里录一段操作自动生成"
                      action={
                        <Button variant="primary" onClick={() => insertStep(0, 'tap')}>
                          添加第一个步骤
                        </Button>
                      }
                    />
                  ) : (
                    <div className="ck-steps">
                      {draft.steps.map((s, i) => (
                        <StepRow
                          key={i}
                          index={i}
                          step={s}
                          total={draft.steps.length}
                          text={stepText(s)}
                          keycodes={keycodes}
                          disabled={busy || running}
                          onKind={(k) => changeStepKind(i, k)}
                          onPatch={(p) => patchStep(i, p)}
                          onMove={(d) => moveStep(i, d)}
                          onRemove={() => removeStep(i)}
                          onInsert={() => insertStep(i + 1, 'tap')}
                          onRunOne={() => runOne(s)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </div>

            {/* ---------------- 右：参数 / 脚本库 ---------------- */}
            <div className="ck-col ck-col-side">
              <Card title="执行参数" subtitle="倍速只影响等待与间隙，不缩短长按/滑动时长">
                <div className="col">
                  <Field label="循环次数" hint="0 = 无限循环，直到手动停止">
                    <Input
                      type="number"
                      min={0}
                      value={draft.loop}
                      onChange={(e) => patchDraft({ loop: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    />
                  </Field>

                  <div className="col" style={{ gap: 8 }}>
                    <span className="field-label">
                      倍速 <em className="field-hint">1× = 原速</em>
                    </span>
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      {SPEED_CHIPS.map((s) => (
                        <button
                          key={s}
                          className={`chip ${draft.speed === s ? 'on' : ''}`}
                          onClick={() => patchDraft({ speed: s })}
                        >
                          {s}×
                        </button>
                      ))}
                    </div>
                    <Input
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={draft.speed}
                      onChange={(e) =>
                        patchDraft({ speed: Math.min(10, Math.max(0.1, parseFloat(e.target.value) || 1)) })
                      }
                    />
                  </div>

                  <div className="col" style={{ gap: 8 }}>
                    <span className="field-label">
                      模拟真实点击（随机偏移）<em className="field-hint">像素</em>
                    </span>
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      {JITTER_CHIPS.map((j) => (
                        <button
                          key={j}
                          className={`chip ${draft.jitterPx === j ? 'on' : ''}`}
                          onClick={() => patchDraft({ jitterPx: j })}
                        >
                          {j === 0 ? '关闭' : `±${j}px`}
                        </button>
                      ))}
                    </div>
                    <p className="text-dim ck-hint">
                      每次点击在 ±{draft.jitterPx}px 内随机落点。用途是规避「每次都在同一像素」
                      这种机械点击特征 —— 不少游戏与风控会据此识别脚本。
                    </p>
                  </div>

                  <div className="divider" />

                  <div className="ck-meta-grid">
                    <div className="kv">
                      <span className="kv-key">步骤总数</span>
                      <span className="kv-value mono">{draft.steps.length}</span>
                    </div>
                    <div className="kv">
                      <span className="kv-key">可执行步骤</span>
                      <span className="kv-value mono">
                        {draft.steps.filter((s) => s.kind !== 'note').length}
                      </span>
                    </div>
                    <div className="kv">
                      <span className="kv-key">来源</span>
                      <span className="kv-value">{draft.source === 'record' ? '手机录制' : '手动创建'}</span>
                    </div>
                    {draft.recordedMeta && (
                      <div className="kv">
                        <span className="kv-key">录制屏</span>
                        <span className="kv-value mono">
                          {draft.recordedMeta.width}×{draft.recordedMeta.height}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Card>

              <Card
                title="脚本库"
                subtitle="保存在本机，随时复用"
                extra={<Badge tone="default">{scripts.length} 个</Badge>}
              >
                {scripts.length === 0 ? (
                  <Empty title="暂无脚本" desc="编辑好步骤后点「保存脚本」" />
                ) : (
                  <div className="ck-script-list">
                    {scripts.map((s) => (
                      <div
                        key={s.id}
                        className={`ck-script ${selectedId === s.id ? 'active' : ''}`}
                        onClick={() => selectScript(s)}
                      >
                        <div className="ck-script-main">
                          <span className="ck-script-name">
                            {s.name}
                            {s.source === 'record' && <Badge tone="accent">录制</Badge>}
                          </span>
                          <span className="ck-script-desc">
                            {s.steps.length} 步 · {s.loop === 0 ? '无限' : `${s.loop} 轮`} · {s.speed}× ·
                            偏移 {s.jitterPx}px
                          </span>
                        </div>
                        <button
                          className="icon-btn ck-script-del"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(s);
                          }}
                        >
                          {Icon.close}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="免 Root 实现说明">
                <div className="col" style={{ gap: 8 }}>
                  <p className="text-dim ck-hint">
                    所有输入都通过 <span className="mono">adb shell input</span> 下发，<strong>不需要 Root</strong>，
                    也不需要往设备上装任何东西。点击 = <span className="mono">input tap</span>、
                    长按 = 原地 <span className="mono">input swipe</span>（免 Root 下唯一可靠的按住手段）、
                    滑动 = <span className="mono">input swipe</span>。
                  </p>
                  <p className="text-dim ck-hint">
                    <strong>坐标一律存比例</strong>：录制时的屏幕、回放时的设备、投屏窗口大小三者都可能不同，
                    只有「占屏幕宽高的比例」是这三种场景都认的。回放开始时读一次
                    <span className="mono"> wm size</span>，把比例换算成目标设备的真实像素。
                  </p>
                  <p className="text-dim ck-hint">
                    <strong>倍速的语义</strong>是「操作之间等多久」，不是「动作多快」——
                    把「长按 500ms」缩成 250ms 就不再是长按了（很多长按判定有阈值）。所以倍速只缩
                    <span className="mono"> 等待</span> 步骤与步骤间隙。
                  </p>
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 步骤行                                                              */
/* ------------------------------------------------------------------ */

interface StepRowProps {
  index: number;
  step: ClickerStep;
  total: number;
  text: string;
  keycodes: { code: number; label: string }[];
  disabled: boolean;
  onKind: (k: ClickerStepKind) => void;
  onPatch: (p: Partial<ClickerStep>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onInsert: () => void;
  onRunOne: () => void;
}

/**
 * 一行步骤。
 *
 * 布局是「左窄右宽」：左边是序号 + 类型图标 + 类型下拉（这三样在每个步骤上都一样，
 * 占固定宽度，扫一眼列就能看出脚本的节奏）；右边是该类型的参数。
 * 参数区**按类型渲染不同的输入控件** —— 不用「把所有字段都列出来」的做法，
 * 那样 swipe 行会多出 4 个跟它无关的输入框。
 */
function StepRow({
  index,
  step,
  total,
  text,
  keycodes,
  disabled,
  onKind,
  onPatch,
  onMove,
  onRemove,
  onInsert,
  onRunOne,
}: StepRowProps) {
  const num = (v: string, dflt = 0) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };

  return (
    <div className={`ck-step ${step.kind === 'note' ? 'is-note' : ''}`}>
      <div className="ck-step-head">
        <span className="ck-step-idx">{index + 1}</span>
        <span className="ck-step-icon">{StepIcon[step.kind]}</span>
        <Select
          className="ck-step-kind"
          value={step.kind}
          disabled={disabled}
          onChange={(e) => onKind(e.target.value as ClickerStepKind)}
          options={STEP_KIND_OPTIONS}
        />
        <span className="ck-step-text text-dim mono" title={text}>
          {text}
        </span>
        <div className="ck-step-tools">
          <button className="icon-btn" title="向上" disabled={disabled || index === 0} onClick={() => onMove(-1)}>
            {Icon.up}
          </button>
          <button
            className="icon-btn"
            title="向下"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
          >
            {Icon.down}
          </button>
          <button className="icon-btn" title="立即执行这一步（调试）" disabled={disabled} onClick={onRunOne}>
            {Icon.bolt}
          </button>
          <button className="icon-btn" title="在下方插入" disabled={disabled} onClick={onInsert}>
            {Icon.insertBelow}
          </button>
          <button className="icon-btn danger" title="删除" disabled={disabled} onClick={onRemove}>
            {Icon.close}
          </button>
        </div>
      </div>

      <div className="ck-step-body">
        {(step.kind === 'tap' || step.kind === 'longPress') && (
          <>
            <Field label="X 比例" hint="0~1">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.nx}
                disabled={disabled}
                onChange={(e) => onPatch({ nx: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
            <Field label="Y 比例" hint="0~1">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.ny}
                disabled={disabled}
                onChange={(e) => onPatch({ ny: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
          </>
        )}

        {step.kind === 'tap' && (
          <Field label="连击次数" hint=">1 即连击">
            <Input
              type="number"
              min={1}
              max={100}
              value={step.count ?? 1}
              disabled={disabled}
              onChange={(e) => onPatch({ count: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            />
          </Field>
        )}

        {step.kind === 'longPress' && (
          <Field label="按住时长" hint="ms">
            <Input
              type="number"
              min={50}
              max={60000}
              step={50}
              value={step.ms}
              disabled={disabled}
              onChange={(e) => onPatch({ ms: Math.max(50, parseInt(e.target.value, 10) || 800) })}
            />
          </Field>
        )}

        {step.kind === 'swipe' && (
          <>
            <Field label="起点 X">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.nx1}
                disabled={disabled}
                onChange={(e) => onPatch({ nx1: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
            <Field label="起点 Y">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.ny1}
                disabled={disabled}
                onChange={(e) => onPatch({ ny1: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
            <Field label="终点 X">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.nx2}
                disabled={disabled}
                onChange={(e) => onPatch({ nx2: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
            <Field label="终点 Y">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.005}
                value={step.ny2}
                disabled={disabled}
                onChange={(e) => onPatch({ ny2: Math.min(1, Math.max(0, num(e.target.value))) })}
              />
            </Field>
            <Field label="滑动耗时" hint="ms（不随倍速缩放）">
              <Input
                type="number"
                min={10}
                max={60000}
                step={50}
                value={step.durationMs}
                disabled={disabled}
                onChange={(e) => onPatch({ durationMs: Math.max(10, parseInt(e.target.value, 10) || 300) })}
              />
            </Field>
          </>
        )}

        {step.kind === 'key' && (
          <>
            <Field label="按键">
              <Select
                value={String(step.code)}
                disabled={disabled}
                onChange={(e) => onPatch({ code: parseInt(e.target.value, 10) })}
                options={[
                  ...keycodes.map((k) => ({ value: String(k.code), label: k.label })),
                  // 已选的 code 不在常用表里时补一项，避免下拉显示空白把用户搞懵
                  ...(keycodes.some((k) => k.code === step.code)
                    ? []
                    : [{ value: String(step.code), label: `keycode ${step.code}（当前）` }]),
                ]}
              />
            </Field>
            <Field label="自定义 keycode" hint="可手填任意数字">
              <Input
                type="number"
                min={0}
                value={step.code}
                disabled={disabled}
                onChange={(e) => onPatch({ code: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              />
            </Field>
          </>
        )}

        {step.kind === 'wait' && (
          <Field label="等待时长" hint="ms（倍速生效）">
            <Input
              type="number"
              min={0}
              max={600000}
              step={100}
              value={step.ms}
              disabled={disabled}
              onChange={(e) => onPatch({ ms: Math.max(0, parseInt(e.target.value, 10) || 0) })}
            />
          </Field>
        )}

        {step.kind === 'shell' && (
          <Field label="ADB Shell 命令" hint="整串下发给设备端 shell 解析">
            <Input
              className="mono"
              value={step.cmd}
              placeholder="例如：input keyevent 3"
              disabled={disabled}
              onChange={(e) => onPatch({ cmd: e.target.value })}
            />
          </Field>
        )}

        {step.kind === 'launch' && (
          <Field label="包名" hint="通过 monkey 发 LAUNCHER 事件启动">
            <Input
              className="mono"
              value={step.pkg}
              placeholder="例如：com.tencent.mm"
              disabled={disabled}
              onChange={(e) => onPatch({ pkg: e.target.value.replace(/[^A-Za-z0-9_.]/g, '') })}
            />
          </Field>
        )}

        {step.kind === 'note' && (
          <Field label="说明文字" hint="只用于分节，不执行任何操作">
            <Input
              value={step.text}
              placeholder="例如：这里跳到了设置页"
              disabled={disabled}
              onChange={(e) => onPatch({ text: e.target.value })}
            />
          </Field>
        )}

        {step.kind === 'screenshot' && (
          <p className="text-dim ck-hint ck-hint-inline">执行时会把当前屏幕截图保存到截图目录。</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 录制面板                                                            */
/* ------------------------------------------------------------------ */

interface RecordPanelProps {
  info: RecorderInfo | null;
  status: RecorderStatus | null;
  busy: boolean;
  hasDevice: boolean;
  session: RecordedSession | null;
  frameUrl: string;
  framePick: number;
  onInstall: () => void;
  onAuthorize: () => void;
  onOpenUi: () => void;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onPull: () => void;
  onRefresh: () => void;
  onPickFrame: (f: RecordedFrame) => void;
}

/**
 * 采集端面板。
 *
 * ## 为什么需要设备侧 App
 *
 * Android 5.0 起第三方 App **读不到自己以外的触摸事件**（要 INJECT_EVENTS，
 * 只有系统签名或 Root 有）。所以「在电脑上看用户在手机上点了哪」这条路根本不通 ——
 * 唯一可行的是：设备侧 App 自己拿 MediaProjection 把屏幕内容采集到自己的窗口里，
 * 用户**在那个窗口上操作**，触摸事件落在它自己身上，天然就拿得到。
 *
 * ## 三步式流程
 *
 * 装 → 授权 → 录。每一步都可能被卡住（没装 / 没授权 / 服务没起来），
 * 所以这里按状态**只显示当前该做的那一步**，而不是把三个按钮一起摆出来让用户猜。
 */
function RecordPanel({
  info,
  status,
  busy,
  hasDevice,
  session,
  frameUrl,
  framePick,
  onInstall,
  onAuthorize,
  onOpenUi,
  onStart,
  onPause,
  onStop,
  onPull,
  onRefresh,
  onPickFrame,
}: RecordPanelProps) {
  const recording = !!status?.recording;
  const paused = !!status?.paused;
  const elapsed = status?.elapsedMs ?? 0;

  return (
    <>
      {!info ? (
        <Card>
          <div className="apps-loading">
            <Spinner size={16} />
            <span>正在检测设备上的采集端…</span>
          </div>
        </Card>
      ) : (
        <Card className={`ck-rec ${recording ? 'recording' : ''}`}>
          <div className="ck-rec-head">
            <div className="ck-rec-brand">
              {recording && <span className="ck-rec-dot" />}
              <strong>
                {recording ? (paused ? '已暂停' : '正在录制') : '手机端录制'}
              </strong>
              <Badge tone={info.ready ? (info.authorized ? 'accent' : 'warn') : 'warn'}>
                {!info.installed ? '未安装' : !info.ready ? '服务未启动' : !info.authorized ? '待授权' : '就绪'}
              </Badge>
              {info.versionCode != null && (
                <span className="text-dim ck-rec-ver">v{info.versionCode}</span>
              )}
            </div>

            <div className="ck-rec-actions">
              {!info.installed ? (
                <Button variant="primary" onClick={onInstall} loading={busy} disabled={!hasDevice}>
                  安装采集端
                </Button>
              ) : !info.ready ? (
                <Button variant="primary" onClick={onRefresh} loading={busy} disabled={!hasDevice}>
                  重新检测
                </Button>
              ) : !info.authorized ? (
                <Button variant="primary" onClick={onAuthorize} loading={busy} disabled={!hasDevice}>
                  授权录屏
                </Button>
              ) : recording ? (
                <>
                  <Button variant="default" onClick={onPause} loading={busy}>
                    {paused ? '继续录制' : '暂停'}
                  </Button>
                  <Button variant="danger" onClick={onStop} loading={busy}>
                    停止录制
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={onOpenUi} disabled={!hasDevice}>
                    在手机上打开
                  </Button>
                  <Button variant="primary" onClick={onStart} loading={busy} disabled={!hasDevice}>
                    开始录制
                  </Button>
                </>
              )}
            </div>
          </div>

          <p className="text-dim ck-rec-note">{info.note}</p>

          {/* ---------- 未安装 / 未启动时的操作指引 ---------- */}
          {!info.ready && (
            <ol className="ck-rec-steps">
              {!info.installed ? (
                <>
                  <li>点右上「安装采集端」——它会把这个 App 装到手机上（随本工具一起发布，不需要你自己编译）</li>
                  <li>装好后在手机上打开一次「屏幕录制」，让它把控制服务起起来</li>
                  <li>点「授权录屏」，在手机系统弹窗里点「立即开始」——录屏授权无法绕过，必须你本人确认</li>
                </>
              ) : (
                <>
                  <li>请在手机上打开一次「屏幕录制」App —— 控制端口由它拉起来，不开就连不上</li>
                  <li>回到这里点「重新检测」</li>
                  <li>若仍连不上，确认 USB 已连接且已授权调试</li>
                </>
              )}
            </ol>
          )}

          {info.ready && !info.authorized && (
            <>
              <ol className="ck-rec-steps">
                <li>点右上「授权录屏」——手机上会打开采集端并弹出系统授权框</li>
                <li>在手机上点「立即开始」/「开始录制」确认（Android 要求录屏必须由用户亲自同意）</li>
                <li>回到这里状态会变绿，然后就能开始录制了</li>
              </ol>
              <Notice tone="accent">
                授权只在<strong>第一次</strong>需要。之后只要不卸载采集端，start/stop 都可以直接从电脑发起。
              </Notice>
            </>
          )}

          {/* ---------- 录制中：实时统计 ---------- */}
          {recording && (
            <div className="ck-rec-stats">
              <div className="wn-stat">
                <span className="wn-stat-label">已录时长</span>
                <strong className="wn-stat-value mono">{formatMs(elapsed)}</strong>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">触摸事件</span>
                <strong className="wn-stat-value mono">{status?.touchCount ?? 0}</strong>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">关键帧</span>
                <strong className="wn-stat-value mono">{status?.frameCount ?? 0}</strong>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">系统事件</span>
                <strong className="wn-stat-value mono">{status?.sysCount ?? 0}</strong>
              </div>
              <div className="wn-stat">
                <span className="wn-stat-label">屏幕</span>
                <strong className="wn-stat-value mono">
                  {status?.meta ? `${status.meta.width}×${status.meta.height}` : '—'}
                </strong>
              </div>
            </div>
          )}

          {recording && (
            <Notice tone="accent">
              现在请<strong>在手机上的采集端窗口里操作</strong> —— 只有落在这个窗口上的触摸才会被记录。
              切到别的 App 后的操作录不到（那是 Android 的硬限制，只有 Root 能破）。
            </Notice>
          )}

          {/* ---------- 录完了：拉取 ---------- */}
          {!recording && (status?.touchCount ?? 0) > 0 && (
            <div className="ck-rec-pull">
              <span className="text-dim">
                设备上现有 <strong>{status?.touchCount}</strong> 条触摸、
                <strong>{status?.frameCount}</strong> 张关键帧待取。
              </span>
              <Button variant="primary" onClick={onPull} loading={busy}>
                拉取并转成脚本
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* ---------- 拉取结果预览 ---------- */}
      {session && (
        <Card
          title="录制数据预览"
          subtitle="点关键帧可放大查看，用来核对坐标是否落在目标控件上"
          extra={
            <Badge tone="default">
              {session.touches.length} 触摸 · {session.frames.length} 帧 · {session.sysEvents.length} 事件
            </Badge>
          }
        >
          <div className="col">
            <div className="ck-frame-row">
              {session.frames.length === 0 ? (
                <span className="text-dim">这次录制没有采到关键帧。</span>
              ) : (
                session.frames.map((f) => (
                  <button
                    key={f.id}
                    className={`ck-frame-chip ${framePick === f.id ? 'active' : ''}`}
                    onClick={() => onPickFrame(f)}
                    title={`${formatMs(f.t)} · ${(f.bytes / 1024).toFixed(0)} KB`}
                  >
                    #{f.id}
                    <em>{formatMs(f.t)}</em>
                  </button>
                ))
              )}
            </div>

            {framePick >= 0 && (
              <div className="ck-frame-view">
                {frameUrl ? (
                  <img src={frameUrl} alt={`关键帧 #${framePick}`} />
                ) : (
                  <div className="apps-loading">
                    <Spinner size={16} />
                    <span>正在取帧…</span>
                  </div>
                )}
              </div>
            )}

            {session.sysEvents.length > 0 && (
              <div className="ck-sys-list">
                {session.sysEvents.slice(0, 20).map((e, i) => (
                  <div key={i} className="kv">
                    <span className="kv-key mono">{formatMs(e.t)}</span>
                    <span className="kv-value">{e.label || e.pkg || e.kind}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const cs = Math.floor((ms % 1000) / 100);
  return m > 0
    ? `${m}:${String(r).padStart(2, '0')}.${cs}`
    : `${r}.${cs}s`;
}
