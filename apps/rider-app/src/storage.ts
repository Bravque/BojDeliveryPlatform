/**
 * Session token persistence. A tiny abstraction so `createRiderModel` can be unit-tested with an
 * in-memory store. The default implementation uses the web `localStorage` when present (the app runs
 * in-browser via expo-web); on a native runtime where it's absent it degrades to a no-op (native
 * secure storage, e.g. AsyncStorage/SecureStore, is a deferred follow-up).
 */
export interface TokenStore {
  load(): string | null;
  save(token: string): void;
  clear(): void;
}

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'boj.rider.token';

function webStorage(): WebStorage | null {
  try {
    const g = globalThis as { localStorage?: WebStorage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The default store: web localStorage when available, otherwise a no-op. */
export const webTokenStore: TokenStore = {
  load() {
    try {
      return webStorage()?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  },
  save(token) {
    try {
      webStorage()?.setItem(KEY, token);
    } catch {
      // non-fatal: the session just won't survive a reload
    }
  },
  clear() {
    try {
      webStorage()?.removeItem(KEY);
    } catch {
      // ignore
    }
  },
};
