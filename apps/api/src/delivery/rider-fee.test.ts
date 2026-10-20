import { describe, expect, it } from 'vitest';
import { computeRiderFeeCents } from './rider-fee';

describe('computeRiderFeeCents (D15)', () => {
  it('pays the configured flat rate, platform keeping the margin', () => {
    expect(computeRiderFeeCents(10_000, 7_000)).toBe(7_000);
  });

  it('caps the rider fee at the delivery fee (never more than the customer paid)', () => {
    expect(computeRiderFeeCents(5_000, 7_000)).toBe(5_000);
  });

  it('never goes negative', () => {
    expect(computeRiderFeeCents(0, 7_000)).toBe(0);
  });
});
