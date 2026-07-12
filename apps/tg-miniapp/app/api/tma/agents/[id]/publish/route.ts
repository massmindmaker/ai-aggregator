import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Upper bound on author rent: 100000 cents = $1000. Rejects absurd / overflow prices.
const MAX_PRICE_CREDITS = 100_000;
// Upper bound on the monthly spend limit included in a subscription: 1_000_000
// cents = $10000. Mirrors the agent daily/monthly budget ceilings.
const MAX_LIMIT_CREDITS = 1_000_000;

// The ONLY columns we read off the owned agent — the publicly shareable spec.
// We NEVER select external_api_key_encrypted, external_api_key_hint,
// mcp_auth_encrypted, agent_memory, or agent_runs. The share-subset is the whole
// point: a published template is a spec, not a secret.
interface ShareSpecRow {
  name: string;
  description: string | null;
  system_prompt: string;
  tools: unknown;
  model_slug: string | null;
  mcp_endpoint_url: string | null;
  // Provenance: if this agent was created from a template, template_kind = 'tpl:<uuid>'.
  template_kind: string | null;
}

async function loadShareSpec(id: string, tgUserId: string): Promise<ShareSpecRow | null> {
  // Ownership guard (id + tg_user_id), mirrors loadAgent in ../route.ts. Selects the
  // share-subset ONLY — no *_encrypted / *_hint / *_auth columns are referenced.
  // template_kind carries the remix provenance ('tpl:<uuid>' for a template-created agent).
  const rows = (await sql`
    SELECT name, description, system_prompt, tools, model_slug, mcp_endpoint_url,
           template_kind
    FROM agents
    WHERE id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as ShareSpecRow[];
  return rows[0] ?? null;
}

const TPL_KIND_RE = /^tpl:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// REMIX-LINEAGE: if the published agent was itself created from a template
// (template_kind = 'tpl:<uuid>'), resolve that source template's uuid as the new
// template's fork_parent_id — but ONLY
// if it's a real agent_templates row (else leave NULL, e.g. a since-deleted parent or a
// hardcoded-seed template_kind that is not a uuid).
async function resolveForkParent(templateKind: string | null): Promise<string | null> {
  if (!templateKind) return null;
  const m = TPL_KIND_RE.exec(templateKind);
  if (!m) return null;
  const parentId = m[1]!;
  const rows = (await sql`
    SELECT id::text FROM agent_templates WHERE id = ${parentId}::uuid LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

interface PublishBody {
  // NULL / absent = free. Otherwise a positive integer (US cents) author rent.
  // Аренда = месячная подписка: это МЕСЯЧНАЯ цена.
  price_credits?: number | null;
  // Месячный лимит трат (US cents), входящий в цену подписки. NULL/absent = дефолт
  // клона (rent-роут подставит DEFAULT_BUDGET_CREDITS). Игнорируется для free.
  rent_monthly_limit_credits?: number | null;
  visibility?: 'public' | 'unlisted' | 'private';
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  let body: PublishBody;
  try {
    body = (await req.json()) as PublishBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // price_credits: NULL/absent => free. Else must be a positive integer in range.
  let priceCredits: number | null = null;
  if (body.price_credits !== undefined && body.price_credits !== null) {
    const p = body.price_credits;
    if (!Number.isInteger(p) || p <= 0 || p > MAX_PRICE_CREDITS) {
      return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
    }
    priceCredits = p;
  }

  // rent_monthly_limit_credits: только для платного шаблона; NULL = дефолт клона.
  let monthlyLimit: number | null = null;
  if (priceCredits !== null && body.rent_monthly_limit_credits != null) {
    const l = body.rent_monthly_limit_credits;
    if (!Number.isInteger(l) || l <= 0 || l > MAX_LIMIT_CREDITS) {
      return NextResponse.json({ error: 'invalid_limit' }, { status: 400 });
    }
    monthlyLimit = l;
  }

  const visibility =
    body.visibility === 'unlisted' || body.visibility === 'private' ? body.visibility : 'public';

  const spec = await loadShareSpec(params.id, tgUserId);
  if (!spec) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Remix-lineage: derive fork_parent_id from this agent's provenance (validated as a
  // real template row, else NULL).
  const forkParentId = await resolveForkParent(spec.template_kind);

  // Snapshot ONLY the shareable spec into agent_templates. The target table has no
  // secret columns, so a secret is structurally impossible to publish.
  const ins = (await sql`
    INSERT INTO agent_templates (
      author_tg_user_id, name, description, system_prompt,
      model_slug, tools, mcp_endpoint_url, price_credits,
      rent_monthly_limit_credits, visibility,
      fork_parent_id
    )
    VALUES (
      ${tgUserId}::bigint,
      ${spec.name},
      ${spec.description},
      ${spec.system_prompt},
      ${spec.model_slug},
      ${sql.json((Array.isArray(spec.tools) ? spec.tools : []) as never)},
      ${spec.mcp_endpoint_url},
      ${priceCredits},
      ${monthlyLimit},
      ${visibility},
      ${forkParentId}
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  return NextResponse.json({ template_id: ins[0]!.id }, { status: 201 });
}
