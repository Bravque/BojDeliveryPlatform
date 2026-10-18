/**
 * Zod-validated environment configuration helpers.
 *
 * Services define their own schema and call `parseEnv` at boot so the process fails fast on
 * missing/invalid configuration (see docs/architecture/10-deployment-and-dr.md §1).
 */
import { z, type ZodTypeAny } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => ` - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Validate `source` against `schema`, throwing a readable EnvValidationError on failure. */
export function parseEnv<T extends ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}

/** Schema for a TCP port provided as an environment string. */
export const envPort = () => z.coerce.number().int().min(1).max(65535);

/** Schema for a boolean-ish environment string ("true"/"false"/"1"/"0") or a real boolean. */
export const envBool = () =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((value) => value === true || value === 'true' || value === '1');
