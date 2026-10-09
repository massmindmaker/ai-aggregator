/**
 * POST /v1/agent/topup + GET /v1/agent/invoices/:id — headless agent topup
 * (plan 2026-10-09 agentic-rail, Task 6).
 *
 * Auth: the standard gateway key chain — server.ts mounts this sub-app behind
 * requireApiKey (+ the plan04 RPM limiter), exactly like /v1/usage and
 * /v1/organization, so orgId/keyId always come from the fresh key row and
 * never from the request. On top of the generic RPM limit, topups carry their
 * own coarse Redis window: `agenttop:<key_id>` 12 requests / 5 minutes —
 * invoice minting writes to the payg ledger path and must not be spammed.
 *
 * Money never enters here: the payload is assembled by the Task 5 service
 * (packages/database agent-topup.ts) on top of
 * aiag_create_agent_ton_invoice_v1 / aiag_read_agent_ton_invoice_v1 (0106),
 * which own authorization (live key → active agent principal), the asset
 * allowlist, refund/balance guards and settlement transitions.
 *
 * ── Idempotency is ORG-scoped (0106 phase-review ruling) ────────────────────
 * ton_invoices enforces UNIQUE(owner_user_id, org_id, idempotency_key); agent
 * invoices share the 0104 service-user owner, so a sibling key of the SAME
 * org replaying the same idempotencyKey gets the same invoiceId back. There
 * is no cross-org collision and no conflict under correct use — the CLIENT
 * mints the idempotencyKey (e.g. a UUID per logical topup). Sending a
 * DIFFERENT body under an already-used idempotencyKey is a 409
 * TON_IDEMPOTENCY_CONFLICT.
 *
 * ── Validation envelope ──────────────────────────────────────────────────────
 * The gateway has no 422: every /v1 schema failure is 400 BAD_REQUEST (see
 * lib/errors.ts), and the minimum grant (100 credits = 100_000 micro, 0106)
 * is enforced at this boundary as part of the body schema.
 *
 * ── Error mapping (service codes → HTTP), no internals leak ─────────────────
 *   AGENT_TOPUP_INVALID            → 400   AGENT_GRANT_TOO_SMALL        → 400
 *   TON_IDEMPOTENCY_CONFLICT       → 409   TON_REFUND_BLOCKED           → 409
 *   AGENT_NOT_AUTHORIZED           → 403   AGENT_TOPUP_NOT_FOUND        → 404
 *   TON_ASSET_NOT_ALLOWLISTED      → 503   TON_CHECKOUT_FX_STALE        → 503
 *   TON_QUOTE_EXPIRED              → 503   AGENT_TOPUP_UNAVAILABLE      → 503
 *   TON_BALANCE_COMPATIBILITY_LIMIT→ 400   anything else                → 400
 * Driver/SQL text is never echoed: unexpected errors rethrow and render a
 * bare {error:{code:'INTERNAL'}}.
 *
 * ── Timestamps ───────────────────────────────────────────────────────────────
 * expiresAt / settledAt are ISO-8601 UTC strings with millisecond precision.
 * Raw Postgres timestamp text never crosses this boundary.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql } from '../../lib/db';
import { AiagError, errors } from '../../lib/errors';
import { makeRedis } from '../../lib/redis';
import {
  AgentTopupError,
  createAgentTopupInvoice,
  readAgentTopupInvoice,
} from '@aiag/database';
import type { AgentTopupInvoice, AgentTopupPolicy, TonPaymentDatabase, TonSqlClient } from '@aiag/database';

export const agentTopup = new Hono();

/** Canonical whole-credit decimal string; ≥100 enforced by the schema below. */
const CREDITS = /^(0|[1-9][0-9]{0,15})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,96}$/;
const MIN_CREDITS = 100n;

const topupSchema = z
  .object({
    asset: z.enum(['gram', 'usdt']),
    credits: z.string().regex(CREDITS),
    /**
     * Client-minted, org-scoped: one unique key per logical topup. Replaying
     * the same body (same asset, credits and key) returns the SAME invoice —
     * including through a sibling gateway key of the same organization.
     */
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  })
  .strict()
  // Throw-proof on purpose: zod may run refinements on a "dirty" inner parse
  // (e.g. fractional credits the regex already rejected), and BigInt('100.5')
  // throws — that must surface as 400, never 500.
  .refine(
    (v) => {
      try {
        return BigInt(v.credits) >= MIN_CREDITS;
      } catch {
        return false;
      }
    },
    { message: 'credits must be at least 100' },
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── Redis sliding window (same script/shape as agent-register / plan04) ──────
const TOPUP_LIMIT = 12;
const TOPUP_WINDOW_MS = 5 * 60 * 1000;

const SLIDING_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_ms = (tonumber(oldest[2]) + window_ms) - now_ms
  return {0, math.max(1, math.ceil(retry_ms / 1000))}
end
redis.call('ZADD', key, now_ms, member)
redis.call('PEXPIRE', key, window_ms + 1000)
return {1, 0}
`;

type SlidingResult = [number, number];

async function guardTopupRate(c: Context, keyId: string): Promise<void> {
  const redis = makeRedis('ratelimit');
  const nowMs = Date.now();
  const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;
  let result: SlidingResult;
  try {
    result = (await redis.eval(
      SLIDING_LUA,
      1,
      `agenttop:${keyId}`,
      String(TOPUP_LIMIT),
      String(TOPUP_WINDOW_MS),
      String(nowMs),
      member,
    )) as SlidingResult;
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      ![0, 1].includes(result[0]) ||
      !Number.isSafeInteger(result[1]) ||
      result[1] < 0
    ) {
      throw new Error('malformed sliding-window result');
    }
  } catch {
    // Fail closed: an unbounded mint path must not survive a Redis outage.
    c.header('Retry-After', '2');
    throw errors.unavailable('Request state unavailable');
  }
  const [ok, retry] = result;
  if (ok !== 1) {
    const retryAfter = retry || 300;
    c.header('Retry-After', String(retryAfter));
    throw errors.rateLimited(retryAfter, 'Agent topup rate limit exceeded');
  }
}

// ── Service-layer DB adapter (same seam as agent-register) ───────────────────
const agentTopupDb: TonPaymentDatabase = {
  async transaction<T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> {
    return (sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '5s'");
      await tx.unsafe("SET LOCAL lock_timeout = '3s'");
      await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout = '8s'");
      return run({
        query: async <Row extends Record<string, unknown>>(config: {
          text: string;
          values: readonly unknown[];
        }) => {
          const rows = (await tx.unsafe(
            config.text,
            [...config.values] as never[],
          )) as unknown as Row[];
          return { rows, rowCount: rows.length };
        },
      });
    }) as unknown as Promise<T>);
  },
};

// ── Policy source: admin_settings first, env fallback (web-checkout pattern) ─
const TON_CHECKOUT_POLICY_KEY = 'ton_checkout_policy';

const atomicString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})$/)
  .refine((x) => BigInt(x) <= 9223372036854775807n);
const positiveAtomic = atomicString.refine((x) => BigInt(x) > 0n);
const label = z.string().min(1).max(96).regex(/^[^\s]+(\S.*)?$/);

/**
 * Subset of the ton_checkout_policy blob the agent rail consumes. Looser than
 * the web zod on purpose: fields the rail ignores (packages, network extras)
 * parse through so a storefront-oriented policy keeps serving agents.
 */
const policySchema = z.object({
  revision: label,
  recipient: z.string().regex(/^0:[a-f0-9]{64}$/),
  network: z.literal('tvm:-3'),
  finalityPolicyId: label,
  verifierVersion: label,
  quoteLifetimeSeconds: z.number().int().min(30).max(600),
  maxFxAgeSeconds: z.number().int().min(1).max(86400),
  fx: z
    .object({
      numerator: positiveAtomic,
      denominator: positiveAtomic,
      rounding: z.enum(['floor', 'ceil', 'half-up']),
      source: label,
      observedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  additionalFeeAtomic: atomicString,
});

async function readPolicyRaw(): Promise<string> {
  try {
    const rows = await sql<Array<{ value: unknown }>>`
      SELECT value FROM admin_settings WHERE key = ${TON_CHECKOUT_POLICY_KEY} LIMIT 1
    `;
    const value = rows[0]?.value;
    if (value !== undefined && value !== null) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
  } catch {
    /* a database outage must not brick topup when env is configured */
  }
  const fromEnv = process.env.TON_CHECKOUT_POLICY;
  return typeof fromEnv === 'string' ? fromEnv : '';
}

async function activeAgentTopupPolicy(): Promise<AgentTopupPolicy> {
  const raw = await readPolicyRaw();
  let parsed: z.infer<typeof policySchema>;
  try {
    if (!raw || raw.length > 16384) throw new Error('empty');
    parsed = policySchema.parse(JSON.parse(raw));
  } catch {
    throw errors.unavailable('Topup pricing unavailable');
  }
  return parsed;
}

// ── Error mapping ────────────────────────────────────────────────────────────
function mapAgentTopupError(e: AgentTopupError): AiagError {
  switch (e.code) {
    case 'AGENT_NOT_AUTHORIZED':
      return new AiagError('AGENT_NOT_AUTHORIZED', 403, 'Agent principal not active');
    case 'AGENT_TOPUP_NOT_FOUND':
      return errors.notFound('Invoice not found');
    case 'TON_IDEMPOTENCY_CONFLICT':
      return new AiagError('TON_IDEMPOTENCY_CONFLICT', 409, 'Idempotency key already used with a different request');
    case 'TON_REFUND_BLOCKED':
      return new AiagError('TON_REFUND_BLOCKED', 409, 'Organization has an unresolved refund');
    case 'TON_ASSET_NOT_ALLOWLISTED':
    case 'TON_CHECKOUT_FX_STALE':
    case 'TON_QUOTE_EXPIRED':
    case 'AGENT_TOPUP_UNAVAILABLE':
      return errors.unavailable('Topup unavailable');
    // AGENT_TOPUP_INVALID / AGENT_GRANT_TOO_SMALL / TON_BALANCE_COMPATIBILITY_LIMIT
    // and anything unmapped: generic 400 — codes distinguish, details never leak.
    default:
      return errors.badRequest('Invalid agent topup request');
  }
}

function throwServiceError(e: unknown): never {
  if (e instanceof AgentTopupError) throw mapAgentTopupError(e);
  if (e instanceof AiagError) throw e;
  throw e;
}

/**
 * Minimum nanoTON attached to a jetton transfer's forward payload so the
 * merchant side can parse the reference out of it. Placeholder until the
 * USDT parameterization task owns it: 0.05 TON.
 */
const USDT_MIN_FORWARD_ATOMIC = '50000000';

function transferHint(asset: AgentTopupInvoice['asset']) {
  if (asset.kind === 'native') {
    // Plain gram transfer with the invoice reference as the body comment.
    return { mode: 'native-comment' as const };
  }
  return {
    mode: 'jetton-forward-payload' as const,
    masterAddress: asset.masterAddress,
    minForwardAtomic: USDT_MIN_FORWARD_ATOMIC,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
async function readJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('JSON object body required');
  }
  return raw;
}

agentTopup.post('/topup', async (c) => {
  const apiKey = c.get('apiKey' as never) as { id: string };
  const orgId = c.get('orgId' as never) as string;
  await guardTopupRate(c, apiKey.id);

  const parsed = topupSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw errors.badRequest('Invalid agent topup request');

  let policy: AgentTopupPolicy;
  try {
    policy = await activeAgentTopupPolicy();
  } catch (e) {
    if (e instanceof AiagError) throw e;
    throw errors.unavailable('Topup pricing unavailable');
  }

  let invoice: Awaited<ReturnType<typeof createAgentTopupInvoice>>;
  try {
    invoice = await createAgentTopupInvoice(
      agentTopupDb,
      {
        keyId: apiKey.id,
        orgId,
        asset: parsed.data.asset,
        credits: parsed.data.credits,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      () => policy,
    );
  } catch (e) {
    throwServiceError(e);
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(
    {
      invoiceId: invoice.invoiceId,
      network: invoice.network,
      asset: invoice.asset,
      recipient: invoice.recipient,
      amountAtomic: invoice.amountAtomic,
      reference: invoice.reference,
      grantMicrocredits: invoice.grantMicrocredits,
      expiresAt: invoice.expiresAt,
      transferHint: transferHint(invoice.asset),
    },
    201,
  );
});

agentTopup.get('/invoices/:id', async (c) => {
  const apiKey = c.get('apiKey' as never) as { id: string };
  const invoiceId = c.req.param('id');
  if (!UUID.test(invoiceId)) throw errors.badRequest('Invalid invoice id');

  let status: Awaited<ReturnType<typeof readAgentTopupInvoice>>;
  try {
    status = await readAgentTopupInvoice(agentTopupDb, {
      keyId: apiKey.id,
      invoiceId,
    });
  } catch (e) {
    throwServiceError(e);
  }

  c.header('Cache-Control', 'private, no-store');
  const body: Record<string, unknown> = {
    invoiceId: status.invoiceId,
    status: status.status,
    grantMicrocredits: status.grantMicrocredits,
  };
  if (status.settledAt !== null) body.settledAt = status.settledAt;
  return c.json(body);
});
