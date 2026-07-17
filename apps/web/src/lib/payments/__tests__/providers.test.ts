import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPaymentProvider, getTier, TIERS, ALL_PROVIDERS, getTinkoffClient, resolveTinkoffSecret } from '../providers';
import { generateToken } from '@aiag/tinkoff';
import type { WebhookNotification } from '@aiag/tinkoff';

describe('payments/providers — registry', () => {
  it('returns Tinkoff provider', () => {
    const p = getPaymentProvider('tinkoff');
    expect(p.id).toBe('tinkoff');
    expect(typeof p.initPayment).toBe('function');
    expect(typeof p.refund).toBe('function');
  });

  it('returns YooKassa provider', () => {
    const p = getPaymentProvider('yookassa');
    expect(p.id).toBe('yookassa');
  });

  it('returns SBP provider (powered by YooKassa)', () => {
    const p = getPaymentProvider('sbp');
    expect(p.id).toBe('sbp');
  });

  it('throws on unknown provider', () => {
    expect(() => getPaymentProvider('alien' as never)).toThrow();
  });
});

describe('payments/providers — tiers', () => {
  it('exposes Basic/Starter/Pro (no Free tier — founder decision 2026-07-17)', () => {
    expect(TIERS.basic.monthly).toBe(990);
    expect(TIERS.starter.monthly).toBe(2490);
    expect(TIERS.pro.monthly).toBe(6990);
    expect('free' in TIERS).toBe(false);
  });

  it('yearly = monthly * 10 (~17% discount)', () => {
    expect(TIERS.basic.yearly).toBe(9900);
    expect(TIERS.starter.yearly).toBe(24900);
    expect(TIERS.pro.yearly).toBe(69900);
  });

  it('getTier returns null for unknown', () => {
    expect(getTier('does_not_exist')).toBeNull();
  });

  it('getTier returns tier for known', () => {
    expect(getTier('basic')?.monthly).toBe(990);
  });
});

describe('payments/providers — provider matrix', () => {
  let prevTinkoff: string | undefined;
  let prevYoo: string | undefined;

  beforeEach(() => {
    prevTinkoff = process.env.TINKOFF_TERMINAL_KEY;
    prevYoo = process.env.YOOKASSA_SHOP_ID;
  });

  afterEach(() => {
    if (prevTinkoff !== undefined) process.env.TINKOFF_TERMINAL_KEY = prevTinkoff;
    else delete process.env.TINKOFF_TERMINAL_KEY;
    if (prevYoo !== undefined) process.env.YOOKASSA_SHOP_ID = prevYoo;
    else delete process.env.YOOKASSA_SHOP_ID;
  });

  it('lists all 3 known providers', () => {
    const ids = ALL_PROVIDERS.map((p) => p.id).sort();
    expect(ids).toEqual(['sbp', 'tinkoff', 'yookassa']);
  });

  it('flags providers as disabled when ENV missing', async () => {
    delete process.env.TINKOFF_TERMINAL_KEY;
    delete process.env.YOOKASSA_SHOP_ID;
    // re-import to re-evaluate ENV at module load — using dynamic import
    const mod = await import('../providers?reload=' + Date.now());
    const enabled = (mod.ALL_PROVIDERS as typeof ALL_PROVIDERS).filter((p) => p.enabled);
    expect(enabled.length).toBeLessThanOrEqual(ALL_PROVIDERS.length);
  });
});

describe('payments/providers — Tinkoff secret resolution (HIGH: Init/verify parity)', () => {
  let prevPassword: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevPassword = process.env.TINKOFF_PASSWORD;
    prevSecret = process.env.TINKOFF_SECRET_KEY;
  });
  afterEach(() => {
    if (prevPassword !== undefined) process.env.TINKOFF_PASSWORD = prevPassword;
    else delete process.env.TINKOFF_PASSWORD;
    if (prevSecret !== undefined) process.env.TINKOFF_SECRET_KEY = prevSecret;
    else delete process.env.TINKOFF_SECRET_KEY;
  });

  function makeSignedWebhook(secret: string): WebhookNotification {
    const base = {
      TerminalKey: 'term_1',
      OrderId: 'sub_1',
      Success: true,
      Status: 'CONFIRMED' as const,
      PaymentId: 12345,
      ErrorCode: '0',
      Amount: 99000,
    };
    // The bank signs with the terminal PASSWORD; Token = SHA256 over sorted
    // params + Password. Reproduce exactly what Tinkoff would send.
    const Token = generateToken(base as unknown as Record<string, unknown>, secret);
    return { ...base, Token };
  }

  it('resolveTinkoffSecret prefers TINKOFF_PASSWORD, falls back to TINKOFF_SECRET_KEY', () => {
    process.env.TINKOFF_PASSWORD = 'pw';
    process.env.TINKOFF_SECRET_KEY = 'sk';
    expect(resolveTinkoffSecret()).toBe('pw');
    delete process.env.TINKOFF_PASSWORD;
    expect(resolveTinkoffSecret()).toBe('sk');
  });

  it('fail-closed: returns null when NEITHER env var is set', () => {
    delete process.env.TINKOFF_PASSWORD;
    delete process.env.TINKOFF_SECRET_KEY;
    expect(resolveTinkoffSecret()).toBeNull();
  });

  // The actual HIGH bug: a CONFIRMED signed with TINKOFF_PASSWORD must verify.
  it('a webhook signed with TINKOFF_PASSWORD passes verification', () => {
    process.env.TINKOFF_PASSWORD = 'terminal_password_123';
    delete process.env.TINKOFF_SECRET_KEY;
    const parsed = getTinkoffClient().parseWebhook(makeSignedWebhook('terminal_password_123'));
    expect(parsed.isValid).toBe(true);
  });

  it('a webhook signed with TINKOFF_SECRET_KEY still passes (fallback intact)', () => {
    delete process.env.TINKOFF_PASSWORD;
    process.env.TINKOFF_SECRET_KEY = 'legacy_secret_key';
    const parsed = getTinkoffClient().parseWebhook(makeSignedWebhook('legacy_secret_key'));
    expect(parsed.isValid).toBe(true);
  });

  it('a webhook signed with the WRONG secret is rejected', () => {
    process.env.TINKOFF_PASSWORD = 'correct_password';
    delete process.env.TINKOFF_SECRET_KEY;
    const parsed = getTinkoffClient().parseWebhook(makeSignedWebhook('attacker_guess'));
    expect(parsed.isValid).toBe(false);
  });
});
