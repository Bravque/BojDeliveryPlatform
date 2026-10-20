import { Knex } from 'knex';

/**
 * Phase 5 increment 4 — rider assignment (doc 03 §3.6, doc 08 §2). An `assignment_offer` is a
 * time-boxed offer of one order to one rider; offers are made sequentially (one live at a time per
 * order) and resolve to accepted/declined/expired/superseded. A `delivery` is the single
 * fulfilment record per order — `order_id` is UNIQUE, which is the hard backstop that at most one
 * rider can be assigned even under a concurrent-accept race. `rider_fee_cents` is the rider's
 * earning snapshot (D15), set at accept and never rewritten by later rate changes.
 */
export async function up(knex: Knex): Promise<void> {
  const now = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('assignment_offer', (t) => {
    t.bigIncrements('id');
    t.bigInteger('order_id').unsigned().notNullable();
    t.bigInteger('rider_id').unsigned().notNullable(); // rider_profile.user_id
    t.enu('status', ['offered', 'accepted', 'declined', 'expired', 'superseded'])
      .notNullable()
      .defaultTo('offered');
    t.specificType('offered_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.specificType('responded_at', 'DATETIME(3)').nullable();
    t.specificType('expires_at', 'DATETIME(3)').notNullable();
    t.foreign('order_id').references('id').inTable('order').onDelete('CASCADE');
    t.foreign('rider_id').references('user_id').inTable('rider_profile').onDelete('CASCADE');
    t.index(['order_id', 'status'], 'idx_offer_order_status');
    t.index(['rider_id', 'status'], 'idx_offer_rider_status');
  });

  await knex.schema.createTable('delivery', (t) => {
    t.bigIncrements('id');
    t.bigInteger('order_id').unsigned().notNullable().unique(); // one delivery per order (backstop)
    t.bigInteger('rider_id').unsigned().nullable(); // rider_profile.user_id
    t.enu('status', ['unassigned', 'assigned', 'picked_up', 'delivered', 'failed'])
      .notNullable()
      .defaultTo('unassigned');
    t.bigInteger('rider_fee_cents').notNullable().defaultTo(0); // earnings snapshot (D15)
    t.specificType('pickup_confirmed_at', 'DATETIME(3)').nullable();
    t.specificType('delivered_at', 'DATETIME(3)').nullable();
    t.enu('proof_type', ['pin', 'otp', 'photo', 'signature', 'none'])
      .notNullable()
      .defaultTo('none');
    t.string('proof_ref', 255).nullable(); // hashed PIN (increment 5), never plaintext
    t.foreign('order_id').references('id').inTable('order').onDelete('RESTRICT');
    t.foreign('rider_id').references('user_id').inTable('rider_profile').onDelete('RESTRICT');
    t.index(['rider_id', 'status'], 'idx_delivery_rider_status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('delivery');
  await knex.schema.dropTableIfExists('assignment_offer');
}
