import { unauthorized } from '../http/errors';
import type { AuthConfig } from './config';
import { hashOpaqueToken, hashPassword, newOpaqueToken, newUlid, verifyPassword } from './crypto';
import type { PasswordRepo } from './repo';
import { signAccessToken } from './tokens';

export interface PasswordServiceDeps {
  repo: PasswordRepo;
  config: AuthConfig;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface PasswordAuthResult {
  access: string;
  refresh: string;
  user: { ulid: string; email: string | null; displayName: string | null; roles: string[] };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Dashboard email/password login (doc 06 §2.2). Argon2id verification with account lockout +
 * backoff on repeated failures. Every failure path returns the same generic 401, and an
 * unknown/password-less account still burns a verify against a dummy hash so timing does not
 * reveal whether the account exists.
 */
export function createPasswordService(deps: PasswordServiceDeps) {
  const { repo, config } = deps;
  const clock = deps.now ?? (() => new Date());

  let dummyHash: Promise<string> | null = null;
  function getDummyHash(): Promise<string> {
    dummyHash ??= hashPassword(`dummy-${newUlid()}`);
    return dummyHash;
  }

  async function login(input: { email: string; password: string }): Promise<PasswordAuthResult> {
    const email = normalizeEmail(input.email ?? '');
    const password = input.password ?? '';
    const invalid = () => unauthorized('Invalid email or password');

    const user = await repo.findLoginUserByEmail(email);

    // Locked account: refuse without revealing lock state; still verify for constant timing.
    if (user?.lockedUntil && user.lockedUntil.getTime() > clock().getTime()) {
      await verifyPassword(await getDummyHash(), password);
      throw invalid();
    }

    const hash = user?.passwordHash ?? (await getDummyHash());
    const ok = await verifyPassword(hash, password);

    if (!user || !user.passwordHash || !ok) {
      if (user) {
        const count = user.failedLoginCount + 1;
        const lockedUntil =
          count >= config.PASSWORD_MAX_ATTEMPTS
            ? new Date(clock().getTime() + config.PASSWORD_LOCKOUT_SEC * 1000)
            : null;
        await repo.recordFailedLogin(user.id, count, lockedUntil);
      }
      throw invalid();
    }

    if (user.status !== 'active') {
      throw invalid();
    }

    await repo.resetFailedLogins(user.id);
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
      user: { ulid: user.ulid, email: user.email, displayName: user.displayName, roles },
    };
  }

  return { login };
}

export type PasswordService = ReturnType<typeof createPasswordService>;
