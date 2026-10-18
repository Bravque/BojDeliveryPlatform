import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthConfig } from './config';
import { hashPassword } from './crypto';
import { createPasswordService } from './password-service';
import type { InsertRefreshTokenInput, PasswordLoginRecord, PasswordRepo } from './repo';
import { verifyAccessToken } from './tokens';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
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
    PASSWORD_MAX_ATTEMPTS: 3,
    PASSWORD_LOCKOUT_SEC: 900,
    SMS_PROVIDER: 'mock',
    ...overrides,
  };
}

class FakePasswordRepo implements PasswordRepo {
  readonly users: PasswordLoginRecord[] = [];
  private readonly rolesByUser = new Map<number, string[]>();
  readonly refreshTokens: InsertRefreshTokenInput[] = [];

  addUser(user: PasswordLoginRecord, roles: string[]): void {
    this.users.push(user);
    this.rolesByUser.set(user.id, roles);
  }

  findLoginUserByEmail(email: string): Promise<PasswordLoginRecord | null> {
    return Promise.resolve(this.users.find((u) => u.email === email) ?? null);
  }

  recordFailedLogin(
    userId: number,
    failedLoginCount: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    const u = this.users.find((x) => x.id === userId);
    if (u) {
      u.failedLoginCount = failedLoginCount;
      u.lockedUntil = lockedUntil;
    }
    return Promise.resolve();
  }

  resetFailedLogins(userId: number): Promise<void> {
    const u = this.users.find((x) => x.id === userId);
    if (u) {
      u.failedLoginCount = 0;
      u.lockedUntil = null;
    }
    return Promise.resolve();
  }

  getUserRoleCodes(userId: number): Promise<string[]> {
    return Promise.resolve(this.rolesByUser.get(userId) ?? []);
  }

  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void> {
    this.refreshTokens.push(input);
    return Promise.resolve();
  }
}

const PASSWORD = 'CorrectHorse!1';
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

function adminUser(overrides: Partial<PasswordLoginRecord> = {}): PasswordLoginRecord {
  return {
    id: 1,
    ulid: 'U1',
    phoneE164: '+254700000001',
    email: 'admin@boj.local',
    displayName: 'Dev Admin',
    status: 'active',
    passwordHash,
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function setup(user?: PasswordLoginRecord, configOverrides: Partial<AuthConfig> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const repo = new FakePasswordRepo();
  repo.addUser(user ?? adminUser(), ['admin']);
  const svc = createPasswordService({ repo, config: config(configOverrides), now: () => now });
  return { repo, svc };
}

describe('password login', () => {
  it('logs in with correct credentials and returns tokens', async () => {
    const { repo, svc } = setup();
    const result = await svc.login({ email: 'admin@boj.local', password: PASSWORD });

    expect(result.user.roles).toEqual(['admin']);
    expect(repo.refreshTokens).toHaveLength(1);
    const decoded = verifyAccessToken(result.access, {
      publicKey,
      issuer: 'boj-api',
      audience: 'boj-clients',
    });
    expect(decoded.sub).toBe('U1');
    expect(repo.users[0]?.failedLoginCount).toBe(0);
  });

  it('normalizes the email (case/whitespace)', async () => {
    const { svc } = setup();
    const result = await svc.login({ email: '  ADMIN@BOJ.LOCAL ', password: PASSWORD });
    expect(result.user.roles).toEqual(['admin']);
  });

  it('rejects a wrong password with 401 and counts the failure', async () => {
    const { repo, svc } = setup();
    await expect(svc.login({ email: 'admin@boj.local', password: 'wrong' })).rejects.toMatchObject({
      status: 401,
    });
    expect(repo.users[0]?.failedLoginCount).toBe(1);
    expect(repo.refreshTokens).toHaveLength(0);
  });

  it('rejects an unknown email with 401 (no enumeration)', async () => {
    const { svc } = setup();
    await expect(svc.login({ email: 'ghost@boj.local', password: 'x' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects an OTP-only account (no password set)', async () => {
    const { svc } = setup(adminUser({ passwordHash: null }));
    await expect(svc.login({ email: 'admin@boj.local', password: PASSWORD })).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it('locks the account after too many failures, then refuses the correct password', async () => {
    const { repo, svc } = setup(undefined, { PASSWORD_MAX_ATTEMPTS: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(
        svc.login({ email: 'admin@boj.local', password: 'wrong' }),
      ).rejects.toMatchObject({ status: 401 });
    }
    expect(repo.users[0]?.lockedUntil).not.toBeNull();
    await expect(svc.login({ email: 'admin@boj.local', password: PASSWORD })).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it('resets the failure counter after a successful login', async () => {
    const { repo, svc } = setup();
    await expect(svc.login({ email: 'admin@boj.local', password: 'wrong' })).rejects.toBeDefined();
    expect(repo.users[0]?.failedLoginCount).toBe(1);
    await svc.login({ email: 'admin@boj.local', password: PASSWORD });
    expect(repo.users[0]?.failedLoginCount).toBe(0);
  });

  it('rejects a suspended account even with the right password', async () => {
    const { svc } = setup(adminUser({ status: 'suspended' }));
    await expect(svc.login({ email: 'admin@boj.local', password: PASSWORD })).rejects.toMatchObject(
      { status: 401 },
    );
  });
});
