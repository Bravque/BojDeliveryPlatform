/**
 * Presentational primitives for the merchant dashboard (className-based, styled by styles/app.css).
 * Mirrors the customer-app `ui.tsx` convention: no business logic — `App.tsx` and `orders.tsx`
 * compose these into screens.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Brand(): JSX.Element {
  return (
    <div className="brand">
      <span className="brand__mark">b</span>
      <span className="brand__name">Boj</span>
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

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <label className="field">
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
