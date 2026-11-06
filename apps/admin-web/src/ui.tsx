/**
 * Presentational primitives for the admin console (className-based, styled by styles/app.css).
 * No business logic — the section views compose these into screens. Mirrors the merchant-web
 * `ui.tsx` convention, with admin-specific additions (Stat card, Select, StatusBadge).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Brand(): JSX.Element {
  return (
    <div className="brand">
      <span className="brand__mark">b</span>
      <span className="brand__name">Boj</span>
      <span className="brand__tag">Admin</span>
    </div>
  );
}

type Variant = 'primary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  small,
  block,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  small?: boolean;
  block?: boolean;
}): JSX.Element {
  const classes = [
    'btn',
    `btn--${variant}`,
    small ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}

export type Tone = 'ok' | 'off' | 'warn' | 'info' | 'neutral';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}): JSX.Element {
  const cls = tone === 'neutral' ? 'badge' : `badge badge--${tone}`;
  return <span className={cls}>{children}</span>;
}

/** Map a domain lifecycle status to a badge tone. Unknown statuses fall back to neutral. */
export function toneForStatus(status: string): Tone {
  switch (status) {
    case 'approved':
    case 'paid':
    case 'completed':
    case 'delivered':
    case 'succeeded':
    case 'active':
    case 'online':
      return 'ok';
    case 'suspended':
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'off';
    case 'pending':
    case 'processing':
    case 'requested':
    case 'draft':
    case 'partially_refunded':
    case 'refunded':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inline?: boolean;
}): JSX.Element {
  return (
    <label className={`field${props.inline ? ' field--inline' : ''}`}>
      <span className="field__label">{props.label}</span>
      <input
        className="input"
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function Select(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  inline?: boolean;
}): JSX.Element {
  return (
    <label className={`field${props.inline ? ' field--inline' : ''}`}>
      <span className="field__label">{props.label}</span>
      <select
        className="select"
        value={props.value}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled KPI figure. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      {hint !== undefined && <div className="kpi__hint">{hint}</div>}
    </div>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">{props.title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="modal__body">{props.children}</div>
        {props.footer && <footer className="modal__foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer(props: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  return (
    <div className="drawer-overlay" onClick={props.onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer__head">
          <div>
            <h2 className="drawer__title">{props.title}</h2>
            {props.subtitle}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="drawer__body">{props.children}</div>
        {props.footer && <footer className="drawer__foot">{props.footer}</footer>}
      </aside>
    </div>
  );
}

export function Toast({ message }: { message: string }): JSX.Element {
  return (
    <div className="toast" role="status">
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}

export function Spinner(): JSX.Element {
  return (
    <div className="center">
      <div className="spinner" role="status" aria-label="Loading" />
    </div>
  );
}
