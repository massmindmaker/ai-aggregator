import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Upper bound on author rent: 100000 cents = $1000. Rejects absurd / overflow prices.
const MAX_PRICE_CREDITS = 100_000;

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
}

async function loadShareSpec(id: string, tgUserId: string): Promise<ShareSpecRow | null> {
  // Ownership guard (id + tg_user_id), mirrors loadAgent in ../route.ts. Selects the
  // share-subset ONLY — no *_encrypted / *_hint / *_auth columns are referenced.
  const rows = (await sql`
    SELECT name, description, system_prompt, tools, model_slug, mcp_endpoint_url
    FROM agents
    WHERE id = ${id}::uuid
      AND tg_user_id = ${tgUserId}::bigint
      AND status != 'deleted'
    LIMIT 1
  `) as unknown as ShareSpecRow[];
  return rows[0] ?? null;
}

interface PublishBody {
  // NULL / absent = free. Otherwise a positive integer (US cents) author rent.
  price_credits?: number | null;
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

  const visibility =
    body.visibility === 'unlisted' || body.visibility === 'private' ? body.visibility : 'public';

  const spec = await loadShareSpec(params.id, tgUserId);
  if (!spec) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Snapshot ONLY the shareable spec into agent_templates. The target table has no
  // secret columns, so a secret is structurally impossible to publish.
  const ins = (await sql`
    INSERT INTO agent_templates (
      author_tg_user_id, name, description, system_prompt,
      model_slug, tools, mcp_endpoint_url, price_credits, visibility
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
      ${visibility}
    )
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;

  return NextResponse.json({ template_id: ins[0]!.id }, { status: 201 });
}
