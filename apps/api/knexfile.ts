import { Knex } from 'knex';
import { loadEnv } from './src/env';
import { buildKnexConfig } from './src/platform/db';

const env = loadEnv();
const config: Knex.Config = buildKnexConfig({ DATABASE_URL: env.DATABASE_URL });

export default config;
