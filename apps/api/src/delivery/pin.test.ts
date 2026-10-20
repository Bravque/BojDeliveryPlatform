import { describe, expect, it } from 'vitest';
import { generatePin, hashPin, verifyPin } from './pin';

describe('delivery PIN', () => {
  it('generates a 4-digit numeric PIN', () => {
    const pin = generatePin();
    expect(pin).toMatch(/^\d{4}$/);
  });

  it('hashes a PIN (never the plaintext) and verifies the correct one', async () => {
    const pin = generatePin();
    const hash = await hashPin(pin);
    expect(hash).not.toContain(pin);
    expect(await verifyPin(hash, pin)).toBe(true);
  });

  it('rejects an incorrect PIN', async () => {
    const hash = await hashPin('1234');
    expect(await verifyPin(hash, '9999')).toBe(false);
  });
});
