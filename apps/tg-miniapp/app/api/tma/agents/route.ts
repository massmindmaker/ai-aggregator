import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { getTemplate } from '@/lib/agent-templates';
import { encryptSecret, lastFour } from '@/lib/secret-box';
import { validateExternalUrl } from '@/lib/url-validate';

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
  budget_rub_monthly: string;
  status: string;
  connection_type: string;
  external_base_url: string | null;
  external_api_key_hint: string | null;
  external_model_slug: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const rows = (await sql`
    SELECT id::text, tg_user_id::text, template_kind, name, description,
           system_prompt, tools, model_slug, budget_rub_monthly::text,
           status, connection_type, external_base_url, external_api_key_hint,
           external_model_slug, created_at, updated_at
    FROM agents
    WHERE tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    ORDER BY created_at DESC
  `) as unknown as AgentRow[];

  return NextResponse.json({ agents: rows });
}

interface CreateBody {
  template_kind?: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  tools?: unknown[];
  model_slug?: string;
  budget_rub_monthly?: number;
  // External agent fields:
  connection_type?: 'aiag' | 'external_openai';
  external_base_url?: string;
  external_api_key?: string;
  external_model_slug?: string;
}

export async function POST(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const templateKind = (body.template_kind || 'personal').slice(0, 40);
  const template = getTemplate(templateKind);

  const name = (body.name?.trim() || template?.name || 'Без имени').slice(0, 200);
  const description = body.description?.trim() || template?.description || null;
  const systemPrompt = (body.system_prompt?.trim() || template?.systemPrompt || '').slice(0, 8000);
  if (!systemPrompt) {
    return NextResponse.json({ error: 'system_prompt_required' }, { status: 400 });
  }
  const tools = Array.isArray(body.tools) ? body.tools : (template?.suggestedTools ?? []);
  const modelSlug = body.model_slug?.trim() || template?.defaultModelSlug || null;
  const budget =
    typeof body.budget_rub_monthly === 'number' && body.budget_rub_monthly >= 0
      ? body.budget_rub_monthly
      : 1000;

  // ---- external endpoint validation ----
  const connectionType = body.connection_type === 'external_openai' ? 'external_openai' : 'aiag';
  let externalBaseUrl: string | null = null;
  let externalApiKeyHint: string | null = null;
  let externalKeyBlob: Buffer | null = null;
  let externalModelSlug: string | null = null;

  if (connectionType === 'external_openai') {
    const urlCheck = validateExternalUrl(body.external_base_url ?? '');
    if (!urlCheck.ok || !urlCheck.normalised) {
      return NextResponse.json({ error: `url_${urlCheck.reason ?? 'invalid'}` }, { status: 400 });
    }
    externalBaseUrl = urlCheck.normalised;
    const rawKey = body.external_api_key?.trim();
    if (!rawKey || rawKey.length < 8) {
      return NextResponse.json({ error: 'api_key_required' }, { status: 400 });
    }
    try {
      externalKeyBlob = encryptSecret(rawKey);
    } catch (e) {
      console.error('[agents.create] secret-box failure', e);
      return NextResponse.json({ error: 'secret_box_misconfigured' }, { status: 500 });
    }
    externalApiKeyHint = lastFour(rawKey);
    externalModelSlug = body.external_model_slug?.trim().slice(0, 200) || null;
  }

  const ins = (await sql`
    INSERT INTO agents (
      tg_user_id, template_kind, name, description,
      system_prompt, tools, model_slug, budget_rub_monthly,
      connection_type, external_base_url, external_api_key_encrypted,
      external_api_key_hint, external_model_slug
    )
    VALUES (
      ${tgUserId}::bigint,
      ${templateKind},
      ${name},
      ${description},
      ${systemPrompt},
      ${sql.json(tools as never)},
      ${modelSlug},
      ${budget},
      ${connectionType},
      ${externalBaseUrl},
      ${externalKeyBlob},
      ${externalApiKeyHint},
      ${externalModelSlug}
    )
    RETURNING id::text, tg_user_id::text, template_kind, name, description,
              system_prompt, tools, model_slug, budget_rub_monthly::text,
              status, connection_type, external_base_url, external_api_key_hint,
              external_model_slug, created_at, updated_at
  `) as unknown as AgentRow[];

  return NextResponse.json({ agent: ins[0] }, { status: 201 });
}
