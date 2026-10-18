import { createAuditService } from './auth/audit-service';
import { loadAuthConfig } from './auth/config';
import { createOtpService } from './auth/otp-service';
import { createPasswordService } from './auth/password-service';
import { createKnexAuthRepo } from './auth/repo';
import { createSessionService } from './auth/session-service';
import { MockSmsProvider } from './auth/sms/mock';
import { createUserService } from './auth/user-service';
import { createApp } from './app';
import { createMerchantService } from './merchant/merchant-service';
import { createKnexMerchantRepo } from './merchant/repo';
import { createRequireAuth } from './middleware/auth';
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
  const repo = createKnexAuthRepo(db);
  const sms = new MockSmsProvider({ logger, logBody: env.NODE_ENV !== 'production' });
  const auth = {
    otpService: createOtpService({ repo, sms, config: authConfig }),
    passwordService: createPasswordService({ repo, config: authConfig }),
    sessionService: createSessionService({ repo, config: authConfig }),
    userService: createUserService({ repo }),
    auditService: createAuditService(repo),
    requireAuth: createRequireAuth({
      publicKey: authConfig.JWT_PUBLIC_KEY,
      issuer: authConfig.JWT_ISSUER,
      audience: authConfig.JWT_AUDIENCE,
    }),
  };

  const merchant = {
    merchantService: createMerchantService({
      repo: createKnexMerchantRepo(db),
      auditService: auth.auditService,
    }),
    requireAuth: auth.requireAuth,
  };

  const app = createApp({
    logger,
    version: VERSION,
    checkReadiness: async () => ({ db: await checkDbHealth(db) }),
    auth,
    merchant,
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
