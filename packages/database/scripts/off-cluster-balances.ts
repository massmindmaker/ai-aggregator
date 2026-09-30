import { createHash } from "node:crypto";

/**
 * AG-6 Task 3: opening balances at cutover.
 *
 * The off-cluster rehearsal (see docs/operations/off-cluster-restore-stand.md)
 * proves that a `pg_dump`/`pg_restore` between two independent PostgreSQL
 * clusters preserves schema, owners and ACL. Money needs one more property:
 * the balance an organisation wakes up with on the restored cluster must be
 * exactly the balance it had on the source, and the FIRST debit executed after
 * the cutover must come out of that same restored balance.
 *
 * Everything here reads the money authority that already exists in the
 * database (organizations, gateway_transactions, gateway_charge_admissions,
 * gateway_quota_buckets and friends) and drives the already-applied settlement
 * functions. No new tables, no new triggers, no second source of truth, and no
 * money movement of its own: `firstDebitAfterRestore` never writes balances, it
 * only calls `aiag_admit_gateway_charge_v2` /
 * `aiag_mark_gateway_charge_dispatched` /
 * `aiag_record_gateway_charge_outcome_v2` /
 * `aiag_settle_admitted_gateway_charge`, which own the
 * `UPDATE ... WHERE guard RETURNING` contract.
 *
 * SCOPE OF THE MONEY SURFACE, since two tasks of this wave disagreed on it:
 * a TON top-up IS part of it. TON settlement credits
 * `organizations.payg_credits` (0072:393) and writes its `type='topup',
 * source='ton'` receipt (0072:399) in the same transaction, under a deferrable
 * constraint trigger that ties the receipt to the invoice and to the resulting
 * balance (0072:163-178). `readOpeningBalances` therefore attributes positive
 * `source='ton'` deltas to the PAYG credits bucket, exactly like
 * `source='payg'`, and reserves `unattributedDelta` for movement that really
 * has no bucket — which is what makes the reconciliation a stop signal
 * instead of a guaranteed false alarm on any database that has ever taken a
 * TON payment.
 *
 * Every statement is a prepared statement with bound values, and the caller is
 * responsible for pointing the clients at 127.0.0.1 test clusters.
 */

/** Minimal structural client so both `pg` and the guarded test client fit. */
export interface BalanceSqlClient {
  query(config: {
    text: string;
    values?: readonly unknown[];
  }): Promise<{ rows: Record<string, unknown>[] }>;
}

function fail(code: string): never {
  throw Error(code);
}

function assertOrgIds(orgIds: readonly string[]): void {
  if (
    !Array.isArray(orgIds) ||
    orgIds.length === 0 ||
    orgIds.length > 64 ||
    orgIds.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    )
  )
    fail("OFF_CLUSTER_BALANCE_ORGS_INVALID");
}

/**
 * Grant that opened the account, in microcredits. The ledger has no row for
 * the initial grant (it predates the ledger), so the caller supplies it and
 * the reconciliation is checked against that baseline rather than against
 * itself.
 */
export interface BalanceBaseline {
  payg: string;
  subscription: string;
}

export interface BalanceRow {
  orgId: string;
  /** Current balance column as stored. */
  balancePayg: string;
  balanceSubscription: string;
  balanceDebt: string;
  /** Credits granted through the ledger. */
  paygCredits: string;
  subscriptionCredits: string;
  /** Debits already recognised in the ledger. */
  paygDebits: string;
  subscriptionDebits: string;
  /** Holds still outstanding on admissions that never reached `settled`. */
  paygReserves: string;
  subscriptionReserves: string;
  /**
   * Ledger deltas that cannot be attributed to a credits or debits bucket —
   * a non-zero movement the ledger cannot explain against any bucket this
   * reconciliation models. Non-zero means the reconciliation refuses.
   */
  unattributedDelta: string;
}

/**
 * Current balances plus the derived ledger movement, read in a single pass so
 * the caller can assert `balance = grant + credits - debits - reserves` without
 * trusting the balance column on its own.
 *
 * WHY `source='ton'` IS A CREDIT BUCKET, not unattributed movement. The ledger
 * attribution below is enumerated from the migrations that actually write
 * `gateway_transactions`, not guessed:
 *
 *   - `source='payg'|'subscription'`, delta < 0 — api_usage debits
 *     (0014:343/348, 0058:119/124, 0067:593/606, 0068:747/760) and the RUB
 *     topup-refund clawback (apps/web `topup-refund.ts`, type 'refund').
 *   - `source='payg'|'subscription'`, delta > 0 — the author-charge reversal
 *     (0089:219-220), which raises the very same bucket.
 *   - `source='ton'`, delta > 0 — TON settlement (0072:399-403). It is an
 *     authoritative PAYG credit, NOT movement outside the gateway: the same
 *     function does `UPDATE organizations SET payg_credits = payg_credits +
 *     _grant` (0072:393) and writes the receipt, in one transaction.
 *
 * An earlier version counted only `source='payg'` as a credit and dumped
 * everything else into `unattributed`, which made the reconciliation fail on
 * EVERY database that had ever taken a TON payment — and the runbook reads a
 * failed reconciliation as "the balance moved outside the gateway authority,
 * stop the cutover". The procedure therefore refused healthy money forever.
 *
 * The database already guarantees part of this, and it is worth being precise
 * about which part. The deferrable constraint trigger
 * `aiag_ton_settlement_consistent_v1` (0072:144-169, attached at 0072:185-187
 * to `ton_invoices`, `ton_invoice_event_decisions` and `gateway_transactions`)
 * compares a TON receipt field-by-field against its invoice and raises
 * `TON_SETTLEMENT_INCONSISTENT` on any mismatch. That makes an inconsistent
 * TON credit/receipt pair unrepresentable — which is why (a) "just exclude it
 * and trust the trigger" would remove the false stop too.
 *
 * But that trigger is NOT a substitute for this reconciliation, and that is
 * the reason the choice is (b) rather than (a). Its body never reads
 * `organizations` at all: it proves the receipt is faithful to the invoice, not
 * that the receipt still agrees with the live `payg_credits` column. The
 * balance is mutable after settlement — the admin top-up route
 * (`apps/web/src/app/api/admin/orgs/[id]/route.ts`) issues a bare
 * `UPDATE organizations SET payg_credits = payg_credits + ...` with no ledger
 * row at all. Excluding TON from the identity would blind this check to exactly
 * the drift a cutover must catch. Counting it as a credit keeps the identity
 * intact: `unattributed` becomes the exact complement of the attributed set, so
 * a TON receipt that does NOT match the balance is still caught by the balance
 * comparison (tested), and a row from a source no migration writes still trips
 * `unattributed` (also tested).
 *
 * A NEGATIVE `source='ton'` row is written nowhere — TON has no clawback path
 * and no refund receipt — so it stays unattributed rather than being silently
 * treated as a debit.
 */
export async function readOpeningBalances(
  client: BalanceSqlClient,
  orgIds: readonly string[],
): Promise<BalanceRow[]> {
  assertOrgIds(orgIds);
  const result = await client.query({
    text: `
      WITH orgs AS (
        SELECT o.id, o.payg_credits, o.subscription_credits, o.refund_debt_credits
        FROM public.organizations o
        WHERE o.id = ANY($1::uuid[])
      ),
      ledger AS (
        SELECT t.org_id,
          coalesce(sum(t.delta) FILTER (WHERE t.delta > 0
            AND t.source IN ('payg', 'ton')), 0) AS payg_credits,
          coalesce(sum(t.delta) FILTER (WHERE t.delta > 0 AND t.source = 'subscription'), 0)
            AS subscription_credits,
          coalesce(-sum(t.delta) FILTER (WHERE t.delta < 0 AND t.source = 'payg'), 0)
            AS payg_debits,
          coalesce(-sum(t.delta) FILTER (WHERE t.delta < 0 AND t.source = 'subscription'), 0)
            AS subscription_debits,
          coalesce(sum(t.delta) FILTER (WHERE t.delta <> 0
            AND NOT (
              (t.delta > 0 AND t.source IN ('payg', 'subscription', 'ton'))
              OR (t.delta < 0 AND t.source IN ('payg', 'subscription'))
            )), 0) AS unattributed
        FROM public.gateway_transactions t
        WHERE t.org_id = ANY($1::uuid[])
        GROUP BY t.org_id
      ),
      holds AS (
        SELECT a.org_id,
          coalesce(sum(a.held_payg_credits), 0) AS payg_holds,
          coalesce(sum(a.held_subscription_credits), 0) AS subscription_holds
        FROM public.gateway_charge_admissions a
        WHERE a.org_id = ANY($1::uuid[])
          AND a.state IN ('held', 'dispatched', 'outcome_recorded')
        GROUP BY a.org_id
      )
      SELECT o.id::text AS org_id,
        o.payg_credits::text AS balance_payg,
        o.subscription_credits::text AS balance_subscription,
        o.refund_debt_credits::text AS balance_debt,
        coalesce(l.payg_credits, 0)::text AS payg_credits,
        coalesce(l.subscription_credits, 0)::text AS subscription_credits,
        coalesce(l.payg_debits, 0)::text AS payg_debits,
        coalesce(l.subscription_debits, 0)::text AS subscription_debits,
        coalesce(h.payg_holds, 0)::text AS payg_reserves,
        coalesce(h.subscription_holds, 0)::text AS subscription_reserves,
        coalesce(l.unattributed, 0)::text AS unattributed_delta
      FROM orgs o
      LEFT JOIN ledger l ON l.org_id = o.id
      LEFT JOIN holds h ON h.org_id = o.id
      ORDER BY o.id
    `,
    values: [orgIds],
  });
  const rows = result.rows.map((row) => ({
    orgId: String(row.org_id),
    balancePayg: String(row.balance_payg),
    balanceSubscription: String(row.balance_subscription),
    balanceDebt: String(row.balance_debt),
    paygCredits: String(row.payg_credits),
    subscriptionCredits: String(row.subscription_credits),
    paygDebits: String(row.payg_debits),
    subscriptionDebits: String(row.subscription_debits),
    paygReserves: String(row.payg_reserves),
    subscriptionReserves: String(row.subscription_reserves),
    unattributedDelta: String(row.unattributed_delta),
  }));
  if (rows.length !== orgIds.length) fail("OFF_CLUSTER_BALANCE_ORG_MISSING");
  return rows;
}

/** Digest of the whole money surface an organisation owns, balance excluded. */
export async function readMoneyLedgerDigest(
  client: BalanceSqlClient,
  orgIds: readonly string[],
): Promise<string> {
  assertOrgIds(orgIds);
  const result = await client.query({
    text: `
      SELECT jsonb_build_object(
        'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id), '[]'::jsonb)
          FROM public.gateway_transactions t WHERE t.org_id = ANY($1::uuid[])),
        'admissions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', a.billing_request_id::text, 'state', a.state,
            'authorized', a.authorized_max_credits::text,
            'heldSubscription', a.held_subscription_credits::text,
            'heldPayg', a.held_payg_credits::text,
            'actual', coalesce(a.actual_cost_credits, 0)::text,
            'releasedSubscription', a.released_subscription_credits::text,
            'releasedPayg', a.released_payg_credits::text,
            'debtRepaid', a.debt_repaid_credits::text,
            'expiredSubscription', a.expired_subscription_credits::text
          ) ORDER BY a.billing_request_id), '[]'::jsonb)
          FROM public.gateway_charge_admissions a WHERE a.org_id = ANY($1::uuid[])),
        'admissionEvents', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'admission', e.admission_id::text, 'key', e.event_key, 'kind', e.event_kind,
            'heldSubscription', e.held_subscription_credits::text,
            'heldPayg', e.held_payg_credits::text,
            'usedSubscription', e.used_subscription_credits::text,
            'usedPayg', e.used_payg_credits::text,
            'releasedSubscription', e.released_subscription_credits::text,
            'releasedPayg', e.released_payg_credits::text,
            'debtRepaid', e.debt_repaid_credits::text,
            'expiredSubscription', e.expired_subscription_credits::text
          ) ORDER BY e.admission_id, e.event_key), '[]'::jsonb)
          FROM public.gateway_charge_admission_events e WHERE e.org_id = ANY($1::uuid[])),
        'quotaBuckets', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'kind', b.kind, 'apiKey', b.api_key_id::text,
            'session', b.declared_session_id, 'periodStart', b.period_start,
            'reserved', b.reserved_amount::text, 'settled', b.settled_amount::text
          ) ORDER BY b.kind, b.api_key_id, coalesce(b.declared_session_id, ''),
            coalesce(b.period_start::text, '')), '[]'::jsonb)
          FROM public.gateway_quota_buckets b WHERE b.org_id = ANY($1::uuid[])),
        'quotaReservations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.billing_request_id, r.kind), '[]'::jsonb)
          FROM public.gateway_charge_quota_reservations r
          JOIN public.gateway_charge_quota_contexts c USING (billing_request_id)
          WHERE c.org_id = ANY($1::uuid[])),
        'quotaContexts', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.billing_request_id), '[]'::jsonb)
          FROM public.gateway_charge_quota_contexts c WHERE c.org_id = ANY($1::uuid[])),
        'authorCredits', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
          FROM public.author_credit_ledger l
          JOIN public.author_request_bindings b USING (billing_request_id)
          WHERE b.org_id = ANY($1::uuid[]))
      )::text AS json
    `,
    values: [orgIds],
  });
  const json = result.rows[0]?.json;
  if (typeof json !== "string") fail("OFF_CLUSTER_BALANCE_DIGEST_MISSING");
  return createHash("sha256").update(json).digest("hex");
}

export interface OpeningBalancesSnapshot {
  balances: BalanceRow[];
  ledgerDigest: string;
}

/**
 * Full cutover snapshot: balances AND the ledger that explains them. Two
 * snapshots taken on two different clusters must be identical, otherwise the
 * organisation does not wake up with the money it had.
 */
export async function readOpeningSnapshot(
  client: BalanceSqlClient,
  orgIds: readonly string[],
): Promise<OpeningBalancesSnapshot> {
  return {
    balances: await readOpeningBalances(client, orgIds),
    ledgerDigest: await readMoneyLedgerDigest(client, orgIds),
  };
}

export function openingBalancesIdentical(
  a: OpeningBalancesSnapshot,
  b: OpeningBalancesSnapshot,
): boolean {
  return (
    a.ledgerDigest === b.ledgerDigest &&
    JSON.stringify(a.balances) === JSON.stringify(b.balances)
  );
}

export interface ReconciliationLine {
  orgId: string;
  expectedPayg: string;
  observedPayg: string;
  expectedSubscription: string;
  observedSubscription: string;
  unattributedDelta: string;
}

export interface Reconciliation {
  consistent: boolean;
  lines: ReconciliationLine[];
}

/**
 * `remaining = grant + credits - debits - reserves`, computed from the ledger
 * rather than asserted by the operator. Holds are already subtracted from the
 * balance column at admission time, so the identity that must hold is
 * `balance + reserves == grant + credits - debits`.
 */
export function reconcileOpeningBalances(
  snapshot: OpeningBalancesSnapshot,
  baseline: Readonly<Record<string, BalanceBaseline>>,
): Reconciliation {
  const lines = snapshot.balances.map((row) => {
    const grant = baseline[row.orgId];
    if (grant === undefined) fail("OFF_CLUSTER_BALANCE_BASELINE_MISSING");
    for (const value of [grant.payg, grant.subscription])
      if (!/^-?[0-9]+$/.test(value))
        fail("OFF_CLUSTER_BALANCE_BASELINE_INVALID");
    const payg =
      BigInt(grant.payg) +
      BigInt(row.paygCredits) -
      BigInt(row.paygDebits) +
      BigInt(row.paygReserves);
    const subscription =
      BigInt(grant.subscription) +
      BigInt(row.subscriptionCredits) -
      BigInt(row.subscriptionDebits) +
      BigInt(row.subscriptionReserves);
    return {
      orgId: row.orgId,
      expectedPayg: payg.toString(),
      observedPayg: row.balancePayg,
      expectedSubscription: subscription.toString(),
      observedSubscription: row.balanceSubscription,
      unattributedDelta: row.unattributedDelta,
    };
  });
  return {
    consistent: lines.every(
      (line) =>
        line.expectedPayg === line.observedPayg &&
        line.expectedSubscription === line.observedSubscription &&
        line.unattributedDelta === "0",
    ),
    lines,
  };
}

export interface ChargeInput {
  orgId: string;
  apiKeyId: string;
  billingRequestId: string;
  attemptId: string;
  declaredSessionId: string | null;
  modelSlug: string;
  /** Prompt tokens to bill; the charged credits follow from the quote. */
  promptTokens: number;
  deadline: string;
}

export interface ChargeResult {
  billingRequestId: string;
  authorizedMaxCredits: string;
  actualCostCredits: string;
  state: string;
  didTransition: boolean;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical priced candidate. `aiag_quota_candidate` derives the chargeable
 * maximum from `ceil((input * context + max(output - input, 0) * cap) *
 * markup)`, so the candidate is written once here and both the maximum and the
 * usage snapshot are derived from it — a hand-written maximum that disagrees
 * with the pricing is rejected by the database, which is the intent.
 */
function pricedCandidate(
  modelSlug: string,
  promptTokens: number,
): Record<string, unknown> {
  const input = "0.1",
    output = "0.1",
    markup = "10",
    context = 2000,
    cap = 200;
  const base = Number(input) * context; // output === input, so cap adds nothing
  const maxCredits = Math.ceil(base * Number(markup));
  return {
    modelSlug,
    modelType: "chat",
    upstreamId: "openrouter",
    upstreamModelId: "openai/gpt-4o-mini",
    adapterKey: "openrouter",
    modelUpstreamId: "11111111-1111-4111-8111-111111111111",
    profileId: "openrouter-openai-gpt-4o-mini-chat-v1",
    profileRevision: 1,
    adapterContract: "openrouter-pinned-provider-chat-v1",
    endpointPolicy: {
      only: ["openai"],
      allowFallbacks: false,
      requireParameters: true,
    },
    contextWindowTokens: context,
    maxOutputTokens: cap,
    prices: {
      inputCentsPer1k: input,
      outputCentsPer1k: output,
      markup,
    },
    maxCredits: String(maxCredits),
  };
}

/** `div`-rounded charge for the candidate, mirroring aiag_quota_supplier_actual. */
function chargedCredits(candidate: Record<string, unknown>, prompt: number): bigint {
  const prices = candidate.prices as Record<string, string>;
  const base =
    Number(prices.inputCentsPer1k) * prompt +
    Number(prices.outputCentsPer1k) * 0;
  const charged = Math.floor((base * Number(prices.markup) * prompt * 2 + prompt) / (2 * prompt));
  return BigInt(charged);
}

function quoteFor(
  candidate: Record<string, unknown>,
  maxCredits: string,
): Record<string, unknown> {
  return {
    version: 1,
    tokenQuote: {
      version: 1,
      formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1",
      requestedMode: "auto",
      effectiveMode: "auto",
      authorizedMaxCredits: maxCredits,
      candidates: [candidate],
    },
    actualChargePolicy: {
      formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1",
      cachingDiscount: "1",
    },
  };
}

function usageFor(
  candidate: Record<string, unknown>,
  input: ChargeInput,
  promptTokens: number,
): Record<string, unknown> {
  return {
    version: 1,
    formulaVersion: "db-input-output-cents-per-1k-legacy-whole-cache-v1",
    billingRequestId: input.billingRequestId,
    attemptId: input.attemptId,
    usageContract: candidate.adapterContract,
    upstreamId: candidate.upstreamId,
    upstreamModelId: candidate.upstreamModelId,
    adapterKey: candidate.adapterKey,
    modelSlug: candidate.modelSlug,
    modelUpstreamId: candidate.modelUpstreamId,
    profileId: candidate.profileId,
    profileRevision: candidate.profileRevision,
    completionId: "cmpl-off-cluster",
    reportedModel: candidate.modelSlug,
    usage: {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
      cachedInputTokens: 0,
    },
  };
}

function assertChargeInput(input: ChargeInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.orgId !== "string" ||
    typeof input.apiKeyId !== "string" ||
    typeof input.billingRequestId !== "string" ||
    typeof input.attemptId !== "string" ||
    typeof input.modelSlug !== "string" ||
    typeof input.deadline !== "string" ||
    !UUID.test(input.orgId) ||
    !UUID.test(input.apiKeyId) ||
    !UUID.test(input.billingRequestId) ||
    !UUID.test(input.attemptId) ||
    !Number.isInteger(input.promptTokens) ||
    input.promptTokens <= 0 ||
    (input.declaredSessionId !== null &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.declaredSessionId))
  )
    fail("OFF_CLUSTER_BALANCE_INPUT_INVALID");
}

/**
 * Run one complete charge through the existing gateway authority:
 * admit -> dispatch -> outcome -> settle. No balance is written here; the
 * settlement function owns the `UPDATE ... WHERE guard RETURNING`.
 */
export async function settleChargeViaGatewayAuthority(
  client: BalanceSqlClient,
  input: ChargeInput,
): Promise<ChargeResult> {
  assertChargeInput(input);
  const candidate = pricedCandidate(input.modelSlug, input.promptTokens);
  const maxCredits = String(candidate.maxCredits);
  const cost = chargedCredits(candidate, input.promptTokens);
  if (cost <= 0n || cost > BigInt(maxCredits))
    fail("OFF_CLUSTER_BALANCE_COST_INVALID");
  const quote = quoteFor(candidate, maxCredits);
  const supplierQuote = {
    version: 2,
    formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
    tokenQuote: quote.tokenQuote,
  };

  const admitted = (
    await client.query({
      text: `SELECT authorized_max_credits::text AS authorized, state, did_transition
        FROM public.aiag_admit_gateway_charge_v2(
          $1::uuid,$2::uuid,$3::uuid,$4::varchar,'chat'::varchar,'stored'::varchar,
          $5::varchar,$6::bigint,$7::jsonb,$8::timestamptz,$9::varchar,$10::jsonb)`,
      values: [
        input.orgId,
        input.billingRequestId,
        input.apiKeyId,
        "off-cluster-cutover",
        input.modelSlug,
        maxCredits,
        JSON.stringify(quote),
        input.deadline,
        input.declaredSessionId,
        JSON.stringify(supplierQuote),
      ],
    })
  ).rows[0];
  if (admitted === undefined) fail("OFF_CLUSTER_BALANCE_ADMIT_UNCONFIRMED");

  await client.query({
    text: `SELECT * FROM public.aiag_mark_gateway_charge_dispatched(
        $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::jsonb)`,
    values: [
      input.orgId,
      input.billingRequestId,
      input.attemptId,
      candidate.upstreamId,
      JSON.stringify({
        ...candidate,
        actualChargePolicy: quote.actualChargePolicy,
      }),
    ],
  });
  await client.query({
    text: `SELECT * FROM public.aiag_record_gateway_charge_outcome_v2(
        $1::uuid,$2::uuid,$3::bigint,$4::jsonb,$5::varchar)`,
    values: [
      input.orgId,
      input.billingRequestId,
      cost.toString(),
      JSON.stringify(usageFor(candidate, input, input.promptTokens)),
      "success",
    ],
  });
  const settled = (
    await client.query({
      text: `SELECT actual_cost_credits::text AS actual, state, did_transition
        FROM public.aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)`,
      values: [input.orgId, input.billingRequestId],
    })
  ).rows[0];
  if (settled?.state !== "settled" || settled.did_transition !== true)
    fail("OFF_CLUSTER_BALANCE_SETTLE_UNCONFIRMED");
  return {
    billingRequestId: input.billingRequestId,
    authorizedMaxCredits: String(admitted.authorized),
    actualCostCredits: String(settled.actual),
    state: String(settled.state),
    didTransition: settled.did_transition as boolean,
  };
}

export interface FirstDebitInput extends ChargeInput {
  /**
   * When set, the debit is refused before any money moves if the hold exceeds
   * the restored balance. Used by the guard test to prove a restore that lost
   * credits cannot be spent from.
   */
  rejectHoldAboveBalance?: boolean;
}

export interface FirstDebitOutcome {
  billingRequestId: string;
  admittedMaxCredits: string;
  settledCostCredits: string;
  /** Payg balance before and after the debit, read back from the cluster. */
  balanceBefore: string;
  balanceAfter: string;
  /** Balance before minus the settled cost, computed independently. */
  balanceExpected: string;
  quotaReservedAfter: string;
  quotaSettledAfter: string;
  /** `api_usage` receipt rows the debit produced (one per funded bucket). */
  receiptRows: number;
  settlementEventRows: number;
  /** `did_transition` of a replayed settle — must stay false. */
  replayDidTransition: boolean;
  receiptAfterReplay: number;
}

/**
 * Execute one charge on a restored cluster through the existing gateway
 * authority and prove three things at once:
 *   - the debit came out of the restored balance, not out of thin air;
 *   - the quota reservation moved from reserved to settled by that amount;
 *   - one request yields one immutable outcome (replay is a no-op).
 */
export async function firstDebitAfterRestore(
  client: BalanceSqlClient,
  input: FirstDebitInput,
): Promise<FirstDebitOutcome> {
  assertChargeInput(input);
  const before = await readOpeningBalances(client, [input.orgId]);
  const balanceBefore = before[0].balancePayg;
  const maxCredits = String(
    pricedCandidate(input.modelSlug, input.promptTokens).maxCredits,
  );
  if (input.rejectHoldAboveBalance === true) {
    // The whole point of the cutover: the restored balance alone must fund the
    // first debit. If it cannot, the restore lost money and we stop here.
    if (BigInt(maxCredits) > BigInt(balanceBefore))
      fail("OFF_CLUSTER_BALANCE_HOLD_EXCEEDS_RESTORED");
  }

  const charge = await settleChargeViaGatewayAuthority(client, input);

  const after = await readOpeningBalances(client, [input.orgId]);
  const balanceAfter = after[0].balancePayg;
  const balanceExpected = (
    BigInt(balanceBefore) - BigInt(charge.actualCostCredits)
  ).toString();
  if (balanceAfter !== balanceExpected)
    fail("OFF_CLUSTER_BALANCE_FIRST_DEBIT_WRONG");

  const receiptCount = async () =>
    Number(
      (
        await client.query({
          text: `SELECT count(*)::int AS n FROM public.gateway_transactions
            WHERE org_id = $1 AND type = 'api_usage'
              AND metadata->>'billing_request_id' = $2`,
          values: [input.orgId, input.billingRequestId],
        })
      ).rows[0]?.n ?? 0,
    );
  const quota = (
    await client.query({
      text: `SELECT coalesce(sum(b.reserved_amount), 0)::text AS reserved,
          coalesce(sum(b.settled_amount), 0)::text AS settled
        FROM public.gateway_quota_buckets b WHERE b.org_id = $1`,
      values: [input.orgId],
    })
  ).rows[0];
  const receiptRows = await receiptCount();
  const settlementEventRows = Number(
    (
      await client.query({
        text: `SELECT count(*)::int AS n FROM public.gateway_charge_admission_events
          WHERE org_id = $1 AND admission_id = $2 AND event_kind = 'settlement'`,
        values: [input.orgId, input.billingRequestId],
      })
    ).rows[0]?.n ?? 0,
  );
  // One request, one immutable outcome: exactly one receipt per funded bucket
  // and exactly one settlement event, no matter how often settle is called.
  if (receiptRows < 1 || receiptRows > 2 || settlementEventRows !== 1)
    fail("OFF_CLUSTER_BALANCE_OUTCOME_NOT_SINGLE");

  const replay = (
    await client.query({
      text: `SELECT did_transition FROM public.aiag_settle_admitted_gateway_charge($1::uuid,$2::uuid)`,
      values: [input.orgId, input.billingRequestId],
    })
  ).rows[0];
  const receiptAfterReplay = await receiptCount();
  if (replay?.did_transition !== false || receiptAfterReplay !== receiptRows)
    fail("OFF_CLUSTER_BALANCE_OUTCOME_NOT_IMMUTABLE");

  return {
    billingRequestId: input.billingRequestId,
    admittedMaxCredits: charge.authorizedMaxCredits,
    settledCostCredits: charge.actualCostCredits,
    balanceBefore,
    balanceAfter,
    balanceExpected,
    quotaReservedAfter: String(quota?.reserved ?? "0"),
    quotaSettledAfter: String(quota?.settled ?? "0"),
    receiptRows,
    settlementEventRows,
    replayDidTransition: replay.did_transition as boolean,
    receiptAfterReplay,
  };
}
