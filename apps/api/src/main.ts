import { loadAuthConfig } from './auth/config';
import { createOtpService } from './auth/otp-service';
import { createKnexAuthRepo } from './auth/repo';
import { MockSmsProvider } from './auth/sms/mock';
import { createApp } from './app';
import { loadEnv } from './env';
import { buildKnexConfig, checkDbHealth, createDb } from './platform/db';
import { createLogger } from './platform/logger';

const VERSION = process.env.npm_package_version ?? '0.0.0';

function main(): void {
  const env = loadEnv(); // fail-fast on missing/invalid configuration
  const authConfig = loadAuthConfig(); // fail-fast on missing JWT keys / OTP pepper
  const logger = createLogger({ level: env.LOG_LEVEL });
  const db = createDb(buildKnexConfig({ DATABASE_URL: env.DATABASE_URL }));

  // Phase 1 uses the mock SMS provider; it logs the OTP body only outside production (D12).
  const sms = new MockSmsProvider({ logger, logBody: env.NODE_ENV !== 'production' });
  const otpService = createOtpService({ repo: createKnexAuthRepo(db), sms, config: authConfig });

  const app = createApp({
    logger,
    version: VERSION,
    checkReadiness: async () => ({ db: await checkDbHealth(db) }),
    otpService,
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
