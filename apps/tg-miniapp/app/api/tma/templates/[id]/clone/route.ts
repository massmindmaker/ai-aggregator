import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';
import { assertAgentQuota, QuotaExceededError, quotaExceededBody } from '@/lib/membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Default monthly budget for a cloned agent (US cents). $100/mo.
const DEFAULT_BUDGET_CREDITS = 10_000;

// The shareable spec we copy into the new agent. The template table has no secret
// columns, so cloning structurally cannot carry a secret. The cloner wires their own
// keys/provider afterwards via PATCH …/agents/[id] (BYOK flow).
interface TemplateSpecRow {
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
  price_credits: string | null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const rows = (await sql`
    SELECT name, description, system_prompt, model_slug, tools, mcp_endpoint_url,
           price_credits::text AS price_credits
    FROM agent_templates
    WHERE id = ${params.id}::uuid
      AND visibility = 'public'
    LIMIT 1
  `) as unknown as TemplateSpecRow[];

  const tpl = rows[0] ?? null;
  if (!tpl) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Slice 1 is FREE-clone only. A non-null price means the author set author-rent;
  // paid rent (debit + author payout) is Slice 2. Do NOT silently clone a paid
  // template for free — reject with 402 until rent exists.
  if (tpl.price_credits !== null) {
    return NextResponse.json({ error: 'rent_not_available_yet' }, { status: 402 });
  }

  // template_kind references the source template (VARCHAR(40)): "tpl:<uuid>" fits in 40.
  const templateKind = `tpl:${params.id}`.slice(0, 40);
  const name = (tpl.name ?? 'Без имени').slice(0, 200);
  const systemPrompt = (tpl.system_prompt ?? '').slice(0, 8000);
  const tools = Array.isArray(tpl.tools) ? tpl.tools : [];

  // Atomic: create the caller-owned clone AND bump the template's clone_count in one
  // transaction. connection_type='aiag' (caller wires their own keys/provider later);
  // every external_*/mcp_auth secret column is left at its NULL default — no secret copied.
  let newAgentId = '';
  try {
    await sql.begin(async (sql) => {
      // Per-tier agent quota (issue #32): a template clone creates an agent the caller
      // OWNS → counts against the cap like any other create. In this SAME transaction,
      // so the FOR UPDATE lock serializes concurrent clones by this user.
      await assertAgentQuota(tgUserId, sql);

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
          ${tpl.description},
          ${systemPrompt},
          ${sql.json(tools as never)},
          ${tpl.model_slug},
          ${DEFAULT_BUDGET_CREDITS},
          'aiag',
          ${tpl.mcp_endpoint_url}
        )
        RETURNING id::text
      `) as unknown as Array<{ id: string }>;

      newAgentId = ins[0]!.id;

      await sql`
        UPDATE agent_templates
        SET clone_count = clone_count + 1
        WHERE id = ${params.id}::uuid
      `;
    });
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return NextResponse.json(quotaExceededBody(e), { status: 403 });
    }
    throw e;
  }

  return NextResponse.json({ agent_id: newAgentId }, { status: 201 });
}
