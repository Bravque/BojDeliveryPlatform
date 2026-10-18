import { createApp } from './app';
import { loadEnv } from './env';
import { buildKnexConfig, checkDbHealth, createDb } from './platform/db';
import { createLogger } from './platform/logger';

const VERSION = process.env.npm_package_version ?? '0.0.0';

function main(): void {
  const env = loadEnv(); // fail-fast on missing/invalid configuration
  const logger = createLogger({ level: env.LOG_LEVEL });
  const db = createDb(buildKnexConfig({ DATABASE_URL: env.DATABASE_URL }));

  const app = createApp({
    logger,
    version: VERSION,
    checkReadiness: async () => ({ db: await checkDbHealth(db) }),
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
