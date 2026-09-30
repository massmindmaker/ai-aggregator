/**
 * Unified payment provider interface.
 *
 * Wraps Tinkoff Acquiring + YooKassa REST behind a single API used by
 * subscription/topup/refund routes. New providers can be added by implementing
 * the `PaymentProvider` interface and registering in `getPaymentProvider`.
 */
import { createTinkoffClient } from '@aiag/tinkoff';
import type { TinkoffAcquiring } from '@aiag/tinkoff';
import { createYooKassaClient } from '@aiag/yookassa';
import type { YooKassaClient } from '@aiag/yookassa';

export type ProviderId = 'tinkoff' | 'yookassa' | 'sbp';

export interface InitPaymentParams {
  orderId: string;
  amountRub: number;
  description: string;
  returnUrl: string;
  notificationUrl?: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, string>;
  recurrent?: boolean;
}

export interface InitPaymentResult {
  success: boolean;
  providerPaymentId: string;
  paymentUrl?: string;
  qrPayload?: string;     // for SBP
  status: string;
  errorMessage?: string;
}

export interface RefundResult {
  success: boolean;
  providerRefundId?: string;
  errorMessage?: string;
}

export interface PaymentProvider {
  id: ProviderId;
  initPayment(params: InitPaymentParams): Promise<InitPaymentResult>;
  refund(providerPaymentId: string, amountRub: number, reason?: string): Promise<RefundResult>;
}

/* ------------------------------ Tinkoff impl ----------------------------- */

class TinkoffProvider implements PaymentProvider {
  id: ProviderId = 'tinkoff';
  constructor(private client: TinkoffAcquiring) {}

  async initPayment(params: InitPaymentParams): Promise<InitPaymentResult> {
    const r = await this.client.createPayment({
      orderId: params.orderId,
      amount: params.amountRub,
      description: params.description,
      successUrl: params.returnUrl,
      failUrl: params.returnUrl,
      notificationUrl: params.notificationUrl,
      email: params.email,
      phone: params.phone,
      metadata: params.metadata,
      recurrent: params.recurrent,
    });
    return {
      success: r.success,
      providerPaymentId: r.paymentId,
      paymentUrl: r.paymentUrl,
      status: r.status,
      errorMessage: r.errorMessage,
    };
  }

  async refund(providerPaymentId: string, amountRub: number): Promise<RefundResult> {
    const r = await this.client.refundPayment(providerPaymentId, amountRub);
    return {
      success: r.success,
      providerRefundId: r.paymentId,
      errorMessage: r.errorMessage,
    };
  }
}

/* ----------------------------- YooKassa impl ----------------------------- */

class YooKassaProvider implements PaymentProvider {
  id: ProviderId;
  constructor(
    private client: YooKassaClient,
    private method: 'bank_card' | 'sbp' = 'bank_card'
  ) {
    this.id = method === 'sbp' ? 'sbp' : 'yookassa';
  }

  async initPayment(params: InitPaymentParams): Promise<InitPaymentResult> {
    const r = await this.client.createPayment({
      orderId: params.orderId,
      amount: params.amountRub,
      description: params.description,
      returnUrl: params.returnUrl,
      paymentMethod: this.method,
      email: params.email,
      phone: params.phone,
      metadata: params.metadata,
    });
    return {
      success: r.success,
      providerPaymentId: r.paymentId,
      paymentUrl: r.paymentUrl,
      qrPayload: r.confirmationData,
      status: r.status,
      errorMessage: r.errorMessage,
    };
  }

  async refund(providerPaymentId: string, amountRub: number, reason?: string): Promise<RefundResult> {
    try {
      const r = await this.client.refundPayment(providerPaymentId, amountRub, reason);
      return { success: r.status === 'succeeded', providerRefundId: r.id };
    } catch (e) {
      return { success: false, errorMessage: (e as Error).message };
    }
  }
}

/* ------------------------------- Registry -------------------------------- */

/**
 * SINGLE source of truth for the Tinkoff terminal password. Both payment
 * initiation (Init request signing) and webhook signature verification MUST
 * resolve the secret through here so they can never diverge — a mismatch would
 * make CONFIRMED callbacks fail verification and silently lose the payment.
 * Returns null when neither env var is set (caller decides: build-safe
 * placeholder for Init, fail-closed rejection for verify).
 */
export function resolveTinkoffSecret(): string | null {
  return process.env.TINKOFF_PASSWORD || process.env.TINKOFF_SECRET_KEY || null;
}

export function getTinkoffClient(): TinkoffAcquiring {
  return createTinkoffClient({
    terminalKey: process.env.TINKOFF_TERMINAL_KEY || 'placeholder_terminal',
    // Placeholder only keeps build/import from crashing when env is unset; a
    // real Init to the bank needs a real secret anyway. The webhook must NOT
    // trust this placeholder (it is guessable from source) — it fail-closes via
    // resolveTinkoffSecret() before verifying. See /api/webhooks/tinkoff.
    secretKey: resolveTinkoffSecret() ?? 'placeholder_secret',
    apiUrl: process.env.TINKOFF_API_URL,
  });
}

export function getYooKassaClient(): YooKassaClient {
  return createYooKassaClient({
    shopId: process.env.YOOKASSA_SHOP_ID || 'placeholder_shop',
    secretKey: process.env.YOOKASSA_SECRET_KEY || 'placeholder_secret',
  });
}

export function getPaymentProvider(id: ProviderId): PaymentProvider {
  switch (id) {
    case 'tinkoff':
      return new TinkoffProvider(getTinkoffClient());
    case 'yookassa':
      return new YooKassaProvider(getYooKassaClient(), 'bank_card');
    case 'sbp':
      return new YooKassaProvider(getYooKassaClient(), 'sbp');
    default:
      throw new Error(`Unknown payment provider: ${id}`);
  }
}

export const ALL_PROVIDERS: ReadonlyArray<{
  id: ProviderId;
  label: string;
  description: string;
  enabled: boolean;
}> = [
  {
    id: 'tinkoff',
    label: 'Tinkoff',
    description: 'Карты, Tinkoff Pay',
    enabled: !!process.env.TINKOFF_TERMINAL_KEY,
  },
  {
    id: 'yookassa',
    label: 'YooKassa (карта)',
    description: 'Visa / Mastercard / МИР через ЮKassa',
    enabled: !!process.env.YOOKASSA_SHOP_ID,
  },
  {
    id: 'sbp',
    label: 'СБП',
    description: 'Система быстрых платежей',
    enabled: !!process.env.YOOKASSA_SHOP_ID,
  },
];

// 🔴 AG-7 (2026-09-30): the tier table moved to `./tiers` so marketing pages
// (home, /pricing) can render tiers and prices without importing this module —
// which pulls the Tinkoff/YooKassa acquiring SDKs in at module scope. Re-
// exported here so every existing `getTier` / `TIERS` caller keeps working.
export { TIERS, getTier, TIER_ORDER, type TierId } from './tiers';
