import { describe, expect, it } from 'vitest';
import { computeDeliveryFeeCents, distanceMeters, type FeeInputs } from './compute';

const BASE: FeeInputs = {
  baseFeeCents: 10_000, // KES 100.00
  perKmCents: 2_000, // KES 20.00 / km
  minFeeCents: 10_000,
  maxFeeCents: 20_000,
};

describe('computeDeliveryFeeCents', () => {
  it('adds a per-km component rounded to whole cents', () => {
    // 10000 + round(2000 * 3) = 16000
    expect(computeDeliveryFeeCents(BASE, 3_000)).toBe(16_000);
  });

  it('rounds a fractional-km component half-up', () => {
    // base 0, 100 cents/km over 1.5 km = round(150) = 150
    expect(
      computeDeliveryFeeCents(
        { baseFeeCents: 0, perKmCents: 100, minFeeCents: 0, maxFeeCents: null },
        1_500,
      ),
    ).toBe(150);
  });

  it('is just the base when per-km is zero', () => {
    expect(
      computeDeliveryFeeCents(
        { baseFeeCents: 12_000, perKmCents: 0, minFeeCents: 0, maxFeeCents: null },
        9_999,
      ),
    ).toBe(12_000);
  });

  it('clamps up to the minimum fee', () => {
    expect(
      computeDeliveryFeeCents(
        { baseFeeCents: 5_000, perKmCents: 0, minFeeCents: 10_000, maxFeeCents: null },
        0,
      ),
    ).toBe(10_000);
  });

  it('clamps down to the maximum fee', () => {
    // 10000 + round(2000 * 20) = 50000, capped at 20000
    expect(computeDeliveryFeeCents(BASE, 20_000)).toBe(20_000);
  });

  it('leaves an uncapped rule unclamped above', () => {
    expect(
      computeDeliveryFeeCents(
        { baseFeeCents: 10_000, perKmCents: 2_000, minFeeCents: 0, maxFeeCents: null },
        20_000,
      ),
    ).toBe(50_000);
  });

  it('returns the base (≥ min) at zero distance', () => {
    expect(computeDeliveryFeeCents(BASE, 0)).toBe(10_000);
  });

  it('rejects a negative distance', () => {
    expect(() => computeDeliveryFeeCents(BASE, -1)).toThrow(RangeError);
  });
});

describe('distanceMeters', () => {
  it('returns whole metres', () => {
    const d = distanceMeters({ lat: -1.0634, lng: 34.4731 }, { lat: -1.05, lng: 34.49 });
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });

  it('is zero for the same point', () => {
    expect(distanceMeters({ lat: -1.0634, lng: 34.4731 }, { lat: -1.0634, lng: 34.4731 })).toBe(0);
  });
});
