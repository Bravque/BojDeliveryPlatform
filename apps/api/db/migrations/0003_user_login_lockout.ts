import { Knex } from 'knex';

/**
 * Phase 1 increment 5 — account lockout for dashboard email/password login (doc 06 §2.2).
 * Tracks consecutive failed logins and, once a threshold is crossed, a lockout window. Both
 * reset on a successful login. (OTP-only accounts keep a NULL password_hash and never log in
 * this way.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (t) => {
    t.specificType('failed_login_count', 'SMALLINT UNSIGNED').notNullable().defaultTo(0);
    t.specificType('locked_until', 'DATETIME(3)').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user', (t) => {
    t.dropColumn('failed_login_count');
    t.dropColumn('locked_until');
  });
}
