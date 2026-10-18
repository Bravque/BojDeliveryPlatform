import { Knex } from 'knex';

/**
 * Phase 2 increment 4 — inventory (doc 03 §3.2). One row per product (product_id is the PK),
 * separated from `product` so stock updates don't contend with catalogue reads. `reserved` holds
 * stock for in-flight orders; reservation/release are atomic conditional updates (see the repo).
 * Products with `track_stock = 0` are effectively unlimited.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('inventory', (t) => {
    t.bigInteger('product_id').unsigned().primary();
    t.boolean('track_stock').notNullable().defaultTo(false);
    t.integer('quantity').notNullable().defaultTo(0); // current on-hand
    t.integer('reserved').notNullable().defaultTo(0); // held by in-flight orders
    t.specificType('version', 'INT UNSIGNED').notNullable().defaultTo(1);
    t.specificType('updated_at', 'DATETIME(3)')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
    t.foreign('product_id').references('id').inTable('product').onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('inventory');
}
