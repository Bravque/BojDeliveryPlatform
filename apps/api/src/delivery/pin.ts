import { generateOtp, hashPassword, verifyPassword } from '../auth/crypto';

/**
 * Proof-of-delivery PIN (D7). A short numeric code is generated for the customer and only its
 * Argon2id hash is stored; the rider's submitted code is verified against the hash. The plaintext
 * is returned to the customer exactly once (at issue) and never persisted or logged.
 */
const PIN_LENGTH = 4;

export function generatePin(): string {
  return generateOtp(PIN_LENGTH);
}

export function hashPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export function verifyPin(hash: string, pin: string): Promise<boolean> {
  return verifyPassword(hash, pin);
}
