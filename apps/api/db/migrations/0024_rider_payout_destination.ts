import { Knex } from 'knex';

/**
 * Rider withdrawal destination — the M-Pesa number a rider's earnings are paid out to. Parallel to
 * `merchant.payout_phone_e164` (migration `0023`). Nullable: when unset, payouts fall back to the
 * rider's sign-in number (`user.phone_e164`), so this only overrides where earnings are withdrawn.
 * Stored in canonical E.164 (`+2547XXXXXXXX`).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('rider_profile', (t) => {
    t.string('payout_phone_e164', 20).nullable(); // +2547XXXXXXXX — B2C withdrawal destination
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('rider_profile', (t) => {
    t.dropColumn('payout_phone_e164');
  });
}
