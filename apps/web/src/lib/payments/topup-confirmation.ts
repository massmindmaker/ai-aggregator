import { db } from "@/lib/db";
import { getOrCreateDefaultOrg } from "@/lib/dashboard/org";
import { sql, type Database } from "@aiag/database";

type ConfirmationDatabase = Database;

export interface TopupGrantRate {
  priceRubles: number;
  credits: number;
}

export interface ConfirmTinkoffTopupInput {
  paymentId: string;
  userId: string;
  providerPaymentId: string;
  providerOrderId: string;
  paidKopecks: number;
  /** Required for a first grant; duplicate/late checks trust the stored snapshot. */
  grantCredits?: number;
  tinkoffStatus: "CONFIRMED";
  cardPan?: string;
  rebillId?: string;
}

interface IdRow {
  id: string;
}

interface ConfirmedPaymentRow extends IdRow {
  amount: string;
}

interface ConfirmationStateRow {
  status: string;
  amount_kopecks: string | number;
  tinkoff_payment_id: string | null;
  tinkoff_order_id: string | null;
  subscription_id: string | null;
  metadata: Record<string, unknown> | null;
  topup_org_id: string | null;
  topup_paid_kopecks: string | number | null;
  topup_grant_credits: string | number | null;
  error_code: string | null;
}

export const TOPUP_REFUND_BEFORE_CONFIRMATION =
  "TOPUP_REFUND_BEFORE_CONFIRMATION";

export interface TinkoffTopupIdentity {
  paymentId: string;
  providerPaymentId: string;
  providerOrderId: string;
}

function rowsOf<Row>(result: unknown): Row[] {
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Row[] }).rows;
  }
  if (Array.isArray(result)) return result as Row[];
  throw new Error("unsupported database result");
}

/** Convert persisted NUMERIC RUB into integer kopecks without floating point. */
export function rublesToKopecks(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;

  const kopecks =
    BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return kopecks > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(kopecks);
}

/** Exact positive-integer half-up rounding from the canonical tier rate. */
export function calculateTopupGrantCredits(
  paidKopecks: number,
  rate: TopupGrantRate,
): number {
  if (
    !Number.isSafeInteger(paidKopecks) ||
    paidKopecks <= 0 ||
    !Number.isSafeInteger(rate.priceRubles) ||
    rate.priceRubles <= 0 ||
    !Number.isSafeInteger(rate.credits) ||
    rate.credits <= 0
  ) {
    throw new Error("invalid top-up grant inputs");
  }

  const denominator = BigInt(rate.priceRubles) * 100n;
  const numerator = BigInt(paidKopecks) * BigInt(rate.credits) * 1000n;
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("top-up grant exceeds safe integer range");
  }
  return Number(rounded);
}

/**
 * Serialize a refund-before-confirmation against the payment grant CAS. This
 * transaction locks only the payment row and commits before any org→payment
 * full reconciliation begins.
 */
export async function blockUnconfirmedTopupGrantForRefund(
  identity: TinkoffTopupIdentity,
  database: ConfirmationDatabase = db,
) {
  return database.transaction(async (tx) => {
    const marked = rowsOf<IdRow>(
      await tx.execute(sql`
        /* topup_refund_before_confirmation_marker */
        UPDATE payments
        SET error_code = ${TOPUP_REFUND_BEFORE_CONFIRMATION},
            updated_at = NOW()
        WHERE id = ${identity.paymentId}::uuid
          AND tinkoff_payment_id = ${identity.providerPaymentId}
          AND tinkoff_order_id = ${identity.providerOrderId}
          AND currency = 'RUB'
          AND subscription_id IS NULL
          AND metadata->>'kind' = 'topup'
          AND metadata->>'provider' = 'tinkoff'
          AND status IN ('pending', 'authorized')
          AND topup_org_id IS NULL
          AND topup_paid_kopecks IS NULL
          AND topup_grant_credits IS NULL
        RETURNING id
      `),
    )[0];
    if (marked) return { kind: "blocked" } as const;

    const state = rowsOf<ConfirmationStateRow>(
      await tx.execute(sql`
        SELECT status,
               (amount * 100)::text AS amount_kopecks,
               tinkoff_payment_id,
               tinkoff_order_id,
               subscription_id,
               metadata,
               topup_org_id,
               topup_paid_kopecks,
               topup_grant_credits,
               error_code
        FROM payments
        WHERE id = ${identity.paymentId}::uuid
        FOR UPDATE
      `),
    )[0];
    if (!state) return { kind: "reconciliation_required" } as const;

    const identityMatches =
      state.tinkoff_payment_id === identity.providerPaymentId &&
      state.tinkoff_order_id === identity.providerOrderId &&
      state.subscription_id === null &&
      state.metadata?.kind === "topup" &&
      state.metadata?.provider === "tinkoff";
    if (!identityMatches) return { kind: "reconciliation_required" } as const;

    const completeSnapshot =
      state.topup_org_id !== null &&
      Number.isSafeInteger(Number(state.topup_paid_kopecks)) &&
      Number(state.topup_paid_kopecks) > 0 &&
      Number.isSafeInteger(Number(state.topup_grant_credits)) &&
      Number(state.topup_grant_credits) > 0;
    if (
      completeSnapshot &&
      ["confirmed", "partial_refunded", "refunded"].includes(state.status)
    ) {
      return { kind: "snapshot_exists" } as const;
    }
    if (
      state.error_code === TOPUP_REFUND_BEFORE_CONFIRMATION &&
      state.topup_org_id === null &&
      state.topup_paid_kopecks === null &&
      state.topup_grant_credits === null
    ) {
      return { kind: "blocked" } as const;
    }
    return { kind: "reconciliation_required" } as const;
  });
}

async function resolveAndLockDefaultOrg(
  tx: ConfirmationDatabase,
  userId: string,
): Promise<string> {
  // Serialize first-org creation for the user. Existing refund operations lock
  // the organization before a payment; confirmation follows that same order.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))
  `);

  const orgId = await getOrCreateDefaultOrg(userId, tx);

  const locked = rowsOf<IdRow>(
    await tx.execute(sql`
      /* topup_confirmation_org_lock */
      SELECT id
      FROM organizations
      WHERE id = ${orgId}::uuid
      FOR UPDATE
    `),
  )[0];
  if (!locked) throw new Error("top-up organization not found");
  return orgId;
}

/**
 * First CONFIRMED delivery for a Tinkoff top-up. The org lock is acquired
 * before the payment row and every money/snapshot mutation shares one tx.
 */
export async function confirmTinkoffTopup(
  input: ConfirmTinkoffTopupInput,
  database: ConfirmationDatabase = db,
) {
  if (
    !Number.isSafeInteger(input.paidKopecks) ||
    input.paidKopecks <= 0 ||
    (input.grantCredits !== undefined &&
      (!Number.isSafeInteger(input.grantCredits) || input.grantCredits <= 0))
  ) {
    throw new Error("invalid top-up confirmation amount");
  }

  return database.transaction(async (tx) => {
    const orgId = await resolveAndLockDefaultOrg(tx, input.userId);
    const grantCredits = input.grantCredits;

    const confirmed =
      grantCredits === undefined
        ? undefined
        : rowsOf<ConfirmedPaymentRow>(
            await tx.execute(sql`
        /* topup_confirmation_payment_gate */
        UPDATE payments
        SET status = 'confirmed',
            tinkoff_status = ${input.tinkoffStatus},
            card_pan = ${input.cardPan ?? null},
            tinkoff_rebill_id = ${input.rebillId ?? null},
            confirmed_at = NOW(),
            updated_at = NOW(),
            topup_org_id = ${orgId}::uuid,
            topup_paid_kopecks = ${input.paidKopecks}::bigint,
            topup_grant_credits = ${grantCredits}::bigint
        WHERE id = ${input.paymentId}::uuid
          AND user_id = ${input.userId}::uuid
          AND tinkoff_payment_id = ${input.providerPaymentId}
          AND tinkoff_order_id = ${input.providerOrderId}
          AND currency = 'RUB'
          AND subscription_id IS NULL
          AND metadata->>'kind' = 'topup'
          AND metadata->>'provider' = 'tinkoff'
          AND status IN ('pending', 'authorized')
          AND topup_org_id IS NULL
          AND topup_paid_kopecks IS NULL
          AND topup_grant_credits IS NULL
          AND error_code IS DISTINCT FROM ${TOPUP_REFUND_BEFORE_CONFIRMATION}
          AND amount * 100 = ${input.paidKopecks}::numeric
        RETURNING id, amount::text
      `),
          )[0];

    if (!confirmed) {
      const state = rowsOf<ConfirmationStateRow>(
        await tx.execute(sql`
          SELECT status,
                 (amount * 100)::text AS amount_kopecks,
                 tinkoff_payment_id,
                 tinkoff_order_id,
                 subscription_id,
                 metadata,
                 topup_org_id,
                 topup_paid_kopecks,
                 topup_grant_credits,
                 error_code
          FROM payments
          WHERE id = ${input.paymentId}::uuid
          FOR UPDATE
        `),
      )[0];
      if (!state) {
        return {
          kind: "reconciliation_required",
          reason: "PAYMENT_MISSING",
        } as const;
      }

      const identityMatches =
        state.tinkoff_payment_id === input.providerPaymentId &&
        state.tinkoff_order_id === input.providerOrderId &&
        state.subscription_id === null &&
        state.metadata?.kind === "topup" &&
        state.metadata?.provider === "tinkoff" &&
        Number(state.amount_kopecks) === input.paidKopecks;
      if (!identityMatches) {
        return {
          kind: "reconciliation_required",
          reason: "PAYMENT_CHANGED",
        } as const;
      }

      const snapshotMatches =
        state.topup_org_id !== null &&
        Number(state.topup_paid_kopecks) === input.paidKopecks &&
        Number.isSafeInteger(Number(state.topup_grant_credits)) &&
        Number(state.topup_grant_credits) > 0;
      if (state.status === "confirmed" && snapshotMatches) {
        return { kind: "duplicate" } as const;
      }
      if (
        (state.status === "refunded" || state.status === "partial_refunded") &&
        snapshotMatches
      ) {
        return { kind: "late_terminal" } as const;
      }
      if (
        ["cancelled", "rejected", "failed"].includes(state.status) &&
        state.topup_org_id === null &&
        state.topup_paid_kopecks === null &&
        state.topup_grant_credits === null
      ) {
        return { kind: "late_terminal" } as const;
      }
      return {
        kind: "reconciliation_required",
        reason:
          state.status === "confirmed"
            ? "SNAPSHOT_MISSING_OR_CHANGED"
            : "CAS_REJECTED",
      } as const;
    }

    const updatedUser = rowsOf<{ balance: string }>(
      await tx.execute(sql`
        UPDATE users
        SET balance = (
              COALESCE(balance, '0')::numeric + ${confirmed.amount}::numeric
            )::text,
            updated_at = NOW()
        WHERE id = ${input.userId}::uuid
        RETURNING balance
      `),
    )[0];
    if (!updatedUser) throw new Error("top-up user not found");

    await tx.execute(sql`
      INSERT INTO balance_transactions (
        user_id, payment_id, type, amount, balance_before, balance_after,
        description, reference_type, reference_id
      ) VALUES (
        ${input.userId}::uuid,
        ${input.paymentId}::uuid,
        'deposit',
        ${confirmed.amount}::numeric,
        (${updatedUser.balance}::numeric - ${confirmed.amount}::numeric),
        ${updatedUser.balance}::numeric,
        'Payment deposit',
        'payment',
        ${input.paymentId}::uuid
      )
    `);

    const org = rowsOf<{
      payg_credits: string | number;
      refund_debt_credits: string | number;
    }>(
      await tx.execute(sql`
        UPDATE organizations
        SET payg_credits = payg_credits + (
              ${grantCredits}::bigint
              - LEAST(refund_debt_credits, ${grantCredits}::bigint)
            ),
            refund_debt_credits = refund_debt_credits
              - LEAST(refund_debt_credits, ${grantCredits}::bigint)
        WHERE id = ${orgId}::uuid
        RETURNING payg_credits, refund_debt_credits
      `),
    )[0];
    if (!org) throw new Error("top-up organization update failed");

    return {
      kind: "confirmed",
      orgId,
      paidKopecks: input.paidKopecks,
      grantCredits,
    } as const;
  });
}
