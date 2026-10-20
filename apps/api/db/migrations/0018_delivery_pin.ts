import { Knex } from 'knex';

/**
 * Phase 5 increment 5 — proof-of-delivery PIN (doc 07 D7). One PIN per delivery: the customer is
 * issued a code (plaintext returned once, only the Argon2id hash is stored) and the rider submits
 * it to complete the delivery. `attempts`/`max_attempts` bound brute force; `expires_at` bounds the
 * window; `consumed_at` marks a used PIN. Re-issuing overwrites the row (new hash, attempts reset).
 */
export async function up(knex: Knex): Promise<void> {
  const now = knex.raw('CURRENT_TIMESTAMP(3)');

  await knex.schema.createTable('delivery_pin', (t) => {
    t.bigIncrements('id');
    t.bigInteger('delivery_id').unsigned().notNullable().unique(); // one live PIN per delivery
    t.string('pin_hash', 255).notNullable(); // Argon2id — never plaintext
    t.specificType('expires_at', 'DATETIME(3)').notNullable();
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('max_attempts').unsigned().notNullable().defaultTo(5);
    t.specificType('consumed_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(now);
    t.foreign('delivery_id').references('id').inTable('delivery').onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('delivery_pin');
}
