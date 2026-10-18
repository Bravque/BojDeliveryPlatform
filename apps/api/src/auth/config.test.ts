import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './config';

const base = {
  JWT_PRIVATE_KEY: 'priv',
  JWT_PUBLIC_KEY: 'pub',
  OTP_PEPPER: 'x'.repeat(16),
} as unknown as NodeJS.ProcessEnv;

describe('loadAuthConfig', () => {
  it('applies sensible defaults', () => {
    const cfg = loadAuthConfig(base);
    expect(cfg.JWT_ISSUER).toBe('boj-api');
    expect(cfg.JWT_AUDIENCE).toBe('boj-clients');
    expect(cfg.ACCESS_TOKEN_TTL_SEC).toBe(900);
    expect(cfg.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(cfg.OTP_LENGTH).toBe(6);
    expect(cfg.SMS_PROVIDER).toBe('mock');
  });

  it('coerces numeric settings from strings', () => {
    const cfg = loadAuthConfig({
      ...base,
      ACCESS_TOKEN_TTL_SEC: '60',
      OTP_MAX_PER_PHONE: '3',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.ACCESS_TOKEN_TTL_SEC).toBe(60);
    expect(cfg.OTP_MAX_PER_PHONE).toBe(3);
  });

  it('expands escaped newlines in PEM keys', () => {
    const cfg = loadAuthConfig({ ...base, JWT_PRIVATE_KEY: 'a\\nb' } as NodeJS.ProcessEnv);
    expect(cfg.JWT_PRIVATE_KEY).toBe('a\nb');
  });

  it('requires JWT keys and a long-enough pepper', () => {
    expect(() => loadAuthConfig({ OTP_PEPPER: 'x'.repeat(16) } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadAuthConfig({ ...base, OTP_PEPPER: 'short' } as NodeJS.ProcessEnv)).toThrow();
  });
});
