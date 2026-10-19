import { describe, expect, it } from 'vitest';
import { haversineMeters } from './distance';

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters({ lat: -1.0634, lng: 34.4731 }, { lat: -1.0634, lng: 34.4731 })).toBe(0);
  });

  it('is ~111.2 km for one degree of latitude', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('is ~111.3 km for one degree of longitude at the equator', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('is symmetric', () => {
    const a = { lat: -1.0634, lng: 34.4731 };
    const b = { lat: -1.05, lng: 34.49 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('shrinks a degree of longitude away from the equator', () => {
    const equator = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const high = haversineMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    expect(high).toBeLessThan(equator);
  });
});
