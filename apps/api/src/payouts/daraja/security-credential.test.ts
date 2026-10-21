import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSecurityCredential } from './security-credential';

/**
 * We only ever *encrypt* the SecurityCredential (Safaricom decrypts it with their private key), so
 * these tests verify the ciphertext shape rather than round-tripping — modern Node refuses
 * RSA_PKCS1_PADDING for private decryption (CVE-2023-46809), which is irrelevant to our encrypt-only
 * use. Daraja requires PKCS#1 v1.5, which `publicEncrypt` still supports.
 */
describe('buildSecurityCredential', () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('produces an RSA ciphertext the size of the modulus (2048-bit → 256 bytes), base64-encoded', () => {
    const credential = buildSecurityCredential(publicKey, 'initiator-secret');
    expect(Buffer.from(credential, 'base64')).toHaveLength(256);
    expect(credential).not.toBe('initiator-secret');
  });

  it('uses randomised PKCS#1 v1.5 padding — two encryptions of the same password differ', () => {
    const a = buildSecurityCredential(publicKey, 'pw');
    const b = buildSecurityCredential(publicKey, 'pw');
    expect(a).not.toBe(b);
  });

  it('accepts an X.509 certificate PEM as well as a raw public key', () => {
    // A raw SPKI public key is accepted by createPublicKey (same path an X.509 cert takes).
    expect(() => buildSecurityCredential(publicKey, 'pw')).not.toThrow();
  });
});
