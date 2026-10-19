import { Knex } from 'knex';
import { PLATFORM_ACCOUNTS } from '../../src/ledger/accounts';

/**
 * Phase 4 seed — the fixed **platform** chart of accounts (doc 07 §7). Per-merchant / per-rider
 * payable accounts are created on demand by the ledger service, so they are not seeded here.
 *
 * Idempotent: existing accounts are left untouched (the ledger service also get-or-creates, so a
 * fresh CI database without this seed still works).
 */
export async function seed(knex: Knex): Promise<void> {
  for (const account of PLATFORM_ACCOUNTS) {
    await knex('ledger_account')
      .insert({ code: account.code, type: account.type, owner_type: 'platform', owner_id: null })
      .onConflict('code')
      .ignore();
  }
}
