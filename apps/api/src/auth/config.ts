import { parseEnv } from '@boj/config';
import { z } from 'zod';

/**
 * Auth configuration, validated separately from the core app env (`src/env.ts`).
 *
 * This loader is called only when the API boots the auth routes, so running `db:migrate` or the
 * health-only process does not require JWT keys. Multi-line PEM keys may be supplied with
 * literal `\n` escapes (convenient for single-line env files); they are expanded here.
 */
const pem = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\\n/g, '\n'));

const authEnvSchema = z.object({
  // RS256 key pair (doc 06 §2.3). Private signs; public verifies.
  JWT_PRIVATE_KEY: pem,
  JWT_PUBLIC_KEY: pem,
  JWT_ISSUER: z.string().min(1).default('boj-api'),
  JWT_AUDIENCE: z.string().min(1).default('boj-clients'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900), // 15 min
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // OTP (doc 06 §2.1). Codes are hashed with OTP_PEPPER; throttled per phone and per IP.
  OTP_LENGTH: z.coerce.number().int().min(4).max(9).default(6),
  OTP_TTL_SEC: z.coerce.number().int().positive().default(300), // 5 min
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 characters'),
  OTP_REQUEST_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
  OTP_MAX_PER_PHONE: z.coerce.number().int().positive().default(5),
  OTP_MAX_PER_IP: z.coerce.number().int().positive().default(20),

  SMS_PROVIDER: z.enum(['mock']).default('mock'),
});

export type AuthConfig = z.infer<typeof authEnvSchema>;

/** Load and validate auth configuration (fail-fast on missing/invalid values). */
export function loadAuthConfig(source?: NodeJS.ProcessEnv): AuthConfig {
  return parseEnv(authEnvSchema, source);
}
