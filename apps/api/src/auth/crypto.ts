import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { ulid } from 'ulid';

/**
 * Auth crypto primitives. Pure functions with no environment coupling — secrets (OTP pepper)
 * and keys are passed in by callers, so this module is trivially unit-testable and the wiring
 * lives at the edges. Nothing here ever logs or returns a plaintext secret.
 */

/** A fresh ULID (26-char Crockford base32) for public identifiers / token families. */
export function newUlid(): string {
  return ulid();
}

/** Hash a dashboard password with Argon2id (doc 06 §2.2). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Verify a password against an Argon2id hash. Never throws — a bad hash returns false. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Cryptographically-random numeric OTP, zero-padded to `length` digits (default 6). */
export function generateOtp(length = 6): string {
  if (length < 1 || length > 9) {
    throw new RangeError(`OTP length must be between 1 and 9, received: ${length}`);
  }
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}

/** HMAC-SHA256 of an OTP using a server-side pepper. Low-entropy codes are never stored raw. */
export function hashOtp(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(code).digest('hex');
}

/** A high-entropy opaque token (default 32 bytes) as a URL-safe string — e.g. a refresh token. */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 of a high-entropy opaque token for at-rest storage. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}
