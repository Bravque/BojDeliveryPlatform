import { Knex } from 'knex';
import { ulid } from 'ulid';

/**
 * Phase 0 synthetic seed (D1 — launch town & zones), extended in Phase 3 with the public `ulid`
 * and the circle serviceable-area geometry (`center_lat`/`center_lng` + `radius_m`).
 *
 * Loads a single launch town, **Migori**, with one compact **Migori CBD** delivery zone,
 * modelled as ordinary configurable DB records (not hardcoded geography). The centre/radius are
 * approximate synthetic values for the CBD. Both records ship **inactive**: activation is an
 * explicit, audited operational step in a later phase, so a fresh environment never silently
 * starts accepting orders.
 *
 * Synthetic development data only (CLAUDE.md) — no real personal or production data.
 *
 * Idempotent: re-running does not create duplicates and backfills the Phase 3 columns on rows
 * seeded by an earlier version.
 */
const MIGORI_CBD = { centerLat: -1.0634, centerLng: 34.4731, radiusM: 3000 };

export async function seed(knex: Knex): Promise<void> {
  await knex.transaction(async (trx) => {
    const existingTown = await trx('town').where({ name: 'Migori' }).first('id', 'ulid');
    let townId: number | undefined =
      existingTown === undefined ? undefined : Number(existingTown.id);

    if (townId === undefined) {
      const inserted = await trx('town').insert({
        ulid: ulid(),
        name: 'Migori',
        timezone: 'Africa/Nairobi',
        is_active: false,
      });
      townId = inserted[0];
    } else if (!existingTown.ulid) {
      await trx('town').where({ id: townId }).update({ ulid: ulid() });
    }

    if (townId === undefined) {
      throw new Error('Seed failed: could not resolve the Migori town id');
    }

    const existingZone = await trx('zone')
      .where({ town_id: townId, name: 'Migori CBD' })
      .first('id', 'ulid');

    if (existingZone === undefined) {
      await trx('zone').insert({
        ulid: ulid(),
        town_id: townId,
        name: 'Migori CBD',
        center_lat: MIGORI_CBD.centerLat,
        center_lng: MIGORI_CBD.centerLng,
        radius_m: MIGORI_CBD.radiusM,
        is_active: false,
      });
    } else {
      await trx('zone')
        .where({ id: existingZone.id })
        .update({
          ...(!existingZone.ulid && { ulid: ulid() }),
          center_lat: MIGORI_CBD.centerLat,
          center_lng: MIGORI_CBD.centerLng,
          radius_m: MIGORI_CBD.radiusM,
        });
    }
  });
}
