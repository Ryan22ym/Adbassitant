import React, { useState } from 'react';
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
}: CardProps) {
  /*
   * 折叠只是**视觉收起**：body 一直留在 DOM 里（CSS display:none），
   * 不条件渲染。两个原因：
   *   1. 折叠卡片里的按钮（如「检查更新」）要能被验收脚本 querySelector 到；
   *   2. 卡片内部的 useEffect（自检、检查更新）保持常驻，展开时立刻有结果。
   */
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !collapsible || open;

  const toggle = collapsible ? () => setOpen((v) => !v) : undefined;

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
                    setOpen((v) => !v);
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
            /* 右侧操作区独立可点（如折叠态下的「检查更新」），别让点击穿到标题的折叠开关 */
            <div className="card-extra" onClick={(e) => e.stopPropagation()}>
              {extra}
            </div>
          )}
        </header>
      )}
      <div
        className={`${padding ? 'card-body' : ''} ${expanded ? '' : 'card-body-collapsed'}`}
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

export function Input({ suffix, className = '', ...rest }: InputProps) {
  if (suffix) {
    return (
      <span className="input-wrap">
        <input className={`input ${className}`} {...rest} />
        <span className="input-suffix">{suffix}</span>
      </span>
    );
  }
  return <input className={`input ${className}`} {...rest} />;
}

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
  options: { value: T; label: string }[];
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
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
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
