import React from 'react';
import './ui.css';

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
}

export function Card({
  title,
  subtitle,
  extra,
  children,
  padding = true,
  className = '',
}: CardProps) {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <header className="card-head">
          <div className="card-head-text">
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {extra && <div className="card-extra">{extra}</div>}
        </header>
      )}
      <div className={padding ? 'card-body' : ''}>{children}</div>
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
