import { Knex } from 'knex';

/**
 * Phase 4 increment 5 — refunds (doc 03 §3.7, doc 07 §8).
 *
 * A `refund` is the lifecycle record for returning funds on a captured order:
 * `requested → approved → processing → completed` (or `rejected` / `failed`). `idempotency_key`
 * is UNIQUE so a duplicate request or execution can never double-pay. `source` separates `manual`
 * refunds (ops/finance — subject to separation of duties, requester ≠ approver) from `auto`
 * refunds raised by the late-success-after-cancel reconciliation edge, which have no human
 * requester (hence nullable `requested_by`). The ledger reversal into `refunds_payable` is posted
 * on completion; the actual cash outflow is settled at payout (Phase 7).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('refund', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('order_id').unsigned().notNullable();
    t.bigInteger('payment_id').unsigned().notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.string('reason', 255).notNullable();
    t.enu('status', ['requested', 'approved', 'processing', 'completed', 'failed', 'rejected'])
      .notNullable()
      .defaultTo('requested');
    t.enu('source', ['manual', 'auto']).notNullable().defaultTo('manual');
    t.bigInteger('requested_by').unsigned().nullable(); // null for source='auto' (system)
    t.bigInteger('approved_by').unsigned().nullable();
    t.string('provider_ref', 64).nullable(); // gateway reversal / B2C id
    t.string('idempotency_key', 80).notNullable().unique(); // guards double-refund
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('approved_at', 'DATETIME(3)').nullable();
    t.specificType('completed_at', 'DATETIME(3)').nullable();
    t.foreign('order_id').references('id').inTable('order').onDelete('RESTRICT');
    t.foreign('payment_id').references('id').inTable('payment').onDelete('RESTRICT');
    t.foreign('requested_by').references('id').inTable('user').onDelete('RESTRICT');
    t.foreign('approved_by').references('id').inTable('user').onDelete('RESTRICT');
    t.index(['order_id'], 'idx_refund_order');
    t.index(['status'], 'idx_refund_status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('refund');
}
