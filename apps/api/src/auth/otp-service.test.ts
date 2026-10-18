import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from './config';
import { createOtpService } from './otp-service';
import type {
  AuthRepo,
  InsertOtpInput,
  InsertRefreshTokenInput,
  OtpRecord,
  UserRecord,
} from './repo';
import { MockSmsProvider } from './sms/mock';
import { verifyAccessToken } from './tokens';

// One RSA key pair for the whole suite (keygen is relatively expensive).
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function testConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'boj-api',
    JWT_AUDIENCE: 'boj-clients',
    ACCESS_TOKEN_TTL_SEC: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    OTP_LENGTH: 6,
    OTP_TTL_SEC: 300,
    OTP_MAX_ATTEMPTS: 3,
    OTP_PEPPER: 'test-pepper-0123456789',
    OTP_REQUEST_WINDOW_SEC: 3600,
    OTP_MAX_PER_PHONE: 3,
    OTP_MAX_PER_IP: 5,
    PASSWORD_MAX_ATTEMPTS: 5,
    PASSWORD_LOCKOUT_SEC: 900,
    SMS_PROVIDER: 'mock',
    ...overrides,
  };
}

type OtpInternal = OtpRecord & { requestIp: Buffer | null };

class FakeAuthRepo implements AuthRepo {
  private otps: OtpInternal[] = [];
  private users: UserRecord[] = [];
  private rolesByUser = new Map<number, string[]>();
  readonly refreshTokens: InsertRefreshTokenInput[] = [];
  private otpSeq = 0;
  private userSeq = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  countOtpRequestsByPhone(phoneE164: string, since: Date): Promise<number> {
    return Promise.resolve(
      this.otps.filter((r) => r.phoneE164 === phoneE164 && r.createdAt >= since).length,
    );
  }

  countOtpRequestsByIp(requestIp: Buffer, since: Date): Promise<number> {
    return Promise.resolve(
      this.otps.filter((r) => r.requestIp?.equals(requestIp) && r.createdAt >= since).length,
    );
  }

  insertOtp(input: InsertOtpInput): Promise<void> {
    this.otps.push({
      id: ++this.otpSeq,
      phoneE164: input.phoneE164,
      codeHash: input.codeHash,
      purpose: input.purpose,
      attempts: 0,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: this.clock(),
      requestIp: input.requestIp,
    });
    return Promise.resolve();
  }

  findLatestUnconsumedOtp(phoneE164: string, purpose: string): Promise<OtpRecord | null> {
    const matches = this.otps.filter(
      (r) => r.phoneE164 === phoneE164 && r.purpose === purpose && r.consumedAt === null,
    );
    return Promise.resolve(matches.at(-1) ?? null);
  }

  incrementOtpAttempts(id: number): Promise<void> {
    const row = this.otps.find((r) => r.id === id);
    if (row) {
      row.attempts += 1;
    }
    return Promise.resolve();
  }

  consumeOtp(id: number, consumedAt: Date): Promise<void> {
    const row = this.otps.find((r) => r.id === id);
    if (row) {
      row.consumedAt = consumedAt;
    }
    return Promise.resolve();
  }

  findUserByPhone(phoneE164: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.find((u) => u.phoneE164 === phoneE164) ?? null);
  }

  provisionUser(input: { phoneE164: string; ulid: string; roleCode: string }): Promise<UserRecord> {
    const user: UserRecord = {
      id: ++this.userSeq,
      ulid: input.ulid,
      phoneE164: input.phoneE164,
      email: null,
      displayName: null,
      status: 'active',
    };
    this.users.push(user);
    this.rolesByUser.set(user.id, [input.roleCode]);
    return Promise.resolve(user);
  }

  getUserRoleCodes(userId: number): Promise<string[]> {
    return Promise.resolve(this.rolesByUser.get(userId) ?? []);
  }

  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void> {
    this.refreshTokens.push(input);
    return Promise.resolve();
  }
}

function setup(configOverrides: Partial<AuthConfig> = {}) {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(nowMs);
  const advanceSec = (sec: number) => {
    nowMs += sec * 1000;
  };
  const config = testConfig(configOverrides);
  const repo = new FakeAuthRepo(clock);
  const sms = new MockSmsProvider();
  const svc = createOtpService({ repo, sms, config, now: clock });
  return { svc, sms, repo, config, advanceSec };
}

async function requestAndReadCode(
  svc: ReturnType<typeof createOtpService>,
  sms: MockSmsProvider,
  phone: string,
  ip?: string,
): Promise<string> {
  await svc.requestOtp({ phone, ip });
  const body = sms.lastTo('+254712345678')?.body ?? sms.sent.at(-1)?.body ?? '';
  const code = body.match(/(\d{6})/)?.[1] ?? '';
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

describe('OTP service', () => {
  const LOCAL = '0712345678';
  const E164 = '+254712345678';

  it('issues a code and verifies it, provisioning a customer and returning tokens', async () => {
    const { svc, sms, repo, config } = setup();
    const code = await requestAndReadCode(svc, sms, LOCAL);

    const result = await svc.verifyOtp({ phone: LOCAL, code });

    expect(result.user.phoneE164).toBe(E164);
    expect(result.user.roles).toEqual(['customer']);
    expect(repo.refreshTokens).toHaveLength(1);

    const decoded = verifyAccessToken(result.access, {
      publicKey: config.JWT_PUBLIC_KEY,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    expect(decoded.sub).toBe(result.user.ulid);
    expect(decoded.roles).toEqual(['customer']);
  });

  it('reuses the existing user on a second login (no duplicate provisioning)', async () => {
    const { svc, sms } = setup();
    const first = await svc.verifyOtp({
      phone: LOCAL,
      code: await requestAndReadCode(svc, sms, LOCAL),
    });
    const second = await svc.verifyOtp({
      phone: LOCAL,
      code: await requestAndReadCode(svc, sms, LOCAL),
    });
    expect(second.user.ulid).toBe(first.user.ulid);
  });

  it('rejects a wrong code with a generic 401 and counts the attempt', async () => {
    const { svc, sms, repo } = setup();
    await requestAndReadCode(svc, sms, LOCAL);
    await expect(svc.verifyOtp({ phone: LOCAL, code: '000000' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
    expect(repo.refreshTokens).toHaveLength(0);
  });

  it('locks out after too many attempts even if the right code is then supplied', async () => {
    const { svc, sms } = setup({ OTP_MAX_ATTEMPTS: 3 });
    const code = await requestAndReadCode(svc, sms, LOCAL);
    for (let i = 0; i < 3; i++) {
      await expect(svc.verifyOtp({ phone: LOCAL, code: '000000' })).rejects.toMatchObject({
        status: 401,
      });
    }
    await expect(svc.verifyOtp({ phone: LOCAL, code })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired code', async () => {
    const { svc, sms, advanceSec, config } = setup();
    const code = await requestAndReadCode(svc, sms, LOCAL);
    advanceSec(config.OTP_TTL_SEC + 1);
    await expect(svc.verifyOtp({ phone: LOCAL, code })).rejects.toMatchObject({ status: 401 });
  });

  it('throttles per phone within the window', async () => {
    const { svc } = setup({ OTP_MAX_PER_PHONE: 3 });
    for (let i = 0; i < 3; i++) {
      await svc.requestOtp({ phone: LOCAL });
    }
    await expect(svc.requestOtp({ phone: LOCAL })).rejects.toMatchObject({ status: 429 });
  });

  it('throttles per IP across different phones', async () => {
    const { svc } = setup({ OTP_MAX_PER_IP: 2, OTP_MAX_PER_PHONE: 10 });
    const ip = '41.90.1.2';
    await svc.requestOtp({ phone: '0712345670', ip });
    await svc.requestOtp({ phone: '0712345671', ip });
    await expect(svc.requestOtp({ phone: '0712345672', ip })).rejects.toMatchObject({
      status: 429,
    });
  });

  it('does not leak account existence: unknown number verifies like a wrong code', async () => {
    const { svc } = setup();
    await expect(svc.verifyOtp({ phone: LOCAL, code: '123456' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects an invalid phone number with 422', async () => {
    const { svc } = setup();
    await expect(svc.requestOtp({ phone: '0812345678' })).rejects.toMatchObject({ status: 422 });
    await expect(svc.verifyOtp({ phone: 'nope', code: '123456' })).rejects.toMatchObject({
      status: 422,
    });
  });
});
