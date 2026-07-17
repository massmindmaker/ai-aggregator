/**
 * Model resolver: slug → { type, candidates[] } with Redis cache.
 * (FIX C8: markup comes from model_upstreams.markup per upstream.)
 */
import { makeRedis } from '../lib/redis';
import { sql } from '../lib/db';
import { errors } from '../lib/errors';
import type { UpstreamCandidate } from './engine';

const TTL_SEC = 600;

export type ResolvedModel = {
  slug: string;
  type: 'chat' | 'embedding' | 'image' | 'audio' | 'completion';
  candidates: UpstreamCandidate[];
};

type DbRow = {
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
};

export async function resolveModel(slug: string): Promise<ResolvedModel> {
  const redis = makeRedis('cache');
  try {
    const cached = await redis.get(`model:${slug}`);
    if (cached) return JSON.parse(cached) as ResolvedModel;
  } catch {
    /* cache optional */
  }

  const rows = (await sql<DbRow[]>`
    SELECT m.slug, m.type,
           mu.upstream_id, mu.upstream_model_id,
           u.provider, u.ru_residency, u.latency_p50_ms, u.uptime,
           mu.price_per_1k_input, mu.price_per_1k_output, mu.price_per_image,
           mu.markup
      FROM models m
      JOIN model_upstreams mu ON mu.model_id = m.id AND mu.enabled = TRUE
      JOIN upstreams u       ON u.id = mu.upstream_id AND u.enabled = TRUE
     WHERE m.slug = ${slug} AND m.enabled = TRUE
  `) as DbRow[];

  if (rows.length === 0) throw errors.badRequest(`Unknown model: ${slug}`);

  const candidates: UpstreamCandidate[] = rows.map((r) => ({
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
  }));

  const payload: ResolvedModel = {
    slug,
    type: rows[0]!.type,
    candidates,
  };
  try {
    await redis.setex(`model:${slug}`, TTL_SEC, JSON.stringify(payload));
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
