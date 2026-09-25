/**
 * Model resolver: slug → { type, candidates[] } with Redis cache.
 * (FIX C8: markup comes from model_upstreams.markup per upstream.)
 */
import { makeRedis } from '../lib/redis';
import { sql } from '../lib/db';
import { errors } from '../lib/errors';
import { parseCandidateBillingFacts, type UpstreamCandidate } from './engine';
import { findReviewedChatProfile } from '../billing/reviewed-token-profiles';
import { z } from 'zod';

const TTL_SEC = 600;
// Legacy registry types are broader than the separately reviewed chat capability.
const modelTypes = ['chat', 'embedding', 'image', 'audio', 'completion', 'video'] as const;

export type ResolvedModel = {
  slug: string;
  type: (typeof modelTypes)[number];
  candidates: UpstreamCandidate[];
};

export type ModelRoutingDbRow = {
  model_upstream_id: string;
  billing_input_cents_per_1k: string;
  billing_output_cents_per_1k: string;
  billing_markup: string;
  slug: string;
  type: ResolvedModel['type'];
  upstream_id: string;
  upstream_model_id: string;
  provider: string;
  ru_residency: boolean;
  latency_p50_ms: number;
  uptime: string | number;
  price_per_1k_input: string | number;
  price_per_1k_output: string | number;
  price_per_image: string | number | null;
  markup: string | number;
  egress_proxy: string | null;
  priority: number;
};

const finite = z.number().finite();
const cachedModel = z.object({
  slug: z.string().min(1), type: z.enum(modelTypes),
  candidates: z.array(z.object({
    id: z.string().min(1), upstream_id: z.string().min(1), upstream_model_id: z.string().min(1), provider: z.string().min(1),
    price_per_1k_input: finite.nonnegative(), price_per_1k_output: finite.nonnegative(), price_per_image: finite.nonnegative().optional(),
    markup: finite.positive(), latency_p50_ms: finite.nonnegative(), uptime: finite.min(0).max(1), ru_residency: z.boolean(),
    egress_proxy: z.string().nullable().optional(), priority: z.number().int().optional(),
    billing: z.unknown().transform((value, ctx) => {
      const facts = parseCandidateBillingFacts(value);
      if (!facts) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid exact billing facts' }); return z.NEVER; }
      return facts;
    }),
  })).min(1),
});

/** Redis is untrusted runtime data. Profiles are always rebound from this process's manifest. */
export function parseResolvedModelCache(value: unknown, slug: string): ResolvedModel | null {
  const parsed = cachedModel.safeParse(value);
  if (!parsed.success || parsed.data.slug !== slug) return null;
  const data = parsed.data;
  const candidates: UpstreamCandidate[] = data.candidates.map(c => {
    const profile = findReviewedChatProfile({ modelSlug: data.slug, modelType: data.type, upstreamId: c.upstream_id, upstreamModelId: c.upstream_model_id, adapterKey: c.id });
    return { ...c, ...(profile ? { reviewedChatProfile: profile } : {}) };
  });
  return { slug: data.slug, type: data.type, candidates };
}

/** Shared DB projection; exact billing text and reviewed bindings stay identical to legacy. */
export function projectModelRoutingRows(rows: ModelRoutingDbRow[], slug: string): ResolvedModel {
  if (!rows.length) throw new Error('Invalid model routing facts');
  const candidates: UpstreamCandidate[] = rows.map((r) => ({
    billing: {
      modelUpstreamId: r.model_upstream_id,
      prices: { inputCentsPer1k: r.billing_input_cents_per_1k, outputCentsPer1k: r.billing_output_cents_per_1k, markup: r.billing_markup },
      ...(r.price_per_image == null ? {} : { pricePerImageCents: String(r.price_per_image) }),
    },
    id: r.upstream_id,
    provider: r.provider,
    price_per_1k_input: Number(r.price_per_1k_input),
    price_per_1k_output: Number(r.price_per_1k_output),
    price_per_image: r.price_per_image == null ? undefined : Number(r.price_per_image),
    latency_p50_ms: Number(r.latency_p50_ms),
    uptime: Number(r.uptime),
    ru_residency: r.ru_residency,
    upstream_id: r.upstream_id,
    upstream_model_id: r.upstream_model_id,
    markup: Number(r.markup),
    // Raw column value — precedence vs env AIAG_EGRESS_PROXY_URL is applied
    // per-request in upstreams/fetch-upstream.ts (T2), not here, so cached
    // payloads never bake the env tier in.
    egress_proxy: r.egress_proxy,
    priority: Number(r.priority),
  }));

  const payload = parseResolvedModelCache({ slug, type: rows[0]!.type, candidates }, slug);
  if (!payload) throw new Error('Invalid model routing facts');
  return payload;
}

export async function resolveModel(slug: string): Promise<ResolvedModel> {
  const redis = makeRedis('cache');
  try {
    const cached = await redis.get(`model:v2:${slug}`);
    if (cached) {
      const parsed = parseResolvedModelCache(JSON.parse(cached), slug);
      if (parsed) return parsed;
    }
  } catch {
    /* cache optional */
  }

  // T3 (native egress integration): deterministic FAILOVER order —
  // model_upstreams.priority ASC (lower = tried first), upstream_id as the
  // stable tiebreak. The routing engine still picks the preferred candidate
  // from this list; the order matters to executeWithFailover only.
  const rows = (await sql<ModelRoutingDbRow[]>`
    SELECT m.slug, m.type,
           mu.id::text AS model_upstream_id,
           mu.price_per_1k_input::text AS billing_input_cents_per_1k,
           mu.price_per_1k_output::text AS billing_output_cents_per_1k,
           mu.markup::text AS billing_markup,
           mu.upstream_id, mu.upstream_model_id,
           u.provider, u.ru_residency, u.latency_p50_ms, u.uptime,
           mu.price_per_1k_input, mu.price_per_1k_output, mu.price_per_image,
           mu.markup, mu.egress_proxy, mu.priority
      FROM models m
      JOIN model_upstreams mu ON mu.model_id = m.id AND mu.enabled = TRUE
       JOIN upstreams u       ON u.id = mu.upstream_id AND u.enabled = TRUE
      WHERE m.slug = ${slug} AND m.enabled = TRUE
      ORDER BY mu.priority ASC, mu.upstream_id ASC
  `) as ModelRoutingDbRow[];

  if (rows.length === 0) throw errors.badRequest(`Unknown model: ${slug}`);

  const payload = projectModelRoutingRows(rows, slug);
  try {
    // Capability bindings are process-owned, never trusted from Redis.
    const cachePayload = { ...payload, candidates: payload.candidates.map(({ reviewedChatProfile: _profile, ...candidate }) => candidate) };
    await redis.setex(`model:v2:${slug}`, TTL_SEC, JSON.stringify(cachePayload));
  } catch {
    /* ignore */
  }
  return payload;
}

/** Test seam: let tests replace resolveModel logic entirely. */
let override: ((slug: string) => Promise<ResolvedModel>) | null = null;
export function setResolveModelOverride(
  fn: ((slug: string) => Promise<ResolvedModel>) | null
): void {
  override = fn;
}
export function resolveModelWithOverride(slug: string): Promise<ResolvedModel> {
  return override ? override(slug) : resolveModel(slug);
}
