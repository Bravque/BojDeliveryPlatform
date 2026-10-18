import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from './config';
import { hashOpaqueToken } from './crypto';
import type { InsertRefreshTokenInput, RefreshTokenRecord, SessionRepo, UserRecord } from './repo';
import { createSessionService } from './session-service';
import { verifyAccessToken } from './tokens';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function config(): AuthConfig {
  return {
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'boj-api',
    JWT_AUDIENCE: 'boj-clients',
    ACCESS_TOKEN_TTL_SEC: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    OTP_LENGTH: 6,
    OTP_TTL_SEC: 300,
    OTP_MAX_ATTEMPTS: 5,
    OTP_PEPPER: 'test-pepper-0123456789',
    OTP_REQUEST_WINDOW_SEC: 3600,
    OTP_MAX_PER_PHONE: 5,
    OTP_MAX_PER_IP: 20,
    SMS_PROVIDER: 'mock',
  };
}

interface TokenRow {
  id: number;
  userId: number;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

class FakeSessionRepo implements SessionRepo {
  readonly tokens: TokenRow[] = [];
  private readonly users: UserRecord[] = [];
  private readonly rolesByUser = new Map<number, string[]>();
  private seq = 0;

  addUser(user: UserRecord, roles: string[]): void {
    this.users.push(user);
    this.rolesByUser.set(user.id, roles);
  }

  seedToken(input: {
    userId: number;
    plaintext: string;
    familyId: string;
    expiresAt: Date;
    revokedAt?: Date | null;
  }): TokenRow {
    const row: TokenRow = {
      id: ++this.seq,
      userId: input.userId,
      tokenHash: hashOpaqueToken(input.plaintext),
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: input.revokedAt ?? null,
    };
    this.tokens.push(row);
    return row;
  }

  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const t = this.tokens.find((x) => x.tokenHash === tokenHash);
    return Promise.resolve(
      t
        ? {
            id: t.id,
            userId: t.userId,
            familyId: t.familyId,
            expiresAt: t.expiresAt,
            revokedAt: t.revokedAt,
          }
        : null,
    );
  }

  revokeRefreshToken(id: number, revokedAt: Date): Promise<void> {
    const t = this.tokens.find((x) => x.id === id);
    if (t && !t.revokedAt) {
      t.revokedAt = revokedAt;
    }
    return Promise.resolve();
  }

  revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
    for (const t of this.tokens) {
      if (t.familyId === familyId && !t.revokedAt) {
        t.revokedAt = revokedAt;
      }
    }
    return Promise.resolve();
  }

  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void> {
    this.tokens.push({
      id: ++this.seq,
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return Promise.resolve();
  }

  findUserById(id: number): Promise<UserRecord | null> {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }

  getUserRoleCodes(userId: number): Promise<string[]> {
    return Promise.resolve(this.rolesByUser.get(userId) ?? []);
  }
}

const NOW = new Date('2026-01-01T00:00:00.000Z');
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);

function setup() {
  const repo = new FakeSessionRepo();
  repo.addUser(
    {
      id: 1,
      ulid: 'U1',
      phoneE164: '+254712345678',
      email: null,
      displayName: null,
      status: 'active',
    },
    ['customer'],
  );
  const svc = createSessionService({ repo, config: config(), now: () => NOW });
  return { repo, svc };
}

describe('session service', () => {
  it('rotates a valid refresh token: new tokens, old revoked, same family', async () => {
    const { repo, svc } = setup();
    const seeded = repo.seedToken({
      userId: 1,
      plaintext: 'tok-1',
      familyId: 'F1',
      expiresAt: future,
    });

    const result = await svc.refresh('tok-1');

    expect(result.refresh).not.toBe('tok-1');
    expect(seeded.revokedAt).not.toBeNull(); // old token rotated
    expect(repo.tokens).toHaveLength(2);
    const fresh = repo.tokens.find((t) => t.tokenHash === hashOpaqueToken(result.refresh));
    expect(fresh?.familyId).toBe('F1');
    expect(fresh?.revokedAt).toBeNull();

    const decoded = verifyAccessToken(result.access, {
      publicKey,
      issuer: 'boj-api',
      audience: 'boj-clients',
    });
    expect(decoded.sub).toBe('U1');
    expect(decoded.roles).toEqual(['customer']);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { repo, svc } = setup();
    repo.seedToken({ userId: 1, plaintext: 'tok-1', familyId: 'F1', expiresAt: future });
    await svc.refresh('tok-1'); // rotates; tok-1 now revoked

    await expect(svc.refresh('tok-1')).rejects.toMatchObject({ status: 401 });

    expect(repo.tokens.every((t) => t.familyId !== 'F1' || t.revokedAt !== null)).toBe(true);
  });

  it('rejects an expired refresh token', async () => {
    const { repo, svc } = setup();
    repo.seedToken({ userId: 1, plaintext: 'old', familyId: 'F1', expiresAt: past });
    await expect(svc.refresh('old')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unknown refresh token', async () => {
    const { svc } = setup();
    await expect(svc.refresh('nope')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects when the user is not active', async () => {
    const { repo, svc } = setup();
    repo.seedToken({ userId: 2, plaintext: 'tok-x', familyId: 'F2', expiresAt: future });
    // user 2 does not exist → treated as invalid
    await expect(svc.refresh('tok-x')).rejects.toMatchObject({ status: 401 });
  });

  it('logout revokes the family and makes the token unusable', async () => {
    const { repo, svc } = setup();
    repo.seedToken({ userId: 1, plaintext: 'tok-1', familyId: 'F1', expiresAt: future });
    await svc.logout('tok-1');
    expect(repo.tokens.every((t) => t.revokedAt !== null)).toBe(true);
    await expect(svc.refresh('tok-1')).rejects.toMatchObject({ status: 401 });
    await expect(svc.logout('unknown')).resolves.toBeUndefined();
  });
});
