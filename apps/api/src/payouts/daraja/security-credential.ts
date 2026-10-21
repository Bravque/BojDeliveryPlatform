import { constants, createPublicKey, publicEncrypt } from 'node:crypto';

/**
 * Builds the Daraja `SecurityCredential` (doc 07 §10): the initiator's plaintext password,
 * RSA-encrypted with Safaricom's public certificate (PKCS#1 v1.5) and base64-encoded. Safaricom
 * decrypts it with their private key to authenticate B2C / reversal requests. The cert differs
 * between sandbox and production, so it is supplied by env — never committed.
 *
 * `certPem` may be an X.509 certificate PEM or a raw SPKI public-key PEM; `createPublicKey` accepts
 * both.
 */
export function buildSecurityCredential(certPem: string, initiatorPassword: string): string {
  const key = createPublicKey(certPem);
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(initiatorPassword, 'utf8'),
  );
  return encrypted.toString('base64');
}
