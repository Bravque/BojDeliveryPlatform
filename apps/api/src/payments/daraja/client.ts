/**
 * Thin Daraja (Safaricom M-Pesa) HTTP client (doc 07 §2). Handles OAuth token fetch + caching and
 * authenticated POSTs. Uses the global `fetch` (Node 20) so there is no HTTP-client dependency. All
 * Daraja-specific wire details live here and in the gateway — nothing else in the app knows them.
 */

export interface DarajaClientConfig {
  /** API base, e.g. https://sandbox.safaricom.co.ke (no trailing slash needed). */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Clock for token-cache expiry; injectable for tests. */
  now?: () => number;
}

export interface DarajaHttpError extends Error {
  httpStatus: number;
  body: unknown;
}

export interface DarajaClient {
  getToken(): Promise<string>;
  postJson<T>(path: string, payload: unknown): Promise<T>;
}

/** Refresh the cached token this many ms before it actually expires. */
const TOKEN_SAFETY_MS = 30_000;

export function createDarajaClient(cfg: DarajaClientConfig): DarajaClient {
  const now = cfg.now ?? (() => Date.now());
  const base = cfg.baseUrl.replace(/\/+$/, '');
  let cached: { token: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (cached && cached.expiresAt > now() + TOKEN_SAFETY_MS) {
      return cached.token;
    }
    const basic = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
    const res = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) {
      throw new Error(`Daraja OAuth failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: string | number };
    if (!body.access_token) {
      throw new Error('Daraja OAuth returned no access_token');
    }
    const ttlMs = Number(body.expires_in ?? 3599) * 1000;
    cached = { token: body.access_token, expiresAt: now() + ttlMs };
    return cached.token;
  }

  async function postJson<T>(path: string, payload: unknown): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const err = new Error(`Daraja ${path} failed: HTTP ${res.status}`) as DarajaHttpError;
      err.httpStatus = res.status;
      err.body = body;
      throw err;
    }
    return body as T;
  }

  return { getToken, postJson };
}
