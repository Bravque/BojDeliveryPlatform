import { Knex } from 'knex';

/**
 * Phase 2 increment 2 — catalogue: categories & products (doc 03 §3.2). `product.version` is an
 * optimistic lock bumped on every edit (price edits in particular). `category.ulid` is added
 * over the illustrative DDL so categories have a stable external identifier (consistent with
 * merchant/product).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('category', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('merchant_id').unsigned().notNullable();
    t.string('name', 120).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('CASCADE');
    t.index(['merchant_id'], 'idx_category_merchant');
  });

  await knex.schema.createTable('product', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('merchant_id').unsigned().notNullable();
    t.bigInteger('category_id').unsigned().nullable();
    t.string('name', 160).notNullable();
    t.text('description').nullable();
    t.bigInteger('price_cents').notNullable(); // authoritative base price (integer cents)
    t.specificType('currency', 'CHAR(3)').notNullable().defaultTo('KES');
    t.boolean('is_available').notNullable().defaultTo(true);
    t.specificType('version', 'INT UNSIGNED').notNullable().defaultTo(1); // optimistic lock
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('CASCADE');
    t.foreign('category_id').references('id').inTable('category').onDelete('SET NULL');
    t.index(['merchant_id', 'is_available'], 'idx_product_merchant_available');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('product');
  await knex.schema.dropTableIfExists('category');
}
