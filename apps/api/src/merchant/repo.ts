import type { Knex } from 'knex';

/**
 * Persistence for the merchant domain, behind an interface so the service can be unit-tested
 * with an in-memory fake. The Knex implementation is a thin mapping layer. Cross-domain reads
 * (town id by name, user id by ulid) and the global-role grant are included because merchant
 * onboarding legitimately references those entities (merchant_user → user, merchant → town).
 */

export type MerchantStatus = 'pending' | 'approved' | 'suspended' | 'closed';
export type MerchantCategory = 'restaurant' | 'grocery' | 'pharmacy' | 'retail' | 'other';
export type MerchantUserRole = 'owner' | 'staff';

export interface MerchantRecord {
  id: number;
  ulid: string;
  townId: number;
  name: string;
  categoryType: MerchantCategory;
  status: MerchantStatus;
  isOpen: boolean;
  prepMinutes: number;
  commissionBps: number;
  /** Canonical E.164 M-Pesa number paid for merchant B2C payouts; null when none is on file. */
  payoutPhoneE164: string | null;
  createdAt: Date;
}

export interface CreateMerchantInput {
  ulid: string;
  townId: number;
  name: string;
  categoryType: MerchantCategory;
  commissionBps: number;
  prepMinutes: number;
}

export interface MerchantRepo {
  findTownIdByName(name: string): Promise<number | null>;
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createMerchant(input: CreateMerchantInput): Promise<MerchantRecord>;
  findMerchantByUlid(ulid: string): Promise<MerchantRecord | null>;
  setMerchantStatus(merchantId: number, status: MerchantStatus): Promise<void>;
  /** Set (or clear, with null) the merchant's canonical-E.164 B2C payout destination. */
  setMerchantPayoutPhone(merchantId: number, phoneE164: string | null): Promise<void>;
  addMerchantUser(merchantId: number, userId: number, role: MerchantUserRole): Promise<void>;
  /** Idempotently grant a global role (user_role) so the policy layer recognizes the user. */
  grantGlobalRole(userId: number, roleCode: string): Promise<void>;
}

interface MerchantRowDb {
  id: number | string;
  ulid: string;
  town_id: number | string;
  name: string;
  category_type: MerchantCategory;
  status: MerchantStatus;
  is_open: number | boolean;
  prep_minutes: number | string;
  commission_bps: number | string;
  payout_phone_e164: string | null;
  created_at: string | Date;
}

function mapMerchant(row: MerchantRowDb): MerchantRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    townId: Number(row.town_id),
    name: row.name,
    categoryType: row.category_type,
    status: row.status,
    isOpen: Boolean(row.is_open),
    prepMinutes: Number(row.prep_minutes),
    commissionBps: Number(row.commission_bps),
    payoutPhoneE164: row.payout_phone_e164 ?? null,
    createdAt: new Date(row.created_at),
  };
}

export function createKnexMerchantRepo(db: Knex): MerchantRepo {
  return {
    async findTownIdByName(name) {
      const row = (await db('town').where({ name }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createMerchant(input) {
      const inserted = await db('merchant').insert({
        ulid: input.ulid,
        town_id: input.townId,
        name: input.name,
        category_type: input.categoryType,
        commission_bps: input.commissionBps,
        prep_minutes: input.prepMinutes,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create merchant');
      }
      const row = (await db('merchant').where({ id }).first()) as MerchantRowDb;
      return mapMerchant(row);
    },

    async findMerchantByUlid(ulid) {
      const row = (await db('merchant').where({ ulid }).first()) as MerchantRowDb | undefined;
      return row ? mapMerchant(row) : null;
    },

    async setMerchantStatus(merchantId, status) {
      await db('merchant').where({ id: merchantId }).update({ status });
    },

    async setMerchantPayoutPhone(merchantId, phoneE164) {
      await db('merchant').where({ id: merchantId }).update({ payout_phone_e164: phoneE164 });
    },

    async addMerchantUser(merchantId, userId, role) {
      await db('merchant_user')
        .insert({ merchant_id: merchantId, user_id: userId, role })
        .onConflict(['merchant_id', 'user_id'])
        .merge({ role });
    },

    async grantGlobalRole(userId, roleCode) {
      const role = (await db('role').where({ code: roleCode }).first('id')) as
        { id: number | string } | undefined;
      if (!role) {
        throw new Error(`Role not found: ${roleCode}`);
      }
      await db('user_role')
        .insert({ user_id: userId, role_id: role.id })
        .onConflict(['user_id', 'role_id'])
        .ignore();
    },
  };
}
