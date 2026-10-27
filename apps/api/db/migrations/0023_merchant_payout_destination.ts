import { Knex } from 'knex';

/**
 * Go-live gap closure — merchant B2C payout destination. Rider payouts already resolve a payee
 * MSISDN from `user.phone_e164`; merchants had no destination modelled, so a real Daraja B2C payout
 * to a merchant failed with "no destination". This adds the merchant's own M-Pesa number, stored in
 * canonical E.164 (`+2547XXXXXXXX`), parallel to `user.phone_e164`. Nullable: existing merchants and
 * those settled out-of-band have none, and `getPayeeMsisdn` returns null (payout is retryable once a
 * destination is set) rather than guessing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('merchant', (t) => {
    t.string('payout_phone_e164', 20).nullable(); // +2547XXXXXXXX — B2C PartyB destination
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('merchant', (t) => {
    t.dropColumn('payout_phone_e164');
  });
}
