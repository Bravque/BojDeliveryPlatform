import { randomInt } from 'node:crypto';

/**
 * Human-facing order number, e.g. `BOJ-7F3K9Q2M`. Crockford base32 (no I/L/O/U) from a CSPRNG;
 * `order.order_number` is UNIQUE, so the (astronomically rare) collision surfaces as an insert
 * error rather than a duplicate. The opaque `ulid` remains the API identifier.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateOrderNumber(length = 8): string {
  let body = '';
  for (let i = 0; i < length; i += 1) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `BOJ-${body}`;
}
