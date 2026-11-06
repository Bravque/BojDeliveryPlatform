/**
 * Presentation helpers. Money everywhere in the platform is integer cents KES (`@boj/money` does the
 * arithmetic); this only formats for display, so it lives here rather than pulling a dep into the UI.
 */

/** Integer cents → `KES 1,500.00`. */
export function formatKes(cents: number): string {
  const shillings = cents / 100;
  return `KES ${shillings.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

/** Human label for an order status (snake_case → Title Case). */
export function statusLabel(status: string): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
