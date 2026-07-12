import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { getTemplate } from '@/lib/agent-templates';
import { encryptSecret, hintFromSecret } from '@/lib/crypto';
import { validateExternalUrl } from '@/lib/external-agent';
import {
  hasCreatorMembership,
  assertAgentQuota,
  QuotaExceededError,
  quotaExceededBody,
} from '@/lib/membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

interface AgentRow {
  id: string;
  tg_user_id: string;
  template_kind: string;
  name: string;
  description: string | null;
  system_prompt: string;
  tools: unknown;
  model_slug: string | null;
  // Multimodel per-role (migration 0042): optional per-role model overrides.
  image_model_slug?: string | null;
  voice_model_slug?: string | null;
  vision_model_slug?: string | null;
  budget_rub_monthly: string;
  daily_budget_credits?: string;
  status: string;
  created_at: string;
  updated_at: string;
  // Инбокс-превью: последний запуск агента (LEFT JOIN LATERAL agent_runs).
  last_output?: string | null;
  last_at?: string | null;
  last_status?: string | null;
  mcp_endpoint_url?: string | null;
}

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Инбокс-лента: к каждому агенту цепляем его последний запуск (вывод, время,
  // статус) через LEFT JOIN LATERAL, и сортируем по «последней активности»
  // (последний запуск ИЛИ дата создания), чтобы свежие диалоги были сверху.
  const rows = (await sql`
    SELECT a.id::text, a.tg_user_id::text, a.template_kind, a.name, a.description,
           a.system_prompt, a.tools, a.model_slug,
           a.image_model_slug, a.voice_model_slug, a.vision_model_slug,
           a.budget_credits_monthly::text AS budget_rub_monthly,
           a.status, a.created_at, a.updated_at, a.mcp_endpoint_url,
           r.output AS last_output, r.created_at AS last_at, r.status AS last_status
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT output, created_at, status
      FROM agent_runs
      WHERE agent_id = a.id
      ORDER BY created_at DESC
      LIMIT 1
    ) r ON true
    WHERE a.tg_user_id = ${tgUserId}::bigint
      AND a.status != 'deleted'
    ORDER BY COALESCE(r.created_at, a.created_at) DESC
  `) as unknown as AgentRow[];

  // ADDITIVE: нанятые агенты (active agent_sessions, но НЕ владелец). Изоляция
  // истории per-наниматель — превью (last_*) берём ТОЛЬКО из ПРОГОНОВ нанимателя
  // (r.tg_user_id = caller), а не из всей истории агента (OWASP LLM06).
  const hired = (await sql`
    SELECT a.id::text, a.tg_user_id::text, a.template_kind, a.name, a.description,
           a.system_prompt, a.tools, a.model_slug,
           a.image_model_slug, a.voice_model_slug, a.vision_model_slug,
           a.budget_credits_monthly::text AS budget_rub_monthly,
           a.status, a.created_at, a.updated_at, a.mcp_endpoint_url,
           r.output AS last_output, r.created_at AS last_at, r.status AS last_status
    FROM agent_sessions s
    JOIN agents a ON a.id = s.agent_id
    LEFT JOIN LATERAL (
      SELECT output, created_at, status
      FROM agent_runs
      WHERE agent_id = a.id
        AND tg_user_id = ${tgUserId}::bigint
      ORDER BY created_at DESC
      LIMIT 1
    ) r ON true
    WHERE s.hirer_tg_user_id = ${tgUserId}::bigint
      AND s.status = 'active'
      AND a.status = 'active'
      AND a.tg_user_id <> ${tgUserId}::bigint
    ORDER BY COALESCE(r.created_at, s.created_at) DESC
  `) as unknown as AgentRow[];

  return NextResponse.json({ agents: rows, hired });
}

interface CreateBody {
  template_kind?: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  tools?: unknown[];
  model_slug?: string;
  // Multimodel per-role (migration 0042): optional per-role model slugs. Empty/
  // missing ⇒ NULL ⇒ worker falls back to the primary model_slug.
  image_model_slug?: string;
  voice_model_slug?: string;
  vision_model_slug?: string;
  budget_rub_monthly?: number;
  // P1-7: daily spend cap, integer credits (the worker's daily guard column).
  // Mirrors the PATCH validation in [id]/route.ts: int 1..1_000_000.
  daily_budget_credits?: number;
  // "Свой агент" (Path 1, OpenAI-compatible external endpoint)
  connection_type?: 'aiag' | 'external_openai';
  external_base_url?: string;
  external_api_key?: string;
  external_model_slug?: string;
  // Provider picker (catalog BYOK): pick a seeded provider, bring your own key.
  // Resolves server-side to the external_openai path → ZERO commission.
  provider_id?: string;
  // MCP (skills): optional remote https MCP server + optional auth header value.
  mcp_endpoint_url?: string;
  mcp_auth?: string;
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Creator-membership gate (founder 2026-06-24): creating from scratch requires a
  // membership NFT. HIRE/CLONE routes are NOT gated. Fail-closed (no row → 403).
  if (!(await hasCreatorMembership(tgUserId, sql))) {
    return NextResponse.json({ error: 'membership_required' }, { status: 403 });
  }

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // SECURITY: a client may pick a seed kind (writer/coder/…) or 'personal', but must
  // NOT forge a clone-provenance kind 'tpl:<uuid>' — only the server-side clone/rent
  // routes stamp those. A forged tpl: kind would otherwise pass the rating-eligibility
  // guard (templates/[id]/rate) + fake fork-lineage, with no clone/rent. Strip it.
  const rawKind = (body.template_kind || 'personal').slice(0, 40);
  const templateKind = /^tpl:/i.test(rawKind) ? 'personal' : rawKind;
  const template = getTemplate(templateKind);

  const name = (body.name?.trim() || template?.name || 'Без имени').slice(0, 200);
  const description = body.description?.trim() || template?.description || null;
  const systemPrompt = (body.system_prompt?.trim() || template?.systemPrompt || '').slice(0, 8000);
  if (!systemPrompt) {
    return NextResponse.json({ error: 'system_prompt_required' }, { status: 400 });
  }
  const tools = Array.isArray(body.tools) ? body.tools : (template?.suggestedTools ?? []);
  const modelSlug = body.model_slug?.trim() || template?.defaultModelSlug || null;
  // Multimodel per-role: optional per-role slugs. Same handling as model_slug —
  // trim, empty ⇒ NULL. The UI picks them from the registered model registry (like
  // the primary model); an out-of-registry slug just falls back to OpenRouter via
  // the gateway exactly like the primary, so no white-label/markup change.
  const imageModelSlug = body.image_model_slug?.trim() || null;
  const voiceModelSlug = body.voice_model_slug?.trim() || null;
  const visionModelSlug = body.vision_model_slug?.trim() || null;
  const budget =
    typeof body.budget_rub_monthly === 'number' && body.budget_rub_monthly >= 0
      ? body.budget_rub_monthly
      : 1000;
  // P1-7: daily budget — integer credits, 1..1_000_000 (BIGINT column, worker
  // daily guard). Out-of-range/non-integer → the column default (10000 = $100).
  const dailyBudget =
    typeof body.daily_budget_credits === 'number' &&
    Number.isInteger(body.daily_budget_credits) &&
    body.daily_budget_credits >= 1 &&
    body.daily_budget_credits <= 1_000_000
      ? body.daily_budget_credits
      : 10_000;

  // ---- Provider / "Свой агент" (BYOK → external OpenAI-compatible upstream) ----
  // BOTH the catalog picker (provider_id) and the legacy raw endpoint
  // (connection_type='external_openai') land on the SAME external_openai path,
  // which the worker treats as the user's own provider → isExternal=true → ZERO
  // commission (founder rule: own key/provider = free). We deliberately do NOT
  // set the agents.provider_id column (that selects the worker's markup branch A);
  // this slice routes through the proven branch B and touches NO worker code.
  let connectionType: 'aiag' | 'external_openai' = 'aiag';
  let externalBaseUrl: string | null = null;
  let externalApiKeyEncrypted: Buffer | null = null;
  let externalApiKeyHint: string | null = null;
  let externalModelSlug: string | null = null;

  const providerId = body.provider_id?.trim();
  if (providerId) {
    // Catalog BYOK. Resolve the provider's base URL SERVER-SIDE for known
    // providers (never trust the client to name OpenAI's URL); the user only
    // supplies a base URL for the 'custom' sentinel (requires_base_url=true),
    // and that one is SSRF-validated.
    const prov = (await sql`
      SELECT id, api_base, requires_base_url
      FROM providers
      WHERE id = ${providerId} AND enabled = true
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
    connectionType = 'external_openai';
    externalBaseUrl = base;
    externalApiKeyEncrypted = encryptSecret(key);
    externalApiKeyHint = hintFromSecret(key);
    externalModelSlug = body.external_model_slug?.trim() || body.model_slug?.trim() || null;
  } else if (body.connection_type === 'external_openai') {
    connectionType = 'external_openai';
    const url = body.external_base_url?.trim() ?? '';
    const key = body.external_api_key?.trim() ?? '';
    if (!url) return NextResponse.json({ error: 'external_base_url_required' }, { status: 400 });
    if (!key) return NextResponse.json({ error: 'external_api_key_required' }, { status: 400 });
    const guard = validateExternalUrl(url);
    if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 400 });
    externalBaseUrl = url.replace(/\/+$/, '');
    externalApiKeyEncrypted = encryptSecret(key);
    externalApiKeyHint = hintFromSecret(key);
    externalModelSlug = body.external_model_slug?.trim() || null;
  }

  // MCP (skills): optional remote MCP server. URL gets the same https/SSRF
  // pre-check as external endpoints; the auth token (a header value like
  // "Bearer x") is AES-256-GCM encrypted (base64) — the worker decrypts at run.
  let mcpEndpointUrl: string | null = null;
  let mcpAuthEncrypted: string | null = null;
  const mcpUrl = body.mcp_endpoint_url?.trim();
  if (mcpUrl) {
    const mguard = validateExternalUrl(mcpUrl);
    if (!mguard.ok) return NextResponse.json({ error: `mcp_${mguard.reason}` }, { status: 400 });
    mcpEndpointUrl = mcpUrl.replace(/\/+$/, '');
    const mcpToken = body.mcp_auth?.trim();
    if (mcpToken) mcpAuthEncrypted = encryptSecret(mcpToken).toString('base64');
  }

  // Per-tier agent quota (issue #32): creator→1, builder→5, studio→20; NULL tier
  // (founder-seed) / no membership row → unlimited. The check and the INSERT run in
  // ONE transaction so the FOR UPDATE lock inside assertAgentQuota serializes
  // concurrent creates by the same user (see the helper's doc comment) — two parallel
  // requests at count = cap-1 cannot both pass. Server-side and before the INSERT, so
  // calling this endpoint directly (bypassing the UI) hits the exact same gate.
  let agent: AgentRow;
  try {
    agent = await sql.begin(async (tx) => {
      await assertAgentQuota(tgUserId, tx);

      const ins = (await tx`
        INSERT INTO agents (
          tg_user_id, template_kind, name, description,
          system_prompt, tools, model_slug,
          image_model_slug, voice_model_slug, vision_model_slug,
          budget_credits_monthly,
          daily_budget_credits,
          connection_type, external_base_url, external_api_key_encrypted,
          external_api_key_hint, external_model_slug,
          mcp_endpoint_url, mcp_auth_encrypted
        )
        VALUES (
          ${tgUserId}::bigint,
          ${templateKind},
          ${name},
          ${description},
          ${systemPrompt},
          ${tx.json(tools as never)},
          ${modelSlug},
          ${imageModelSlug},
          ${voiceModelSlug},
          ${visionModelSlug},
          ${budget},
          ${dailyBudget},
          ${connectionType},
          ${externalBaseUrl},
          ${externalApiKeyEncrypted},
          ${externalApiKeyHint},
          ${externalModelSlug},
          ${mcpEndpointUrl},
          ${mcpAuthEncrypted}
        )
        RETURNING id::text, tg_user_id::text, template_kind, name, description,
                  system_prompt, tools, model_slug,
                  image_model_slug, voice_model_slug, vision_model_slug,
                  budget_credits_monthly::text AS budget_rub_monthly,
                  daily_budget_credits::text,
                  status, created_at, updated_at, connection_type,
                  external_base_url, external_api_key_hint, external_model_slug
      `) as unknown as AgentRow[];

      return ins[0]!;
    });
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return NextResponse.json(quotaExceededBody(e), { status: 403 });
    }
    throw e;
  }

  return NextResponse.json({ agent }, { status: 201 });
}
