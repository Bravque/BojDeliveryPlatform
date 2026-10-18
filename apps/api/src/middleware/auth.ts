import type { RequestHandler } from 'express';
import { verifyAccessToken } from '../auth/tokens';
import { unauthorized } from '../http/errors';

/** The authenticated principal resolved from a verified access token. */
export interface Principal {
  ulid: string;
  roles: string[];
  jti: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export interface RequireAuthOptions {
  publicKey: string;
  issuer: string;
  audience: string;
}

/**
 * Guard that requires a valid `Authorization: Bearer <access_jwt>`. On success it attaches the
 * principal to `req.principal`; otherwise it forwards a 401 (missing, malformed, invalid,
 * wrong-issuer/audience, or expired token) — never leaking why.
 */
export function createRequireAuth(opts: RequireAuthOptions): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      next(unauthorized('Authentication required'));
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const decoded = verifyAccessToken(token, opts);
      req.principal = { ulid: decoded.sub, roles: decoded.roles, jti: decoded.jti };
      next();
    } catch {
      next(unauthorized('Invalid or expired token'));
    }
  };
}
