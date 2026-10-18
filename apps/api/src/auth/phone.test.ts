import { describe, expect, it } from 'vitest';
import { normalizeKenyanPhone } from './phone';

describe('normalizeKenyanPhone', () => {
  it('normalizes accepted Kenyan spellings to E.164', () => {
    const e164 = '+254712345678';
    expect(normalizeKenyanPhone('0712345678')).toBe(e164);
    expect(normalizeKenyanPhone('+254712345678')).toBe(e164);
    expect(normalizeKenyanPhone('254712345678')).toBe(e164);
    expect(normalizeKenyanPhone('712345678')).toBe(e164);
    expect(normalizeKenyanPhone('  0712 345 678 ')).toBe(e164);
    expect(normalizeKenyanPhone('0712-345-678')).toBe(e164);
  });

  it('accepts the 01X mobile range', () => {
    expect(normalizeKenyanPhone('0112345678')).toBe('+254112345678');
  });

  it('rejects invalid numbers', () => {
    expect(normalizeKenyanPhone('0812345678')).toBeNull(); // bad prefix (8)
    expect(normalizeKenyanPhone('071234567')).toBeNull(); // too short
    expect(normalizeKenyanPhone('07123456789')).toBeNull(); // too long
    expect(normalizeKenyanPhone('+1 555 123 4567')).toBeNull(); // non-KE
    expect(normalizeKenyanPhone('+2548123456789')).toBeNull(); // KE code, bad prefix
    expect(normalizeKenyanPhone('notaphone')).toBeNull();
    expect(normalizeKenyanPhone('')).toBeNull();
  });
});
