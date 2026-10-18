import { unauthorized } from '../http/errors';
import type { AuthConfig } from './config';
import { hashOpaqueToken, newOpaqueToken, newUlid } from './crypto';
import type { SessionRepo } from './repo';
import { signAccessToken } from './tokens';

export interface SessionServiceDeps {
  repo: SessionRepo;
  config: AuthConfig;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface RefreshedTokens {
  access: string;
  refresh: string;
}

export function createSessionService(deps: SessionServiceDeps) {
  const { repo, config } = deps;
  const clock = deps.now ?? (() => new Date());
  const invalid = () => unauthorized('Invalid session');

  function mintAccess(userUlid: string, roles: string[]): string {
    return signAccessToken(
      { sub: userUlid, roles, jti: newUlid() },
      {
        privateKey: config.JWT_PRIVATE_KEY,
        expiresInSec: config.ACCESS_TOKEN_TTL_SEC,
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      },
    );
  }

  /**
   * Rotate a refresh token: issue a new access + refresh in the same family and revoke the
   * presented one. If a token that was ALREADY rotated (revoked) is presented again, that is
   * token reuse — the whole family is revoked and the request is rejected, forcing re-auth.
   */
  async function refresh(presented: string): Promise<RefreshedTokens> {
    const row = await repo.findRefreshTokenByHash(hashOpaqueToken(presented));
    if (!row) {
      throw invalid();
    }
    if (row.revokedAt) {
      // Reuse of a rotated/revoked token → nuke the family.
      await repo.revokeFamily(row.familyId, clock());
      throw invalid();
    }
    if (row.expiresAt.getTime() <= clock().getTime()) {
      throw invalid();
    }

    const user = await repo.findUserById(row.userId);
    if (!user || user.status !== 'active') {
      throw invalid();
    }

    await repo.revokeRefreshToken(row.id, clock());
    const roles = await repo.getUserRoleCodes(user.id);
    const refreshToken = newOpaqueToken();
    await repo.insertRefreshToken({
      userId: user.id,
      tokenHash: hashOpaqueToken(refreshToken),
      familyId: row.familyId,
      expiresAt: new Date(clock().getTime() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });

    return { access: mintAccess(user.ulid, roles), refresh: refreshToken };
  }

  /**
   * Revoke the presented refresh token's entire family (logs out that session). Idempotent and
   * silent about whether the token existed, so it never reveals session state.
   */
  async function logout(presented: string): Promise<void> {
    const row = await repo.findRefreshTokenByHash(hashOpaqueToken(presented));
    if (row) {
      await repo.revokeFamily(row.familyId, clock());
    }
  }

  return { refresh, logout };
}

export type SessionService = ReturnType<typeof createSessionService>;
