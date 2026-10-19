import { Knex } from 'knex';

/**
 * Phase 3 increment 2 — per-zone delivery-fee rules (doc 03 §3.3, pricing D3).
 *
 * A rule prices delivery within a zone as `base_fee_cents + per_km_cents × distance_km`, clamped
 * to `[min_fee_cents, max_fee_cents]`. Rules are time-boxed (`effective_from`/`effective_to`) so a
 * price change is a new row, never an in-place edit of history; the rule in force at a given
 * instant is the latest `effective_from` whose window covers it. All amounts are integer cents
 * (server-authoritative — the client never supplies a delivery fee). A public `ulid` is added for
 * external references, consistent with the other tables.
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('delivery_fee_rule', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('zone_id').unsigned().notNullable();
    t.bigInteger('base_fee_cents').notNullable();
    t.bigInteger('per_km_cents').notNullable().defaultTo(0);
    t.bigInteger('min_fee_cents').notNullable();
    t.bigInteger('max_fee_cents').nullable(); // NULL = uncapped
    t.specificType('effective_from', 'DATETIME(3)').notNullable();
    t.specificType('effective_to', 'DATETIME(3)').nullable(); // NULL = open-ended
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.foreign('zone_id').references('id').inTable('zone').onDelete('CASCADE');
    t.index(['zone_id', 'effective_from'], 'idx_fee_rule_zone_effective');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('delivery_fee_rule');
}
