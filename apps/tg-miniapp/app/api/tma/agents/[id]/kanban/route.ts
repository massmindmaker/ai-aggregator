import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { decryptSecret } from '@/lib/crypto';
import { safeFetch } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * READ-ONLY Hermes-kanban poller.
 *
 * Concept (founder insight, validated by docs/specs/research/2026-06-04-hermes-updates.md):
 * we do NOT run Hermes. A user runs `NousResearch/hermes-agent` on their own VPS
 * and connects it to us as an external OpenAI-compatible provider. Hermes exposes
 * a local dashboard (default `:9119`) whose kanban plugin serves readable HTTP
 * endpoints. We poll those endpoints SERVER-SIDE and render a board. Nothing here
 * writes to Hermes or touches the money path.
 *
 * Hermes endpoint shapes (from plugins/kanban/dashboard/plugin_api.py @ main,
 * fetched 2026-06-04):
 *   GET /api/plugins/kanban/board
 *     → { columns: [{ name, tasks: [Task...] }], tenants, assignees,
 *         latest_event_id, now }
 *       Task = { id, title, body, assignee, status, priority, created_at,
 *                started_at, completed_at, latest_summary, link_counts,
 *                comment_count, progress {done,total}|null, age, worker_pid, … }
 *       BOARD_COLUMNS = triage,todo,scheduled,ready,running,blocked,review,done
 *   GET /api/plugins/kanban/workers/active
 *     → { workers: [{ run_id, task_id, task_title, task_status, task_assignee,
 *         profile, worker_pid, started_at, last_heartbeat_at, … }], count,
 *         checked_at }
 * Auth: a per-process session token, accepted as `X-Hermes-Session-Token: <t>`
 * or `Authorization: Bearer <t>`. We send the agent's stored key as both so a
 * Hermes configured with either scheme is reachable; an open dashboard ignores
 * them.
 *
 * Because Hermes's dashboard port differs from its OpenAI chat port, the host is
 * known but the port/scheme are not guaranteed. We derive the dashboard origin
 * from the agent's `external_base_url` host and allow an explicit `?hermes_url=`
 * override (still SSRF-validated, still pinned to the agent's own host). On any
 * unreachable / timeout / bad-shape outcome we return a graceful
 * `{ error: 'hermes_unreachable' }` (HTTP 200) — never a 500 — so the UI can show
 * an honest "недоступен" state instead of crashing.
 */

const FETCH_TIMEOUT_MS = 6000;
const KANBAN_API_PREFIX = '/api/plugins/kanban';

interface AgentConnRow {
  id: string;
  connection_type: string;
  external_base_url: string | null;
  external_api_key_encrypted: Buffer | null;
}

interface NormalizedTask {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  priority: number | null;
  summary: string | null;
  comment_count: number | null;
  progress: { done: number; total: number } | null;
  worker_pid: number | null;
}

interface NormalizedWorker {
  run_id: number | string;
  task_id: string;
  task_title: string | null;
  profile: string | null;
  worker_pid: number | null;
  started_at: number | null;
}

interface KanbanResult {
  columns: Array<{ name: string; tasks: NormalizedTask[] }>;
  workers: NormalizedWorker[];
  checked_at: number;
}

async function loadAgentConn(id: string, tgUserId: string): Promise<AgentConnRow | null> {
  const rows = (await sql`
    SELECT id::text, connection_type, external_base_url, external_api_key_encrypted
    FROM agents
    WHERE id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as AgentConnRow[];
  return rows[0] ?? null;
}

/**
 * Derive the Hermes dashboard origin to poll. The agent's external_base_url is
 * the OpenAI-compatible chat URL (e.g. https://host:8642/v1). The kanban API
 * lives on the dashboard server (default :9119), same host. We use the host's
 * origin as the default; if the user pinned the chat URL to the dashboard port
 * too, that origin already works. An explicit override URL may be passed but is
 * constrained to the SAME host as external_base_url (no cross-host pivot).
 */
function deriveHermesOrigins(externalBaseUrl: string, override: string | null): string[] {
  let baseHost: string;
  try {
    baseHost = new URL(externalBaseUrl).hostname.toLowerCase();
  } catch {
    return [];
  }

  const candidates: string[] = [];

  if (override) {
    try {
      const ov = new URL(override);
      // Only honor an override that targets the agent's own Hermes host.
      if (ov.hostname.toLowerCase() === baseHost) {
        candidates.push(ov.origin);
      }
    } catch {
      /* ignore malformed override */
    }
  }

  try {
    candidates.push(new URL(externalBaseUrl).origin);
  } catch {
    /* unreachable: parsed above */
  }

  // De-dupe, preserve order.
  return Array.from(new Set(candidates));
}

/**
 * Fetch one kanban endpoint with the FULL SSRF guard, short timeout.
 *
 * We deliberately do NOT pass an `allowlist` (which would bypass HTTPS + IP
 * checks): the agent's Hermes is a public HTTPS host already vetted at
 * write-time by validateExternalUrl, so safeFetch's HTTPS-only + DNS-resolve +
 * reject-private-IP + per-hop re-validation must all apply here too. This closes
 * the DNS-rebind / redirect-to-internal window even though the host is "ours".
 */
async function fetchHermes(url: string, bearer: string | null): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
      headers['x-hermes-session-token'] = bearer;
    }
    const res = await safeFetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
      maxRedirects: 2,
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as unknown;
  } catch {
    // SsrfError, abort/timeout, DNS, connection refused → treat as unreachable.
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------------------- defensive parsers --------------------------- */
// Hermes shapes are documented but we never trust them blindly — every field is
// read defensively so a schema drift renders partial data instead of throwing.

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeTask(raw: unknown): NormalizedTask | null {
  const o = asObj(raw);
  if (!o) return null;
  const id = asStr(o.id);
  if (!id) return null;
  const prog = asObj(o.progress);
  return {
    id,
    title: asStr(o.title) ?? '(без названия)',
    assignee: asStr(o.assignee),
    status: asStr(o.status) ?? 'todo',
    priority: asNum(o.priority),
    summary: asStr(o.latest_summary) ?? asStr(o.result) ?? asStr(o.summary),
    comment_count: asNum(o.comment_count),
    progress:
      prog && asNum(prog.done) !== null && asNum(prog.total) !== null
        ? { done: asNum(prog.done)!, total: asNum(prog.total)! }
        : null,
    worker_pid: asNum(o.worker_pid),
  };
}

function normalizeBoard(raw: unknown): Array<{ name: string; tasks: NormalizedTask[] }> {
  const o = asObj(raw);
  if (!o) return [];
  return asArr(o.columns)
    .map((col) => {
      const c = asObj(col);
      if (!c) return null;
      const name = asStr(c.name);
      if (!name) return null;
      const tasks = asArr(c.tasks)
        .map(normalizeTask)
        .filter((x): x is NormalizedTask => x !== null);
      return { name, tasks };
    })
    .filter((x): x is { name: string; tasks: NormalizedTask[] } => x !== null);
}

function normalizeWorkers(raw: unknown): NormalizedWorker[] {
  const o = asObj(raw);
  if (!o) return [];
  return asArr(o.workers)
    .map((w) => {
      const wo = asObj(w);
      if (!wo) return null;
      const taskId = asStr(wo.task_id);
      if (!taskId) return null;
      const runId = asNum(wo.run_id) ?? asStr(wo.run_id);
      return {
        run_id: runId ?? '',
        task_id: taskId,
        task_title: asStr(wo.task_title),
        profile: asStr(wo.profile),
        worker_pid: asNum(wo.worker_pid),
        started_at: asNum(wo.started_at),
      };
    })
    .filter((x): x is NormalizedWorker => x !== null);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agent = await loadAgentConn(params.id, tgUserId);
  if (!agent) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Kanban is ONLY meaningful for a connected external Hermes. For any other
  // connection type we return an honest, non-error "not a connected Hermes".
  if (agent.connection_type !== 'external_openai' || !agent.external_base_url) {
    return NextResponse.json({ error: 'not_connected_hermes' }, { status: 200 });
  }

  const override = req.nextUrl.searchParams.get('hermes_url');
  const origins = deriveHermesOrigins(agent.external_base_url, override);
  if (origins.length === 0) {
    return NextResponse.json({ error: 'hermes_unreachable' }, { status: 200 });
  }

  let bearer: string | null = null;
  if (agent.external_api_key_encrypted) {
    try {
      bearer = decryptSecret(agent.external_api_key_encrypted);
    } catch {
      bearer = null; // key undecryptable → still try open-dashboard reachability
    }
  }

  // Try each candidate origin until one answers the board endpoint.
  for (const origin of origins) {
    const boardRaw = await fetchHermes(`${origin}${KANBAN_API_PREFIX}/board`, bearer);
    if (boardRaw === null) continue; // this origin unreachable → try next

    const columns = normalizeBoard(boardRaw);
    // Workers is best-effort; a missing/again-unreachable workers endpoint must
    // not blank the board we already have.
    const workersRaw = await fetchHermes(
      `${origin}${KANBAN_API_PREFIX}/workers/active`,
      bearer,
    );
    const workers = normalizeWorkers(workersRaw);

    const result: KanbanResult = {
      columns,
      workers,
      checked_at: Math.floor(Date.now() / 1000),
    };
    return NextResponse.json(result, { status: 200 });
  }

  // Nothing answered.
  return NextResponse.json({ error: 'hermes_unreachable' }, { status: 200 });
}
