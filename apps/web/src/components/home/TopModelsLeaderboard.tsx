/**
 * Live "Top models" leaderboard for the home page.
 *
 * Source of truth: gateway `requests` table (last 7 days, GROUP BY model_slug).
 * Renders NOTHING when there isn't enough real telemetry (< 3 distinct
 * models) — the section must never claim "Live" over placeholder/hash-based
 * numbers. See `isLive` below: only the real-telemetry branch is shown.
 */

import { db, sql } from '@/lib/db';
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

async function getTopModels(): Promise<{ models: TopModel[]; isLive: boolean }> {
  // Try live telemetry first. This is the ONLY branch allowed to render —
  // no fallback/placeholder data is computed, so there's nothing fake left
  // to accidentally show under a "Live" badge.
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
      return {
        isLive: true,
        models: rows.map((r) => ({
          slug: r.slug,
          name: r.name ? stripProviderBrand(r.name) : r.name,
          org_slug: orgFromSlug(r.slug),
          runs: r.runs,
        })),
      };
    }
  } catch {
    // schema mismatch / no requests / build-time DB not initialized — fall through
  }

  // No real telemetry yet (e.g. requests=0) — do not fabricate a leaderboard.
  return { models: [], isLive: false };
}

function formatRuns(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export async function TopModelsLeaderboard() {
  const { models, isLive } = await getTopModels();
  // Honesty gate: only render when backed by real 7-day request telemetry.
  // Never show the "Live" badge over placeholder/hash-based numbers.
  if (!isLive || models.length === 0) return null;

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
          Топ моделей за неделю
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
          Live · за 7 дней
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
