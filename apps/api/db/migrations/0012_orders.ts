import { Knex } from 'knex';

/**
 * Phase 3 increment 5 — orders (doc 03 §3.5) + promotion redemptions (§3.9).
 *
 * `order` carries the authoritative, server-computed **money snapshot** (subtotal/delivery/
 * service/discount/total + commission rate & amount) and the fulfilment `status` (doc 04). Line
 * snapshots (`order_item` + `order_item_option`) freeze names/prices at checkout. Every status
 * change is appended to `order_status_history` in the same transaction. `promotion_redemption`
 * ties a promotion to an order + user (one promo per order via `UNIQUE(order_id)`), enabling the
 * per-user-limit enforcement deferred from increment 4.
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('order', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.string('order_number', 20).notNullable().unique();
    t.bigInteger('customer_id').unsigned().notNullable();
    t.bigInteger('merchant_id').unsigned().notNullable();
    t.bigInteger('town_id').unsigned().notNullable();
    t.bigInteger('zone_id').unsigned().notNullable();
    t.bigInteger('delivery_address_id').unsigned().notNullable();
    t.string('status', 40).notNullable();
    t.bigInteger('subtotal_cents').notNullable();
    t.bigInteger('delivery_fee_cents').notNullable();
    t.bigInteger('service_fee_cents').notNullable().defaultTo(0);
    t.bigInteger('discount_cents').notNullable().defaultTo(0);
    t.bigInteger('total_cents').notNullable();
    t.specificType('commission_bps', 'INT UNSIGNED').notNullable();
    t.bigInteger('commission_cents').notNullable().defaultTo(0);
    t.specificType('currency', 'CHAR(3)').notNullable().defaultTo('KES');
    t.enu('payment_status', [
      'unpaid',
      'pending',
      'paid',
      'failed',
      'refunded',
      'partially_refunded',
    ])
      .notNullable()
      .defaultTo('unpaid');
    t.specificType('placed_at', 'DATETIME(3)').nullable();
    t.string('cancelled_reason', 255).nullable();
    t.specificType('distance_m', 'INT UNSIGNED').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.foreign('customer_id').references('id').inTable('user').onDelete('RESTRICT');
    t.foreign('merchant_id').references('id').inTable('merchant').onDelete('RESTRICT');
    t.foreign('town_id').references('id').inTable('town').onDelete('RESTRICT');
    t.foreign('zone_id').references('id').inTable('zone').onDelete('RESTRICT');
    t.foreign('delivery_address_id').references('id').inTable('address').onDelete('RESTRICT');
    t.index(['customer_id', 'created_at'], 'idx_order_customer');
    t.index(['merchant_id', 'status'], 'idx_order_merchant_status');
    t.index(['status', 'created_at'], 'idx_order_status');
  });

  await knex.schema.createTable('order_item', (t) => {
    t.bigIncrements('id');
    t.bigInteger('order_id').unsigned().notNullable();
    t.bigInteger('product_id').unsigned().notNullable();
    t.string('name_snapshot', 160).notNullable();
    t.bigInteger('unit_price_cents').notNullable();
    t.specificType('quantity', 'INT UNSIGNED').notNullable();
    t.bigInteger('line_total_cents').notNullable();
    t.foreign('order_id').references('id').inTable('order').onDelete('CASCADE');
    t.foreign('product_id').references('id').inTable('product').onDelete('RESTRICT');
    t.index(['order_id'], 'idx_order_item_order');
  });

  await knex.schema.createTable('order_item_option', (t) => {
    t.bigIncrements('id');
    t.bigInteger('order_item_id').unsigned().notNullable();
    t.string('name_snapshot', 120).notNullable();
    t.bigInteger('price_delta_cents').notNullable();
    t.foreign('order_item_id').references('id').inTable('order_item').onDelete('CASCADE');
    t.index(['order_item_id'], 'idx_order_item_option_item');
  });

  await knex.schema.createTable('order_status_history', (t) => {
    t.bigIncrements('id');
    t.bigInteger('order_id').unsigned().notNullable();
    t.string('from_status', 40).nullable();
    t.string('to_status', 40).notNullable();
    t.enu('actor_type', ['customer', 'merchant', 'rider', 'admin', 'system']).notNullable();
    t.bigInteger('actor_user_id').unsigned().nullable();
    t.string('reason', 255).nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.foreign('order_id').references('id').inTable('order').onDelete('CASCADE');
    t.index(['order_id', 'created_at'], 'idx_order_history_order');
  });

  await knex.schema.createTable('promotion_redemption', (t) => {
    t.bigIncrements('id');
    t.bigInteger('promotion_id').unsigned().notNullable();
    t.bigInteger('user_id').unsigned().notNullable();
    t.bigInteger('order_id').unsigned().notNullable().unique(); // one promo per order
    t.bigInteger('discount_cents').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.foreign('promotion_id').references('id').inTable('promotion').onDelete('RESTRICT');
    t.foreign('user_id').references('id').inTable('user').onDelete('RESTRICT');
    t.foreign('order_id').references('id').inTable('order').onDelete('CASCADE');
    t.unique(['promotion_id', 'user_id', 'order_id']);
    t.index(['promotion_id', 'user_id'], 'idx_redemption_promo_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('promotion_redemption');
  await knex.schema.dropTableIfExists('order_status_history');
  await knex.schema.dropTableIfExists('order_item_option');
  await knex.schema.dropTableIfExists('order_item');
  await knex.schema.dropTableIfExists('order');
}
