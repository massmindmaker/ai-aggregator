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
  // Direct-clone opt-in (2026-06-12): owner allows others to clone this agent's
  // spec via POST …/agents/[id]/clone. Spec-only; no secrets/memory copied.
  cloneable: boolean;
  // Аренда = месячная подписка (founder 2026-06-14). NULL во всех полях = агент
  // создан НЕ через аренду (обычный клон/с нуля) → подписочной плашки нет.
  // Все поля приходят из активной template_rentals(rent_period='month') клона.
  sub_template_id: string | null;       // для продления (POST templates/[id]/rent)
  sub_price_credits: string | null;     // месячная цена подписки (US cents)
  sub_monthly_limit_credits: string | null; // месячный лимит, входящий в цену
  sub_period_end: string | null;        // дата продления (ISO)
  sub_expired: boolean;                 // период истёк (доступ к запуску лапснут)
  sub_spent_period_credits: string | null;  // потрачено в текущем периоде
}

// Hire-aware view flags (ADDITIVE). The page renders owner vs hired vs other from
// these — never from the row's tg_user_id (which is not exposed to non-owners).
interface AgentView extends AgentRow {
  // Caller is the agent owner (tg_user_id === caller).
  is_owner: boolean;
  // Caller has an ACTIVE agent_sessions row for this agent (hired, not owner).
  hired: boolean;
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
    SELECT agents.id::text, agents.tg_user_id::text, agents.template_kind, agents.name, agents.description,
           agents.system_prompt, agents.tools, agents.model_slug, agents.budget_credits_monthly::text AS budget_rub_monthly,
           agents.daily_budget_credits::text,
           agents.status, agents.created_at, agents.updated_at,
           agents.connection_type, agents.external_base_url, agents.external_api_key_hint,
           agents.external_model_slug,
           agents.mcp_endpoint_url,
           agents.transferable,
           agents.transfer_price_credits::text AS transfer_price_credits,
           agents.nft_address,
           agents.cloneable,
           (agents.mcp_auth_encrypted IS NOT NULL) AS mcp_auth_set,
           (o.agent_id IS NOT NULL) AS mcp_oauth_set,
           o.scope AS mcp_oauth_scope,
           r.template_id::text AS sub_template_id,
           r.price_credits::text AS sub_price_credits,
           r.monthly_limit_credits::text AS sub_monthly_limit_credits,
           r.period_end::text AS sub_period_end,
           (r.period_end IS NOT NULL AND r.period_end <= NOW()) AS sub_expired,
           (
             SELECT COALESCE(SUM(ar.cost_credits), 0)::text
             FROM agent_runs ar
             WHERE ar.agent_id = agents.id
               AND r.period_start IS NOT NULL
               AND ar.created_at >= r.period_start
           ) AS sub_spent_period_credits
    FROM agents
    LEFT JOIN agent_mcp_oauth o ON o.agent_id = agents.id
    LEFT JOIN template_rentals r
      ON r.cloned_agent_id = agents.id
     AND r.status = 'active'
     AND r.rent_period = 'month'
    WHERE agents.id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

// Hire-aware read: an agent's detail page is visible to (a) its OWNER, (b) a HIRER
// with an active agent_sessions row, or (c) any logged-in user viewing an ACTIVE
// agent they could hire. For non-owners we strip owner-only/secret-derived columns
// (keys/hints/budget/MCP/transfer) → a public spec view + the "Нанять" CTA. The
// owner branch returns EXACTLY the same shape as before (loadAgent) + the two flags.
async function loadAgentForViewer(id: string, tgUserId: string): Promise<AgentView | null> {
  // Owner path is unchanged — same query, same columns the page already relied on.
  const owned = await loadAgent(id, tgUserId);
  if (owned) return { ...owned, is_owner: true, hired: false };

  // Not the owner. Show the agent if it's active (so it can be hired / is hired).
  const rows = (await sql`
    SELECT agents.id::text, agents.tg_user_id::text, agents.template_kind, agents.name,
           agents.description, agents.system_prompt, agents.tools, agents.model_slug,
           agents.budget_credits_monthly::text AS budget_rub_monthly,
           agents.daily_budget_credits::text,
           agents.status, agents.created_at, agents.updated_at,
           agents.connection_type,
           agents.cloneable,
           (s.id IS NOT NULL) AS hired
    FROM agents
    LEFT JOIN agent_sessions s
      ON s.agent_id = agents.id
     AND s.hirer_tg_user_id = ${tgUserId}::bigint
     AND s.status = 'active'
    WHERE agents.id = ${id}::uuid
      AND agents.status = 'active'
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    tg_user_id: string;
    template_kind: string;
    name: string;
    description: string | null;
    system_prompt: string;
    tools: unknown;
    model_slug: string | null;
    budget_rub_monthly: string;
    daily_budget_credits: string;
    status: string;
    created_at: string;
    updated_at: string;
    connection_type: string;
    cloneable: boolean;
    hired: boolean;
  }>;
  const r = rows[0];
  if (!r) return null;

  // Public/hirer view: never leak the owner id or any secret-derived column.
  return {
    id: r.id,
    tg_user_id: '', // hidden for non-owners
    template_kind: r.template_kind,
    name: r.name,
    description: r.description,
    system_prompt: r.system_prompt,
    tools: r.tools,
    model_slug: r.model_slug,
    budget_rub_monthly: r.budget_rub_monthly,
    daily_budget_credits: r.daily_budget_credits,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    connection_type: r.connection_type,
    external_base_url: null,
    external_api_key_hint: null,
    external_model_slug: null,
    mcp_endpoint_url: null,
    mcp_auth_set: false,
    mcp_oauth_set: false,
    mcp_oauth_scope: null,
    transferable: false,
    transfer_price_credits: null,
    nft_address: null,
    cloneable: r.cloneable,
    sub_template_id: null,
    sub_price_credits: null,
    sub_monthly_limit_credits: null,
    sub_period_end: null,
    sub_expired: false,
    sub_spent_period_credits: null,
    is_owner: false,
    hired: r.hired,
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const agent = await loadAgentForViewer(params.id, tgUserId);
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

  // History isolation (OWASP LLM06, SECURITY.md): the OWNER sees the full run
  // history; a HIRER / public viewer sees ONLY their own runs (tg_user_id = caller).
  // The owner branch keeps the prior behaviour (no tg_user_id filter).
  const runs = (
    agent.is_owner
      ? await sql`
          SELECT id::text, input, output, status, cost_credits::text AS cost_rub, error,
                 created_at, completed_at, tool_calls
          FROM agent_runs
          WHERE agent_id = ${params.id}::uuid
          ORDER BY created_at DESC
          LIMIT 20
        `
      : await sql`
          SELECT id::text, input, output, status, cost_credits::text AS cost_rub, error,
                 created_at, completed_at, tool_calls
          FROM agent_runs
          WHERE agent_id = ${params.id}::uuid
            AND tg_user_id = ${tgUserId}::bigint
          ORDER BY created_at DESC
          LIMIT 20
        `
  ) as unknown as RunRow[];

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
  // Direct-clone opt-in toggle (2026-06-12). Spec-data column only, no money path.
  cloneable?: boolean;
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

  // Direct-clone opt-in: only a boolean flips it; anything else keeps the current value.
  const cloneable =
    typeof body.cloneable === 'boolean' ? body.cloneable : existing.cloneable;

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
        cloneable = ${cloneable},
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
              cloneable,
              (mcp_auth_encrypted IS NOT NULL) AS mcp_auth_set,
              EXISTS (SELECT 1 FROM agent_mcp_oauth o WHERE o.agent_id = agents.id) AS mcp_oauth_set,
              (SELECT o.scope FROM agent_mcp_oauth o WHERE o.agent_id = agents.id) AS mcp_oauth_scope,
              (SELECT tr.template_id::text FROM template_rentals tr
                 WHERE tr.cloned_agent_id = agents.id AND tr.status = 'active'
                   AND tr.rent_period = 'month' LIMIT 1) AS sub_template_id,
              (SELECT tr.price_credits::text FROM template_rentals tr
                 WHERE tr.cloned_agent_id = agents.id AND tr.status = 'active'
                   AND tr.rent_period = 'month' LIMIT 1) AS sub_price_credits,
              (SELECT tr.monthly_limit_credits::text FROM template_rentals tr
                 WHERE tr.cloned_agent_id = agents.id AND tr.status = 'active'
                   AND tr.rent_period = 'month' LIMIT 1) AS sub_monthly_limit_credits,
              (SELECT tr.period_end::text FROM template_rentals tr
                 WHERE tr.cloned_agent_id = agents.id AND tr.status = 'active'
                   AND tr.rent_period = 'month' LIMIT 1) AS sub_period_end,
              false AS sub_expired,
              null AS sub_spent_period_credits
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
