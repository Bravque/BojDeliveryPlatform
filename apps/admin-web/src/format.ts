/**
 * Presentation helpers for the admin console. Money everywhere in the platform is integer cents KES
 * (`@boj/money` does the arithmetic); this only formats for display.
 */

/** Integer cents → `KES 1,500.00`. */
export function formatKes(cents: number): string {
  const shillings = cents / 100;
  return `KES ${shillings.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** A 0–1 rate → a percentage like `12.50%`. */
export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** The last 30 days, ending today, as a `{ periodStart, periodEnd }` of YYYY-MM-DD strings. */
export function last30Days(now: Date = new Date()): { periodStart: string; periodEnd: string } {
  const periodEnd = now.toISOString().slice(0, 10);
  const periodStart = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return { periodStart, periodEnd };
}

/** Human label for a snake_case code (status, classification…) → Title Case. */
export function titleCase(code: string): string {
  return code
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** An ISO timestamp → a short local date-time, e.g. `25 Oct 2026, 14:05`. Empty string if absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleString('en-KE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** An ISO timestamp → a short relative age like `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
