import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptAesGcm,
  decryptAesGcm,
  deriveKek,
  generateDek,
  envelopeEncrypt,
  envelopeDecrypt,
  ByokRouter,
  type OrgByokKeys,
} from '../byok';

describe('AES-256-GCM helpers', () => {
  const kek = randomBytes(32);

  it('roundtrip encrypt → decrypt returns original plaintext', () => {
    const enc = encryptAesGcm('sk-abc-123', kek);
    expect(enc.version).toBe(1);
    expect(enc.ciphertext).not.toBe('sk-abc-123');
    expect(decryptAesGcm(enc, kek)).toBe('sk-abc-123');
  });

  it('two encryptions of same plaintext produce different ciphertext (random IV)', () => {
    const a = encryptAesGcm('hello', kek);
    const b = encryptAesGcm('hello', kek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('decrypt with wrong KEK fails with authentication error', () => {
    const enc = encryptAesGcm('secret', kek);
    const badKek = randomBytes(32);
    expect(() => decryptAesGcm(enc, badKek)).toThrow();
  });

  it('decrypt with tampered ciphertext fails (auth tag mismatch)', () => {
    const enc = encryptAesGcm('secret', kek);
    // Replacing a base64 character can leave the ciphertext unchanged (1/64).
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] ^= 1;
    const tampered = { ...enc, ciphertext: bytes.toString('base64') };
    expect(tampered.ciphertext).not.toBe(enc.ciphertext);
    expect(() => decryptAesGcm(tampered, kek)).toThrow();
  });

  it('rejects KEK of wrong length', () => {
    expect(() => encryptAesGcm('x', Buffer.alloc(16))).toThrow();
  });

  it('accepts hex-encoded KEK', () => {
    const hex = kek.toString('hex');
    const enc = encryptAesGcm('x', hex);
    expect(decryptAesGcm(enc, hex)).toBe('x');
  });

  it('accepts base64-encoded KEK', () => {
    const b64 = kek.toString('base64');
    const enc = encryptAesGcm('x', b64);
    expect(decryptAesGcm(enc, b64)).toBe('x');
  });

  it('rejects EncryptedSecret with unsupported version', () => {
    const enc = encryptAesGcm('x', kek);
    expect(() => decryptAesGcm({ ...enc, version: 2 as 1 }, kek)).toThrow(/version/);
  });
});

describe('deriveKek (HKDF-SHA256)', () => {
  const master = randomBytes(32);

  it('produces deterministic 32-byte output for same (master, info)', () => {
    const a = deriveKek(master, 'byok:tenant:org-1');
    const b = deriveKek(master, 'byok:tenant:org-1');
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('different info strings produce domain-separated keys', () => {
    const a = deriveKek(master, 'byok:tenant:org-1');
    const b = deriveKek(master, 'byok:tenant:org-2');
    const c = deriveKek(master, 'byok:admin:replicate');
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(b).not.toEqual(c);
  });

  it('derived key can encrypt/decrypt independently', () => {
    const sub = deriveKek(master, 'byok:tenant:org-1');
    const enc = encryptAesGcm('tenant-secret', sub);
    expect(decryptAesGcm(enc, sub)).toBe('tenant-secret');
    // Master cannot decrypt what sub-key encrypted
    expect(() => decryptAesGcm(enc, master)).toThrow();
  });
});

describe('envelope encryption', () => {
  const kekAdmin = randomBytes(32);

  it('generateDek returns 32 random bytes', () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(32);
    expect(a).not.toEqual(b);
  });

  it('envelopeEncrypt/Decrypt roundtrip', () => {
    const { secret, dek_encrypted } = envelopeEncrypt('r8_token_here', kekAdmin);
    const plain = envelopeDecrypt(secret, dek_encrypted, kekAdmin);
    expect(plain).toBe('r8_token_here');
  });

  it('wrong KEK_ADMIN cannot unwrap DEK → decrypt fails', () => {
    const { secret, dek_encrypted } = envelopeEncrypt('r8_token', kekAdmin);
    const wrongKek = randomBytes(32);
    expect(() => envelopeDecrypt(secret, dek_encrypted, wrongKek)).toThrow();
  });
});

describe('ByokRouter', () => {
  const kek = randomBytes(32);
  let store: Map<string, OrgByokKeys>;
  let router: ByokRouter;

  beforeEach(() => {
    store = new Map();
    router = new ByokRouter({
      kek,
      getOrgKeys: async (orgId) => store.get(orgId) ?? null,
      setOrgKeys: async (orgId, keys) => {
        store.set(orgId, keys);
      },
    });
  });

  it('resolveKey priority: header override wins over stored key', async () => {
    await router.saveKey('org-1', 'openai', 'sk-stored');
    const k = await router.resolveKey('org-1', 'openai', 'sk-header');
    expect(k).toBe('sk-header');
  });

  it('resolveKey falls back to stored key when no header override', async () => {
    await router.saveKey('org-1', 'openai', 'sk-stored');
    const k = await router.resolveKey('org-1', 'openai');
    expect(k).toBe('sk-stored');
  });

  it('resolveKey returns null when no header and no stored key', async () => {
    const k = await router.resolveKey('org-none', 'openai');
    expect(k).toBeNull();
  });

  it('isByok is true when any source provides a key', async () => {
    expect(await router.isByok('org-1', 'openai')).toBe(false);
    await router.saveKey('org-1', 'openai', 'sk-x');
    expect(await router.isByok('org-1', 'openai')).toBe(true);
    expect(await router.isByok('org-other', 'openai', 'sk-header')).toBe(true);
  });

  it('computeGatewayFeeRub defaults to 0.5 when no config/env', () => {
    const orig = process.env.BYOK_FEE_RUB;
    delete process.env.BYOK_FEE_RUB;
    try {
      expect(router.computeGatewayFeeRub()).toBe(0.5);
    } finally {
      if (orig !== undefined) process.env.BYOK_FEE_RUB = orig;
    }
  });

  it('computeGatewayFeeRub honors BYOK_FEE_RUB env override', () => {
    const orig = process.env.BYOK_FEE_RUB;
    process.env.BYOK_FEE_RUB = '2.5';
    try {
      expect(router.computeGatewayFeeRub()).toBe(2.5);
    } finally {
      if (orig === undefined) delete process.env.BYOK_FEE_RUB;
      else process.env.BYOK_FEE_RUB = orig;
    }
  });

  it('computeGatewayFeeRub honors explicit config', () => {
    const r = new ByokRouter({
      kek,
      getOrgKeys: async () => null,
      feeRub: 1.25,
    });
    expect(r.computeGatewayFeeRub()).toBe(1.25);
  });

  it('deleteKey removes only the specified upstream', async () => {
    await router.saveKey('org-1', 'openai', 'sk-o');
    await router.saveKey('org-1', 'anthropic', 'sk-a');
    await router.deleteKey('org-1', 'openai');
    expect(await router.resolveKey('org-1', 'openai')).toBeNull();
    expect(await router.resolveKey('org-1', 'anthropic')).toBe('sk-a');
  });

  it('revokeAll clears every key for the org', async () => {
    await router.saveKey('org-1', 'openai', 'sk-o');
    await router.saveKey('org-1', 'fal', 'sk-f');
    await router.revokeAll('org-1');
    expect(await router.resolveKey('org-1', 'openai')).toBeNull();
    expect(await router.resolveKey('org-1', 'fal')).toBeNull();
  });

  it('listMasked returns last-4 preview never plaintext', async () => {
    await router.saveKey('org-1', 'openai', 'sk-1234567890ABCD');
    const masked = await router.listMasked('org-1');
    expect(masked).toHaveLength(1);
    expect(masked[0].upstream).toBe('openai');
    expect(masked[0].masked).toBe('***ABCD');
    expect(masked[0].masked).not.toContain('12345');
  });
});
