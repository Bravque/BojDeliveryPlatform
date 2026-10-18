import { unauthorized } from '../http/errors';
import type { ProfilePatch, UserRepo } from './repo';

export interface UserProfile {
  ulid: string;
  phoneE164: string;
  email: string | null;
  displayName: string | null;
  roles: string[];
}

export interface UserServiceDeps {
  repo: UserRepo;
}

export function createUserService(deps: UserServiceDeps) {
  const { repo } = deps;

  async function getProfile(ulid: string): Promise<UserProfile> {
    const user = await repo.findUserByUlid(ulid);
    if (!user) {
      // The token was valid but the account is gone/suspended.
      throw unauthorized('Account not found');
    }
    const roles = await repo.getUserRoleCodes(user.id);
    return {
      ulid: user.ulid,
      phoneE164: user.phoneE164,
      email: user.email,
      displayName: user.displayName,
      roles,
    };
  }

  /** Update the mutable profile. Email changes are deferred (they need a verification flow). */
  async function updateProfile(ulid: string, patch: ProfilePatch): Promise<UserProfile> {
    const user = await repo.findUserByUlid(ulid);
    if (!user) {
      throw unauthorized('Account not found');
    }
    await repo.updateUserProfile(user.id, patch);
    return getProfile(ulid);
  }

  return { getProfile, updateProfile };
}

export type UserService = ReturnType<typeof createUserService>;
