import { NextRequest, NextResponse } from 'next/server';
import { safeFetch } from '@/lib/safe-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/tma/agents/ai-builder
 * Body: { description: string }
 *
 * AI-builder — "создать агента из слов". Takes a free-text description and asks a
 * cheap model to emit a strict agent SPEC the /agents/new form pre-fills. The user
 * then reviews + edits before saving (this route NEVER persists an agent).
 *
 * Billing: this generation is HOUSE-FUNDED — it is NOT an agent run, so it does NOT
 * touch settleRun / the credit ledger / any debit. It just calls the gateway like a
 * plain OpenAI-compatible client. Mirrors the worker's gateway call shape
 * (apps/agent-worker/src/agent-runner.ts): POST http://127.0.0.1:4000/v1/chat/completions
 * with Bearer AIAG_GATEWAY_KEY. 127.0.0.1:4000 is the trusted internal gateway, so we
 * pass it through the same SSRF allowlist safeFetch uses there.
 */

const AIAG_GATEWAY_URL = 'http://127.0.0.1:4000/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SAFE_FETCH_ALLOWLIST = ['127.0.0.1:4000', 'openrouter.ai'];

// Generation model — cheap + registered in the prod gateway model registry.
const BUILDER_MODEL = 'openai/gpt-4o-mini';

// Models the builder is allowed to assign to the generated agent (must be in the
// prod `models` table — an unregistered slug would silently fall back to OpenRouter).
const ALLOWED_AGENT_MODELS = new Set(['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-6']);
const ALLOWED_TOOLS = new Set(['web_search', 'calc', 'image_gen', 'memory']);

const SYSTEM_PROMPT =
  'Ты конструктор AI-агентов. По описанию пользователя верни СТРОГО JSON ' +
  '{name, role, system_prompt, model_slug, tools} где tools — подмножество ' +
  '[web_search, calc, image_gen, memory]. name краткое русское, role 2-4 слова, ' +
  'system_prompt — персона+задача на русском, model_slug — из зарегистрированных: ' +
  'openai/gpt-4o-mini (дёшево) или anthropic/claude-sonnet-4-6 (сложное). ' +
  'Только JSON, без markdown.';

interface AgentSpec {
  name: string;
  role: string;
  system_prompt: string;
  model_slug: string;
  tools: string[];
}

interface ModelResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** Strip ```json … ``` (or bare ```) fences a model might wrap the JSON in. */
function stripFences(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  return s;
}

/** Validate + normalize the model's JSON into a safe AgentSpec, or null. */
function normalizeSpec(parsed: unknown): AgentSpec | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 200) : '';
  const role = typeof p.role === 'string' ? p.role.trim().slice(0, 80) : '';
  const systemPrompt =
    typeof p.system_prompt === 'string' ? p.system_prompt.trim().slice(0, 8000) : '';
  if (!name || !systemPrompt) return null;

  const modelSlug =
    typeof p.model_slug === 'string' && ALLOWED_AGENT_MODELS.has(p.model_slug.trim())
      ? p.model_slug.trim()
      : 'openai/gpt-4o-mini';

  const tools = Array.isArray(p.tools)
    ? Array.from(
        new Set(
          p.tools.filter((t): t is string => typeof t === 'string' && ALLOWED_TOOLS.has(t)),
        ),
      )
    : [];

  return { name, role, system_prompt: systemPrompt, model_slug: modelSlug, tools };
}

/** Resolve the upstream chat endpoint — gateway when keyed, else OpenRouter fallback. */
function resolveUpstream(): { url: string; apiKey: string } | null {
  const gwKey = process.env.AIAG_GATEWAY_KEY;
  if (gwKey) return { url: AIAG_GATEWAY_URL, apiKey: gwKey };
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) return { url: OPENROUTER_URL, apiKey: orKey };
  return null;
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: { description?: string };
  try {
    body = (await req.json()) as { description?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const description = body.description?.trim() ?? '';
  if (!description) return NextResponse.json({ error: 'description_required' }, { status: 400 });
  if (description.length > 2000) {
    return NextResponse.json({ error: 'description_too_long' }, { status: 400 });
  }

  const upstream = resolveUpstream();
  if (!upstream) {
    return NextResponse.json({ error: 'builder_unavailable' }, { status: 503 });
  }

  let res: Response;
  try {
    res = await safeFetch(upstream.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${upstream.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://ai-aggregator.ru',
        'X-Title': 'AIAG TMA',
      },
      body: JSON.stringify({
        model: BUILDER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: description },
        ],
        max_tokens: 1000,
        // Ask for raw JSON — harmless on OpenRouter, honored by the gateway upstream.
        response_format: { type: 'json_object' },
      }),
      allowlist: SAFE_FETCH_ALLOWLIST,
    });
  } catch {
    return NextResponse.json({ error: 'builder_failed' }, { status: 502 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: 'builder_failed' }, { status: 502 });
  }

  let content: string;
  try {
    const data = (await res.json()) as ModelResponse;
    content = data.choices?.[0]?.message?.content ?? '';
  } catch {
    return NextResponse.json({ error: 'builder_failed' }, { status: 502 });
  }
  if (!content.trim()) {
    return NextResponse.json({ error: 'invalid_spec' }, { status: 422 });
  }

  let spec: AgentSpec | null;
  try {
    spec = normalizeSpec(JSON.parse(stripFences(content)));
  } catch {
    spec = null;
  }
  if (!spec) return NextResponse.json({ error: 'invalid_spec' }, { status: 422 });

  return NextResponse.json({ spec });
}
