import { Knex } from 'knex';

/**
 * Phase 0 synthetic seed (D1 — launch town & zones).
 *
 * Loads a single launch town, **Migori**, with one compact **Migori CBD** delivery zone,
 * modelled as ordinary configurable DB records (not hardcoded geography). Both records ship
 * **inactive**: activation is an explicit, audited operational step in a later phase, so a
 * fresh environment never silently starts accepting orders.
 *
 * Synthetic development data only (CLAUDE.md) — no real personal or production data.
 *
 * Idempotent: re-running does not create duplicates, so it is safe in CI and local resets.
 */
export async function seed(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    const existingTown = await trx('town').where({ name: 'Migori' }).first('id');
    let townId: number | undefined =
      existingTown === undefined ? undefined : Number(existingTown.id);

    if (townId === undefined) {
      const inserted = await trx('town').insert({
        name: 'Migori',
        timezone: 'Africa/Nairobi',
        is_active: false,
      });
      townId = inserted[0];
    }

    if (townId === undefined) {
      throw new Error('Seed failed: could not resolve the Migori town id');
    }

    const existingZone = await trx('zone')
      .where({ town_id: townId, name: 'Migori CBD' })
      .first('id');

    if (existingZone === undefined) {
      await trx('zone').insert({
        town_id: townId,
        name: 'Migori CBD',
        is_active: false,
      });
    }
  });
}
