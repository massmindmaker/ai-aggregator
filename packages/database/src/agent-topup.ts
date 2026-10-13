/**
 * Headless agent topup (plan 2026-10-09 agentic-rail, Task 6 service seam).
 *
 * Thin assembly layer over the 0106 SQL entrypoints
 * (`aiag_create_agent_ton_invoice_v1` / `aiag_read_agent_ton_invoice_v1`):
 * it builds the strict agent_topup payload exactly the way the web checkout
 * builds its gateway_topup one (same `createQuote` arithmetic, same policy
 * source), then hands authorization, allowlisting and money guards to the SQL
 * — nothing here re-implements a guard the database already enforces.
 *
 * Differences from the web checkout that live HERE:
 *  - Authorization is the gateway key id, not a user session: the SQL resolves
 *    key → org → active agent_principals principal and pins the owner to the
 *    0104 service user. This module never queries the org's human owner.
 *  - Idempotency is ORG-scoped (phase review ruling on 0106): ton_invoices
 *    carries UNIQUE(owner_user_id, org_id, idempotency_key) and every agent
 *    invoice shares the same service-user owner, so a sibling key of the same
 *    org replays the invoice too. A DIFFERENT body under the same key is a
 *    TON_IDEMPOTENCY_CONFLICT. The replay pre-lookup below makes a same-body
 *    retry return the stored invoice instead of minting a fresh quote that
 *    would collide on payload equality (timestamps differ per quote).
 *  - USDT is an oracle-free peg: 1 USDT = 100 credits, so amount_atomic MUST
 *    be grantMicrocredits × 10 (decimals 6). The jetton asset is pinned to
 *    the TON mainnet USDT master in raw form (0106 validator), network
 *    'tvm:-1'; testnet USDT parameterization is a later plan task.
 *  - credits (the public API unit) convert 1:1000 to microcredits, matching
 *    organizations.payg_credits (1 credit = 1000 micro).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createQuote, type Asset } from '@aiag/shared/ton-payment-contract';
import type { TonPaymentDatabase, TonSqlClient } from './ton-payment-types';

export class AgentTopupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentTopupError';
  }
}

export type AgentTopupAsset = 'gram' | 'usdt';

/**
 * Policy subset the agent rail consumes. Same blob the worker persists to
 * admin_settings under 'ton_checkout_policy' (network stays 'tvm:-3' — gram
 * invoices are testnet exactly like the web storefront).
 */
export interface AgentTopupPolicy {
  revision: string;
  /** Raw workchain-0 deposit wallet, 0:hex64. */
  recipient: string;
  network: 'tvm:-3';
  finalityPolicyId: string;
  verifierVersion: string;
  /** 30..600 seconds. */
  quoteLifetimeSeconds: number;
  /** 1..86400 seconds; gram freshness only. */
  maxFxAgeSeconds: number;
  fx: {
    numerator: string;
    denominator: string;
    rounding: 'floor' | 'ceil' | 'half-up';
    source: string;
    observedAtMs: number;
    expiresAtMs: number;
  };
  /** Gram only — the USDT peg forces additionalFeeAtomic to 0. */
  additionalFeeAtomic: string;
}

export interface AgentTopupInvoice {
  invoiceId: string;
  network: 'tvm:-3' | 'tvm:-1';
  asset: Asset;
  recipient: string;
  amountAtomic: string;
  reference: string;
  grantMicrocredits: string;
  /** ISO-8601 UTC, millisecond precision — never the raw PG text form. */
  expiresAt: string;
  status: 'pending' | 'observed' | 'confirmed' | 'settled' | 'expired' | 'review_required';
}

export interface CreateAgentTopupInput {
  /** gateway_api_keys.id from the authenticated request. */
  keyId: string;
  /** organizations.id from the same authenticated key row. */
  orgId: string;
  asset: AgentTopupAsset;
  /** Canonical decimal string of whole credits (>= 100). */
  credits: string;
  idempotencyKey: string;
}

export interface ReadAgentTopupInput {
  keyId: string;
  invoiceId: string;
}

export interface AgentTopupInvoiceStatus {
  invoiceId: string;
  status: AgentTopupInvoice['status'];
  grantMicrocredits: string;
  settledAt: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────
/** 1 credit = 1000 microcredits (organizations.*_credits are BIGINT micro). */
const MICRO_PER_CREDIT = 1000n;
/** 0106 floor: _grant < 100_000 micro is AGENT_GRANT_TOO_SMALL. */
const MIN_CREDITS = 100n;
/** 0098/0106 guard the payg ledger at Number.MAX_SAFE_INTEGER micro. */
const MAX_COMPATIBILITY_MICRO = 9007199254740991n;

/**
 * USDT jetton pinned by the 0106 validator: TON mainnet master
 * EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs in raw form, network
 * 'tvm:-1' (mainnet chain id). amount = grantMicrocredits × 10 exactly.
 */
const USDT_ASSET: Asset = {
  network: 'tvm:-1',
  kind: 'jetton',
  masterAddress: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
  decimals: 6,
};
/** Peg ratio: 10 atomic USDT per microcredit ⇒ 1 USDT (10^6 atoms) = 10^5 micro = 100 credits. */
const USDT_FX = { numerator: '10', denominator: '1', rounding: 'floor' } as const;
const USDT_FX_SOURCE = 'usdt-peg-v1';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,96}$/;
const CANONICAL_CREDITS = /^(0|[1-9][0-9]{0,15})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(code: string): never {
  throw new AgentTopupError(code);
}

async function query<R extends Record<string, unknown>>(
  tx: TonSqlClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  return (await tx.query<R>({ text, values })).rows;
}

/** DB clock in Unix ms — the same source the quote timestamps are checked against. */
async function clock(tx: TonSqlClient): Promise<number> {
  const row = (
    await query<{ now_ms: string }>(
      tx,
      'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms',
    )
  )[0];
  const now = Number(row?.now_ms);
  if (!Number.isSafeInteger(now) || now < 0) fail('AGENT_TOPUP_UNAVAILABLE');
  return now;
}

/**
 * Request fingerprint: sha256 of the canonical JSON of the client body
 * (fixed alphabetical key order, canonical credits spelling enforced upstream
 * by the route schema). Same body → same fingerprint → org-scoped replay
 * works across sibling keys of the org; a different body → 409 at the SQL.
 */
export function agentTopupFingerprint(input: {
  asset: AgentTopupAsset;
  credits: string;
  idempotencyKey: string;
}): string {
  const canonical = JSON.stringify({
    asset: input.asset,
    credits: input.credits,
    idempotencyKey: input.idempotencyKey,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ── Invoice JSON validation (never trust driver output blindly) ──────────────
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isoTimestamp(value: unknown, code = 'AGENT_TOPUP_UNAVAILABLE'): string {
  if (typeof value !== 'string' || !ISO_LIKE.test(value)) fail(code);
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms)) fail(code);
  return new Date(ms).toISOString();
}

function atomic(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(value)) {
    fail('AGENT_TOPUP_UNAVAILABLE');
  }
  return value;
}

function parseInvoiceJson(raw: unknown): AgentTopupInvoice {
  if (typeof raw !== 'string') fail('AGENT_TOPUP_UNAVAILABLE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('AGENT_TOPUP_UNAVAILABLE');
  }
  const v = parsed as Record<string, unknown>;
  const invoiceId = typeof v.invoiceId === 'string' && UUID.test(v.invoiceId) ? v.invoiceId : fail('AGENT_TOPUP_UNAVAILABLE');
  const network = v.network === 'tvm:-3' || v.network === 'tvm:-1' ? v.network : fail('AGENT_TOPUP_UNAVAILABLE');
  const assetRaw = v.asset as Record<string, unknown> | undefined;
  if (!assetRaw || typeof assetRaw !== 'object') fail('AGENT_TOPUP_UNAVAILABLE');
  let asset: Asset;
  if (assetRaw.kind === 'native' && assetRaw.network === network && assetRaw.decimals === 9) {
    asset = { network, kind: 'native', decimals: 9 };
  } else if (
    assetRaw.kind === 'jetton' &&
    assetRaw.network === network &&
    typeof assetRaw.masterAddress === 'string' &&
    /^(-1|0):[0-9a-f]{64}$/.test(assetRaw.masterAddress) &&
    typeof assetRaw.decimals === 'number'
  ) {
    asset = {
      network,
      kind: 'jetton',
      masterAddress: assetRaw.masterAddress,
      decimals: assetRaw.decimals,
    };
  } else {
    fail('AGENT_TOPUP_UNAVAILABLE');
  }
  const recipient = typeof v.recipient === 'string' && /^(0|-1):[0-9a-f]{64}$/.test(v.recipient) ? v.recipient : fail('AGENT_TOPUP_UNAVAILABLE');
  const reference =
    typeof v.reference === 'string' && /^aiag-ton:[0-9a-f-]{36}$/.test(v.reference) ? v.reference : fail('AGENT_TOPUP_UNAVAILABLE');
  const status = v.status as AgentTopupInvoice['status'];
  if (!['pending', 'observed', 'confirmed', 'settled', 'expired', 'review_required'].includes(status)) {
    fail('AGENT_TOPUP_UNAVAILABLE');
  }
  return {
    invoiceId,
    network,
    asset,
    recipient,
    amountAtomic: atomic(v.amountAtomic),
    reference,
    grantMicrocredits: atomic(v.grantMicrocredits),
    expiresAt: isoTimestamp(v.expiresAt),
    status,
  };
}

// ── Payload assembly (mirrors ton-wallet-checkout quote construction) ────────
function buildQuote(
  input: CreateAgentTopupInput,
  policy: AgentTopupPolicy,
  grant: bigint,
  now: number,
): ReturnType<typeof createQuote> {
  const grantStr = grant.toString();
  const lifetimeMs = policy.quoteLifetimeSeconds * 1000;
  if (input.asset === 'usdt') {
    // Peg: exact integer ratio, no oracle, no fee — the 0106 equality
    // amountAtomic === grant × 10 forces additionalFeeAtomic to 0 anyway.
    const asset = USDT_ASSET;
    return createQuote(
      {
        quoteId: 'agent-' + randomUUID(),
        sourcePrice: { unit: 'gateway_microcredits', amountAtomic: grantStr },
        asset,
        fx: {
          sourceUnit: 'gateway_microcredits',
          targetAsset: asset,
          ...USDT_FX,
          source: USDT_FX_SOURCE,
          observedAtMs: now,
          expiresAtMs: now + lifetimeMs,
        },
        additionalFeeAtomic: '0',
        expiresAtMs: now + lifetimeMs,
      },
      [asset],
      now,
    );
  }
  // Gram: the storefront asset — testnet native, FX from the active policy.
  if (policy.network !== 'tvm:-3') fail('AGENT_TOPUP_UNAVAILABLE');
  const fx = policy.fx;
  if (
    !Number.isSafeInteger(fx.observedAtMs) ||
    fx.observedAtMs > now ||
    now - fx.observedAtMs > policy.maxFxAgeSeconds * 1000 ||
    fx.expiresAtMs <= now
  ) {
    fail('TON_CHECKOUT_FX_STALE');
  }
  const asset: Asset = { network: 'tvm:-3', kind: 'native', decimals: 9 };
  return createQuote(
    {
      quoteId: 'agent-' + randomUUID(),
      sourcePrice: { unit: 'gateway_microcredits', amountAtomic: grantStr },
      asset,
      fx: { sourceUnit: 'gateway_microcredits', targetAsset: asset, ...fx },
      additionalFeeAtomic: policy.additionalFeeAtomic,
      expiresAtMs: Math.min(now + lifetimeMs, fx.expiresAtMs),
    },
    [asset],
    now,
  );
}

// ── Public entrypoints ───────────────────────────────────────────────────────
/** PG RAISE EXCEPTION surfaces with the code as the driver message. */
const KNOWN_SQL_CODES = new Set([
  'AGENT_NOT_AUTHORIZED',
  'AGENT_GRANT_TOO_SMALL',
  'AGENT_ASSET_UNSUPPORTED',
  'AGENT_PEG_VIOLATION',
  'TON_INVALID_PAYLOAD',
  'TON_INVALID_QUOTE',
  'TON_INVALID_FINGERPRINT',
  'TON_IDEMPOTENCY_CONFLICT',
  'TON_ASSET_NOT_ALLOWLISTED',
  'TON_REFUND_BLOCKED',
  'TON_BALANCE_COMPATIBILITY_LIMIT',
  'TON_QUOTE_EXPIRED',
]);

function rethrowSqlError(e: unknown): never {
  if (e instanceof AgentTopupError) throw e;
  const message = typeof e === 'object' && e !== null ? String((e as { message?: unknown }).message) : '';
  if (KNOWN_SQL_CODES.has(message)) throw new AgentTopupError(message);
  // Unique violation on ton_invoices = a concurrent same-key insert raced the
  // pre-lookup; replay semantics say that is a conflict for the loser.
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505') {
    throw new AgentTopupError('TON_IDEMPOTENCY_CONFLICT');
  }
  throw e;
}

/** DB epoch-ms → ISO timestamp (settled_at path — never emit PG text). */
function isoFromEpochMs(value: string): string {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0) fail('AGENT_TOPUP_UNAVAILABLE');
  return new Date(ms).toISOString();
}

// ── Public entrypoints ───────────────────────────────────────────────────────
export async function createAgentTopupInvoice(
  db: TonPaymentDatabase,
  input: CreateAgentTopupInput,
  policy: () => AgentTopupPolicy,
): Promise<AgentTopupInvoice> {
  if (!UUID.test(input.keyId) || !UUID.test(input.orgId)) fail('AGENT_TOPUP_INVALID');
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) fail('AGENT_TOPUP_INVALID');
  if (input.asset !== 'gram' && input.asset !== 'usdt') fail('AGENT_TOPUP_INVALID');
  if (!CANONICAL_CREDITS.test(input.credits)) fail('AGENT_TOPUP_INVALID');
  const credits = BigInt(input.credits);
  if (credits < MIN_CREDITS) fail('AGENT_GRANT_TOO_SMALL');
  const grant = credits * MICRO_PER_CREDIT;
  if (grant > MAX_COMPATIBILITY_MICRO) fail('TON_BALANCE_COMPATIBILITY_LIMIT');
  const fingerprint = agentTopupFingerprint(input);

  return db.transaction(async (tx) => {
    // Service owner (0104) — every agent invoice is owned by this user.
    const ownerRow = (
      await query<{ owner: string | null }>(tx, 'SELECT aiag_agent_owner_user_v1()::text AS owner')
    )[0];
    const owner = ownerRow?.owner;
    if (!owner || !UUID.test(owner)) fail('AGENT_NOT_AUTHORIZED');

    // Org-scoped idempotent replay, authorized by the same live-key +
    // active-principal predicate the 0106 entrypoints use. A hit with the
    // same fingerprint returns the stored invoice (no second quote is built —
    // a fresh quote would differ on timestamps and never pass payload
    // equality); a hit with a different fingerprint is a conflict.
    const prior = (
      await query<{ request_fingerprint: string; invoice: string }>(
        tx,
        `SELECT i.request_fingerprint AS request_fingerprint, aiag_ton_invoice_json_v1(i) AS invoice
         FROM gateway_api_keys k
         JOIN agent_principals p ON p.org_id = k.org_id AND p.status = 'active'
         JOIN ton_invoices i ON i.org_id = k.org_id
          AND i.owner_user_id = $3::uuid AND i.purpose = 'agent_topup' AND i.idempotency_key = $2
         WHERE k.id = $1::uuid AND k.revoked_at IS NULL AND k.disabled_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp())
         LIMIT 1`,
        [input.keyId, input.idempotencyKey, owner],
      )
    )[0];
    if (prior) {
      if (prior.request_fingerprint !== fingerprint) fail('TON_IDEMPOTENCY_CONFLICT');
      return parseInvoiceJson(prior.invoice);
    }

    const p = policy();
    if (
      !Number.isInteger(p.quoteLifetimeSeconds) ||
      p.quoteLifetimeSeconds < 30 ||
      p.quoteLifetimeSeconds > 600
    ) {
      fail('AGENT_TOPUP_UNAVAILABLE');
    }
    const now = await clock(tx);
    let quote: ReturnType<typeof createQuote>;
    try {
      quote = buildQuote(input, p, grant, now);
    } catch (e) {
      if (e instanceof AgentTopupError) throw e;
      fail('TON_CHECKOUT_FX_STALE');
    }

    // Strict 0106 key set — no extras, no expectedSender (agent contract).
    const payload = JSON.stringify({
      schemaVersion: 1,
      purpose: 'agent_topup',
      ownerId: owner,
      orgId: input.orgId,
      idempotencyKey: input.idempotencyKey,
      grantMicrocredits: grant.toString(),
      priceRevision: p.revision,
      quote,
      recipient: p.recipient,
      finalityPolicyId: p.finalityPolicyId,
      verifierVersion: p.verifierVersion,
    });

    try {
      const row = (
        await query<{ invoice: string }>(
          tx,
          'SELECT aiag_create_agent_ton_invoice_v1($1::uuid, $2::text::jsonb, $3) AS invoice',
          [input.keyId, payload, fingerprint],
        )
      )[0];
      if (!row?.invoice) fail('AGENT_TOPUP_UNAVAILABLE');
      return parseInvoiceJson(row.invoice);
    } catch (e) {
      rethrowSqlError(e);
    }
  });
}

export async function readAgentTopupInvoice(
  db: TonPaymentDatabase,
  input: ReadAgentTopupInput,
): Promise<AgentTopupInvoiceStatus> {
  if (!UUID.test(input.keyId) || !UUID.test(input.invoiceId)) fail('AGENT_TOPUP_INVALID');
  return db.transaction(async (tx) => {
    // The SQL function applies the live-key + active-principal predicate; the
    // settled_at epoch is fetched by id and only surfaced when the function
    // authorized the read (NULL invoice → not found, foreign or otherwise).
    const row = (
      await query<{ invoice: string | null; settled_ms: string | null }>(
        tx,
        `SELECT aiag_read_agent_ton_invoice_v1($1::uuid, $2::uuid) AS invoice,
          (SELECT floor(extract(epoch FROM t.settled_at) * 1000)::text
             FROM ton_invoices t WHERE t.id = $2::uuid) AS settled_ms`,
        [input.keyId, input.invoiceId],
      )
    )[0];
    if (!row?.invoice) fail('AGENT_TOPUP_NOT_FOUND');
    const invoice = parseInvoiceJson(row.invoice);
    return {
      invoiceId: invoice.invoiceId,
      status: invoice.status,
      grantMicrocredits: invoice.grantMicrocredits,
      settledAt: row.settled_ms !== null ? isoFromEpochMs(row.settled_ms) : null,
    };
  });
}
