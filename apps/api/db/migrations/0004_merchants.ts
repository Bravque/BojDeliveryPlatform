import { Knex } from 'knex';

/**
 * Phase 2 increment 1 — merchants & their staff (doc 03 §3.2). `commission_bps` is
 * server-controlled (set by admin, D2). `status` drives approval; `is_open` + `status` gate
 * public visibility. A small addition over the illustrative DDL: `updated_at` with ON UPDATE
 * (consistent with the other mutable tables).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('merchant', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('town_id').unsigned().notNullable();
    t.string('name', 160).notNullable();
    t.enu('category_type', ['restaurant', 'grocery', 'pharmacy', 'retail', 'other']).notNullable();
    t.enu('status', ['pending', 'approved', 'suspended', 'closed'])
      .notNullable()
      .defaultTo('pending');
    t.boolean('is_open').notNullable().defaultTo(false);
    t.specificType('prep_minutes', 'SMALLINT UNSIGNED').notNullable().defaultTo(20);
    t.specificType('commission_bps', 'INT UNSIGNED').notNullable(); // basis points, server-controlled
    t.decimal('lat', 9, 6).nullable();
    t.decimal('lng', 9, 6).nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.foreign('town_id').references('id').inTable('town').onDelete('RESTRICT');
    t.index(['town_id', 'status'], 'idx_merchant_town_status');
  });

  await knex.schema.createTable('merchant_user', (t) => {
    t.bigInteger('merchant_id').unsigned().notNullable();
    t.bigInteger('user_id').unsigned().notNullable();
    t.enu('role', ['owner', 'staff']).notNullable();
    t.primary(['merchant_id', 'user_id']);
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('CASCADE');
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.index(['user_id'], 'idx_merchant_user_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('merchant_user');
  await knex.schema.dropTableIfExists('merchant');
}
