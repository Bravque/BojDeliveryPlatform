import type { Knex } from 'knex';

/**
 * Persistence for the auth module, behind an interface so the OTP service can be unit-tested
 * with an in-memory fake and the Knex implementation stays a thin mapping layer. All datetimes
 * are UTC (doc 03 §1). `requestIp` is a 16-byte key (a truncated hash of the client IP) — it
 * supports per-IP throttling without storing the raw address.
 */

export type OtpPurpose = 'login' | 'verify';

export interface UserRecord {
  id: number;
  ulid: string;
  phoneE164: string;
  email: string | null;
  displayName: string | null;
  status: string;
}

export interface OtpRecord {
  id: number;
  phoneE164: string;
  codeHash: string;
  purpose: OtpPurpose;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface InsertOtpInput {
  phoneE164: string;
  codeHash: string;
  purpose: OtpPurpose;
  expiresAt: Date;
  requestIp: Buffer | null;
}

export interface InsertRefreshTokenInput {
  userId: number;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface AuthRepo {
  countOtpRequestsByPhone(phoneE164: string, since: Date): Promise<number>;
  countOtpRequestsByIp(requestIp: Buffer, since: Date): Promise<number>;
  insertOtp(input: InsertOtpInput): Promise<void>;
  findLatestUnconsumedOtp(phoneE164: string, purpose: OtpPurpose): Promise<OtpRecord | null>;
  incrementOtpAttempts(id: number): Promise<void>;
  consumeOtp(id: number, consumedAt: Date): Promise<void>;
  findUserByPhone(phoneE164: string): Promise<UserRecord | null>;
  provisionUser(input: { phoneE164: string; ulid: string; roleCode: string }): Promise<UserRecord>;
  getUserRoleCodes(userId: number): Promise<string[]>;
  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void>;
}

export interface RefreshTokenRecord {
  id: number;
  userId: number;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ProfilePatch {
  displayName?: string;
}

/** Refresh-token lifecycle (rotation, reuse detection, logout). */
export interface SessionRepo {
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revokeRefreshToken(id: number, revokedAt: Date): Promise<void>;
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>;
  insertRefreshToken(input: InsertRefreshTokenInput): Promise<void>;
  findUserById(id: number): Promise<UserRecord | null>;
  getUserRoleCodes(userId: number): Promise<string[]>;
}

/** Profile reads/writes for the authenticated principal. */
export interface UserRepo {
  findUserByUlid(ulid: string): Promise<UserRecord | null>;
  updateUserProfile(userId: number, patch: ProfilePatch): Promise<void>;
  getUserRoleCodes(userId: number): Promise<string[]>;
}

/** The full Knex-backed repository implements every segment. */
export type FullAuthRepo = AuthRepo & SessionRepo & UserRepo;

interface UserRowDb {
  id: number | string;
  ulid: string;
  phone_e164: string;
  email: string | null;
  display_name: string | null;
  status: string;
}

interface OtpRowDb {
  id: number | string;
  phone_e164: string;
  code_hash: string;
  purpose: OtpPurpose;
  attempts: number | string;
  expires_at: string | Date;
  consumed_at: string | Date | null;
  created_at: string | Date;
}

interface RefreshTokenRowDb {
  id: number | string;
  user_id: number | string;
  family_id: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
}

function mapRefreshToken(row: RefreshTokenRowDb): RefreshTokenRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    familyId: row.family_id,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function mapUser(row: UserRowDb): UserRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    phoneE164: row.phone_e164,
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    status: row.status,
  };
}

function mapOtp(row: OtpRowDb): OtpRecord {
  return {
    id: Number(row.id),
    phoneE164: row.phone_e164,
    codeHash: row.code_hash,
    purpose: row.purpose,
    attempts: Number(row.attempts),
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    createdAt: new Date(row.created_at),
  };
}

/** MySQL/Knex-backed implementation of the full auth repository. */
export function createKnexAuthRepo(db: Knex): FullAuthRepo {
  return {
    async countOtpRequestsByPhone(phoneE164, since) {
      const rows = await db('auth_credential_otp')
        .where({ phone_e164: phoneE164 })
        .where('created_at', '>=', since)
        .count<{ c: number | string }[]>({ c: '*' });
      return Number(rows[0]?.c ?? 0);
    },

    async countOtpRequestsByIp(requestIp, since) {
      const rows = await db('auth_credential_otp')
        .where({ request_ip: requestIp })
        .where('created_at', '>=', since)
        .count<{ c: number | string }[]>({ c: '*' });
      return Number(rows[0]?.c ?? 0);
    },

    async insertOtp(input) {
      await db('auth_credential_otp').insert({
        phone_e164: input.phoneE164,
        code_hash: input.codeHash,
        purpose: input.purpose,
        expires_at: input.expiresAt,
        request_ip: input.requestIp,
      });
    },

    async findLatestUnconsumedOtp(phoneE164, purpose) {
      const row = (await db('auth_credential_otp')
        .where({ phone_e164: phoneE164, purpose })
        .whereNull('consumed_at')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .first()) as OtpRowDb | undefined;
      return row ? mapOtp(row) : null;
    },

    async incrementOtpAttempts(id) {
      await db('auth_credential_otp').where({ id }).increment('attempts', 1);
    },

    async consumeOtp(id, consumedAt) {
      await db('auth_credential_otp').where({ id }).update({ consumed_at: consumedAt });
    },

    async findUserByPhone(phoneE164) {
      const row = (await db('user').where({ phone_e164: phoneE164 }).first()) as
        UserRowDb | undefined;
      return row ? mapUser(row) : null;
    },

    async provisionUser({ phoneE164, ulid, roleCode }) {
      return db.transaction(async (trx) => {
        const inserted = await trx('user').insert({
          ulid,
          phone_e164: phoneE164,
          status: 'active',
        });
        const userId = inserted[0];
        if (userId === undefined) {
          throw new Error('Failed to provision user');
        }
        const role = (await trx('role').where({ code: roleCode }).first('id')) as
          { id: number | string } | undefined;
        if (!role) {
          throw new Error(`Role not found: ${roleCode}`);
        }
        await trx('user_role').insert({ user_id: userId, role_id: role.id });
        const row = (await trx('user').where({ id: userId }).first()) as UserRowDb;
        return mapUser(row);
      });
    },

    async getUserRoleCodes(userId) {
      const rows = (await db('user_role')
        .join('role', 'role.id', 'user_role.role_id')
        .where('user_role.user_id', userId)
        .select('role.code')) as { code: string }[];
      return rows.map((r) => r.code);
    },

    async insertRefreshToken(input) {
      await db('refresh_token').insert({
        user_id: input.userId,
        token_hash: input.tokenHash,
        family_id: input.familyId,
        expires_at: input.expiresAt,
      });
    },

    async findRefreshTokenByHash(tokenHash) {
      const row = (await db('refresh_token').where({ token_hash: tokenHash }).first()) as
        RefreshTokenRowDb | undefined;
      return row ? mapRefreshToken(row) : null;
    },

    async revokeRefreshToken(id, revokedAt) {
      await db('refresh_token')
        .where({ id })
        .whereNull('revoked_at')
        .update({ revoked_at: revokedAt });
    },

    async revokeFamily(familyId, revokedAt) {
      await db('refresh_token')
        .where({ family_id: familyId })
        .whereNull('revoked_at')
        .update({ revoked_at: revokedAt });
    },

    async findUserById(id) {
      const row = (await db('user').where({ id }).first()) as UserRowDb | undefined;
      return row ? mapUser(row) : null;
    },

    async findUserByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first()) as UserRowDb | undefined;
      return row ? mapUser(row) : null;
    },

    async updateUserProfile(userId, patch) {
      const update: Record<string, unknown> = {};
      if (patch.displayName !== undefined) {
        update.display_name = patch.displayName;
      }
      if (Object.keys(update).length > 0) {
        await db('user').where({ id: userId }).update(update);
      }
    },
  };
}
