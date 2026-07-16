/** GET /v1/balance — returns current subscription + payg credit amounts. */
import { Hono } from 'hono';
import { sql } from '../../lib/db';
import { errors } from '../../lib/errors';
import { MICRO_PER_CREDIT } from '../../lib/pricing';

export const balance = new Hono();

balance.get('/', async (c) => {
  const orgId = c.get('orgId' as never) as string;
  const rows = await sql<
    Array<{
      subscription_credits: string;
      payg_credits: string;
      subscription_credits_expires_at: string | null;
    }>
  >`
    SELECT subscription_credits, payg_credits, subscription_credits_expires_at
      FROM organizations WHERE id = ${orgId}::uuid
  `;
  const row = rows[0];
  if (!row) throw errors.notFound('organization');
  // 🔴 HIGH-2 fix (Opus review): this response used to name its fields
  // `subscription_rub`/`payg_rub`/`total_rub` while returning whole CREDITS
  // (an ~8.7% off value that would have been mistaken for ₽ by any B2B
  // caller reading the field name literally). organizations.* columns are
  // now BIGINT MICRO-credits (1 credit = 1000 micro) — divide by
  // MICRO_PER_CREDIT to report the display unit ("credits"), and name the
  // fields for what they actually are.
  const subscriptionCredits = Number(row.subscription_credits) / MICRO_PER_CREDIT;
  const paygCredits = Number(row.payg_credits) / MICRO_PER_CREDIT;
  return c.json({
    subscription_credits: subscriptionCredits,
    payg_credits: paygCredits,
    subscription_expires_at: row.subscription_credits_expires_at,
    total_credits: subscriptionCredits + paygCredits,
    // 🔴 Dual-emit (MED fix, Opus review): the HIGH-2 rework above REMOVED
    // `subscription_rub`/`payg_rub`/`total_rub` outright with no grace
    // period — a hard break for any external B2B caller (this is a public
    // `/v1/*` gateway endpoint; API keys are handed to real org integrations
    // per SECURITY.md, so "no consumer in this repo" doesn't prove "no
    // consumer"). Keep the old field names for one release, populated with
    // the SAME corrected value as their `_credits` twin — not the old ~8.7%
    // off number, so a caller that never updates its field name at least
    // gets the right amount. Remove once callers have migrated (track via
    // access logs / a follow-up deprecation window, not a fixed date here).
    subscription_rub: subscriptionCredits,
    payg_rub: paygCredits,
    total_rub: subscriptionCredits + paygCredits,
  });
});
