/**
 * Subscription tiers — the single source of truth for what we sell.
 *
 * Extracted from `lib/payments/providers.ts` (2026-09-30, AG-7) because the
 * marketing pages need to render tiers and prices, and `providers.ts` pulls in
 * the Tinkoff/YooKassa acquiring SDKs at module scope — importing it from a
 * page (especially a client component like `pricing/PricingClient.tsx`) would
 * drag payment-server code into the browser bundle. `providers.ts` re-exports
 * everything from here, so `getTier()` callers are unaffected.
 *
 * 🔴 These three ids are the WHOLE catalogue. `getTier()` returns null for
 * anything else and `api/subscriptions/create` answers 400 BAD_TIER — which is
 * exactly what happened to the home page, where Growth and Business were being
 * sold next to Basic/Starter/Pro but could not be bought.
 *
 * `credits` is a MONTHLY credit allotment, not a ruble bonus: the webhook
 * grants exactly `tier.credits` credits (see api/subscriptions/create/route.ts
 * and api/webhooks/tinkoff). 1 credit = 1 US cent (pricing-calc.ts docblock).
 */
export const TIERS = {
  basic: { name: 'Basic', monthly: 990, yearly: 9900, credits: 1200 },
  starter: { name: 'Starter', monthly: 2490, yearly: 24900, credits: 3200 },
  pro: { name: 'Pro', monthly: 6990, yearly: 69900, credits: 10000 },
} as const;

export type TierId = keyof typeof TIERS;

export function getTier(tierId: string): (typeof TIERS)[TierId] | null {
  if (tierId in TIERS) return TIERS[tierId as TierId];
  return null;
}

/** Tiers in display order — every one of them is purchasable. */
export const TIER_ORDER: readonly TierId[] = Object.freeze([
  'basic',
  'starter',
  'pro',
] as const);
