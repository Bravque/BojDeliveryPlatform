import { Knex } from 'knex';

/**
 * Phase 7 increment 2 — payouts (doc 03 §3.8, doc 07 §10). A `payout` pays a merchant (from an
 * approved settlement) or a rider (from delivered-fee earnings) via simulated M-Pesa B2C.
 * Dual-sign: both `finance_approved_by` and `ops_approved_by` (two distinct users) must be set
 * before execute. `idempotency_key` UNIQUE makes generation + the ledger draw-down idempotent
 * (`DR merchant_payable|rider_payable / CR mpesa_clearing` on `paid`). `payout_line` records what
 * the payout covers (a settlement, or individual deliveries).
 */
export async function up(knex: Knex): Promise<void> {
  const now = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('payout', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.enu('payee_type', ['merchant', 'rider']).notNullable();
    t.bigInteger('payee_id').unsigned().notNullable(); // merchant.id or rider_profile.user_id
    t.bigInteger('amount_cents').notNullable();
    t.enu('status', ['draft', 'approved', 'processing', 'paid', 'failed'])
      .notNullable()
      .defaultTo('draft');
    t.enu('method', ['mpesa_b2c', 'manual']).notNullable().defaultTo('mpesa_b2c');
    t.string('external_ref', 80).nullable(); // provider B2C conversation id
    t.string('idempotency_key', 120).notNullable().unique();
    t.bigInteger('finance_approved_by').unsigned().nullable();
    t.bigInteger('ops_approved_by').unsigned().nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.specificType('paid_at', 'DATETIME(3)').nullable();
    t.foreign('finance_approved_by').references('id').inTable('user').onDelete('RESTRICT');
    t.foreign('ops_approved_by').references('id').inTable('user').onDelete('RESTRICT');
    t.index(['status'], 'idx_payout_status');
    t.index(['payee_type', 'payee_id'], 'idx_payout_payee');
  });

  await knex.schema.createTable('payout_line', (t) => {
    t.bigIncrements('id');
    t.bigInteger('payout_id').unsigned().notNullable();
    t.enu('ref_type', ['settlement', 'delivery']).notNullable();
    t.bigInteger('ref_id').unsigned().notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.foreign('payout_id').references('id').inTable('payout').onDelete('CASCADE');
    t.index(['payout_id'], 'idx_payout_line_payout');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payout_line');
  await knex.schema.dropTableIfExists('payout');
}
