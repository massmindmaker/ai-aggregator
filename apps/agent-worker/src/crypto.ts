import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM helper for at-rest encryption of user-supplied upstream API keys.
 *
 * Blob layout (stored as Postgres bytea, returned by postgres-js as Buffer):
 *   iv (12 bytes) | ciphertext | authTag (16 bytes)
 *
 * Key: TMA_KEY_ENCRYPTION_KEY env (64 hex chars = 32 bytes).
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.TMA_KEY_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('TMA_KEY_ENCRYPTION_KEY missing or not 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decryptSecret(blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('encrypted blob too short');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Returns the last 4 characters of a secret prefixed with ***. Used for
 * an `external_api_key_hint` column so the UI can show ***xxxx without
 * a round-trip through decryption.
 */
export function hintFromSecret(plain: string): string {
  if (!plain) return '';
  return `***${plain.slice(-4)}`.slice(0, 8);
}
