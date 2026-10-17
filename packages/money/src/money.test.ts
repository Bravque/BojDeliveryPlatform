import { describe, expect, it } from 'vitest';
import {
  CURRENCY,
  addCents,
  applyBps,
  assertInteger,
  clampCents,
  formatKes,
  majorToCents,
  multiplyCents,
  subtractCents,
} from './index';

describe('money', () => {
  it('adds integer cents', () => {
    expect(addCents(1000, 250, 50)).toBe(1300);
    expect(addCents()).toBe(0);
  });

  it('subtracts cents', () => {
    expect(subtractCents(1500, 500)).toBe(1000);
  });

  it('multiplies a unit price by an integer quantity', () => {
    expect(multiplyCents(1250, 3)).toBe(3750);
    expect(() => multiplyCents(1250, -1)).toThrow(RangeError);
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBps(10000, 1000)).toBe(1000); // 10% of 100.00
    expect(applyBps(12345, 750)).toBe(926); // 7.5% => 925.875 -> 926
    expect(() => applyBps(100, -1)).toThrow(RangeError);
  });

  it('clamps within bounds', () => {
    expect(clampCents(50, 100)).toBe(100);
    expect(clampCents(500, 100, 300)).toBe(300);
    expect(clampCents(200, 100, 300)).toBe(200);
  });

  it('converts major units to cents', () => {
    expect(majorToCents(150.5)).toBe(15050);
    expect(majorToCents(0.1)).toBe(10);
  });

  it('formats KES', () => {
    expect(formatKes(15050)).toBe('KES 150.50');
    expect(formatKes(1234567)).toBe('KES 12,345.67');
    expect(formatKes(-500)).toBe('-KES 5.00');
  });

  it('rejects non-integer cents', () => {
    expect(() => assertInteger(10.5)).toThrow(RangeError);
  });

  it('exposes the currency code', () => {
    expect(CURRENCY).toBe('KES');
  });
});
