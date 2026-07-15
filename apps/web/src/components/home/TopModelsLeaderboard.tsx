/**
 * Live "Top models" leaderboard for the home page.
 *
 * Source of truth: gateway `requests` table (last 7 days, GROUP BY model_slug).
 * Falls back to the marketplace catalog with deterministic placeholderRuns()
 * when telemetry is missing or schema doesn't match (e.g. fresh DB).
 */

import { db, sql } from '@/lib/db';
import { placeholderRuns } from '@/lib/marketplace/placeholders';
import { stripProviderBrand } from '@/lib/marketplace/strip-provider-brand';

interface TopModel {
  slug: string;
  name: string | null;
  org_slug: string | null;
  runs: number;
}

function orgFromSlug(slug: string): string | null {
  // slugs are typically `org/model`, e.g. `openai/gpt-4o-mini`
  const idx = slug.indexOf('/');
  return idx > 0 ? slug.slice(0, idx) : null;
}

function parseRunsToken(token: string): number {
  // `1.4M` / `420K` → integer
  if (token.endsWith('M')) return Math.round(parseFloat(token) * 1_000_000);
  if (token.endsWith('K')) return Math.round(parseFloat(token) * 1_000);
  return parseInt(token, 10) || 0;
}

async function getTopModels(): Promise<TopModel[]> {
  // Try live telemetry first.
  try {
    const result = await db.execute(sql`
      SELECT
        r.model_slug AS slug,
        m.display_name AS name,
        COUNT(*)::int AS runs
      FROM requests r
      LEFT JOIN models m ON m.slug = r.model_slug
      WHERE r.created_at > NOW() - INTERVAL '7 days'
      GROUP BY r.model_slug, m.display_name
      ORDER BY runs DESC
      LIMIT 10
    `);
    const rows =
      (result as unknown as { rows?: Array<{ slug: string; name: string | null; runs: number }> }).rows ??
      (result as unknown as Array<{ slug: string; name: string | null; runs: number }>);

    if (Array.isArray(rows) && rows.length >= 3) {
      return rows.map((r) => ({
        slug: r.slug,
        name: r.name ? stripProviderBrand(r.name) : r.name,
        org_slug: orgFromSlug(r.slug),
        runs: r.runs,
      }));
    }
  } catch {
    // schema mismatch / no requests / build-time DB not initialized — fall through
  }

  // Fallback: marketplace catalog with deterministic placeholder counts.
  try {
    const result = await db.execute(sql`
      SELECT m.slug, m.display_name AS name
      FROM models m
      WHERE m.enabled = true
      LIMIT 24
    `);
    const rows =
      (result as unknown as { rows?: Array<{ slug: string; name: string | null }> }).rows ??
      (result as unknown as Array<{ slug: string; name: string | null }>);

    return (rows ?? [])
      .map((r) => ({
        slug: r.slug,
        name: r.name ? stripProviderBrand(r.name) : r.name,
        org_slug: orgFromSlug(r.slug),
        runs: parseRunsToken(placeholderRuns(r.slug)),
      }))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function formatRuns(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export async function TopModelsLeaderboard() {
  const models = await getTopModels();
  if (models.length === 0) return null;

  return (
    <section className="container mx-auto max-w-5xl px-4 py-16">
      <div className="flex items-baseline justify-between mb-8 flex-wrap gap-3">
        <h2
          className="font-bold"
          style={{
            fontSize: 'clamp(28px, 3.4vw, 40px)',
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
          }}
        >
          Топ моделей сегодня
        </h2>
        <p
          className="text-xs uppercase tracking-widest flex items-center gap-2 font-mono"
          style={{ color: 'var(--ink-muted)' }}
        >
          <span
            className="aiag-pulse inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: 'var(--success, #22c55e)',
            }}
          />
          Live · обновляется каждый час
        </p>
      </div>

      <ol className="grid sm:grid-cols-2 gap-2">
        {models.map((m, i) => (
          <li
            key={m.slug}
            className="flex items-center gap-3 rounded-md px-4 py-3 transition-colors hover:bg-white/[0.03]"
            style={{
              borderColor: 'var(--line)',
              border: '1px solid var(--line)',
              background: 'var(--bg-elev)',
            }}
          >
            <span
              className="font-mono tabular-nums w-7 shrink-0"
              style={{
                fontSize: 13,
                color: i < 3 ? 'var(--accent)' : 'var(--ink-muted)',
                fontWeight: i < 3 ? 700 : 500,
              }}
            >
              #{i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className="font-semibold truncate"
                style={{ fontSize: 14, color: 'var(--ink)' }}
              >
                {m.name ?? m.slug}
              </div>
              <div
                className="font-mono truncate"
                style={{ fontSize: 11, color: 'var(--ink-muted)' }}
              >
                {m.org_slug ?? m.slug}
              </div>
            </div>
            <div
              className="font-mono tabular-nums shrink-0"
              style={{ fontSize: 13, color: 'var(--accent)' }}
            >
              {formatRuns(m.runs)}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
