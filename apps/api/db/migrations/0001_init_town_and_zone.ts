import { Knex } from 'knex';

/**
 * First migration — demonstrates the reversible migration workflow and models the two
 * configurable geographic records the launch depends on (D1): towns and delivery zones.
 *
 * The spatial `boundary GEOMETRY` column for point-in-polygon zone resolution
 * (see docs/architecture/03-data-model.md §3.2) is intentionally deferred to a later
 * migration to keep Phase 0 minimal.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('town', (table) => {
    table.bigIncrements('id').primary();
    table.string('name', 120).notNullable();
    table.string('timezone', 60).notNullable().defaultTo('Africa/Nairobi');
    table.boolean('is_active').notNullable().defaultTo(false);
    table.timestamps(true, true); // created_at, updated_at (defaults to now)
  });

  await knex.schema.createTable('zone', (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('town_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('town')
      .onDelete('RESTRICT');
    table.string('name', 120).notNullable();
    table.boolean('is_active').notNullable().defaultTo(false);
    table.timestamps(true, true);
    table.index(['town_id'], 'idx_zone_town');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('zone');
  await knex.schema.dropTableIfExists('town');
}
