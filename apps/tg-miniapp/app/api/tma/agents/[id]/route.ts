import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { encryptSecret, hintFromSecret } from '@/lib/crypto';
import { validateExternalUrl } from '@/lib/external-agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgentRow {
  id: string;
  tg_user_id: string;
  template_kind: string;
  name: string;
  description: string | null;
  system_prompt: string;
  tools: unknown;
  model_slug: string | null;
  budget_rub_monthly: string;
  // Daily spend cap (credits) — the worker's getOrResetDailyBucket guard column
  // (migration 0020, renamed daily_budget_rub → daily_budget_credits in 0029).
  daily_budget_credits: string;
  status: string;
  created_at: string;
  updated_at: string;
  connection_type: string;
  external_base_url: string | null;
  external_api_key_hint: string | null;
  external_model_slug: string | null;
  mcp_endpoint_url: string | null;
  // Derived boolean (mcp_auth_encrypted IS NOT NULL) — never the encrypted token itself.
  mcp_auth_set: boolean;
  // Derived booleans — never the token. mcp_oauth_set = an agent_mcp_oauth row exists.
  mcp_oauth_set: boolean;
  mcp_oauth_scope: string | null;
  // Transfer state (plan 16-02). nft_owner_wallet + memory_owner_key NOT exposed here.
  transferable: boolean;
  transfer_price_credits: string | null;
  nft_address: string | null;
}

interface RunRow {
  id: string;
  input: string;
  output: string | null;
  status: string;
  cost_rub: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  // jsonb → already-parsed array via postgres-js. Empty [] for legacy runs.
  tool_calls: unknown;
}

async function loadAgent(id: string, tgUserId: string): Promise<AgentRow | null> {
  const rows = (await sql`
    SELECT id::text, tg_user_id::text, template_kind, name, description,
           system_prompt, tools, model_slug, budget_credits_monthly::text AS budget_rub_monthly,
           daily_budget_credits::text,
           status, created_at, updated_at,
           connection_type, external_base_url, external_api_key_hint,
           external_model_slug,
           mcp_endpoint_url,
           transferable,
           transfer_price_credits::text AS transfer_price_credits,
           nft_address,
           (mcp_auth_encrypted IS NOT NULL) AS mcp_auth_set,
           (o.agent_id IS NOT NULL) AS mcp_oauth_set,
           o.scope AS mcp_oauth_scope
    FROM agents
    LEFT JOIN agent_mcp_oauth o ON o.agent_id = agents.id
    WHERE agents.id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agent = await loadAgent(params.id, tgUserId);
  if (!agent) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // R2.1-A4: model rate for the pre-send cost hint (AIAG path only — BYOK is 0).
  // model_upstreams prices are in RUB per 1K tokens (web-product unit, seeds
  // 0004/0006); credits are US cents → ×100/USD_TO_RUB. Same constant family as
  // the worker's billing fallback. Display-only — settle stays authoritative.
  let modelRate: { in_per_1m_credits: string; out_per_1m_credits: string } | null = null;
  if (agent.connection_type === 'aiag' && agent.model_slug) {
    const rub = Number(process.env.USD_TO_RUB ?? '90');
    const rate = (await sql`
      SELECT ROUND(mu.price_per_1k_input  * mu.markup * 1000 * 100 / ${rub}, 2)::text AS in_per_1m_credits,
             ROUND(mu.price_per_1k_output * mu.markup * 1000 * 100 / ${rub}, 2)::text AS out_per_1m_credits
      FROM models m
      JOIN model_upstreams mu ON mu.model_id = m.id AND mu.enabled = true
      WHERE m.slug = ${agent.model_slug}
      ORDER BY mu.price_per_1k_input ASC, mu.created_at ASC
      LIMIT 1
    `) as unknown as Array<{ in_per_1m_credits: string; out_per_1m_credits: string }>;
    modelRate = rate[0] ?? null;
  }

  const runs = (await sql`
    SELECT id::text, input, output, status, cost_credits::text AS cost_rub, error,
           created_at, completed_at, tool_calls
    FROM agent_runs
    WHERE agent_id = ${params.id}::uuid
    ORDER BY created_at DESC
    LIMIT 20
  `) as unknown as RunRow[];

  return NextResponse.json({ agent, runs, model_rate: modelRate });
}

interface PatchBody {
  name?: string;
  description?: string;
  system_prompt?: string;
  tools?: unknown[];
  model_slug?: string;
  budget_rub_monthly?: number;
  // C10: daily spend cap, integer credits (the worker's daily guard column).
  daily_budget_credits?: number;
  // Connection editing (opt-in). provider_id → BYOK via catalog (external_openai,
  // 0 commission). reset_connection → back to the AIAG gateway. Neither → unchanged.
  provider_id?: string;
  external_api_key?: string;
  external_base_url?: string;
  external_model_slug?: string;
  reset_connection?: boolean;
  // MCP (skills) editing (opt-in). mcp_endpoint_url present → set/replace the remote
  // MCP server (+ optional mcp_auth token). reset_mcp → clear both columns. Neither →
  // MCP columns untouched.
  mcp_endpoint_url?: string;
  mcp_auth?: string;
  reset_mcp?: boolean;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const existing = await loadAgent(params.id, tgUserId);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const name = body.name?.trim() ? body.name.trim().slice(0, 200) : existing.name;
  const description =
    body.description !== undefined ? (body.description?.trim() || null) : existing.description;
  const systemPrompt = body.system_prompt?.trim()
    ? body.system_prompt.trim().slice(0, 8000)
    : existing.system_prompt;
  const tools = Array.isArray(body.tools) ? body.tools : (existing.tools as unknown[]);
  const modelSlug =
    body.model_slug !== undefined ? (body.model_slug?.trim() || null) : existing.model_slug;
  const budget =
    typeof body.budget_rub_monthly === 'number' && body.budget_rub_monthly >= 0
      ? body.budget_rub_monthly
      : Number(existing.budget_rub_monthly);
  // C10: daily budget — integer credits, 1..1_000_000 (BIGINT column, worker
  // daily guard). Out-of-range/non-integer → keep the existing value.
  const dailyBudget =
    typeof body.daily_budget_credits === 'number' &&
    Number.isInteger(body.daily_budget_credits) &&
    body.daily_budget_credits >= 1 &&
    body.daily_budget_credits <= 1_000_000
      ? body.daily_budget_credits
      : Number(existing.daily_budget_credits);

  // ---- Connection editing (opt-in) ----
  // Mirrors the create route: BYOK via the catalog routes through external_openai
  // (worker isExternal=true → 0 commission); we NEVER set agents.provider_id (that
  // selects the markup branch). reset_connection puts the agent back on the AIAG
  // gateway. Neither → connection columns untouched.
  let changeConn = false;
  let newConnType: 'aiag' | 'external_openai' = 'aiag';
  let newExtBase: string | null = null;
  let newExtKeyEnc: Buffer | null = null;
  let newExtKeyHint: string | null = null;
  let newExtModel: string | null = null;

  const providerId = body.provider_id?.trim();
  if (body.reset_connection === true) {
    changeConn = true; // → aiag gateway, clear external_* (defaults above)
  } else if (providerId) {
    changeConn = true;
    const prov = (await sql`
      SELECT id, api_base, requires_base_url
      FROM providers WHERE id = ${providerId} AND enabled = true
    `) as unknown as Array<{ id: string; api_base: string | null; requires_base_url: boolean }>;
    if (prov.length === 0) {
      return NextResponse.json({ error: 'unknown_provider' }, { status: 400 });
    }
    const key = body.external_api_key?.trim() ?? '';
    if (!key) return NextResponse.json({ error: 'external_api_key_required' }, { status: 400 });
    let base: string;
    if (prov[0].requires_base_url) {
      const url = body.external_base_url?.trim() ?? '';
      if (!url) return NextResponse.json({ error: 'external_base_url_required' }, { status: 400 });
      const guard = validateExternalUrl(url);
      if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 400 });
      base = url.replace(/\/+$/, '');
    } else {
      base = (prov[0].api_base ?? '').replace(/\/+$/, '');
      if (!base) return NextResponse.json({ error: 'provider_misconfigured' }, { status: 400 });
    }
    newConnType = 'external_openai';
    newExtBase = base;
    newExtKeyEnc = encryptSecret(key);
    newExtKeyHint = hintFromSecret(key);
    newExtModel = body.external_model_slug?.trim() || modelSlug || null;
  }

  const setConn = changeConn
    ? sql`,
        connection_type = ${newConnType},
        external_base_url = ${newExtBase},
        external_api_key_encrypted = ${newExtKeyEnc},
        external_api_key_hint = ${newExtKeyHint},
        external_model_slug = ${newExtModel}`
    : sql``;

  // ---- MCP (skills) editing (opt-in) ----
  // Mirrors the create route: a new mcp_endpoint_url is https/SSRF-validated and the
  // optional auth token is AES-256-GCM base64 (same crypto as BYOK keys). reset_mcp
  // clears both columns. Neither → MCP columns left untouched. Touches NO money path.
  let changeMcp = false;
  let newMcpUrl: string | null = null;
  let newMcpAuthEnc: string | null = null;

  const mcpUrl = body.mcp_endpoint_url?.trim();
  if (body.reset_mcp === true) {
    changeMcp = true; // → clear both (defaults above are null)
    // Detaching MCP also revokes any stored OAuth token for this agent.
    await sql`DELETE FROM agent_mcp_oauth WHERE agent_id = ${params.id}::uuid`;
  } else if (mcpUrl) {
    changeMcp = true;
    const mguard = validateExternalUrl(mcpUrl);
    if (!mguard.ok) return NextResponse.json({ error: `mcp_${mguard.reason}` }, { status: 400 });
    newMcpUrl = mcpUrl.replace(/\/+$/, '');
    const mcpToken = body.mcp_auth?.trim();
    if (mcpToken) newMcpAuthEnc = encryptSecret(mcpToken).toString('base64');
  }

  const setMcp = changeMcp
    ? sql`,
        mcp_endpoint_url = ${newMcpUrl},
        mcp_auth_encrypted = ${newMcpAuthEnc}`
    : sql``;

  const upd = (await sql`
    UPDATE agents
    SET name = ${name},
        description = ${description},
        system_prompt = ${systemPrompt},
        tools = ${sql.json(tools as never)},
        model_slug = ${modelSlug},
        budget_credits_monthly = ${budget},
        daily_budget_credits = ${dailyBudget},
        updated_at = NOW()${setConn}${setMcp}
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
    RETURNING id::text, tg_user_id::text, template_kind, name, description,
              system_prompt, tools, model_slug, budget_credits_monthly::text AS budget_rub_monthly,
              daily_budget_credits::text,
              status, created_at, updated_at,
              connection_type, external_base_url, external_api_key_hint,
              external_model_slug,
              mcp_endpoint_url,
              (mcp_auth_encrypted IS NOT NULL) AS mcp_auth_set,
              EXISTS (SELECT 1 FROM agent_mcp_oauth o WHERE o.agent_id = agents.id) AS mcp_oauth_set,
              (SELECT o.scope FROM agent_mcp_oauth o WHERE o.agent_id = agents.id) AS mcp_oauth_scope
  `) as unknown as AgentRow[];

  return NextResponse.json({ agent: upd[0] });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const res = (await sql`
    DELETE FROM agents
    WHERE id = ${params.id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  if (!res[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
