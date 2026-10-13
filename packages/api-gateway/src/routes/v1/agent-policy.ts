/**
 * GET/PUT /v1/agent/policy — agent self-service for routing policy and
 * OPTIONAL quotas (Task 8; plan 2026-10-09 agentic-rail). Founder decision:
 * limits are opt-in, an agent that never sets them is unlimited — nothing
 * here ever imposes a default cap.
 *
 * Mounted on the ROOT app behind requireApiKey + rateLimit exactly like
 * /v1/agent/keys and /v1/agent/topup (server.ts): orgId/keyId always come
 * from the fresh gateway_api_keys row, never from the request, and the
 * public registration sub-app mounted earlier carries no handler for this
 * path.
 *
 * ── GET ─────────────────────────────────────────────────────────────────────
 * {policies, model_whitelist, quotas}. `policies` is the routing subset of
 * engine.ts ApiKeyPolicies found on the key (non-routing flags such as
 * kind/s2s_key_minting are never echoed); `quotas` carries the three opt-in
 * limits as decimal STRINGS (bigint-safe JSON):
 *   - session_micro        gateway_quota_key_policies.session_microcredits_limit_v2 (0068)
 *   - monthly_credits      gateway_api_keys.cost_limit_monthly_rub — CREDITS since
 *                          0061 (1 credit = 1000 micro), the exact column 0068
 *                          reads as the v2 key_month source (*1000 -> micro)
 *   - daily_org_usd_micro  gateway_quota_org_policies.daily_supplier_usd_micro_limit_v2
 * null everywhere = no limit.
 *
 * ── PUT (PATCH semantics) ───────────────────────────────────────────────────
 * Strict zod body; every field optional, but an EMPTY body is a 400 (a PUT
 * that changes nothing has no contract). Unknown fields → 400 before any
 * state is read, so garbage can never reach the merge. Per field:
 *   - absent  → unchanged;
 *   - null    → removed/cleared (allowed_providers:null drops the filter,
 *               session_micro_limit:null removes the session policy row);
 *   - value   → set.
 * Routing fields merge onto gateway_api_keys.policies INSIDE the service
 * transaction against the row locked FOR UPDATE — unknown existing keys
 * (kind, s2s_key_minting) are preserved untouched, so minting rights and
 * rail flags survive every self-service edit. model_whitelist (validated
 * like organization-keys.ts: ≤200 trimmed deduped slugs) goes to its own
 * column; null means []. Quota fields flow to the 0108 SQL writers, which
 * also scrub the legacy fields (daily_usd_cap, policies
 * per_session_budget_cap_rub) that would otherwise raise
 * QUOTA_POLICY_MIGRATION_REQUIRED under v2 admission (0068:421-438).
 * Limits are NOT mandatory and are NOT clamped here — a self-cap may also
 * be raised or removed freely; sub-key minting keeps its own issuer clamp
 * (organization-keys.ts clampToIssuer).
 *
 * ── Rate ────────────────────────────────────────────────────────────────────
 * Own coarse Redis window `agentpolicy:<key_id>` 30/min on top of the
 * per-key RPM limiter mounted in server.ts (policies are not heavy: one
 * locked read + a few single-row writes). Fails closed like agent-topup.
 *
 * ── Error mapping, no internals leak ────────────────────────────────────────
 *   AGENT_NOT_AUTHORIZED       → 403  (live key, but not an agent org)
 *   AGENT_QUOTA_OUT_OF_RANGE   → 400
 *   AGENT_POLICY_UNAVAILABLE   → 503
 *   anything else              → 400 generic / 500 INTERNAL
 * Driver/SQL text is never echoed.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql } from '../../lib/db';
import { AiagError, errors } from '../../lib/errors';
import { makeRedis } from '../../lib/redis';
import { readAgentPolicy, updateAgentPolicy, AgentPolicyError } from '@aiag/database';
import type { AgentPolicyPatch, AgentPolicyState, TonPaymentDatabase, TonSqlClient } from '@aiag/database';

export const agentPolicy = new Hono();

const MODES = ['auto', 'fastest', 'cheapest', 'balanced', 'ru-only'] as const;
const MAX_WHITELIST = 200;
const MAX_SLUG = 128;
const MAX_PROVIDERS = 64;
/** 0106/0108 compatibility ceiling for micro-scale integers (Number.MAX_SAFE_INTEGER). */
const MAX_MICRO = 9_007_199_254_740_991;
/** Monthly credits ceiling: NUMERIC(10,2) integer capacity of cost_limit_monthly_rub. */
const MAX_MONTHLY_CREDITS = 99_999_999;

const putSchema = z
  .object({
    default_mode: z.enum(MODES).nullish(),
    allowed_providers: z.array(z.string().min(1).max(MAX_SLUG)).max(MAX_PROVIDERS).nullish(),
    blocked_providers: z.array(z.string().min(1).max(MAX_SLUG)).max(MAX_PROVIDERS).nullish(),
    forbid_non_ru: z.boolean().nullish(),
    allow_pii_transborder: z.boolean().nullish(),
    model_whitelist: z.array(z.string().min(1).max(MAX_SLUG)).max(MAX_WHITELIST).nullish(),
    session_micro_limit: z.number().int().min(0).max(MAX_MICRO).nullish(),
    monthly_credits_limit: z.number().int().min(0).max(MAX_MONTHLY_CREDITS).nullish(),
    daily_org_usd_micro_limit: z.number().int().min(0).max(MAX_MICRO).nullish(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one policy field is required',
  });

export type PolicyPutBody = z.infer<typeof putSchema>;

function trimmedUnique(entries: string[], field: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const slug = entry.trim();
    if (slug.length === 0 || slug.length > MAX_SLUG) {
      throw errors.badRequest(`${field} entries must be 1..${MAX_SLUG} characters`);
    }
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

/** zod output → service patch: quota integers become canonical decimal strings. */
export function toServicePatch(body: PolicyPutBody): AgentPolicyPatch {
  const patch: AgentPolicyPatch = {};
  if (body.default_mode !== undefined) patch.default_mode = body.default_mode;
  if (body.allowed_providers !== undefined) {
    patch.allowed_providers = body.allowed_providers === null ? null : trimmedUnique(body.allowed_providers, 'allowed_providers');
  }
  if (body.blocked_providers !== undefined) {
    patch.blocked_providers = body.blocked_providers === null ? null : trimmedUnique(body.blocked_providers, 'blocked_providers');
  }
  if (body.forbid_non_ru !== undefined) patch.forbid_non_ru = body.forbid_non_ru;
  if (body.allow_pii_transborder !== undefined) patch.allow_pii_transborder = body.allow_pii_transborder;
  if (body.model_whitelist !== undefined) {
    patch.model_whitelist = body.model_whitelist === null ? [] : trimmedUnique(body.model_whitelist, 'model_whitelist');
  }
  if (body.session_micro_limit !== undefined) patch.session_micro_limit = body.session_micro_limit === null ? null : String(body.session_micro_limit);
  if (body.monthly_credits_limit !== undefined) patch.monthly_credits_limit = body.monthly_credits_limit === null ? null : String(body.monthly_credits_limit);
  if (body.daily_org_usd_micro_limit !== undefined) patch.daily_org_usd_micro_limit = body.daily_org_usd_micro_limit === null ? null : String(body.daily_org_usd_micro_limit);
  return patch;
}

/** Presentation: routing subset of ApiKeyPolicies; rail flags (kind, s2s_key_minting) are never echoed. */
export function projectApiPolicies(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['default_mode', 'allowed_providers', 'blocked_providers', 'forbid_non_ru', 'allow_pii_transborder', 'forbid_streaming_prompts'] as const) {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
  }
  // Legacy cap: surface only when it still means something (>0); 0 is the
  // scrubbed state the 0108 writer leaves behind.
  const cap = raw.per_session_budget_cap_rub;
  if (typeof cap === 'number' && cap > 0) out.per_session_budget_cap_rub = cap;
  if (typeof cap === 'string' && /^0*[1-9]/.test(cap)) out.per_session_budget_cap_rub = cap;
  return out;
}

function toResponseBody(state: AgentPolicyState): Record<string, unknown> {
  return {
    policies: projectApiPolicies(state.policies),
    model_whitelist: state.modelWhitelist,
    quotas: {
      session_micro: state.quotas.sessionMicrocredits,
      monthly_credits: state.quotas.monthlyCredits,
      daily_org_usd_micro: state.quotas.dailyOrgUsdMicro,
    },
  };
}

// ── Service-layer DB adapter (same seam as agent-keys / agent-topup) ─────────
const agentPolicyDb: TonPaymentDatabase = {
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
          const res = (await tx.unsafe(
            config.text,
            [...config.values] as never[],
          )) as unknown;
          // postgres.js returns a row array for SELECT/RETURNING but a
          // { count } object for plain UPDATE/DELETE — rowCount must be
          // derived from either, never from .length on the object.
          const rows = (Array.isArray(res) ? res : []) as Row[];
          const rowCount = Array.isArray(res)
            ? res.length
            : typeof (res as { count?: unknown })?.count === 'number'
              ? (res as unknown as { count: number }).count
              : 0;
          return { rows, rowCount };
        },
      });
    }) as unknown as Promise<T>);
  },
};

// ── 30/min coarse window on top of the mounted per-key RPM limiter ──────────
const POLICY_LIMIT = 30;
const POLICY_WINDOW_MS = 60 * 1000;

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

async function guardPolicyRate(c: Context, keyId: string): Promise<void> {
  const redis = makeRedis('ratelimit');
  const nowMs = Date.now();
  const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;
  let result: SlidingResult;
  try {
    result = (await redis.eval(
      SLIDING_LUA,
      1,
      `agentpolicy:${keyId}`,
      String(POLICY_LIMIT),
      String(POLICY_WINDOW_MS),
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
    // Fail closed: policy writes must not survive a Redis outage unthrottled.
    c.header('Retry-After', '2');
    throw errors.unavailable('Request state unavailable');
  }
  const [ok, retry] = result;
  if (ok !== 1) {
    const retryAfter = retry || 60;
    c.header('Retry-After', String(retryAfter));
    throw errors.rateLimited(retryAfter, 'Agent policy rate limit exceeded');
  }
}

function mapAgentPolicyError(e: AgentPolicyError): AiagError {
  switch (e.code) {
    case 'AGENT_NOT_AUTHORIZED':
      return new AiagError('AGENT_NOT_AUTHORIZED', 403, 'Agent principal not active');
    case 'AGENT_QUOTA_OUT_OF_RANGE':
      return errors.badRequest('Quota limit out of range');
    // Malformed 0108 entrypoint output: the rail is ours, so a bad shape is
    // unavailability — same contract as AGENT_REVOKE_UNAVAILABLE (T7) and
    // AGENT_TOPUP_UNAVAILABLE (T6).
    case 'AGENT_POLICY_UNAVAILABLE':
      return errors.unavailable('Agent policy unavailable');
    default:
      return errors.badRequest('Invalid agent policy request');
  }
}

async function requireAgentKey(c: Context): Promise<{ id: string }> {
  const apiKey = c.get('apiKey' as never) as { id: string } | undefined;
  if (!apiKey) throw errors.unauthorized();
  return apiKey;
}

agentPolicy.get('/policy', async (c) => {
  const apiKey = await requireAgentKey(c);
  await guardPolicyRate(c, apiKey.id);

  let state: AgentPolicyState;
  try {
    state = await readAgentPolicy(agentPolicyDb, { keyId: apiKey.id });
  } catch (e) {
    if (e instanceof AgentPolicyError) throw mapAgentPolicyError(e);
    if (e instanceof AiagError) throw e;
    // Read failures are availability, not caller error — and the driver text
    // is never echoed (listKeys precedent, agent-keys.ts).
    throw errors.unavailable('Agent policy unavailable');
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(toResponseBody(state), 200);
});

agentPolicy.put('/policy', async (c) => {
  const apiKey = await requireAgentKey(c);

  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined) throw errors.badRequest('JSON object body required');
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) throw errors.badRequest('Invalid agent policy request');

  await guardPolicyRate(c, apiKey.id);

  let state: AgentPolicyState;
  try {
    state = await updateAgentPolicy(agentPolicyDb, { keyId: apiKey.id, patch: toServicePatch(parsed.data) });
  } catch (e) {
    if (e instanceof AgentPolicyError) throw mapAgentPolicyError(e);
    // Unexpected failures keep the T7 revoke contract: rethrow, the generic
    // 500 carries no internals.
    throw e;
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(toResponseBody(state), 200);
});
