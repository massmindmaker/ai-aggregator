/**
 * POST /v1/agent/challenge + /v1/agent/register — headless agent bootstrap.
 *
 * public by design: registration bootstrap — the caller has NO gateway key
 * yet; the TON wallet proof IS the authentication. server.ts mounts this on
 * the root app, ahead of every requireApiKey assembly, next to /health.
 * Abuse is bounded by three layers: this route's Redis sliding-window guards
 * (`agentreg:glob` 60/min, `agentreg:addr:<raw>` 6/5min), the service-side
 * challenge caps (Task 3), and the challenge being single-use + 120s.
 *
 * ── The first key, and the only place it exists in the clear ────────────────
 * Review wave (T-a1 Fix 2): the first gateway key is minted INSIDE the
 * service's registration transaction. The route generates the plaintext
 * BEFORE the service call (`generateApiKey`), passes only its SHA-256 hash
 * and 20-char prefix down, and returns the plaintext in this ONE response
 * from its own local value — it is never stored, never logged, and never
 * crosses the service boundary. Atomicity is the point: the two-transaction
 * split (org+principal, then key) could strand a registered wallet with no
 * key — a keyless lock-out with no recovery but principal revoke. Now a
 * mint failure rolls the whole registration back (AGENT_AUTH_UNAVAILABLE →
 * 503) and the wallet can simply register again. The same transaction also
 * enrolls the org into quota v2 (0068) — stored admission requires
 * enforcement_version=2, so without the enrollment every later request
 * would 500 with QUOTA_V2_NOT_ENABLED.
 *
 * The minted key: name 'agent-primary', rpm_limit 60, policies
 * {"kind":"agent","s2s_key_minting":true} (the agent may mint sibling keys
 * for its own org via /v1/organization/keys), expires_at NULL — the TTL
 * column exists (0105) but the bootstrap key is deliberately non-expiring.
 *
 * ── The challenge domain is configuration, not the Host header ──────────────
 * AIAG_AGENT_PROOF_DOMAIN (config.ts) names the domain the wallet proof must
 * be signed for. PRODUCTION MUST SET IT: the request Host is
 * attacker-influenced at the edge and is only a dev fallback here. The
 * service re-validates whatever arrives (3..300 chars, dot, URL round-trip).
 *
 * ── Error mapping (service codes → HTTP), no internals leak ─────────────────
 *   AGENT_ALREADY_REGISTERED  → 409   (one wallet = one org = one bootstrap)
 *   AGENT_PROOF_INVALID       → 400
 *   AGENT_CHALLENGE_INVALID   → 400
 *   AGENT_CHALLENGE_EXPIRED   → 410
 *   AGENT_CHALLENGE_RATE_LIMIT→ 429
 *   AGENT_AUTH_UNAVAILABLE    → 503
 *   anything else             → 400 generic / 500 INTERNAL
 * Driver/SQL text is never echoed: unexpected errors rethrow and the app
 * error handler renders a bare {error:{code:'INTERNAL'}}.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql } from '../../lib/db';
import { AiagError, errors } from '../../lib/errors';
import { generateApiKey } from '../../lib/api-key';
import { makeRedis } from '../../lib/redis';
import { config } from '../../config';
import {
  AgentAuthError,
  consumeAgentRegister,
  issueAgentChallenge,
} from '@aiag/database';
import type { TonPaymentDatabase, TonSqlClient } from '@aiag/database';

export const agentRegister = new Hono();

/** Ton Connect raw workchain-0 address, as it arrives in the proof. */
const RAW_ADDRESS = /^0:[0-9a-f]{64}$/;

const challengeSchema = z.object({
  address: z.string().regex(RAW_ADDRESS),
  network: z.literal('-3'),
});

const registerSchema = z.object({
  challengeId: z.string().uuid(),
  address: z.string().regex(RAW_ADDRESS),
  /** Opaque Ton Connect proof blob; Task 3 owns its parsing and verification. */
  proof: z.unknown(),
});

/** Mirrors the service-side `expires_at = issued_at + 120 seconds`. */
const CHALLENGE_TTL_SECONDS = 120;

const ADDR_LIMIT = 6;
const ADDR_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_LIMIT = 60;
const GLOBAL_WINDOW_MS = 60 * 1000;

// ── Redis sliding window (same script/shape as middleware/rate-limit-plan04) ─
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

async function consumeSliding(
  c: Context,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const redis = makeRedis('ratelimit');
  const nowMs = Date.now();
  const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;
  let result: SlidingResult;
  try {
    result = (await redis.eval(
      SLIDING_LUA,
      1,
      key,
      String(limit),
      String(windowMs),
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
    // Fail closed, like every other guard in this gateway: a public
    // unauthenticated endpoint must not fall back to unlimited DB writes.
    c.header('Retry-After', '2');
    throw errors.unavailable('Request state unavailable');
  }
  const [ok, retry] = result;
  if (ok !== 1) {
    const retryAfter = retry || 60;
    c.header('Retry-After', String(retryAfter));
    throw errors.rateLimited(retryAfter);
  }
}

const guardGlobal = (c: Context) =>
  consumeSliding(c, 'agentreg:glob', GLOBAL_LIMIT, GLOBAL_WINDOW_MS);

const guardAddress = (c: Context, address: string) =>
  consumeSliding(c, `agentreg:addr:${address}`, ADDR_LIMIT, ADDR_WINDOW_MS);

// ── Service-layer DB adapter ─────────────────────────────────────────────────
// Task 3 speaks the node-pg `{text, values}` protocol on top of one real
// transaction; the gateway's postgres.js pool is adapted to that seam. Local
// timeouts bound the service's advisory-lock waits so a stuck DB cannot pin
// gateway handlers indefinitely (mirrors the web wallet adapter).
const agentAuthDb: TonPaymentDatabase = {
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
          // postgres.js returns an array for every statement: SELECT rows
          // carry only .length, while UPDATE/DELETE carry a numeric .count
          // field (and an empty .length). rowCount must prefer .count.
          const rows = (Array.isArray(res) ? res : []) as Row[];
          const countField = (res as { count?: unknown } | undefined)?.count;
          const rowCount =
            typeof countField === 'number'
              ? countField
              : Array.isArray(res)
                ? res.length
                : 0;
          return { rows, rowCount };
        },
      });
    }) as unknown as Promise<T>);
  },
};

// ── Error mapping ────────────────────────────────────────────────────────────
function mapAgentAuthError(e: AgentAuthError): AiagError {
  switch (e.code) {
    case 'AGENT_ALREADY_REGISTERED':
      return new AiagError('AGENT_ALREADY_REGISTERED', 409, 'Agent already registered');
    case 'AGENT_CHALLENGE_EXPIRED':
      return new AiagError('AGENT_CHALLENGE_EXPIRED', 410, 'Challenge expired');
    case 'AGENT_CHALLENGE_RATE_LIMIT':
      return errors.rateLimited(60, 'Agent registration rate limit exceeded');
    case 'AGENT_AUTH_UNAVAILABLE':
      return errors.unavailable('Agent registration unavailable');
    // AGENT_PROOF_INVALID / AGENT_CHALLENGE_INVALID / AGENT_AUTH_INVALID and
    // anything unmapped: a generic 400 — codes distinguish, details never leak.
    default:
      return errors.badRequest('Invalid agent registration request');
  }
}

function toHttpError(e: unknown): AiagError {
  if (e instanceof AgentAuthError) return mapAgentAuthError(e);
  if (e instanceof AiagError) return e;
  throw e;
}

/** Throw the mapped error, keeping the Retry-After contract for 429s. */
function throwServiceError(c: Context, e: unknown): never {
  const mapped = toHttpError(e);
  if (mapped.code === 'RATE_LIMITED') {
    const details = mapped.details as { retryAfterSec?: number } | undefined;
    const retry = Number(details?.retryAfterSec ?? 0);
    c.header('Retry-After', String(retry > 0 ? retry : 60));
  }
  throw mapped;
}

// ── Routes ───────────────────────────────────────────────────────────────────
async function readJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('JSON object body required');
  }
  return raw;
}

agentRegister.post('/challenge', async (c) => {
  await guardGlobal(c);
  const parsed = challengeSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw errors.badRequest('Invalid agent challenge request');
  await guardAddress(c, parsed.data.address);

  let challenge: Awaited<ReturnType<typeof issueAgentChallenge>>;
  try {
    challenge = await issueAgentChallenge(agentAuthDb, {
      address: parsed.data.address,
      network: '-3',
      // Review wave (T-a1 Fix 4): the proof domain is configuration, not the
      // request Host (attacker-influenced at the edge). PRODUCTION MUST SET
      // AIAG_AGENT_PROOF_DOMAIN; the Host here is a dev-only fallback, and
      // the service re-validates whichever value arrives (3..300 chars).
      domain: config.AIAG_AGENT_PROOF_DOMAIN ?? new URL(c.req.url).host,
    });
  } catch (e) {
    throwServiceError(c, e);
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    challengeId: challenge.challengeId,
    payload: challenge.payload,
    expiresIn: CHALLENGE_TTL_SECONDS,
  });
});

agentRegister.post('/register', async (c) => {
  await guardGlobal(c);
  const parsed = registerSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw errors.badRequest('Invalid agent registration request');
  await guardAddress(c, parsed.data.address);

  // Review wave (T-a1 Fix 2): the plaintext is generated HERE, before the
  // service call, and exists only in this handler's local scope. The service
  // receives hash + prefix + name and inserts the key INSIDE the
  // registration transaction — org, principal, key, quota enrollment and
  // audits commit together or not at all.
  const { key, hash, prefix } = generateApiKey('live');

  let registered: Awaited<ReturnType<typeof consumeAgentRegister>>;
  try {
    registered = await consumeAgentRegister(agentAuthDb, {
      challengeId: parsed.data.challengeId,
      address: parsed.data.address,
      proof: parsed.data.proof,
      primaryKey: { hash, prefix, name: 'agent-primary' },
    });
  } catch (e) {
    throwServiceError(c, e);
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(
    {
      principal_id: registered.principalId,
      org_id: registered.orgId,
      // Shown exactly once. There is no endpoint that returns it again.
      key,
      key_prefix: registered.primaryKey?.prefix ?? prefix,
    },
    201,
  );
});
