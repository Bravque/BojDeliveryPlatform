import { Knex } from 'knex';
import { ulid } from 'ulid';

/**
 * Phase 3 increment 1 — delivery zones (serviceable areas) & customer addresses.
 *
 * Two changes to the Phase 0 geography tables plus one new table:
 *  - `town` / `zone` gain a public **`ulid`** so external references never expose auto-increment
 *    ids (doc 03 §1). Added nullable, backfilled for any existing rows, then made NOT NULL UNIQUE.
 *  - `zone` becomes a **circle** serviceable area (`center_lat`/`center_lng` + `radius_m`) rather
 *    than the doc 03 §3.2 `GEOMETRY` polygon. Decided for the single compact Migori CBD launch
 *    (D1): simpler, unit-testable without MySQL spatial, boundaries still config-driven. The
 *    circle columns are nullable at the schema level (a zone may exist before it is geo-configured)
 *    and required by the service before a zone can be activated / used for resolution. A polygon
 *    model remains a documented future enhancement for precise multi-zone boundaries.
 *  - `address` (new): a customer's saved delivery point; `zone_id` is resolved at save/checkout
 *    and is NULL when the point falls outside every serviceable zone (doc 03 §3.3).
 */
export async function up(knex: Knex): Promise<void> {
  const createdAt = knex.raw('CURRENT_TIMESTAMP(3)');
  const createdUpdatedAt = knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)');

  // --- town.ulid (add nullable → backfill → NOT NULL + UNIQUE) ---
  await knex.schema.alterTable('town', (t) => {
    t.specificType('ulid', 'CHAR(26)').nullable();
  });
  await backfillUlids(knex, 'town');
  await knex.schema.alterTable('town', (t) => {
    t.specificType('ulid', 'CHAR(26)').notNullable().alter();
    t.unique(['ulid']);
  });

  // --- zone: public ulid + circle serviceable-area columns ---
  await knex.schema.alterTable('zone', (t) => {
    t.specificType('ulid', 'CHAR(26)').nullable();
    t.decimal('center_lat', 9, 6).nullable();
    t.decimal('center_lng', 9, 6).nullable();
    t.specificType('radius_m', 'INT UNSIGNED').nullable();
  });
  await backfillUlids(knex, 'zone');
  await knex.schema.alterTable('zone', (t) => {
    t.specificType('ulid', 'CHAR(26)').notNullable().alter();
    t.unique(['ulid']);
  });

  // --- address (new) ---
  await knex.schema.createTable('address', (t) => {
    t.bigIncrements('id');
    t.specificType('ulid', 'CHAR(26)').notNullable().unique();
    t.bigInteger('user_id').unsigned().notNullable();
    t.string('label', 60).nullable();
    t.string('line1', 200).notNullable();
    t.decimal('lat', 9, 6).notNullable();
    t.decimal('lng', 9, 6).notNullable();
    t.bigInteger('zone_id').unsigned().nullable(); // resolved at save/checkout; NULL = out of zone
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(createdAt);
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(createdUpdatedAt);
    t.foreign('user_id').references('id').inTable('user').onDelete('CASCADE');
    t.foreign('zone_id').references('id').inTable('zone').onDelete('SET NULL');
    t.index(['user_id'], 'idx_address_user');
  });
}

/** Give every existing row in `table` a fresh ULID before the column is made NOT NULL. */
async function backfillUlids(knex: Knex, table: string): Promise<void> {
  const rows = (await knex(table).select('id')) as Array<{ id: number | string }>;
  for (const row of rows) {
    await knex(table).where({ id: row.id }).update({ ulid: ulid() });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('address');

  await knex.schema.alterTable('zone', (t) => {
    t.dropUnique(['ulid']);
  });
  await knex.schema.alterTable('zone', (t) => {
    t.dropColumn('ulid');
    t.dropColumn('center_lat');
    t.dropColumn('center_lng');
    t.dropColumn('radius_m');
  });

  await knex.schema.alterTable('town', (t) => {
    t.dropUnique(['ulid']);
  });
  await knex.schema.alterTable('town', (t) => {
    t.dropColumn('ulid');
  });
}
