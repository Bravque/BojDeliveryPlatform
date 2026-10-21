import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { tooManyRequests } from '../http/errors';

/**
 * HTTP hardening (doc 10 §8, Phase 8). `helmet` sets conservative security headers; the rate
 * limiters cap abusive clients (a global cap plus a stricter cap on the auth surface, layered on
 * top of the MySQL-backed OTP throttle); `corsAllowlist` reflects only explicitly allow-listed
 * origins. Limits/origins are injected (not read from env here) so `createApp` stays a pure factory.
 */

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

/** Conservative security headers. HSTS only bites over HTTPS, so it is safe in all environments. */
export function securityHeaders(): RequestHandler {
  return helmet();
}

/**
 * Fixed-window rate limiter keyed by client IP. Over the limit → the standard `RATE_LIMITED` (429)
 * error envelope via the central error handler. Single-instance memory store (Redis store is a
 * deploy-time swap when running multi-instance).
 */
export function createRateLimiter(opts: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // We set `trust proxy` ourselves; skip express-rate-limit's permissive-proxy warning.
    validate: { trustProxy: false, xForwardedForHeader: false },
    handler: (_req, _res, next) => next(tooManyRequests()),
  });
}

/**
 * CORS allow-list (hand-rolled — no dependency). Reflects the request `Origin` only when it is
 * explicitly allow-listed, and answers pre-flight `OPTIONS` with 204. An empty allow-list means
 * no cross-origin access (same-origin only).
 */
export function corsAllowlist(allowedOrigins: string[]): RequestHandler {
  const allow = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (typeof origin === 'string' && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,Idempotency-Key,X-Request-Id',
      );
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
