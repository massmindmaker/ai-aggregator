/**
 * POST /v1/organization/keys — S2S minting of an org-scoped gateway key.
 *
 * Context: docs/superpowers/plans/2026-09-30-ecosystem-sync.md, wave 2 —
 * "Aggregator: минт `gateway_api_keys` по S2S". Until now the only way to
 * create a gateway key was the authenticated web dashboard
 * (apps/web/src/app/api/dashboard/keys/route.ts), which an agent in Agents
 * Market cannot reach: it holds no NextAuth session. Without this endpoint an
 * agent literally cannot obtain a wallet.
 *
 * ── The secret handling, which is the whole point ───────────────────────────
 * The plaintext key is generated here, returned in this ONE response, and
 * never stored. `lib/api-key.generateApiKey` returns `{key, hash, prefix}`;
 * only `hash` (SHA-256 hex) and `prefix` reach `gateway_api_keys`, exactly as
 * the dashboard does. There is deliberately NO GET/POST here that returns key
 * material again — a lost key is rotated, never looked up. Nothing logs it:
 * this module never passes `key` to `logger`, and the audit row below carries
 * only the key's id and prefix.
 *
 * ── Who may mint, and what they may mint ────────────────────────────────────
 * The caller is an existing gateway API key (S2S), resolved by
 * `requireApiKey` into `orgId` + policies. Three rules, all fail-closed:
 *
 *  1. `policies.s2s_key_minting === true` on the CALLING key. Without it a
 *     plain inference key could mint siblings for itself — turning one
 *     leaked inference key into unlimited key-manufacturing.
 *  2. The new key's org is the CALLER's org, taken from the verified key row.
 *     An `org_id` in the request body is ignored outright: honouring it would
 *     be a total cross-tenant takeover.
 *  3. The new key's limits are clamped to the caller's own: a whitelist entry
 *     the caller cannot call, a monthly cap above the caller's cap, or
 *     `ru_residency_only: false` from a residency-bound caller are all
 *     rejected. A key can therefore never mint a key more powerful than
 *     itself.
 *
 * Money invariants respected: the only write is a parameterized INSERT (no
 * string interpolation, no price arithmetic, no cap is spent or moved here),
 * and the audit row is written in the SAME transaction as the key so a key
 * can never exist without its audit trail.
 */
import { Hono } from 'hono';
import { sql, type SqlClient } from '../../lib/db';
import { errors } from '../../lib/errors';
import { generateApiKey } from '../../lib/api-key';
import type { AuthenticatedApiKey } from '../../middleware/auth-plan04';

export const organizationKeys = new Hono();

const MAX_NAME = 100;
const MAX_WHITELIST = 200;
const MAX_SLUG = 128;
const MAX_RPM = 100_000;
/** Ceiling for a single minted key's monthly cap, in credits. */
const MAX_COST_LIMIT = 10_000_000;

type CreateBody = {
  name: string;
  model_whitelist: string[];
  cost_limit_monthly_rub: number | null;
  ru_residency_only: boolean;
  rpm_limit: number;
  batch_rpm_limit: number;
};

type InsertedKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  model_whitelist: string[];
  cost_limit_monthly_rub: string | null;
  ru_residency_only: boolean;
  rpm_limit: number;
  batch_rpm_limit: number;
  created_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveInt(
  raw: unknown,
  field: string,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0 || raw > max) {
    throw errors.badRequest(`${field} must be a positive integer <= ${max}`);
  }
  return raw;
}

function optionalCostLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  // Plain JSON number, strictly positive, bounded. Reject NaN/Infinity/
  // strings outright rather than coercing — `Number("1000")` on a string is
  // how a "cap" silently becomes NaN in the DB and disables the limit.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > MAX_COST_LIMIT) {
    throw errors.badRequest(`cost_limit_monthly_rub must be a number in (0, ${MAX_COST_LIMIT}]`);
  }
  return raw;
}

function parseWhitelist(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_WHITELIST) {
    throw errors.badRequest(`model_whitelist must be an array of <= ${MAX_WHITELIST} strings`);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw errors.badRequest('model_whitelist entries must be strings');
    const slug = entry.trim();
    if (slug.length === 0 || slug.length > MAX_SLUG) {
      throw errors.badRequest(`model_whitelist entries must be 1..${MAX_SLUG} characters`);
    }
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export function parseCreateBody(raw: unknown): CreateBody {
  if (!isRecord(raw)) throw errors.badRequest('JSON object body required');

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length === 0 || name.length > MAX_NAME) {
    throw errors.badRequest(`name must be 1..${MAX_NAME} characters`);
  }

  return {
    name,
    model_whitelist: parseWhitelist(raw.model_whitelist),
    cost_limit_monthly_rub: optionalCostLimit(raw.cost_limit_monthly_rub),
    ru_residency_only: raw.ru_residency_only === true,
    rpm_limit: optionalPositiveInt(raw.rpm_limit, 'rpm_limit', MAX_RPM, 60),
    batch_rpm_limit: optionalPositiveInt(raw.batch_rpm_limit, 'batch_rpm_limit', MAX_RPM, 10),
  };
}

/**
 * Every minted key is a SUBORDINATE of the caller's key. Returns the body
 * unchanged when it is already within the caller's envelope, throws 400 when
 * it is not.
 */
export function clampToIssuer(body: CreateBody, issuer: AuthenticatedApiKey): CreateBody {
  const issuerWhitelist = issuer.model_whitelist ?? [];
  // An empty issuer whitelist means "no restriction" (the DB default). Only
  // a key that is itself restricted may not widen that.
  if (issuerWhitelist.length > 0) {
    for (const slug of body.model_whitelist) {
      if (!issuerWhitelist.includes(slug)) {
        throw errors.badRequest('model_whitelist exceeds the calling key own whitelist');
      }
    }
  }

  const issuerCap = issuer.cost_limit_monthly_rub;
  if (issuerCap !== null && issuerCap !== undefined) {
    if (body.cost_limit_monthly_rub === null) {
      throw errors.badRequest('cost_limit_monthly_rub is required: the calling key is capped');
    }
    if (body.cost_limit_monthly_rub > Number(issuerCap)) {
      throw errors.badRequest('cost_limit_monthly_rub exceeds the calling key own cap');
    }
  }

  // Residency is a restriction, not a preference: a bound caller cannot mint
  // an unbound sibling.
  if (issuer.ru_residency_only === true && body.ru_residency_only !== true) {
    throw errors.badRequest('ru_residency_only cannot be relaxed below the calling key');
  }

  if (body.rpm_limit > issuer.rpm_limit) {
    throw errors.badRequest('rpm_limit exceeds the calling key own limit');
  }
  if (body.batch_rpm_limit > issuer.batch_rpm_limit) {
    throw errors.badRequest('batch_rpm_limit exceeds the calling key own limit');
  }

  return body;
}

export function assertMayMint(issuer: AuthenticatedApiKey): void {
  const policies = issuer.policies as Record<string, unknown> | undefined;
  if (!policies || policies.s2s_key_minting !== true) {
    throw errors.forbidden('Key is not authorized for S2S key minting');
  }
}

export async function mintKey(
  issuer: AuthenticatedApiKey,
  body: CreateBody,
  client: SqlClient = sql,
): Promise<{ row: InsertedKeyRow; key: string }> {
  const { key, hash, prefix } = generateApiKey('live');

  const inserted = await client.begin(async (tx) => {
    const rows = (await tx<InsertedKeyRow[]>`
      INSERT INTO gateway_api_keys (
        org_id, name, key_hash, key_prefix, policies,
        rpm_limit, batch_rpm_limit, cost_limit_monthly_rub,
        model_whitelist, ru_residency_only
      )
      VALUES (
        ${issuer.org_id}::uuid,
        ${body.name},
        ${hash},
        ${prefix},
        '{}'::jsonb,
        ${body.rpm_limit},
        ${body.batch_rpm_limit},
        ${body.cost_limit_monthly_rub}::numeric,
        ${tx.json(body.model_whitelist)}::jsonb,
        ${body.ru_residency_only}
      )
      RETURNING
        id::text, name, key_prefix, model_whitelist,
        cost_limit_monthly_rub::text, ru_residency_only,
        rpm_limit, batch_rpm_limit,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    `) as unknown as InsertedKeyRow[];
    const row = rows[0];
    if (!row) throw errors.unavailable('Key could not be created');

    // Audit, in the same transaction as the INSERT above: a key must never
    // exist without a record of who minted it. Carries ids and limits only —
    // never the plaintext key, never its hash.
    await tx`
      INSERT INTO usage_events (org_id, api_key_id, request_id, kind, payload)
      VALUES (
        ${issuer.org_id}::uuid,
        ${row.id}::uuid,
        ${null},
        'gateway_key_minted',
        ${tx.json({
          minted_key_id: row.id,
          key_prefix: row.key_prefix,
          minted_by_key_id: issuer.id,
          name: body.name,
          model_whitelist: body.model_whitelist,
          cost_limit_monthly_rub: body.cost_limit_monthly_rub,
          ru_residency_only: body.ru_residency_only,
        })}::jsonb
      )
    `;
    return row;
  });

  return { row: inserted, key };
}

organizationKeys.post('/keys', async (c) => {
  const issuer = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!issuer) throw errors.unauthorized();

  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined) throw errors.badRequest('JSON object body required');

  const body = clampToIssuer(parseCreateBody(raw), issuer);
  assertMayMint(issuer);

  let minted: { row: InsertedKeyRow; key: string };
  try {
    minted = await mintKey(issuer, body);
  } catch (e) {
    if (e instanceof Error && e.name === 'AiagError') throw e;
    // A failed insert must not tell the caller a key exists, and must not
    // echo the driver's message (it can contain the statement).
    throw errors.unavailable('Key could not be created');
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(
    {
      object: 'gateway_api_key',
      id: minted.row.id,
      name: minted.row.name,
      // Shown exactly once. There is no endpoint that returns it again.
      key: minted.key,
      key_prefix: minted.row.key_prefix,
      model_whitelist: minted.row.model_whitelist,
      cost_limit_monthly_rub:
        minted.row.cost_limit_monthly_rub === null
          ? null
          : Number(minted.row.cost_limit_monthly_rub),
      ru_residency_only: minted.row.ru_residency_only,
      rpm_limit: minted.row.rpm_limit,
      batch_rpm_limit: minted.row.batch_rpm_limit,
      created_at: minted.row.created_at,
    },
    201,
  );
});
