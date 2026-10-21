import { Knex } from 'knex';

/**
 * Phase 6 increment 3 — notifications (doc 02 §3). `device` stores a user's push tokens (one row per
 * token; re-registering a token re-points it at the current user). `notification` is a lightweight
 * dispatch record — one row per message the dispatcher fans out (push or SMS) — for auditing/debug.
 * Providers are mock/dev adapters this phase; real Expo Push + SMS swap in at Phase 8 (D12).
 */
export async function up(knex: Knex): Promise<void> {
  const now = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdated = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('device', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id').unsigned().notNullable();
    t.string('push_token', 255).notNullable().unique(); // one device token → one user
    t.enu('platform', ['ios', 'android', 'web']).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdated);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.index(['user_id'], 'idx_device_user');
  });

  await knex.schema.createTable('notification', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id').unsigned().notNullable();
    t.enu('channel', ['push', 'sms']).notNullable();
    t.string('kind', 64).notNullable(); // e.g. order.new, rider.assigned, order.delivered
    t.enu('status', ['sent', 'failed', 'skipped']).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.index(['user_id', 'created_at'], 'idx_notification_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification');
  await knex.schema.dropTableIfExists('device');
}
