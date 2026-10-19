import { envPort, parseEnv } from '@boj/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: envPort().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Active payment gateway (doc 07 §2). Only 'simulated' is implemented until Daraja go-live (Phase 8).
  PAYMENT_PROVIDER: z.enum(['simulated', 'daraja_sandbox', 'daraja_prod']).default('simulated'),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Load and validate environment configuration. Throws (fail-fast) on invalid config. */
export function loadEnv(source?: NodeJS.ProcessEnv): AppEnv {
  return parseEnv(envSchema, source);
}
