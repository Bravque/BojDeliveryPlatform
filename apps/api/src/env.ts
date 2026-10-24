import { envBool, envPort, parseEnv } from '@boj/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: envPort().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Active payment gateway (doc 07 §2). Only 'simulated' is implemented until Daraja go-live (Phase 8).
  PAYMENT_PROVIDER: z.enum(['simulated', 'daraja_sandbox', 'daraja_prod']).default('simulated'),
  // Shared secret for the M-Pesa STK callback webhook (doc 07 §3). When unset the webhook rejects.
  MPESA_WEBHOOK_TOKEN: z.string().min(1).optional(),
  // Minimum seconds between accepted rider location pings (doc 08 §3 — throttle). Below this, a
  // ping is a silent no-op so a chatty client can't hammer the DB.
  RIDER_PING_MIN_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(10),
  // Candidate selection (doc 08 §2): a rider is a candidate only if pinged within this window…
  RIDER_PRESENCE_FRESHNESS_SEC: z.coerce.number().int().min(1).max(86_400).default(120),
  // …and within this many metres of the merchant.
  RIDER_MAX_RADIUS_M: z.coerce.number().int().min(1).max(1_000_000).default(8_000),
  // How long an assignment offer stays open before it expires (doc 08 §2.2; ~30-45s).
  RIDER_OFFER_TTL_SEC: z.coerce.number().int().min(5).max(3600).default(45),
  // D15: rider earning per delivery (platform keeps the margin vs. the customer delivery fee);
  // capped at the delivery fee so a rider never earns more than the customer paid for delivery.
  RIDER_FEE_FLAT_CENTS: z.coerce.number().int().min(0).default(7_000),
  // Proof-of-delivery PIN (D7): how long an issued PIN is valid, and the attempt cap before lockout.
  DELIVERY_PIN_TTL_SEC: z.coerce.number().int().min(30).max(86_400).default(900),
  DELIVERY_PIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // HTTP hardening (Phase 8, doc 10 §8). CORS allow-list (csv of origins); empty = same-origin only.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Trust-proxy hop count behind the load balancer (0 = none). Used for correct client IPs.
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  // Per-IP rate limiting: window + global cap, plus a stricter cap on the auth surface.
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).max(3600).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  // Daraja (M-Pesa) credentials (Phase 8). Required only when PAYMENT_PROVIDER is a Daraja value
  // (enforced below); unused under 'simulated'. STK = money-in (this increment).
  DARAJA_BASE_URL: z.string().url().optional(),
  DARAJA_CONSUMER_KEY: z.string().optional(),
  DARAJA_CONSUMER_SECRET: z.string().optional(),
  DARAJA_SHORTCODE: z.string().optional(),
  DARAJA_PASSKEY: z.string().optional(),
  DARAJA_CALLBACK_URL: z.string().url().optional(),
  // Optional allow-list (csv of IPs) for the M-Pesa callback webhooks; empty = no IP restriction.
  DARAJA_WEBHOOK_IP_ALLOWLIST: z.string().optional(),
  // B2C / reversal (money-out, Phase 8 Inc 3): initiator + RSA cert for the SecurityCredential.
  DARAJA_INITIATOR_NAME: z.string().optional(),
  DARAJA_INITIATOR_PASSWORD: z.string().optional(),
  DARAJA_B2C_SHORTCODE: z.string().optional(),
  DARAJA_SECURITY_CERT: z.string().optional(), // Safaricom public cert (PEM)
  DARAJA_B2C_RESULT_URL: z.string().url().optional(),
  DARAJA_B2C_TIMEOUT_URL: z.string().url().optional(),
  // In-process scheduler (Phase 8, doc 10). Enable on EXACTLY ONE instance. Drives the stale-payment
  // reconcile sweep + the assignment-offer expiry tick; both operations are idempotent.
  SCHEDULER_ENABLED: envBool().default(false),
  RECONCILE_INTERVAL_SEC: z.coerce.number().int().min(5).max(86_400).default(120),
  RECONCILE_OLDER_THAN_SEC: z.coerce.number().int().min(5).max(86_400).default(120),
  OFFER_TICK_INTERVAL_SEC: z.coerce.number().int().min(1).max(3600).default(15),
  // Realtime horizontal scale: when set, Socket.IO fans out across instances via this Redis.
  REDIS_URL: z.string().optional(),
});

/** Config required once a Daraja provider is selected (money-in STK + money-out B2C/reversal). */
const DARAJA_REQUIRED = [
  'DARAJA_BASE_URL',
  'DARAJA_CONSUMER_KEY',
  'DARAJA_CONSUMER_SECRET',
  'DARAJA_SHORTCODE',
  'DARAJA_PASSKEY',
  'DARAJA_CALLBACK_URL',
  'DARAJA_INITIATOR_NAME',
  'DARAJA_INITIATOR_PASSWORD',
  'DARAJA_B2C_SHORTCODE',
  'DARAJA_SECURITY_CERT',
  'DARAJA_B2C_RESULT_URL',
  'DARAJA_B2C_TIMEOUT_URL',
] as const;

const envSchemaChecked = envSchema.superRefine((val, ctx) => {
  if (val.PAYMENT_PROVIDER === 'simulated') {
    return;
  }
  for (const key of DARAJA_REQUIRED) {
    if (!val[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when PAYMENT_PROVIDER=${val.PAYMENT_PROVIDER}`,
      });
    }
  }
});

export type AppEnv = z.infer<typeof envSchema>;

/** Load and validate environment configuration. Throws (fail-fast) on invalid config. */
export function loadEnv(source?: NodeJS.ProcessEnv): AppEnv {
  return parseEnv(envSchemaChecked, source);
}
