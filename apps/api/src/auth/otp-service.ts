import { createHash } from 'node:crypto';
import { tooManyRequests, unauthorized, validationFailed } from '../http/errors';
import type { AuthConfig } from './config';
import {
  generateOtp,
  hashOpaqueToken,
  hashOtp,
  newOpaqueToken,
  newUlid,
  safeEqualHex,
} from './crypto';
import { normalizeKenyanPhone } from './phone';
import type { AuthRepo } from './repo';
import type { SmsProvider } from './sms/provider';
import { signAccessToken } from './tokens';

export interface OtpServiceDeps {
  repo: AuthRepo;
  sms: SmsProvider;
  config: AuthConfig;
  /** Injectable clock (tests). Defaults to the system clock. */
  now?: () => Date;
}

export interface AuthResult {
  access: string;
  refresh: string;
  user: { ulid: string; phoneE164: string; roles: string[]; displayName: string | null };
}

/** 16-byte throttle key derived from the client IP (a truncated hash — not the raw address). */
function ipKey(ip: string | undefined): Buffer | null {
  if (!ip) {
    return null;
  }
  return createHash('sha256').update(ip).digest().subarray(0, 16);
}

export function createOtpService(deps: OtpServiceDeps) {
  const { repo, sms, config } = deps;
  const clock = deps.now ?? (() => new Date());

  function requirePhone(raw: string): string {
    const phone = normalizeKenyanPhone(raw);
    if (!phone) {
      throw validationFailed([{ field: 'phone', issue: 'Must be a valid Kenyan mobile number' }]);
    }
    return phone;
  }

  /**
   * Issue an OTP for `phone` and send it via SMS. Behaves identically whether or not the number
   * is already registered (no user enumeration); provisioning happens on first verify. Enforces
   * per-phone and per-IP request throttling within a rolling window.
   */
  async function requestOtp(input: { phone: string; ip?: string }): Promise<void> {
    const phone = requirePhone(input.phone);
    const windowStart = new Date(clock().getTime() - config.OTP_REQUEST_WINDOW_SEC * 1000);

    if ((await repo.countOtpRequestsByPhone(phone, windowStart)) >= config.OTP_MAX_PER_PHONE) {
      throw tooManyRequests('Too many codes requested. Please try again later.');
    }
    const ipk = ipKey(input.ip);
    if (ipk && (await repo.countOtpRequestsByIp(ipk, windowStart)) >= config.OTP_MAX_PER_IP) {
      throw tooManyRequests('Too many codes requested. Please try again later.');
    }

    const code = generateOtp(config.OTP_LENGTH);
    const expiresAt = new Date(clock().getTime() + config.OTP_TTL_SEC * 1000);
    await repo.insertOtp({
      phoneE164: phone,
      codeHash: hashOtp(code, config.OTP_PEPPER),
      purpose: 'login',
      expiresAt,
      requestIp: ipk,
    });

    const minutes = Math.max(1, Math.round(config.OTP_TTL_SEC / 60));
    await sms.send({
      to: phone,
      body: `Your Boj verification code is ${code}. It expires in ${minutes} minute(s). Do not share it.`,
    });
  }

  /**
   * Verify a submitted code. On success, provisions the user on first login (as a customer),
   * issues an RS256 access token + opaque refresh token, and returns them with the profile.
   * Every failure path (unknown number, wrong code, expired, locked) returns the same generic
   * 401 so nothing about account existence leaks.
   */
  async function verifyOtp(input: {
    phone: string;
    code: string;
    ip?: string;
  }): Promise<AuthResult> {
    const phone = requirePhone(input.phone);
    const code = (input.code ?? '').trim();
    const invalid = () => unauthorized('Invalid or expired code');

    const otp = await repo.findLatestUnconsumedOtp(phone, 'login');
    if (
      !otp ||
      otp.attempts >= config.OTP_MAX_ATTEMPTS ||
      otp.expiresAt.getTime() <= clock().getTime()
    ) {
      throw invalid();
    }

    if (!safeEqualHex(hashOtp(code, config.OTP_PEPPER), otp.codeHash)) {
      await repo.incrementOtpAttempts(otp.id);
      throw invalid();
    }
    await repo.consumeOtp(otp.id, clock());

    let user = await repo.findUserByPhone(phone);
    if (!user) {
      user = await repo.provisionUser({ phoneE164: phone, ulid: newUlid(), roleCode: 'customer' });
    }
    if (user.status !== 'active') {
      throw unauthorized('Account is not active');
    }

    const roles = await repo.getUserRoleCodes(user.id);
    const access = signAccessToken(
      { sub: user.ulid, roles, jti: newUlid() },
      {
        privateKey: config.JWT_PRIVATE_KEY,
        expiresInSec: config.ACCESS_TOKEN_TTL_SEC,
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
    );
    const refresh = newOpaqueToken();
    await repo.insertRefreshToken({
      userId: user.id,
      tokenHash: hashOpaqueToken(refresh),
      familyId: newUlid(),
      expiresAt: new Date(clock().getTime() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });

    return {
      access,
      refresh,
      user: { ulid: user.ulid, phoneE164: user.phoneE164, roles, displayName: user.displayName },
    };
  }

  return { requestOtp, verifyOtp };
}

export type OtpService = ReturnType<typeof createOtpService>;
