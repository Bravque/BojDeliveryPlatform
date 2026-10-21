import { Knex } from 'knex';

/**
 * Phase 7 increment 1 — merchant settlements (doc 03 §3.8, doc 07 §10). A `settlement` is a
 * per-merchant, per-period statement of what the merchant has earned: `net = gross − commission −
 * refunds` over the **delivered, non-fully-refunded** orders in the period (partial refunds are
 * merchant-borne, D14). `UNIQUE(merchant_id, period_start, period_end)` makes generation idempotent.
 * `settlement_line` snapshots the per-order contribution. The money moves at payout (increment 2);
 * a settlement is a statement + approval gate, not a ledger posting.
 */
export async function up(knex: Knex): Promise<void> {
  const now = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('settlement', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('merchant_id').unsigned().notNullable();
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.bigInteger('gross_cents').notNullable();
    t.bigInteger('commission_cents').notNullable();
    t.bigInteger('refunds_cents').notNullable().defaultTo(0);
    t.bigInteger('net_cents').notNullable();
    t.enu('status', ['draft', 'approved', 'paid', 'failed']).notNullable().defaultTo('draft');
    t.bigInteger('approved_by').unsigned().nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.specificType('approved_at', 'DATETIME(3)').nullable();
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('RESTRICT');
    t.foreign('approved_by').references('id').inTable('user').onDelete('RESTRICT');
    t.unique(['merchant_id', 'period_start', 'period_end'], {
      indexName: 'uq_settlement_merchant_period',
    });
    t.index(['status'], 'idx_settlement_status');
  });

  await knex.schema.createTable('settlement_line', (t) => {
    t.bigIncrements('id');
    t.bigInteger('settlement_id').unsigned().notNullable();
    t.bigInteger('order_id').unsigned().notNullable();
    t.bigInteger('gross_cents').notNullable();
    t.bigInteger('commission_cents').notNullable();
    t.bigInteger('refunds_cents').notNullable().defaultTo(0);
    t.bigInteger('net_cents').notNullable();
    t.foreign('settlement_id').references('id').inTable('settlement').onDelete('CASCADE');
    t.foreign('order_id').references('id').inTable('order').onDelete('RESTRICT');
    t.index(['settlement_id'], 'idx_settlement_line_settlement');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('settlement_line');
  await knex.schema.dropTableIfExists('settlement');
}
