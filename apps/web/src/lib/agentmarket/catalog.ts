import { db, sql } from '@/lib/db';

/**
 * Public, read-only `agent_templates` catalog for the /agentmarket web showcase
 * (issue #28). Server-component data access — no new public HTTP API for W1.
 *
 * SAFE FIELDS ONLY. `agent_templates` is a share-spec table with ZERO secret
 * columns (packages/database/migrations/0031_agent_templates.sql) — this file
 * must NEVER select from the separate `agents` table or any of its secret/PII
 * columns: tg_user_id, system_prompt, budget_credits_monthly,
 * daily_budget_credits, external_api_key_encrypted, mcp_auth_encrypted,
 * connection_type.
 *
 * Selected field list is exactly the "safe fields" enumerated in issue #28:
 * id, name, description, trait, model_slug, tools, price_credits, clone_count,
 * avg_rating, rating_count, author_tg_user_id, author_username, created_at,
 * mcp_endpoint_url.
 *
 * `agent_templates` is not modeled in Drizzle — raw SQL is the source of truth
 * (prod migrations are manual/untracked, see packages/database/CLAUDE.md).
 * Query shape mirrors the existing TMA read path:
 * apps/tg-miniapp/app/api/tma/templates/route.ts.
 */

export interface AgentTemplateRow {
  id: string;
  name: string | null;
  description: string | null;
  trait: string | null;
  model_slug: string | null;
  tools: unknown;
  price_credits: string | null;
  clone_count: number;
  avg_rating: string | null;
  rating_count: number;
  author_tg_user_id: string;
  author_username: string | null;
  created_at: string;
  mcp_endpoint_url: string | null;
}

function rows<T>(r: unknown): T[] {
  return (((r as { rows?: T[] }).rows ?? r) as T[]) ?? [];
}

// Fixed, non-interpolated field list reused by both queries below.
const SELECT_FIELDS = sql`
  t.id::text, t.name, t.description, t.trait, t.model_slug, t.tools,
  t.price_credits::text AS price_credits, t.clone_count,
  ROUND(AVG(r.stars), 1)::text AS avg_rating,
  COUNT(r.id)::int AS rating_count,
  t.author_tg_user_id::text AS author_tg_user_id,
  u.username AS author_username,
  t.created_at::text AS created_at,
  t.mcp_endpoint_url`;

export async function getPublicAgentTemplates(): Promise<AgentTemplateRow[]> {
  try {
    const result = await db.execute(sql`
      SELECT ${SELECT_FIELDS}
      FROM agent_templates t
      LEFT JOIN template_ratings r ON r.template_id = t.id
      LEFT JOIN tg_users u ON u.telegram_id = t.author_tg_user_id
      WHERE t.visibility = 'public'
      GROUP BY t.id, u.username
      ORDER BY t.created_at DESC
      LIMIT 100
    `);
    return rows<AgentTemplateRow>(result);
  } catch (e) {
    console.error('agentmarket: catalog fetch failed', e);
    return [];
  }
}

export async function getPublicAgentTemplateById(
  id: string
): Promise<AgentTemplateRow | null> {
  try {
    const result = await db.execute(sql`
      SELECT ${SELECT_FIELDS}
      FROM agent_templates t
      LEFT JOIN template_ratings r ON r.template_id = t.id
      LEFT JOIN tg_users u ON u.telegram_id = t.author_tg_user_id
      WHERE t.id = ${id} AND t.visibility = 'public'
      GROUP BY t.id, u.username
      LIMIT 1
    `);
    return rows<AgentTemplateRow>(result)[0] ?? null;
  } catch (e) {
    console.error('agentmarket: template fetch failed', e);
    return null;
  }
}

/**
 * price_credits is stored in US cents (NULL = free — see migration 0032
 * comment). Display convention (÷100 → "N.NN кр") matches the live TMA
 * formatter in apps/tg-miniapp/app/templates/[id]/page.tsx.
 */
export function priceLabel(price: string | null): string {
  if (price === null) return 'Бесплатно';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'Бесплатно';
  return `${(n / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} кр`;
}

/** First letter of the template name, uppercased — the monogram avatar glyph. */
export function monogramLetter(name: string | null): string {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}
