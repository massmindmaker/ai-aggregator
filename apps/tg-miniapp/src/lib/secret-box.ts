/**
 * AES-256-GCM at-rest encryption for small secrets (external API keys).
 * Duplicated in apps/agent-worker/src/secret-box.ts — both must agree on
 * the format: nonce(12) || ciphertext || tag(16).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.TMA_SECRET_BOX_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('TMA_SECRET_BOX_KEY missing or not 64 hex chars');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plain: string): Buffer {
  const key = getKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decryptSecret(blob: Buffer): string {
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error('secret-box blob too short');
  }
  const key = getKey();
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function lastFour(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}
