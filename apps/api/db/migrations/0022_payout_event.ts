import { Knex } from 'knex';

/**
 * Phase 8 increment 3 — raw M-Pesa B2C result events (doc 07 §2, §10). Every B2C result/timeout
 * callback is persisted here **before** processing, and `dedupe_key` UNIQUE makes a replayed
 * callback a no-op — parity with `payment_event`, so "no money event is ever lost" and a payout is
 * confirmed at most once. `payout_id` is nullable because an unrecognised conversation id is still
 * recorded (then surfaced for ops) rather than dropped.
 */
export async function up(knex: Knex): Promise<void> {
  const receivedAt = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('payout_event', (t) => {
    t.bigIncrements('id');
    t.bigInteger('payout_id').unsigned().nullable();
    t.enu('source', ['b2c_result', 'b2c_timeout', 'manual']).notNullable();
    t.string('dedupe_key', 120).notNullable().unique(); // e.g. conversation_id + ':' + result_code
    t.integer('result_code').nullable();
    t.json('raw_payload').notNullable();
    t.specificType('received_at', 'DATETIME(3)').notNullable().defaultTo(receivedAt);
    t.foreign('payout_id').references('id').inTable('payout').onDelete('SET NULL');
    t.index(['payout_id'], 'idx_payout_event_payout');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payout_event');
}
