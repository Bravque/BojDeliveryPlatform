import { Knex } from 'knex';

/**
 * Phase 3 increment 3 — shopping cart (doc 03 §3.4).
 *
 * One active cart per user (`UNIQUE(user_id)`). The cart is **single-merchant**: `merchant_id` is
 * set by the first item and cleared when the cart empties. `cart_item` holds **references only**
 * (product + selected options) — never prices; the authoritative price is computed at quote time
 * and snapshotted into the order at checkout. `options_json` stores the selected option ulids
 * (validated server-side against the product's option groups). A public `ulid` on `cart_item`
 * lets clients address a line for update/remove.
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('cart', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id').unsigned().notNullable();
    t.bigInteger('merchant_id').unsigned().nullable(); // single-merchant invariant
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.unique(['user_id']); // one active cart per user at launch
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('RESTRICT');
  });

  await knex.schema.createTable('cart_item', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('cart_id').unsigned().notNullable();
    t.bigInteger('product_id').unsigned().notNullable();
    t.specificType('quantity', 'INT UNSIGNED').notNullable();
    t.json('options_json').nullable(); // selected option ulids; validated server-side
    t.foreign('cart_id').references('id').inTable('cart').onDelete('CASCADE');
    t.foreign('product_id').references('id').inTable('product').onDelete('RESTRICT');
    t.index(['cart_id'], 'idx_cart_item_cart');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cart_item');
  await knex.schema.dropTableIfExists('cart');
}
