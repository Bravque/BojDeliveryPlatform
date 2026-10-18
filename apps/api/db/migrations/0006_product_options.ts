import { Knex } from 'knex';

/**
 * Phase 2 increment 3 — product option groups & options (doc 03 §3.2), e.g. "Size: Small/Large"
 * or "Add-ons". Each group has min/max-select bounds; each option carries a non-negative
 * price delta. `ulid` columns are added over the illustrative DDL so groups/options have stable
 * external identifiers (consistent with category/product) — later phases reference selected
 * option ulids and snapshot their deltas.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('product_option_group', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('product_id').unsigned().notNullable();
    t.string('name', 120).notNullable();
    t.specificType('min_select', 'TINYINT UNSIGNED').notNullable().defaultTo(0);
    t.specificType('max_select', 'TINYINT UNSIGNED').notNullable().defaultTo(1);
    t.foreign('product_id').references('id').inTable('product').onDelete('CASCADE');
    t.index(['product_id'], 'idx_option_group_product');
  });

  await knex.schema.createTable('product_option', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('option_group_id').unsigned().notNullable();
    t.string('name', 120).notNullable();
    t.bigInteger('price_delta_cents').notNullable().defaultTo(0); // non-negative add-on cost
    t.boolean('is_available').notNullable().defaultTo(true);
    t.foreign('option_group_id')
      .references('id')
      .inTable('product_option_group')
      .onDelete('CASCADE');
    t.index(['option_group_id'], 'idx_option_group');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('product_option');
  await knex.schema.dropTableIfExists('product_option_group');
}
