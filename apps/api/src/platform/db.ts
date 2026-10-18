import path from 'node:path';
import knex, { Knex } from 'knex';

export interface DbEnv {
  DATABASE_URL: string;
}

/** Build the Knex configuration shared by the app runtime and the migration CLI. */
export function buildKnexConfig(env: DbEnv): Knex.Config {
  return {
    client: 'mysql2',
    connection: env.DATABASE_URL,
    pool: { min: 0, max: 10 },
    migrations: {
      directory: path.join(__dirname, '..', '..', 'db', 'migrations'),
      tableName: 'knex_migrations',
      extension: 'ts',
      loadExtensions: ['.ts'],
    },
    seeds: {
      directory: path.join(__dirname, '..', '..', 'db', 'seeds'),
      extension: 'ts',
      loadExtensions: ['.ts'],
    },
  };
}

/** Create a Knex connection pool. */
export function createDb(config: Knex.Config): Knex {
  return knex(config);
}

/** Lightweight readiness probe used by the health endpoint. */
export async function checkDbHealth(db: Knex): Promise<boolean> {
  try {
    await db.raw('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
