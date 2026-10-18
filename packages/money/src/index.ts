/**
 * Integer-minor-unit (cents) money utilities for KES.
 *
 * All monetary values in the platform are integer cents (BIGINT in MySQL). Floating-point
 * currency arithmetic is never allowed (see docs/architecture/03-data-model.md §1). This
 * module is the only sanctioned place to do money math.
 */

export const CURRENCY = 'KES';

/** Throws if `cents` is not a safe integer. */
export function assertInteger(cents: number): void {
  if (!Number.isInteger(cents) || !Number.isSafeInteger(cents)) {
    throw new RangeError(`Amount must be a safe integer number of cents, received: ${cents}`);
  }
}

/** Sum any number of integer-cent values. */
export function addCents(...values: number[]): number {
  return values.reduce((sum, value) => {
    assertInteger(value);
    return sum + value;
  }, 0);
}

/** Subtract `b` cents from `a` cents. */
export function subtractCents(a: number, b: number): number {
  assertInteger(a);
  assertInteger(b);
  return a - b;
}

/** Multiply a unit price (cents) by an integer quantity. */
export function multiplyCents(cents: number, quantity: number): number {
  assertInteger(cents);
  assertInteger(quantity);
  if (quantity < 0) {
    throw new RangeError(`quantity must be non-negative, received: ${quantity}`);
  }
  return cents * quantity;
}

/**
 * Apply a basis-points rate (e.g. commission) to a cents amount, rounding half-up.
 * 10000 bps = 100%. Example: applyBps(10000, 1000) === 1000 (10% of KES 100.00).
 */
export function applyBps(cents: number, bps: number): number {
  assertInteger(cents);
  assertInteger(bps);
  if (bps < 0) {
    throw new RangeError(`bps must be non-negative, received: ${bps}`);
  }
  return Math.round((cents * bps) / 10_000);
}

/** Clamp a cents value to [min, max]. `max` is optional. */
export function clampCents(value: number, min: number, max?: number): number {
  assertInteger(value);
  assertInteger(min);
  let result = Math.max(value, min);
  if (max !== undefined) {
    assertInteger(max);
    result = Math.min(result, max);
  }
  return result;
}

/**
 * Convert major currency units (e.g. 150.5 KES) to cents (15050), rounding half-up.
 * Intended for admin/config input, never for storing user-supplied prices directly.
 */
export function majorToCents(major: number): number {
  if (!Number.isFinite(major)) {
    throw new RangeError(`Invalid amount: ${major}`);
  }
  return Math.round(major * 100);
}

/** Format cents as a human-readable KES string, e.g. 15050 -> "KES 150.50". */
export function formatKes(cents: number): string {
  assertInteger(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  return `${negative ? '-' : ''}${CURRENCY} ${major.toLocaleString('en-US')}.${minor
    .toString()
    .padStart(2, '0')}`;
}
