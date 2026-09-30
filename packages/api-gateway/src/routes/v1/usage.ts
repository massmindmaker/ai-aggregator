/**
 * GET /v1/usage/{billing_id} — the AUTHORITATIVE charge receipt.
 *
 * Why this route exists (docs/ecosystem/integration.md → «Денежная модель»):
 * a buyer that loses the response of a paid call must be able to ask "what
 * did you actually charge me for billing_id X?" and get the gateway's own
 * numbers back. Reconstructing that from a price list on the client side is
 * exactly the failure mode this replaces.
 *
 * ── Authorisation, the load-bearing part ────────────────────────────────────
 * The caller is an org API key. `requireApiKey` (mounted by the parent app on
 * /v1/*) puts the VERIFIED `orgId` in context — it is never taken from the
 * path, the query string or the body. The org scope is then applied *inside
 * the single prepared statement* (`AND a.org_id = $orgId`), so a billing id
 * belonging to another tenant returns zero rows and nothing else.
 *
 * A foreign billing id answers **404, never 403**: a 403 would confirm the id
 * exists, turning this endpoint into a cross-tenant id oracle. 404 for both
 * "yours" and "not yours" also means the response body cannot differ between
 * them. `notFound()` is used for the empty result — never `forbidden()`.
 *
 * ── What the numbers mean ──────────────────────────────────────────────────
 * Money is reported as exact decimal STRINGS of MICRO-credits (1 credit =
 * 1 US cent = 1000 micro; lib/pricing.ts). Never a JS float: a B2B consumer
 * must not be handed 0.1+0.2. Never a hardcoded price either — every figure
 * is read from the ledger the settlement actually wrote
 * (aiag_settle_charge_credits / aiag_settle_admitted_gateway_charge).
 *
 * `charged` is `null` while the admission has not settled and `"0"` only when
 * a terminal state confirmed nothing was taken. Collapsing those two would
 * make a buyer think it was undercharged and retry a paid generation.
 *
 * Read-only: this route issues exactly one SELECT and never writes.
 */
import { Hono } from 'hono';
import { sql, type SqlClient } from '../../lib/db';
import { errors } from '../../lib/errors';
import { MICRO_PER_CREDIT } from '../../lib/pricing';

export const usage = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdmissionState = 'held' | 'dispatched' | 'outcome_recorded' | 'settled' | 'cancelled';

type LedgerEntry = {
  source: string;
  type: string;
  delta_microcredits: string;
  created_at: string;
};

type ReceiptRow = {
  billing_id: string;
  org_id: string;
  api_key_id: string;
  route_kind: string;
  billing_mode: string;
  model_slug: string;
  state: AdmissionState;
  outcome_kind: string | null;
  client_request_id: string | null;
  authorized_max_credits: string;
  held_subscription_credits: string;
  held_payg_credits: string;
  actual_cost_credits: string | null;
  released_subscription_credits: string;
  released_payg_credits: string;
  expired_subscription_credits: string;
  debt_repaid_credits: string;
  usage_snapshot: Record<string, unknown> | null;
  charged_subscription_microcredits: string;
  charged_payg_microcredits: string;
  refunded_subscription_microcredits: string;
  refunded_payg_microcredits: string;
  ledger_entries: LedgerEntry[];
  org_subscription_microcredits: string;
  org_payg_microcredits: string;
  org_refund_debt_microcredits: string;
  created_at: string;
  settled_at: string | null;
  cancelled_at: string | null;
  reconcile_after: string | null;
};

/**
 * One statement, one round trip. `LEFT JOIN LATERAL` over
 * gateway_transactions is what makes this the LEDGER's answer rather than the
 * admission's guess: the debits are summed from the rows settlement actually
 * inserted, keyed by the same `gw:<billing_id>` receipt id the settle
 * functions write. org_id is repeated on the ledger arm too, so a ledger row
 * can never be attributed across tenants even if a request_id were reused.
 */
async function receiptStatement(client: SqlClient, orgId: string, billingId: string) {
  return client<ReceiptRow[]>`
  SELECT
    a.billing_request_id::text              AS billing_id,
    a.org_id::text                           AS org_id,
    a.api_key_id::text                       AS api_key_id,
    a.route_kind                             AS route_kind,
    a.billing_mode                           AS billing_mode,
    a.model_slug                             AS model_slug,
    a.state                                  AS state,
    a.outcome_kind                           AS outcome_kind,
    a.client_request_id                      AS client_request_id,
    a.authorized_max_credits::text           AS authorized_max_credits,
    a.held_subscription_credits::text        AS held_subscription_credits,
    a.held_payg_credits::text                AS held_payg_credits,
    a.actual_cost_credits::text              AS actual_cost_credits,
    a.released_subscription_credits::text    AS released_subscription_credits,
    a.released_payg_credits::text            AS released_payg_credits,
    a.expired_subscription_credits::text     AS expired_subscription_credits,
    a.debt_repaid_credits::text              AS debt_repaid_credits,
    a.usage_snapshot                         AS usage_snapshot,
    COALESCE(l.charged_subscription, '0')    AS charged_subscription_microcredits,
    COALESCE(l.charged_payg, '0')            AS charged_payg_microcredits,
    COALESCE(l.refunded_subscription, '0')   AS refunded_subscription_microcredits,
    COALESCE(l.refunded_payg, '0')           AS refunded_payg_microcredits,
    COALESCE(l.entries, '[]'::json)          AS ledger_entries,
    o.subscription_credits::text             AS org_subscription_microcredits,
    o.payg_credits::text                     AS org_payg_microcredits,
    o.refund_debt_credits::text              AS org_refund_debt_microcredits,
    to_char(a.created_at     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(a.settled_at     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
    to_char(a.cancelled_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cancelled_at,
    to_char(a.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_after
  FROM gateway_charge_admissions a
  JOIN organizations o ON o.id = a.org_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(t.delta) FILTER (WHERE t.type = 'api_usage' AND t.source = 'subscription'), 0) AS charged_subscription,
      COALESCE(SUM(t.delta) FILTER (WHERE t.type = 'api_usage' AND t.source = 'payg'), 0)         AS charged_payg,
      COALESCE(SUM(-t.delta) FILTER (WHERE t.type = 'refund' AND t.source = 'subscription'), 0)  AS refunded_subscription,
      COALESCE(SUM(-t.delta) FILTER (WHERE t.type = 'refund' AND t.source = 'payg'), 0)          AS refunded_payg,
      jsonb_agg(
        jsonb_build_object(
          'source', t.source,
          'type', t.type,
          'delta_microcredits', t.delta::text,
          'created_at', to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        )
        ORDER BY t.created_at, t.source
      ) AS entries
    FROM gateway_transactions t
    WHERE t.org_id = a.org_id
      AND (
        t.request_id = 'gw:' || a.billing_request_id::text
        OR t.request_id = 'author-refund:' || a.billing_request_id::text
        OR t.metadata->>'billingRequestId' = a.billing_request_id::text
      )
  ) l ON TRUE
  WHERE a.billing_request_id = ${billingId}::uuid
    AND a.org_id = ${orgId}::uuid
  LIMIT 1
  `;
}

/** Terminal states: the charge figure is final (possibly "0"), not unknown. */
const TERMINAL: ReadonlySet<AdmissionState> = new Set<AdmissionState>(['settled', 'cancelled']);

function sumBigInt(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    // A non-numeric ledger value means the money columns are not what this
    // route was written against. Refuse rather than emit a plausible number.
    throw errors.unavailable('Usage receipt unavailable');
  }
}

export function buildReceipt(row: ReceiptRow): Record<string, unknown> {
  const chargedSubscription = row.charged_subscription_microcredits;
  const chargedPayg = row.charged_payg_microcredits;
  const refundedSubscription = row.refunded_subscription_microcredits;
  const refundedPayg = row.refunded_payg_microcredits;
  const terminal = TERMINAL.has(row.state);

  return {
    object: 'billing.receipt',
    receipt_version: '1',
    billing_id: row.billing_id,
    state: row.state,
    // Unit and scale travel WITH the amount, per the money-model rules: a
    // consumer must never have to guess whether 1000 means micro or credits.
    unit: 'microcredits',
    microcredits_per_credit: MICRO_PER_CREDIT,
    route_kind: row.route_kind,
    billing_mode: row.billing_mode,
    model_slug: row.model_slug,
    outcome_kind: row.outcome_kind,
    // The buyer's own trace id, kept deliberately separate from billing_id.
    client_request_id: row.client_request_id,
    charged: terminal
      ? {
          subscription_microcredits: chargedSubscription,
          payg_microcredits: chargedPayg,
          total_microcredits: sumBigInt(chargedSubscription, chargedPayg),
        }
      : null,
    reserved: {
      authorized_max_microcredits: row.authorized_max_credits,
      subscription_microcredits: row.held_subscription_credits,
      payg_microcredits: row.held_payg_credits,
      total_microcredits: sumBigInt(row.held_subscription_credits, row.held_payg_credits),
    },
    released: {
      subscription_microcredits: row.released_subscription_credits,
      payg_microcredits: row.released_payg_credits,
      total_microcredits: sumBigInt(row.released_subscription_credits, row.released_payg_credits),
      expired_subscription_microcredits: row.expired_subscription_credits,
      debt_repaid_microcredits: row.debt_repaid_credits,
    },
    refunded: {
      subscription_microcredits: refundedSubscription,
      payg_microcredits: refundedPayg,
      total_microcredits: sumBigInt(refundedSubscription, refundedPayg),
    },
    usage: row.usage_snapshot,
    balance: {
      subscription_microcredits: row.org_subscription_microcredits,
      payg_microcredits: row.org_payg_microcredits,
      refund_debt_microcredits: row.org_refund_debt_microcredits,
    },
    ledger: row.ledger_entries ?? [],
    // An admitted-but-unsettled charge is exactly the "I don't know yet"
    // state the integration contract asks to be named rather than guessed.
    pending_reconciliation: !terminal && row.reconcile_after !== null,
    created_at: row.created_at,
    settled_at: row.settled_at,
    cancelled_at: row.cancelled_at,
  };
}

async function readReceipt(
  orgId: string,
  billingId: string,
  client: SqlClient = sql,
): Promise<ReceiptRow | undefined> {
  const rows = (await receiptStatement(client, orgId, billingId)) as unknown as ReceiptRow[];
  return rows[0];
}

usage.get('/:billing_id', async (c) => {
  // requireApiKey has already verified the bearer key against a fresh
  // gateway_api_keys row. orgId comes from THAT row and nowhere else.
  const orgId = c.get('orgId' as never) as string;
  const billingId = c.req.param('billing_id');

  // Shape check before SQL: a non-UUID can never be a valid billing id, and
  // rejecting it here means no cast error, no timing signal and no probe.
  if (!orgId || !UUID_RE.test(billingId)) throw errors.badRequest('billing_id must be a uuid');

  let row: ReceiptRow | undefined;
  try {
    // Bound parameters only — `${billingId}` / `${orgId}` are positional binds
    // in the statement text, never string-concatenated into it.
    row = await readReceipt(orgId, billingId.toLowerCase());
  } catch (e) {
    if (e instanceof Error && e.name === 'AiagError') throw e;
    // Never surface a driver message: it can echo the statement or the org.
    throw errors.unavailable('Usage receipt unavailable');
  }
  if (!row) throw errors.notFound('Usage receipt not found');

  // A receipt must stay readable while spending is blocked, so this route is
  // deliberately NOT behind the per-key cost cap (key-limits) — only behind
  // auth and the ordinary RPM bucket. It mints no settlement id and writes
  // nothing: a receipt is a pure read of the ledger.
  c.header('Cache-Control', 'private, no-store');
  return c.json(buildReceipt(row));
});
