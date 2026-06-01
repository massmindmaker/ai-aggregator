import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sql } from '@aiag/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/providers
 *
 * Returns the enabled provider catalog for the BYO-key provider picker.
 * Read-only, no auth required — this is a public list of connectable providers.
 *
 * Response shape:
 *   { providers: Array<{ id, name, apiBase, authKind, requiresBaseUrl }> }
 *
 * Ordered by `sort` ASC. Only `enabled = true` rows are returned.
 * Populated by migration 0026_provider_catalog.sql (seeded; later synced from
 * models.dev in P1).
 */

interface ProviderRow {
  id: string;
  name: string;
  api_base: string | null;
  auth_kind: string;
  requires_base_url: boolean;
}

export async function GET() {
  let rows: ProviderRow[];
  try {
    rows = (await db.execute(sql`
      SELECT id, name, api_base, auth_kind, requires_base_url
      FROM providers
      WHERE enabled = true
      ORDER BY sort ASC
    `)) as unknown as ProviderRow[];
  } catch {
    return NextResponse.json(
      { error: 'database_unavailable' },
      { status: 503 },
    );
  }

  const providers = rows.map((r) => ({
    id: r.id,
    name: r.name,
    apiBase: r.api_base,
    authKind: r.auth_kind,
    requiresBaseUrl: r.requires_base_url,
  }));

  return NextResponse.json({ providers });
}
