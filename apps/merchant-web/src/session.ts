/**
 * Session persistence for the dashboard: the access token lives in `localStorage` so a refresh keeps
 * the merchant signed in. (Refresh-token rotation is deferred — on a 401 the app clears and returns
 * to the login screen.) Storage access is guarded so the module is safe under SSR/tests.
 */
const KEY = 'boj.merchant.token';

export function loadToken(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // Non-fatal: the session just won't survive a reload.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
