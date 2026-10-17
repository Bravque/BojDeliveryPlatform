import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, envBool, envPort, parseEnv } from './index';

describe('parseEnv', () => {
  const schema = z.object({
    PORT: envPort().default(3000),
    FLAG: envBool().default(false),
  });

  it('applies defaults when keys are absent', () => {
    const cfg = parseEnv(schema, {} as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.FLAG).toBe(false);
  });

  it('coerces port and boolean values from strings', () => {
    const cfg = parseEnv(schema, { PORT: '8080', FLAG: '1' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.FLAG).toBe(true);
  });

  it('throws EnvValidationError on invalid input', () => {
    expect(() =>
      parseEnv(z.object({ PORT: envPort() }), {
        PORT: 'not-a-number',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('includes the failing key in the error message', () => {
    try {
      parseEnv(z.object({ DATABASE_URL: z.string().min(1) }), {} as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).message).toContain('DATABASE_URL');
    }
  });
});
