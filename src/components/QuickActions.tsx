import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, Switch, Spinner } from '@/components/ui';
import { useApp } from '@/store/app';
import { call, tryCall } from '@/lib/ipc';
import { ActionIcon, Icon } from './icons';
import type { FavoriteApp } from '@shared/types';
import {
  QUICK_ACTION_INLINE_MAX,
  QUICK_ACTION_KIND_LABEL,
  QUICK_ACTION_MAX,
  QUICK_ACTION_NEEDS_TARGET,
  QUICK_TARGET_FOREGROUND,
  type QuickAction,
  type QuickActionKind,
  type QuickForegroundInfo,
  type QuickRunResult,
} from '@shared/types';
import './quick-actions.css';

/**
 * 设备行「快捷动作」
 * ============================================================
 * 行上的空间只够放两三个按钮，所以：
 *   - 标记了「行内直显」的动作直接渲染成小按钮（最多 3 个）
 *   - 其余收进「更多」菜单；菜单里还能看到当前前台应用、进配置
 * 配置（增删改 / 排序 / 自定义命令）在弹层里做，改完落盘到本机。
 */

const KIND_ORDER = Object.keys(QUICK_ACTION_KIND_LABEL) as QuickActionKind[];

/** com.tencent.mm → tencent.mm，窄位置显示短名 */
export function shortPkg(pkg?: string): string {
  if (!pkg) return '';
  const seg = pkg.split('.');
  return seg.length > 2 ? seg.slice(-2).join('.') : pkg;
}

/** 动作的作用对象提示；与包名无关的动作返回空 */
function targetHint(a: QuickAction): string {
  if (!QUICK_ACTION_NEEDS_TARGET[a.kind]) return '';
  const t = (a.target || '').trim();
  if (!t || t === QUICK_TARGET_FOREGROUND) return '前台应用';
  return shortPkg(t);
}

/* ------------------------------------------------------------------ */
/* 设备行上的动作条                                                     */
/* ------------------------------------------------------------------ */

export function QuickActionBar({
  serial,
  ready,
  actions,
  onConfigure,
}: {
  serial: string;
  ready: boolean;
  actions: QuickAction[];
  onConfigure: () => void;
}) {
  const toast = useApp((s) => s.toast);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fg, setFg] = useState<QuickForegroundInfo | null>(null);
  const [fgLoading, setFgLoading] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const enabled = useMemo(() => actions.filter((a) => a.enabled), [actions]);
  const inline = useMemo(
    () => enabled.filter((a) => a.inline).slice(0, QUICK_ACTION_INLINE_MAX),
    [enabled],
  );

  const loadForeground = useCallback(async () => {
    setFgLoading(true);
    const info = await tryCall<QuickForegroundInfo>(() => window.adbApi.foregroundApp(serial));
    if (alive.current) {
      setFg(info);
      setFgLoading(false);
    }
  }, [serial]);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setMenuOpen(true);
    void loadForeground();
  };

  const closeMenu = () => setMenuOpen(false);

  /** 执行动作：danger 类默认二次确认，确认文案里带上真实目标 */
  const run = async (a: QuickAction) => {
    if (!ready) {
      toast('warn', '设备未就绪');
      return;
    }
    if (a.confirm) {
      const t = targetHint(a);
      const who = t && t !== '前台应用' ? `（${t}）` : '（当前前台应用）';
      if (!window.confirm(`确定执行「${a.label}」${who}？`)) return;
    }

    setBusy(a.id);
    try {
      const r = await call<QuickRunResult>(() => window.adbApi.runQuickAction(serial, a), {
        silent: true,
      });
      toast('success', `${a.label} 完成`, r?.steps?.join(' → '));
      void loadForeground();
    } catch (e) {
      toast('error', `${a.label} 失败`, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (enabled.length === 0) return null;

  return (
    <span className="qa-bar">
      {inline.map((a) => (
        <button
          key={a.id}
          className={`qa-chip qa-chip-${a.tone || 'default'}`}
          title={`${a.label}${targetHint(a) ? ` · ${targetHint(a)}` : ''}`}
          disabled={!ready || busy === a.id}
          data-qa-chip={a.kind}
          onClick={(e) => {
            e.stopPropagation();
            void run(a);
          }}
        >
          {busy === a.id ? <Spinner size={11} /> : <span className="qa-chip-icon">{ActionIcon[a.kind]}</span>}
          <span>{a.label}</span>
        </button>
      ))}

      <button
        ref={btnRef}
        className={`qa-more ${menuOpen ? 'on' : ''}`}
        title="更多快捷动作"
        aria-label="更多快捷动作"
        aria-expanded={menuOpen}
        data-qa-more
        onClick={(e) => {
          e.stopPropagation();
          menuOpen ? closeMenu() : openMenu();
        }}
      >
        {Icon.bolt}
      </button>

      {menuOpen && pos && (
        <>
          <div className="qa-mask" onClick={closeMenu} />
          <div
            className="qa-menu"
            style={{ top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="qa-menu-head">
              <span className="qa-menu-title">快捷动作</span>
              <button
                className="qa-menu-cfg"
                data-qa-configure
                onClick={() => {
                  closeMenu();
                  onConfigure();
                }}
              >
                配置
              </button>
            </div>

            <div className="qa-menu-fg" data-qa-fg>
              {fgLoading && !fg ? (
                <>
                  <Spinner size={11} /> 正在读取当前前台应用…
                </>
              ) : fg?.packageName ? (
                fg.isLauncher ? (
                  <>
                    当前前台：<b>桌面</b>
                    {fg.lastApp ? ` · 将用最近应用 ${shortPkg(fg.lastApp)}` : ''}
                  </>
                ) : (
                  <>
                    当前前台：<b title={fg.packageName}>{shortPkg(fg.packageName)}</b>
                  </>
                )
              ) : (
                '未识别到前台应用（点动作时再探测）'
              )}
            </div>

            <div className="qa-menu-list">
              {enabled.map((a) => (
                <button
                  key={a.id}
                  className={`qa-menu-item qa-menu-item-${a.tone || 'default'}`}
                  disabled={!ready || busy === a.id}
                  data-qa-item={a.kind}
                  onClick={() => void run(a)}
                >
                  <span className="qa-mi-icon">{ActionIcon[a.kind]}</span>
                  <span className="qa-mi-label">{a.label}</span>
                  <span className="qa-mi-target mono">{targetHint(a)}</span>
                  {busy === a.id && <Spinner size={11} />}
                </button>
              ))}
            </div>

            <div className="qa-menu-foot">
              <button
                className="qa-menu-foot-btn"
                onClick={() => {
                  closeMenu();
                  onConfigure();
                }}
              >
                <span className="qa-foot-icon">{Icon.gear}</span>
                配置快捷动作…
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 配置弹层                                                            */
/* ------------------------------------------------------------------ */

export function QuickActionsDialog({
  open,
  actions,
  onClose,
  onSaved,
}: {
  open: boolean;
  actions: QuickAction[];
  onClose: () => void;
  onSaved: (list: QuickAction[]) => void;
}) {
  const toast = useApp((s) => s.toast);
  const [draft, setDraft] = useState<QuickAction[]>([]);
  const [saving, setSaving] = useState(false);
  const [favs, setFavs] = useState<FavoriteApp[]>([]);

  useEffect(() => {
    if (open) setDraft(actions.map((a) => ({ ...a })));
  }, [open, actions]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const list = await tryCall<FavoriteApp[]>(() => window.adbApi.favoriteApps());
      setFavs(list || []);
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const patch = (i: number, p: Partial<QuickAction>) =>
    setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const move = (i: number, dir: number) =>
    setDraft((d) => {
      const n = [...d];
      const t = i + dir;
      if (t < 0 || t >= n.length) return d;
      [n[i], n[t]] = [n[t], n[i]];
      return n;
    });

  const remove = (i: number) => setDraft((d) => d.filter((_, j) => j !== i));

  const add = (kind: QuickActionKind) => {
    if (draft.length >= QUICK_ACTION_MAX) return;
    const needs = QUICK_ACTION_NEEDS_TARGET[kind];
    const short: Record<QuickActionKind, string> = {
      clearData: '清数据',
      homeReturn: '桌面重进',
      restart: '杀进程重进',
      restartFresh: '清数据重进',
      forceStop: '强制停止',
      launch: '启动',
      screenshot: '截图',
      home: '回桌面',
      back: '返回键',
      wake: '亮屏',
      sleep: '息屏',
      shell: '自定义命令',
    };
    setDraft((d) => [
      ...d,
      {
        id: `qa-${kind}-${Date.now().toString(36)}`,
        label: short[kind],
        kind,
        target: needs ? QUICK_TARGET_FOREGROUND : undefined,
        command: kind === 'shell' ? 'am force-stop {pkg}' : undefined,
        tone: kind === 'clearData' || kind === 'restartFresh' ? 'danger' : 'default',
        confirm: kind === 'clearData' || kind === 'restartFresh',
        enabled: true,
      },
    ]);
  };

  const inlineCount = draft.filter((a) => a.inline).length;

  const save = async () => {
    const bad = draft.find((a) => a.kind === 'shell' && !(a.command || '').trim());
    if (bad) {
      toast('warn', `「${bad.label}」还没有填命令`);
      return;
    }
    setSaving(true);
    try {
      const list = await call<QuickAction[]>(() => window.adbApi.saveQuickActions(draft), {
        silent: true,
      });
      onSaved(list && list.length ? list : draft);
      toast('success', '快捷动作配置已保存');
      onClose();
    } catch (e) {
      toast('error', '保存失败', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('恢复成默认的三条快捷动作？当前配置会被覆盖。')) return;
    try {
      const list = await call<QuickAction[]>(() => window.adbApi.resetQuickActions(), {
        silent: true,
      });
      setDraft(list || []);
      onSaved(list || []);
    } catch (e) {
      toast('error', '恢复默认失败', (e as Error).message);
    }
  };

  if (!open) return null;

  return (
    <div className="qa-dialog-mask" onClick={onClose}>
      <div className="qa-dialog" data-qa-dialog onClick={(e) => e.stopPropagation()}>
        <header className="qa-dialog-head">
          <div>
            <h3 className="qa-dialog-title">快捷动作配置</h3>
            <p className="qa-dialog-sub">
              设备行上最多直显 {QUICK_ACTION_INLINE_MAX} 个按钮，其余收进「更多」菜单；顺序即显示顺序
            </p>
          </div>
          <button className="qa-dialog-close" onClick={onClose} title="关闭">
            {Icon.close}
          </button>
        </header>

        <div className="qa-dialog-body">
          {draft.length === 0 ? (
            <p className="text-dim">还没有动作，从下面挑几个添加。</p>
          ) : (
            draft.map((a, i) => {
              const needs = QUICK_ACTION_NEEDS_TARGET[a.kind];
              const fixed = !!a.target && a.target !== QUICK_TARGET_FOREGROUND;
              return (
                <div className={`qa-cfg-row ${a.enabled ? '' : 'off'}`} key={a.id}>
                  <div className="qa-cfg-main">
                    <Switch
                      checked={a.enabled}
                      onChange={(v) => patch(i, { enabled: v })}
                    />
                    <span
                      className={`qa-cfg-icon qa-cfg-icon-${a.tone || 'default'}`}
                      title={QUICK_ACTION_KIND_LABEL[a.kind]}
                    >
                      {ActionIcon[a.kind]}
                    </span>
                    <Input
                      className="qa-cfg-label"
                      value={a.label}
                      maxLength={12}
                      onChange={(e) => patch(i, { label: e.target.value })}
                    />
                    <span className="qa-cfg-kind">{QUICK_ACTION_KIND_LABEL[a.kind]}</span>

                    {needs && (
                      <>
                        <Select
                          className="qa-cfg-mode"
                          value={fixed ? '__fixed__' : QUICK_TARGET_FOREGROUND}
                          onChange={(e) =>
                            patch(i, {
                              target:
                                e.target.value === QUICK_TARGET_FOREGROUND
                                  ? QUICK_TARGET_FOREGROUND
                                  : '',
                            })
                          }
                          options={[
                            { value: QUICK_TARGET_FOREGROUND, label: '当前前台应用' },
                            { value: '__fixed__', label: '指定包名' },
                          ]}
                        />
                        {fixed && (
                          <Input
                            className="qa-cfg-pkg mono"
                            list="qa-fav-pkgs"
                            placeholder="com.example.app"
                            value={a.target || ''}
                            onChange={(e) => patch(i, { target: e.target.value })}
                          />
                        )}
                      </>
                    )}
                  </div>

                  <div className="qa-cfg-sub">
                    <label className="qa-cfg-check">
                      <input
                        type="checkbox"
                        checked={!!a.inline}
                        disabled={!a.inline && inlineCount >= QUICK_ACTION_INLINE_MAX}
                        onChange={(e) => patch(i, { inline: e.target.checked })}
                      />
                      行内直显
                    </label>
                    <label className="qa-cfg-check">
                      <input
                        type="checkbox"
                        checked={!!a.confirm}
                        onChange={(e) => patch(i, { confirm: e.target.checked })}
                      />
                      执行前确认
                    </label>

                    {a.kind === 'shell' && (
                      <Input
                        className="qa-cfg-cmd mono"
                        placeholder="shell 命令，支持 {pkg} / {serial}"
                        value={a.command || ''}
                        onChange={(e) => patch(i, { command: e.target.value })}
                      />
                    )}

                    <span className="qa-cfg-ops">
                      <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} title="上移">
                        {Icon.up}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={i === draft.length - 1}
                        onClick={() => move(i, 1)}
                        title="下移"
                      >
                        {Icon.down}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="qa-cfg-del"
                        onClick={() => remove(i)}
                        title="删除"
                      >
                        删除
                      </Button>
                    </span>
                  </div>
                </div>
              );
            })
          )}

          <div className="qa-cfg-add">
            <span className="res-label">
              添加动作 <em className="field-hint">{draft.length}/{QUICK_ACTION_MAX}</em>
            </span>
            <div className="qa-cfg-add-list">
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  className="qa-add-btn"
                  disabled={draft.length >= QUICK_ACTION_MAX}
                  onClick={() => add(k)}
                >
                  <span className="qa-add-icon">{ActionIcon[k]}</span>
                  {QUICK_ACTION_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="qa-dialog-foot">
          <Button size="sm" variant="ghost" onClick={reset}>
            恢复默认
          </Button>
          <span className="qa-dialog-foot-right">
            <Button size="sm" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" variant="primary" loading={saving} onClick={save} data-qa-save>
              保存
            </Button>
          </span>
        </footer>

        <datalist id="qa-fav-pkgs">
          {favs.map((f) => (
            <option key={f.packageName} value={f.packageName}>
              {f.label || f.packageName}
            </option>
          ))}
        </datalist>
      </div>
    </div>
  );
}
