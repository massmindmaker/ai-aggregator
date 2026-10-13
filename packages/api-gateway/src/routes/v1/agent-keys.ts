/**
 * GET /v1/agent/keys + POST /v1/agent/keys/:id/rotate|revoke + POST
 * /v1/agent/revoke — headless agent key lifecycle (Task 7) and principal
 * self-revoke (spec §3 C1, phase-review ruling I-2).
 *
 * Mounted on the ROOT app behind requireApiKey + rateLimit exactly like
 * /v1/usage, /v1/organization and /v1/agent/topup (server.ts): orgId and
 * keyId always come from the fresh gateway_api_keys row, never from the
 * request. The public registration sub-app (agent-register) is mounted
 * earlier and carries no handlers for these paths, so its public contract
 * is untouched.
 *
 * ── Mint is NOT here ────────────────────────────────────────────────────────
 * Sub-key minting already works through POST /v1/organization/keys: the
 * bootstrap key carries policies {"kind":"agent","s2s_key_minting":true}.
 * Duplicating that flow would widen the credential surface for no gain.
 *
 * ── Rotate: the old plaintext dies in the same statement ────────────────────
 * Rotate replaces key_hash + key_prefix in ONE guarded UPDATE
 * (`WHERE id AND org_id AND revoked_at IS NULL AND disabled_at IS NULL
 * RETURNING`). There is no window where two plaintexts verify: the new hash
 * lands atomically with the old one's removal, and meta.rotated_from_hash
 * (0107) records the superseded hash for audit. The new plaintext is
 * returned in this ONE response and never stored — same custody contract as
 * every mint in this gateway. SELF-ROTATE IS ALLOWED AND FINAL: rotating the
 * key that authenticates this very request kills the current bearer — the
 * next request with it is a 401. That is the feature (a leaked-then-recovered
 * key retires itself), not a bug; a caller rotating its own key must persist
 * the response before doing anything else. Rotation deliberately does NOT
 * touch expires_at: it changes credentials, not lifetime policy (a TTL-bound
 * key cannot rotate itself into immortality — mint a successor key instead),
 * which also keeps the 0105 CHECK (expires_at > created_at) trivially intact.
 *
 * ── Revoke key ──────────────────────────────────────────────────────────────
 * Guarded UPDATE revoked_at=now(), disabled_at=now() WHERE live RETURNING.
 * Self-revoke is allowed. Foreign or already-dead ids match zero rows → 404,
 * indistinguishable from "does not exist" (no org enumeration).
 *
 * ── Revoke principal (§3 C1, ruling I-2) ────────────────────────────────────
 * POST /v1/agent/revoke with a live key of the agent org; body {} or
 * {confirm:true} (an entirely empty body is accepted as {}). Authentication
 * is the key itself — a possession factor transitively bound to the wallet,
 * because agent keys descend from the bootstrap key minted only after a
 * verified TON wallet proof (0104). No challenge/proof round trip. The 0107
 * SQL entrypoint aiag_revoke_agent_principal_v1 revokes the principal AND
 * every live key of the org in one transaction, which frees the wallet for a
 * fresh registration (partial unique agent_principals_active_address WHERE
 * status='active') — this closes the keyless lock-out. IDEMPOTENT: an
 * already-revoked principal returns 200 with the stored fact (keys_revoked
 * counts only the keys killed by THIS call; the branch is reachable only
 * through out-of-band principal revocation, since the first successful call
 * kills every key of the org).
 *
 * ── List ────────────────────────────────────────────────────────────────────
 * GET /v1/agent/keys returns the org's keys WITHOUT plaintext or key_hash:
 * {id,name,key_prefix,expires_at,created_at,last_used_at,revoked_at},
 * timestamps as ISO-8601 UTC (to_char projection — raw PG text never crosses
 * this boundary).
 *
 * ── Audit ───────────────────────────────────────────────────────────────────
 * rotate/revoke write a usage_events row in the SAME transaction as the
 * guarded UPDATE, carrying ids and prefixes only — never plaintext, never a
 * hash. Principal revoke is audited inside the SQL function
 * (audit_log 'agent.revoke').
 *
 * ── Error mapping, no internals leak ────────────────────────────────────────
 * ── Principal gate (review wave T-a1) ───────────────────────────────────────
 * Every op below first proves the key's org belongs to an ACTIVE agent
 * principal — the same predicate the 0106-0108 SQL entrypoints embed
 * (agent_principals.status='active' on the key's org). Without it a HUMAN
 * org's live key could drive the agent key lifecycle: rotate especially is
 * an agent-rail-only feature, and letting a dashboard key rotate its org's
 * credentials through it widens the credential surface of every human org.
 * Human org → 403 AGENT_NOT_AUTHORIZED, before any inventory read, UPDATE
 * or audit row; a lost gate row fails closed the same way.
 *
 *   AGENT_NOT_AUTHORIZED             → 403  (live key, but not an agent org)
 *   AGENT_PRINCIPAL_STATE_CONFLICT   → 409
 *   AGENT_REVOKE_UNAVAILABLE         → 503
 *   anything else                    → 400 generic / 500 INTERNAL
 * Driver/SQL text is never echoed.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import { sql, type SqlClient } from '../../lib/db';
import { AiagError, errors } from '../../lib/errors';
import { generateApiKey } from '../../lib/api-key';
import { revokeAgentPrincipal, AgentAuthError } from '@aiag/database';
import type { TonPaymentDatabase, TonSqlClient } from '@aiag/database';

export const agentKeys = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type KeyListRow = {
  id: string;
  name: string;
  key_prefix: string;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

// ── Principal gate (review wave T-a1; 0106-0108 predicate) ─────────────────
/**
 * The agent key lifecycle only ever acts for an org owned by an ACTIVE
 * agent principal. Throws 403 AGENT_NOT_AUTHORIZED otherwise — the same
 * verdict the SQL entrypoints (0106-0108) hand out — and fails closed on a
 * lost gate row. Runs as the FIRST statement of each operation's
 * transaction, ahead of any inventory read, UPDATE or audit write.
 */
async function requireActiveAgentOrg(
  orgId: string,
  tx: TransactionSql<Record<string, unknown>>,
): Promise<void> {
  const rows = (await tx<{ ok: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM agent_principals p
      WHERE p.org_id = ${orgId}::uuid
        AND p.status = 'active'
    ) AS ok
  `) as unknown as { ok: boolean }[];
  if (!rows[0] || rows[0].ok !== true) {
    throw new AiagError('AGENT_NOT_AUTHORIZED', 403, 'Agent principal not active');
  }
}

// ── GET /keys — org-scoped inventory, no secrets ────────────────────────────
async function listKeys(
  orgId: string,
  client: SqlClient = sql,
): Promise<KeyListRow[]> {
  return client.begin(async (tx) => {
    // Review wave T-a1: a human org's key gets 403 here, never a listing.
    await requireActiveAgentOrg(orgId, tx);

    // Only id/name/prefix/timestamps leave the table: key_hash, policies and
    // meta are deliberately not selected, so no response shape can leak them.
    // Timestamps render as ISO-8601 UTC (to_char, static text — the
    // organization-keys.ts precedent); to_char(NULL) is NULL, so optional
    // columns surface as JSON null. Raw PG timestamp text never crosses here.
    return (await tx<KeyListRow[]>`
      SELECT
        id::text,
        name,
        key_prefix,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_used_at,
        to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked_at
      FROM gateway_api_keys
      WHERE org_id = ${orgId}::uuid
      ORDER BY created_at DESC, id
    `) as unknown as KeyListRow[];
  });
}

agentKeys.get('/keys', async (c) => {
  const orgId = c.get('orgId' as never) as string | undefined;
  if (!orgId) throw errors.unauthorized();

  let rows: KeyListRow[];
  try {
    rows = await listKeys(orgId);
  } catch (e) {
    if (e instanceof AiagError) throw e;
    // No driver text: a listing failure is an availability issue, nothing else.
    throw errors.unavailable('Key inventory unavailable');
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json({ object: 'list', data: rows });
});

// ── POST /keys/:id/rotate — atomic credential replacement ───────────────────
type RotatedRow = { id: string; key_prefix: string };

async function rotateKey(
  orgId: string,
  keyId: string,
  issuer: { id: string },
  client: SqlClient = sql,
): Promise<{ row: RotatedRow | null; key: string }> {
  const { key, hash, prefix } = generateApiKey('live');

  const row = await client.begin(async (tx) => {
    // Review wave T-a1: rotate is an agent-rail-only feature — a human
    // org's key must be refused before any credential is replaced.
    await requireActiveAgentOrg(orgId, tx);

    // Guarded UPDATE: org + id + liveness in the WHERE, new material in the
    // SET, old hash preserved into meta.rotated_from_hash (right-side
    // key_hash is the OLD row value). One statement — no window where both
    // plaintexts verify.
    const rows = (await tx<RotatedRow[]>`
      UPDATE gateway_api_keys
      SET key_hash = ${hash},
          key_prefix = ${prefix},
          meta = jsonb_set(meta, '{rotated_from_hash}', to_jsonb(key_hash), true)
      WHERE id = ${keyId}::uuid
        AND org_id = ${orgId}::uuid
        AND revoked_at IS NULL
        AND disabled_at IS NULL
      RETURNING id::text, key_prefix
    `) as unknown as RotatedRow[];
    const updated = rows[0];
    if (!updated) return null;

    // Audit in the SAME transaction: ids and prefixes only — never the
    // plaintext, never a hash.
    await tx`
      INSERT INTO usage_events (org_id, api_key_id, request_id, kind, payload)
      VALUES (
        ${orgId}::uuid,
        ${updated.id}::uuid,
        ${null},
        'gateway_key_rotated',
        ${tx.json({
          rotated_key_id: updated.id,
          new_key_prefix: updated.key_prefix,
          rotated_by_key_id: issuer.id,
        })}::jsonb
      )
    `;
    return updated;
  });

  return { row, key };
}

agentKeys.post('/keys/:id/rotate', async (c) => {
  const orgId = c.get('orgId' as never) as string | undefined;
  const apiKey = c.get('apiKey' as never) as { id: string } | undefined;
  if (!orgId || !apiKey) throw errors.unauthorized();

  const keyId = c.req.param('id');
  if (!UUID.test(keyId)) throw errors.badRequest('Invalid key id');

  let rotated: { row: RotatedRow | null; key: string };
  try {
    rotated = await rotateKey(orgId, keyId, apiKey);
  } catch (e) {
    if (e instanceof AiagError) throw e;
    // Never echo the driver: it can carry the statement (and the new hash).
    throw errors.unavailable('Key could not be rotated');
  }
  if (!rotated.row) throw errors.notFound('Key not found');

  c.header('Cache-Control', 'private, no-store');
  return c.json(
    {
      id: rotated.row.id,
      // Shown exactly once; the old plaintext is dead from this moment.
      key: rotated.key,
      key_prefix: rotated.row.key_prefix,
    },
    200,
  );
});

// ── POST /keys/:id/revoke — retire one key ──────────────────────────────────
type RevokedRow = { id: string; revoked_at: string };

async function revokeKey(
  orgId: string,
  keyId: string,
  issuer: { id: string },
  client: SqlClient = sql,
): Promise<RevokedRow | null> {
  return client.begin(async (tx) => {
    // Review wave T-a1: same agent-org gate as list/rotate, first statement.
    await requireActiveAgentOrg(orgId, tx);

    // RETURNING sees the NEW revoked_at (= now()), rendered as ISO-8601 UTC.
    const rows = (await tx<RevokedRow[]>`
      UPDATE gateway_api_keys
      SET revoked_at = now(),
          disabled_at = now()
      WHERE id = ${keyId}::uuid
        AND org_id = ${orgId}::uuid
        AND revoked_at IS NULL
      RETURNING id::text,
        to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revoked_at
    `) as unknown as RevokedRow[];
    const updated = rows[0];
    if (!updated) return null;

    await tx`
      INSERT INTO usage_events (org_id, api_key_id, request_id, kind, payload)
      VALUES (
        ${orgId}::uuid,
        ${updated.id}::uuid,
        ${null},
        'gateway_key_revoked',
        ${tx.json({
          revoked_key_id: updated.id,
          revoked_by_key_id: issuer.id,
        })}::jsonb
      )
    `;
    return updated;
  });
}

agentKeys.post('/keys/:id/revoke', async (c) => {
  const orgId = c.get('orgId' as never) as string | undefined;
  const apiKey = c.get('apiKey' as never) as { id: string } | undefined;
  if (!orgId || !apiKey) throw errors.unauthorized();

  const keyId = c.req.param('id');
  if (!UUID.test(keyId)) throw errors.badRequest('Invalid key id');

  let revoked: RevokedRow | null;
  try {
    revoked = await revokeKey(orgId, keyId, apiKey);
  } catch (e) {
    if (e instanceof AiagError) throw e;
    throw errors.unavailable('Key could not be revoked');
  }
  if (!revoked) throw errors.notFound('Key not found');

  c.header('Cache-Control', 'private, no-store');
  return c.json({ id: revoked.id, revoked_at: revoked.revoked_at });
});

// ── POST /revoke — principal + every org key (§3 C1) ────────────────────────
// Same node-pg seam as agent-register/agent-topup: the 0107 SQL entrypoint
// owns every guard; this adapter only bounds statement waits.
const agentKeysDb: TonPaymentDatabase = {
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

/** `{}` or `{confirm:true}`; a fully empty body is accepted as `{}`. */
const principalRevokeSchema = z.union([
  z.object({}).strict(),
  z.object({ confirm: z.literal(true) }).strict(),
]);

async function readPrincipalRevokeBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw errors.badRequest('JSON object body required');
  }
}

function mapAgentRevokeError(e: AgentAuthError): AiagError {
  switch (e.code) {
    case 'AGENT_NOT_AUTHORIZED':
      return new AiagError('AGENT_NOT_AUTHORIZED', 403, 'Agent principal not active');
    case 'AGENT_PRINCIPAL_STATE_CONFLICT':
      return new AiagError('AGENT_PRINCIPAL_STATE_CONFLICT', 409, 'Agent principal state conflict');
    // Malformed 0107 entrypoint output: the rail is ours, so a bad shape is
    // unavailability — same contract as AGENT_AUTH_UNAVAILABLE (T4) and
    // AGENT_TOPUP_UNAVAILABLE (T6).
    case 'AGENT_REVOKE_UNAVAILABLE':
      return errors.unavailable('Agent revoke unavailable');
    default:
      return errors.badRequest('Invalid agent revoke request');
  }
}

agentKeys.post('/revoke', async (c) => {
  const apiKey = c.get('apiKey' as never) as { id: string } | undefined;
  if (!apiKey) throw errors.unauthorized();

  const parsed = principalRevokeSchema.safeParse(await readPrincipalRevokeBody(c));
  if (!parsed.success) throw errors.badRequest('Invalid agent revoke request');

  let revoked: Awaited<ReturnType<typeof revokeAgentPrincipal>>;
  try {
    revoked = await revokeAgentPrincipal(agentKeysDb, { keyId: apiKey.id });
  } catch (e) {
    if (e instanceof AgentAuthError) throw mapAgentRevokeError(e);
    if (e instanceof AiagError) throw e;
    throw e;
  }

  c.header('Cache-Control', 'private, no-store');
  // After this response every key of the org — including the bearer that
  // authorized it — is dead; the wallet may register afresh.
  return c.json({
    principal_id: revoked.principalId,
    revoked_at: revoked.revokedAt,
    keys_revoked: revoked.keysRevoked,
  });
});
