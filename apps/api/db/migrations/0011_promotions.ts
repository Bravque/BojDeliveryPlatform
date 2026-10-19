import { Knex } from 'knex';

/**
 * Phase 3 increment 4 — promotions (doc 03 §3.9).
 *
 * A `promotion` is server-controlled: `percentage` (value_bps), `fixed` (value_cents) or
 * `free_delivery`, with an optional cap (`max_discount_cents`), eligibility (`min_subtotal_cents`,
 * validity window, `is_active`) and limits (`per_user_limit`, `total_limit`/`total_redeemed`). The
 * quote applies a promotion as a **preview** (no redemption). `promotion_redemption` — which ties a
 * promotion to an order and user — lands in increment 5 with the order tables, where per-user
 * limits are enforced and redemptions recorded atomically at checkout.
 *
 * A public `ulid` is added for admin references (the illustrative DDL omits it).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('promotion', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.string('code', 40).notNullable().unique();
    t.enu('type', ['percentage', 'fixed', 'free_delivery']).notNullable();
    t.specificType('value_bps', 'INT UNSIGNED').nullable(); // for percentage
    t.bigInteger('value_cents').nullable(); // for fixed
    t.bigInteger('max_discount_cents').nullable(); // cap (NULL = uncapped)
    t.bigInteger('min_subtotal_cents').notNullable().defaultTo(0);
    t.specificType('per_user_limit', 'INT UNSIGNED').notNullable().defaultTo(1);
    t.specificType('total_limit', 'INT UNSIGNED').nullable(); // NULL = unlimited
    t.specificType('total_redeemed', 'INT UNSIGNED').notNullable().defaultTo(0);
    t.specificType('starts_at', 'DATETIME(3)').notNullable();
    t.specificType('ends_at', 'DATETIME(3)').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('promotion');
}
