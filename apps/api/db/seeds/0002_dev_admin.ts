import { Knex } from 'knex';
import { hashPassword, newUlid } from '../../src/auth/crypto';

/**
 * Phase 1 dev seed — a synthetic **admin dashboard user** for local development and CI only.
 * The credentials are intentionally well-known DEV values and only ever exist in a seeded dev
 * database; this is never a production account (CLAUDE.md: synthetic data for development).
 *
 *   email:    admin@boj.local
 *   password: DevAdmin!2026
 *
 * Idempotent: skips if the account already exists.
 */
const DEV_ADMIN_EMAIL = 'admin@boj.local';
const DEV_ADMIN_PASSWORD = 'DevAdmin!2026';

export async function seed(knex: Knex): Promise<void> {
  const existing = await knex('user').where({ email: DEV_ADMIN_EMAIL }).first('id');
  if (existing) {
    return;
  }

  const passwordHash = await hashPassword(DEV_ADMIN_PASSWORD);

  await knex.transaction(async (trx) => {
    const inserted = await trx('user').insert({
      ulid: newUlid(),
      phone_e164: '+254700000001',
      email: DEV_ADMIN_EMAIL,
      display_name: 'Dev Admin',
      password_hash: passwordHash,
      status: 'active',
    });
    const userId = inserted[0];
    if (userId === undefined) {
      throw new Error('Failed to seed dev admin');
    }

    const role = (await trx('role').where({ code: 'admin' }).first('id')) as
      { id: number | string } | undefined;
    if (!role) {
      throw new Error('admin role not found — run migrations before seeding');
    }
    await trx('user_role').insert({ user_id: userId, role_id: role.id });
  });
}
