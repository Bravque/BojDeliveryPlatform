import { Knex } from 'knex';

/**
 * Phase 5 increment 1 — rider profiles (doc 03 §3.6). A `rider_profile` is keyed by `user_id`
 * (one profile per user); a rider self-applies (`status = 'pending'`) and an admin approves
 * (`approved`) or suspends. `vehicle_type` is required at application. The presence columns
 * (`is_online`, `last_lat/lng`, `last_ping_at`) are populated in increment 2 and read by candidate
 * selection in increment 4; `(status, is_online)` is indexed to support that query. A small
 * addition over the illustrative DDL: `created_at`/`updated_at` (consistent with the other tables).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('rider_profile', (t) => {
    t.bigInteger('user_id').unsigned().primary();
    t.enu('status', ['pending', 'approved', 'suspended']).notNullable().defaultTo('pending');
    t.enu('vehicle_type', ['motorbike', 'bicycle', 'car', 'foot']).notNullable();
    t.boolean('is_online').notNullable().defaultTo(false);
    t.decimal('last_lat', 9, 6).nullable();
    t.decimal('last_lng', 9, 6).nullable();
    t.specificType('last_ping_at', 'DATETIME(3)').nullable();
    t.decimal('rating_avg', 3, 2).nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.index(['status', 'is_online'], 'idx_rider_status_online');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rider_profile');
}
