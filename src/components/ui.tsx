import React, { useEffect, useState } from 'react';
import './ui.css';
import { Icon } from './icons';

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  block?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  loading,
  icon,
  block,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${block ? 'btn-block' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

interface CardProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  padding?: boolean;
  className?: string;
  /** 可折叠：标题行整行可点，收起后只留标题与右侧操作区 */
  collapsible?: boolean;
  /** 初始展开状态（仅 collapsible 时生效），默认展开 */
  defaultOpen?: boolean;
  /** 收起时替换 subtitle 显示的内容（把当前值带出来用） */
  collapsedSubtitle?: React.ReactNode;
  /**
   * 受控展开态。传了它就由外部说了算（内部不再自持状态）——
   * 「软件更新」要能在用户点了收起态里的按钮后**自己展开**
   * （否则点「下载并更新」后进度与「立即更新并重启」都藏在收起区里，看着像没反应）。
   */
  open?: boolean;
  /** 受控模式下的开合回调（不传 open 时忽略） */
  onToggle?: (open: boolean) => void;
}

export function Card({
  title,
  subtitle,
  extra,
  children,
  padding = true,
  className = '',
  collapsible = false,
  defaultOpen = true,
  collapsedSubtitle,
  open,
  onToggle,
}: CardProps) {
  /*
   * 折叠只是**视觉收起**：body 一直留在 DOM 里（CSS display:none），
   * 不条件渲染。两个原因：
   *   1. 折叠卡片里的按钮（如「检查更新」）要能被验收脚本 querySelector 到；
   *   2. 卡片内部的 useEffect（自检、检查更新）保持常驻，展开时立刻有结果。
   */
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const controlled = open !== undefined;
  const isOpen = controlled ? !!open : selfOpen;
  const expanded = !collapsible || isOpen;

  /*
   * defaultOpen 变化时同步内部展开态。
   *
   * 起因：界面配置（Conf/panels.json）是启动后**异步**取回来的，Card 往往已经按
   * store 里的出厂默认挂载过一次 —— 而 useState 的初始值只取第一次。
   * 没有这一段，用户把某块改成「默认收起」就不会生效。
   *
   * 受控模式（传了 open）不受影响；defaultOpen 本身是配置派生值，
   * 整个生命周期里只变一次（出厂默认 → 用户配置），不会反复覆盖用户的手动开合。
   */
  useEffect(() => {
    if (!controlled) setSelfOpen(defaultOpen);
  }, [defaultOpen, controlled]);

  const flip = () => {
    if (!collapsible) return;
    if (controlled) onToggle?.(!isOpen);
    else setSelfOpen((v) => !v);
  };

  const toggle = collapsible ? flip : undefined;

  return (
    <section
      className={`card ${collapsible ? 'card-collapsible' : ''} ${
        expanded ? '' : 'is-collapsed'
      } ${className}`}
    >
      {(title || extra) && (
        <header
          className={`card-head ${collapsible ? 'card-head-toggle' : ''}`}
          onClick={toggle}
          onKeyDown={
            collapsible
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    flip();
                  }
                }
              : undefined
          }
          role={collapsible ? 'button' : undefined}
          tabIndex={collapsible ? 0 : undefined}
          aria-expanded={collapsible ? expanded : undefined}
        >
          <div className="card-head-text">
            {title && (
              <h3 className="card-title">
                {title}
                {collapsible && (
                  <span className="card-toggle-icon" aria-hidden="true">
                    {expanded ? Icon.up : Icon.down}
                  </span>
                )}
              </h3>
            )}
            {subtitle && <p className="card-subtitle">{expanded ? subtitle : collapsedSubtitle ?? subtitle}</p>}
          </div>
          {extra && (
            /*
             * 右侧操作区独立可点（如折叠态下的「检查更新」），别让点击穿到标题的折叠开关。
             * 键盘同理：按钮上按空格/回车会被 header 的 keydown 吞掉（preventDefault 后
             * 按钮自己的 click 不再触发），所以这里也要拦一道。
             */
            <div
              className="card-extra"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {extra}
            </div>
          )}
        </header>
      )}
      <div
        /*
         * card-slot：内容容器的**固定**类名（padding={false} 时原本没有类名，
         * 页面想对「卡片内容区」做 flex 布局就无从下手 —— Logcat 页要让它当
         * 纵向弹性容器，见 pages.css 的 .logcat-card）。
         */
        className={`card-slot ${padding ? 'card-body' : ''} ${expanded ? '' : 'card-body-collapsed'}`}
        aria-hidden={collapsible ? !expanded : undefined}
      >
        {children}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Field / Input / Select                                              */
/* ------------------------------------------------------------------ */

interface FieldProps {
  label?: string;
  hint?: string;
  children: React.ReactNode;
  inline?: boolean;
}

export function Field({ label, hint, children, inline }: FieldProps) {
  return (
    <label className={`field ${inline ? 'field-inline' : ''}`}>
      {label && (
        <span className="field-label">
          {label}
          {hint && <em className="field-hint">{hint}</em>}
        </span>
      )}
      {children}
    </label>
  );
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  suffix?: React.ReactNode;
}

/*
 * 用 forwardRef 暴露 input 节点 —— 「快捷动作」的「指定包名」输入框是切到该模式后
 * 才挂上去的，必须能在挂载后立刻聚焦（见 QuickActions 里 pkgRefs 的用法）。
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { suffix, className = '', ...rest },
  ref,
) {
  if (suffix) {
    return (
      <span className="input-wrap">
        <input ref={ref} className={`input ${className}`} {...rest} />
        <span className="input-suffix">{suffix}</span>
      </span>
    );
  }
  return <input ref={ref} className={`input ${className}`} {...rest} />;
});

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[];
}

export function Select({ options, className = '', ...rest }: SelectProps) {
  return (
    <select className={`select ${className}`} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function Textarea({ className = '', ...rest }: TextareaProps) {
  return <textarea className={`textarea mono ${className}`} spellCheck={false} {...rest} />;
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <label className={`switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span
        className={`switch ${checked ? 'on' : ''}`}
        role="switch"
        aria-checked={checked}
        onClick={() => !disabled && onChange(!checked)}
      >
        <span className="switch-knob" />
      </span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented control                                                   */
/* ------------------------------------------------------------------ */

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  /**
   * `hidden: true` = 这一项**留在 DOM 里、但界面上不显示**。
   *
   * 为什么不直接从数组里删掉（v1.1.17 设置页「主题模式」用得上）：
   *   ① 回归脚本是靠**真实点击**分段项切主题的（check-arknights 全程如此），
   *      删了就点不到，等于把一个能跑的回归弄成假 FAIL；
   *   ② value 落在「不存在的选项」上时分段控件一个都不高亮，
   *      看起来像坏了 —— 保留 DOM 就还能正确标出当前项（只是看不见）。
   * display:none 的元素 Tab 聚焦不到，所以对用户来说就是「没有这个入口」；
   * 程序化 `.click()` 不受影响。
   */
  options: { value: T; label: string; hidden?: boolean }[];
  size?: 'sm' | 'md';
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: SegmentedProps<T>) {
  return (
    <div className={`segmented segmented-${size}`}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`segmented-item ${value === o.value ? 'active' : ''}`}
          style={o.hidden ? { display: 'none' } : undefined}
          aria-hidden={o.hidden || undefined}
          tabIndex={o.hidden ? -1 : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Slider（v1.1.13，透明玻璃主题的参数滑杆）                            */
/* ------------------------------------------------------------------ */

interface SliderProps {
  /** 当前值（整数） */
  value: number;
  /** 取值闭区间，默认 0~100 */
  min?: number;
  max?: number;
  /** 步长，默认 1（两个玻璃参数都是整数百分比） */
  step?: number;
  /** 拖动过程中实时回调（写 DOM，让画面立刻跟手） */
  onInput: (v: number) => void;
  /**
   * 松手（change）时回调 —— 落盘用它。
   * 🔴 落盘和实时变更是**两条路**：拖动时每像素都写一次 settings.json
   *    会把磁盘刷爆（而且是同步 IPC），所以拖动只写 DOM，松手才存。
   */
  onCommit?: (v: number) => void;
  disabled?: boolean;
}

/**
 * 一条原生 <input type="range">，外加右侧的数值读数。
 *
 * 用原生 range 而不是自绘：键盘可调、无障碍支持都是白送的，
 * 而这个控件只需要「拖得动、看得见当前值」两件事。
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onInput,
  onCommit,
  disabled,
}: SliderProps) {
  return (
    <div className={`slider ${disabled ? 'is-disabled' : ''}`}>
      <input
        className="slider-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      <span className="slider-value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

type BadgeTone = 'default' | 'success' | 'warn' | 'danger' | 'accent';

export function Badge({
  tone = 'default',
  children,
  dot,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <i className="badge-dot" />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Empty / Loading                                                     */
/* ------------------------------------------------------------------ */

export function Empty({
  title,
  desc,
  action,
  icon,
}: {
  title: string;
  desc?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {desc && <p className="empty-desc">{desc}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

/* ------------------------------------------------------------------ */
/* Notice                                                              */
/* ------------------------------------------------------------------ */

export function Notice({
  tone = 'accent',
  children,
  onClose,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <div className="notice-body">{children}</div>
      {onClose && (
        <button className="notice-close" onClick={onClose} title="关闭">
          ×
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rotate / Progress                                                   */
/* ------------------------------------------------------------------ */

export function Progress({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${v}%` }} />
    </div>
  );
}
