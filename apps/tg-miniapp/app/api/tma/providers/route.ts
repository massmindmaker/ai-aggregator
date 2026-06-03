import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sql = postgres(process.env.DATABASE_URL ?? '', { prepare: false });

/**
 * GET /tg/api/tma/providers
 *
 * Returns the enabled provider catalog for the BYO-key provider picker in the
 * TMA create-agent flow. TMA-local copy of the web aggregator's /api/providers
 * (apps/web) — the two products do not share routes, so the TMA must serve its
 * own. Auth-gated (x-tma-user-id, set by middleware after JWT verify, stripped
 * at nginx) — this is a logged-in feature, not a public page.
 *
 * Catalog is seeded by migration 0026_provider_catalog.sql (8 BYO-key providers,
 * all OpenAI-compatible). Picking one + entering your OWN key routes the agent
 * via the external_openai path → ZERO commission (founder rule: own key = free).
 *
 * Response: { providers: Array<{ id, name, apiBase, requiresBaseUrl }> }
 */

interface ProviderRow {
  id: string;
  name: string;
  api_base: string | null;
  requires_base_url: boolean;
}

export async function GET(req: NextRequest) {
  const tgUserId = req.headers.get('x-tma-user-id');
  if (!tgUserId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const rows = (await sql`
      SELECT id, name, api_base, requires_base_url
      FROM providers
      WHERE enabled = true
      ORDER BY sort ASC
    `) as unknown as ProviderRow[];

    const providers = rows.map((r) => ({
      id: r.id,
      name: r.name,
      apiBase: r.api_base,
      requiresBaseUrl: r.requires_base_url,
    }));

    return NextResponse.json({ providers });
  } catch {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503 });
  }
}
