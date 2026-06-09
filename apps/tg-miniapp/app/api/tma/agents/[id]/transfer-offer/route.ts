import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /tg/api/tma/agents/[id]/transfer-offer
//
// PUBLIC, INTENTIONALLY UNGUARDED acquirer delivery surface.
// An acquirer (gift recipient / buyer) is NOT the agent owner — the owner-guarded detail
// GET (../route.ts) returns 404 for non-owners. This route is what backs the offer page
// (plan 04) that the acquirer opens from the owner's share link.
//
// Security contract (T-16-08a):
//   - Read-only. No auth required (acquirer does not have a TMA session / is a second user).
//   - Returns ONLY non-sensitive fields: id, name, persona_preview (LEFT(description,280)),
//     template_kind, model_slug, transfer_price_credits, mint_fee_ton, status.
//   - NEVER selects: tg_user_id, *_encrypted, *_hint, external_base_url, external_model_slug,
//     mcp_auth_encrypted, nft_owner_wallet, memory_owner_key, system_prompt, agent_runs.
//   - Filtered on transferable = TRUE: a non-transferable, deleted, or nonexistent agent
//     returns the SAME 404 not_transferable — no existence oracle.
//
// Rate-limiting (T-16-08b, deploy task):
//   Add /tg/api/tma/agents/*/transfer-offer to the nginx public-read rate-limit zone
//   (noted in 16-02-SUMMARY.md as a manual deploy step before going live).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  try {
    const rows = (await sql`
      SELECT id::text,
             name,
             LEFT(COALESCE(description, ''), 280) AS persona_preview,
             template_kind,
             model_slug,
             transfer_price_credits::text AS transfer_price_credits,
             status
      FROM agents
      WHERE id          = ${params.id}::uuid
        AND transferable = TRUE
        AND status      != 'deleted'
      LIMIT 1
    `) as unknown as Array<{
      id: string;
      name: string;
      persona_preview: string;
      template_kind: string;
      model_slug: string | null;
      transfer_price_credits: string | null;
      status: string;
    }>;

    const a = rows[0];
    if (!a) return NextResponse.json({ error: 'not_transferable' }, { status: 404 });

    // mint_fee_ton is the acquirer's chain cost for the lazy NFT mint triggered at actual
    // transfer (plan 03). Sourced from env so it can be adjusted without a deploy.
    const mintFeeTon = process.env.AGENT_MINT_FEE_TON ?? '0.1';

    return NextResponse.json({
      offer: {
        id: a.id,
        name: a.name,
        role: a.persona_preview,           // short persona/role preview — NOT the raw system_prompt
        template_kind: a.template_kind,
        model_slug: a.model_slug,
        transfer_price_credits: a.transfer_price_credits, // null = gift-only
        mint_fee_ton: mintFeeTon,
        status: a.status,
      },
    });
  } catch (e) {
    console.error('transfer-offer error:', e);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
