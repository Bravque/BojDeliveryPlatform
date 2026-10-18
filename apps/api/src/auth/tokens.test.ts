import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from './tokens';

function rsaPem() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const ISSUER = 'boj-api';
const AUDIENCE = 'boj-clients';

let privateKey: string;
let publicKey: string;

beforeAll(() => {
  ({ privateKey, publicKey } = rsaPem());
});

const claims = { sub: '01HZX0ABCDEFGHJKMNPQRSTVWX', roles: ['customer', 'rider'], jti: 'jti-1' };

describe('access tokens (RS256)', () => {
  it('round-trips claims through sign/verify', () => {
    const token = signAccessToken(claims, {
      privateKey,
      expiresInSec: 900,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const decoded = verifyAccessToken(token, { publicKey, issuer: ISSUER, audience: AUDIENCE });
    expect(decoded.sub).toBe(claims.sub);
    expect(decoded.roles).toEqual(claims.roles);
    expect(decoded.jti).toBe(claims.jti);
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('rejects an expired token', () => {
    const token = signAccessToken(claims, {
      privateKey,
      expiresInSec: -1,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(() =>
      verifyAccessToken(token, { publicKey, issuer: ISSUER, audience: AUDIENCE }),
    ).toThrow();
  });

  it('rejects a token verified with the wrong public key', () => {
    const token = signAccessToken(claims, {
      privateKey,
      expiresInSec: 900,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const other = rsaPem();
    expect(() =>
      verifyAccessToken(token, { publicKey: other.publicKey, issuer: ISSUER, audience: AUDIENCE }),
    ).toThrow();
  });

  it('rejects a wrong issuer or audience', () => {
    const token = signAccessToken(claims, {
      privateKey,
      expiresInSec: 900,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(() =>
      verifyAccessToken(token, { publicKey, issuer: 'someone-else', audience: AUDIENCE }),
    ).toThrow();
    expect(() =>
      verifyAccessToken(token, { publicKey, issuer: ISSUER, audience: 'wrong-aud' }),
    ).toThrow();
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken(claims, {
      privateKey,
      expiresInSec: 900,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const tampered = `${token}x`;
    expect(() =>
      verifyAccessToken(tampered, { publicKey, issuer: ISSUER, audience: AUDIENCE }),
    ).toThrow();
  });
});
