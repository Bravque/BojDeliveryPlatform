import type { Knex } from 'knex';
import type { PromotionRecord, PromotionType } from './promotion';

/** Persistence for promotions, behind an interface for in-memory unit testing. */

export interface CreatePromotionInput {
  ulid: string;
  code: string;
  type: PromotionType;
  valueBps: number | null;
  valueCents: number | null;
  maxDiscountCents: number | null;
  minSubtotalCents: number;
  perUserLimit: number;
  totalLimit: number | null;
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
}

export interface PromotionRepo {
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createPromotion(input: CreatePromotionInput): Promise<PromotionRecord>;
  findPromotionByCode(code: string): Promise<PromotionRecord | null>;
  listPromotions(): Promise<PromotionRecord[]>;
}

interface PromotionRowDb {
  id: number | string;
  ulid: string;
  code: string;
  type: PromotionType;
  value_bps: number | string | null;
  value_cents: number | string | null;
  max_discount_cents: number | string | null;
  min_subtotal_cents: number | string;
  per_user_limit: number | string;
  total_limit: number | string | null;
  total_redeemed: number | string;
  starts_at: string | Date;
  ends_at: string | Date;
  is_active: number | boolean;
}

function numOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function mapPromotion(row: PromotionRowDb): PromotionRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    code: row.code,
    type: row.type,
    valueBps: numOrNull(row.value_bps),
    valueCents: numOrNull(row.value_cents),
    maxDiscountCents: numOrNull(row.max_discount_cents),
    minSubtotalCents: Number(row.min_subtotal_cents),
    perUserLimit: Number(row.per_user_limit),
    totalLimit: numOrNull(row.total_limit),
    totalRedeemed: Number(row.total_redeemed),
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    isActive: Boolean(row.is_active),
  };
}

export function createKnexPromotionRepo(db: Knex): PromotionRepo {
  return {
    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createPromotion(input) {
      const inserted = await db('promotion').insert({
        ulid: input.ulid,
        code: input.code,
        type: input.type,
        value_bps: input.valueBps,
        value_cents: input.valueCents,
        max_discount_cents: input.maxDiscountCents,
        min_subtotal_cents: input.minSubtotalCents,
        per_user_limit: input.perUserLimit,
        total_limit: input.totalLimit,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        is_active: input.isActive,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create promotion');
      }
      const row = (await db('promotion').where({ id }).first()) as PromotionRowDb;
      return mapPromotion(row);
    },

    async findPromotionByCode(code) {
      const row = (await db('promotion').where({ code }).first()) as PromotionRowDb | undefined;
      return row ? mapPromotion(row) : null;
    },

    async listPromotions() {
      const rows = (await db('promotion').orderBy('id', 'desc')) as PromotionRowDb[];
      return rows.map(mapPromotion);
    },
  };
}
