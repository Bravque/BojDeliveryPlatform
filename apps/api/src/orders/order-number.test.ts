import { describe, expect, it } from 'vitest';
import { generateOrderNumber } from './order-number';

describe('generateOrderNumber', () => {
  it('has the BOJ- prefix and Crockford base32 body', () => {
    const n = generateOrderNumber();
    expect(n).toMatch(/^BOJ-[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('is practically unique across many draws', () => {
    const set = new Set(Array.from({ length: 2_000 }, () => generateOrderNumber()));
    expect(set.size).toBe(2_000);
  });
});
