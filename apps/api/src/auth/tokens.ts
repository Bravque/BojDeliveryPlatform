import jwt from 'jsonwebtoken';

/**
 * Stateless access-token signing/verification (doc 06 §2.3). Algorithm is **RS256**: an
 * RSA private key signs, the public key verifies. Keys are passed in by callers so this module
 * has no environment or key-management coupling (that is wired at the app edge in a later
 * increment). Refresh tokens are opaque and handled separately (see `crypto.ts` + DB).
 */

export interface AccessTokenClaims {
  /** `sub` — the user's public ULID. */
  sub: string;
  /** Roles held by the principal, used by the RBAC layer. */
  roles: string[];
  /** `jti` — unique token id, for revocation/audit. */
  jti: string;
}

export interface SignAccessTokenOptions {
  /** RS256 private key (PEM). */
  privateKey: string;
  /** Lifetime in seconds (short-lived, e.g. 900 = 15 min). */
  expiresInSec: number;
  issuer: string;
  audience: string;
}

/** Sign a short-lived RS256 access token. */
export function signAccessToken(claims: AccessTokenClaims, opts: SignAccessTokenOptions): string {
  return jwt.sign({ roles: claims.roles }, opts.privateKey, {
    algorithm: 'RS256',
    subject: claims.sub,
    jwtid: claims.jti,
    expiresIn: opts.expiresInSec,
    issuer: opts.issuer,
    audience: opts.audience,
  });
}

export interface VerifyAccessTokenOptions {
  /** RS256 public key (PEM). */
  publicKey: string;
  issuer: string;
  audience: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  /** Expiry (epoch seconds). */
  exp: number;
  /** Issued-at (epoch seconds). */
  iat: number;
}

/**
 * Verify an RS256 access token. Throws (jsonwebtoken `JsonWebTokenError` /
 * `TokenExpiredError`) on an invalid, tampered, wrong-key, wrong-issuer/audience or expired
 * token — callers (the auth middleware, a later increment) translate that into a `401`.
 */
export function verifyAccessToken(
  token: string,
  opts: VerifyAccessTokenOptions,
): VerifiedAccessToken {
  const decoded = jwt.verify(token, opts.publicKey, {
    algorithms: ['RS256'],
    issuer: opts.issuer,
    audience: opts.audience,
  }) as jwt.JwtPayload;

  return {
    sub: String(decoded.sub),
    roles: Array.isArray(decoded.roles) ? (decoded.roles as string[]) : [],
    jti: String(decoded.jti),
    exp: Number(decoded.exp),
    iat: Number(decoded.iat),
  };
}
