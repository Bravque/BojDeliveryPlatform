import type { Knex } from 'knex';

/**
 * Persistence for delivery-fee rules, behind an interface for in-memory unit testing. Rules are
 * append-only in spirit (a change is a new time-boxed row); `findEffectiveRule` picks the rule in
 * force at an instant — the latest `effective_from` whose window covers it.
 */

export interface DeliveryFeeRuleRecord {
  id: number;
  ulid: string;
  zoneId: number;
  baseFeeCents: number;
  perKmCents: number;
  minFeeCents: number;
  maxFeeCents: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface CreateFeeRuleInput {
  ulid: string;
  zoneId: number;
  baseFeeCents: number;
  perKmCents: number;
  minFeeCents: number;
  maxFeeCents: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface UpdateFeeRulePatch {
  baseFeeCents?: number;
  perKmCents?: number;
  minFeeCents?: number;
  maxFeeCents?: number | null;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

export interface DeliveryFeeRuleRepo {
  findZoneIdByUlid(ulid: string): Promise<number | null>;
  findUserIdByUlid(ulid: string): Promise<number | null>;
  createRule(input: CreateFeeRuleInput): Promise<DeliveryFeeRuleRecord>;
  findRuleByUlid(ulid: string): Promise<DeliveryFeeRuleRecord | null>;
  listRules(zoneId: number): Promise<DeliveryFeeRuleRecord[]>;
  updateRule(id: number, patch: UpdateFeeRulePatch): Promise<void>;
  /** The rule in force in `zoneId` at `at`, or null when none covers that instant. */
  findEffectiveRule(zoneId: number, at: Date): Promise<DeliveryFeeRuleRecord | null>;
}

interface FeeRuleRowDb {
  id: number | string;
  ulid: string;
  zone_id: number | string;
  base_fee_cents: number | string;
  per_km_cents: number | string;
  min_fee_cents: number | string;
  max_fee_cents: number | string | null;
  effective_from: string | Date;
  effective_to: string | Date | null;
}

function mapRule(row: FeeRuleRowDb): DeliveryFeeRuleRecord {
  return {
    id: Number(row.id),
    ulid: row.ulid,
    zoneId: Number(row.zone_id),
    baseFeeCents: Number(row.base_fee_cents),
    perKmCents: Number(row.per_km_cents),
    minFeeCents: Number(row.min_fee_cents),
    maxFeeCents: row.max_fee_cents === null ? null : Number(row.max_fee_cents),
    effectiveFrom: new Date(row.effective_from),
    effectiveTo: row.effective_to === null ? null : new Date(row.effective_to),
  };
}

export function createKnexDeliveryFeeRuleRepo(db: Knex): DeliveryFeeRuleRepo {
  return {
    async findZoneIdByUlid(ulid) {
      const row = (await db('zone').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async findUserIdByUlid(ulid) {
      const row = (await db('user').where({ ulid }).first('id')) as
        { id: number | string } | undefined;
      return row ? Number(row.id) : null;
    },

    async createRule(input) {
      const inserted = await db('delivery_fee_rule').insert({
        ulid: input.ulid,
        zone_id: input.zoneId,
        base_fee_cents: input.baseFeeCents,
        per_km_cents: input.perKmCents,
        min_fee_cents: input.minFeeCents,
        max_fee_cents: input.maxFeeCents,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
      });
      const id = inserted[0];
      if (id === undefined) {
        throw new Error('Failed to create delivery fee rule');
      }
      const row = (await db('delivery_fee_rule').where({ id }).first()) as FeeRuleRowDb;
      return mapRule(row);
    },

    async findRuleByUlid(ulid) {
      const row = (await db('delivery_fee_rule').where({ ulid }).first()) as
        FeeRuleRowDb | undefined;
      return row ? mapRule(row) : null;
    },

    async listRules(zoneId) {
      const rows = (await db('delivery_fee_rule')
        .where({ zone_id: zoneId })
        .orderBy('effective_from', 'desc')) as FeeRuleRowDb[];
      return rows.map(mapRule);
    },

    async updateRule(id, patch) {
      const row: Record<string, unknown> = {};
      if (patch.baseFeeCents !== undefined) row.base_fee_cents = patch.baseFeeCents;
      if (patch.perKmCents !== undefined) row.per_km_cents = patch.perKmCents;
      if (patch.minFeeCents !== undefined) row.min_fee_cents = patch.minFeeCents;
      if (patch.maxFeeCents !== undefined) row.max_fee_cents = patch.maxFeeCents;
      if (patch.effectiveFrom !== undefined) row.effective_from = patch.effectiveFrom;
      if (patch.effectiveTo !== undefined) row.effective_to = patch.effectiveTo;
      if (Object.keys(row).length > 0) {
        await db('delivery_fee_rule').where({ id }).update(row);
      }
    },

    async findEffectiveRule(zoneId, at) {
      const row = (await db('delivery_fee_rule')
        .where({ zone_id: zoneId })
        .where('effective_from', '<=', at)
        .where((b) => b.whereNull('effective_to').orWhere('effective_to', '>', at))
        .orderBy('effective_from', 'desc')
        .first()) as FeeRuleRowDb | undefined;
      return row ? mapRule(row) : null;
    },
  };
}
