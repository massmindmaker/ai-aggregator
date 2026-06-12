import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Default monthly budget for a cloned agent (US cents). $100/mo — same as the
// template clone default so both clone paths start identically.
const DEFAULT_BUDGET_CREDITS = 10_000;

// The shareable spec we copy into the new agent. We SELECT only spec columns and
// never the secret/memory/history columns (external_*/mcp_auth_encrypted/runs);
// the clone wires their own keys/provider afterwards via PATCH …/agents/[id].
interface AgentSpecRow {
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
}

// POST /api/tma/agents/[id]/clone — clone a SPECIFIC agent into a fresh agent
// owned by the caller. Allowed ONLY if the source agent has cloneable=true
// (owner opt-in); any other agent → 403. Copies the spec only; every
// external_*/mcp_auth_encrypted secret column is left at its NULL default
// (connection_type='aiag'), and the clone gets its own clean memory/history
// (new agent_id → no agent_runs). Mirrors the template clone isolation.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  // Load the spec of any non-deleted, cloneable agent (cross-user — that's the
  // point: you clone someone else's opted-in agent). We DO NOT filter by owner.
  const rows = (await sql`
    SELECT name, description, system_prompt, model_slug, tools, mcp_endpoint_url
    FROM agents
    WHERE id = ${params.id}::uuid
      AND status != 'deleted'
      AND cloneable = true
    LIMIT 1
  `) as unknown as AgentSpecRow[];

  const src = rows[0] ?? null;
  // Not found OR not opted-in: report 403 when the agent exists but is private,
  // 404 when it doesn't exist at all. Distinguish without leaking the spec.
  if (!src) {
    const exists = (await sql`
      SELECT 1 FROM agents WHERE id = ${params.id}::uuid AND status != 'deleted' LIMIT 1
    `) as unknown as Array<{ '?column?': number }>;
    return exists.length > 0
      ? NextResponse.json({ error: 'not_cloneable' }, { status: 403 })
      : NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // template_kind references the source agent (VARCHAR(40)): "agent:<uuid>" fits in 40.
  const templateKind = `agent:${params.id}`.slice(0, 40);
  const name = (src.name ?? 'Без имени').slice(0, 200);
  const systemPrompt = (src.system_prompt ?? '').slice(0, 8000);
  const tools = Array.isArray(src.tools) ? src.tools : [];

  // connection_type='aiag' (caller wires their own keys/provider later); every
  // external_*/mcp_auth secret column is left at its NULL default — no secret copied.
  const ins = (await sql`
    INSERT INTO agents (
      tg_user_id, template_kind, name, description,
      system_prompt, tools, model_slug, budget_credits_monthly,
      connection_type, mcp_endpoint_url
    )
    VALUES (
      ${tgUserId}::bigint,
      ${templateKind},
      ${name},
      ${src.description},
      ${systemPrompt},
      ${sql.json(tools as never)},
      ${src.model_slug},
      ${DEFAULT_BUDGET_CREDITS},
      'aiag',
      ${src.mcp_endpoint_url}
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  return NextResponse.json({ agent_id: ins[0]!.id }, { status: 201 });
}
