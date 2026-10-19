import { Knex } from 'knex';

/**
 * Phase 4 increment 1 — double-entry ledger (doc 03 §3.8, doc 07 §7).
 *
 * Every money movement is a balanced `ledger_transaction` with ≥2 `ledger_entry` rows whose debits
 * equal its credits (enforced in the app, verified by a job). `idempotency_key` is UNIQUE so a
 * retried capture/refund is a no-op. Accounts are the chart of accounts: platform accounts are
 * seeded; per-merchant / per-rider payable accounts (`merchant_payable:{id}`) are created on demand.
 * The ledger — not any mutable balance field — is the source of financial truth (E8).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('ledger_account', (t) => {
    t.bigIncrements('id');
    t.string('code', 40).notNullable().unique();
    t.enu('type', ['asset', 'liability', 'revenue', 'expense']).notNullable();
    t.enu('owner_type', ['platform', 'merchant', 'rider']).notNullable().defaultTo('platform');
    t.bigInteger('owner_id').unsigned().nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
  });

  await knex.schema.createTable('ledger_transaction', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.string('kind', 40).notNullable(); // order_capture, refund, settlement, payout, adjustment
    t.string('ref_type', 40).notNullable(); // order/payment/refund/…
    t.bigInteger('ref_id').unsigned().notNullable();
    t.string('idempotency_key', 120).notNullable().unique();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.index(['ref_type', 'ref_id'], 'idx_ledger_txn_ref');
  });

  await knex.schema.createTable('ledger_entry', (t) => {
    t.bigIncrements('id');
    t.bigInteger('transaction_id').unsigned().notNullable();
    t.bigInteger('account_id').unsigned().notNullable();
    t.enu('direction', ['debit', 'credit']).notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.foreign('transaction_id').references('id').inTable('ledger_transaction').onDelete('CASCADE');
    t.foreign('account_id').references('id').inTable('ledger_account').onDelete('RESTRICT');
    t.index(['account_id'], 'idx_ledger_entry_account');
    t.index(['transaction_id'], 'idx_ledger_entry_txn');
  });

  // Amounts are always positive (direction carries the sign); defence-in-depth behind the
  // app-level balance check.
  await knex.raw(
    'ALTER TABLE `ledger_entry` ADD CONSTRAINT `chk_ledger_entry_amount` CHECK (`amount_cents` > 0)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ledger_entry');
  await knex.schema.dropTableIfExists('ledger_transaction');
  await knex.schema.dropTableIfExists('ledger_account');
}
