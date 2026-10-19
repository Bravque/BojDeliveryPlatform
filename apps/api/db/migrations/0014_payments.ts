import { Knex } from 'knex';

/**
 * Phase 4 increment 2 — payments + idempotent payment events (doc 03 §3.7, doc 07 §3–4).
 *
 * `payment` holds the M-Pesa STK attempt for an order: `idempotency_key` (client-provided) is
 * UNIQUE so re-initiation is safe; `checkout_request_id` and `mpesa_receipt` are UNIQUE so a
 * callback can be correlated and a receipt can never credit twice. `payment_event` is the
 * append-only record of every raw callback/query result — `dedupe_key` UNIQUE makes duplicate
 * callbacks a no-op (capture lands in increment 3).
 */
export async function up(knex: Knex): Promise<void> {
  const initiatedAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('payment', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('order_id').unsigned().notNullable();
    t.enu('method', ['mpesa_stk', 'cash', 'simulated']).notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.specificType('currency', 'CHAR(3)').notNullable().defaultTo('KES');
    t.enu('status', ['initiated', 'pending', 'succeeded', 'failed', 'timed_out', 'reversed'])
      .notNullable()
      .defaultTo('initiated');
    t.string('merchant_request_id', 64).nullable();
    t.string('checkout_request_id', 64).nullable().unique(); // STK correlation id
    t.string('mpesa_receipt', 32).nullable().unique(); // unique receipt prevents double-credit
    t.string('idempotency_key', 80).notNullable().unique(); // guards re-initiation
    t.specificType('initiated_at', 'DATETIME(3)').notNullable().defaultTo(initiatedAt);
    t.specificType('settled_at', 'DATETIME(3)').nullable();
    t.foreign('order_id').references('id').inTable('order').onDelete('RESTRICT');
    t.index(['order_id', 'status'], 'idx_payment_order_status');
  });

  await knex.schema.createTable('payment_event', (t) => {
    t.bigIncrements('id');
    t.bigInteger('payment_id').unsigned().nullable();
    t.enu('source', ['stk_callback', 'status_query', 'reconciliation', 'manual']).notNullable();
    t.string('dedupe_key', 120).notNullable().unique(); // e.g. checkout_request_id + ':' + result_code
    t.integer('result_code').nullable();
    t.json('raw_payload').notNullable();
    t.specificType('received_at', 'DATETIME(3)').notNullable().defaultTo(initiatedAt);
    t.foreign('payment_id').references('id').inTable('payment').onDelete('SET NULL');
    t.index(['payment_id'], 'idx_payment_event_payment');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_event');
  await knex.schema.dropTableIfExists('payment');
}
