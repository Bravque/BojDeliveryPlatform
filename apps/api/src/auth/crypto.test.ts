import { describe, expect, it } from 'vitest';
import {
  generateOtp,
  hashOpaqueToken,
  hashOtp,
  hashPassword,
  newOpaqueToken,
  newUlid,
  safeEqualHex,
  verifyPassword,
} from './crypto';

describe('passwords (argon2id)', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret');
    expect(await verifyPassword(hash, 'not-it')).toBe(false);
  });

  it('returns false (never throws) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('OTP generation & hashing', () => {
  it('generates a zero-padded numeric code of the requested length', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
      expect(generateOtp(4)).toMatch(/^\d{4}$/);
    }
  });

  it('rejects out-of-range lengths', () => {
    expect(() => generateOtp(0)).toThrow(RangeError);
    expect(() => generateOtp(10)).toThrow(RangeError);
  });

  it('hashes an OTP deterministically per pepper, and differently across inputs', () => {
    const h = hashOtp('123456', 'pepper-a');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtp('123456', 'pepper-a')).toBe(h); // deterministic
    expect(hashOtp('123457', 'pepper-a')).not.toBe(h); // different code
    expect(hashOtp('123456', 'pepper-b')).not.toBe(h); // different pepper
  });
});

describe('opaque tokens', () => {
  it('mints a URL-safe token of the requested byte length', () => {
    const token = newOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newOpaqueToken()).not.toBe(token);
  });

  it('hashes opaque tokens deterministically and distinctly', () => {
    const token = newOpaqueToken();
    const h = hashOpaqueToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(token)).toBe(h);
    expect(hashOpaqueToken(newOpaqueToken())).not.toBe(h);
  });
});

describe('safeEqualHex', () => {
  it('compares equal / unequal / mismatched-length digests', () => {
    const a = hashOtp('111111', 'p');
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, hashOtp('222222', 'p'))).toBe(false);
    expect(safeEqualHex(a, 'ab')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('newUlid', () => {
  it('returns a 26-char Crockford base32 ULID, unique per call', () => {
    const a = newUlid();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newUlid()).not.toBe(a);
  });
});
