/**
 * Plan 04 PII filter (Spec §8).
 *
 * - Extracts text from request body across chat/completions/embeddings shapes.
 * - Detects email / phone / ИНН / ФИО via regex.
 * - If target upstream is non-RU and key policy `allow_pii_transborder !== true`:
 *    blocking-kind hits (email/phone/inn) → 403 Block
 *    non-blocking (fio) → pass with log action='warn'
 * - Persists hashes (not raw samples) to `pii_detections` table.
 *
 * Resolver hook: `setResolveModel(fn)` lets tests/harness inject model info
 * without hitting Postgres.
 *
 * F-3 (security review):
 *   1. The transborder slug pattern is now DERIVED from FOREIGN_PROVIDERS
 *      (middleware/transborderGate.ts) instead of a second hand-written regex.
 *      The old literal `^(openai|anthropic|together|mistral|google|cohere)\/`
 *      silently treated `kie/…`, `fal/…`, `replicate/…`, `openrouter/…`,
 *      `huggingface/…` and `groq/…` as RU-local, so a prompt with an email
 *      sailed through to kie.ai unchecked. One list, one truth.
 *   2. The resolver seam is actually wired at boot (see server.ts
 *      `setPiiResolveModel(resolveModelWithOverride)`), so residency comes from
 *      the same candidate rows the router will use rather than from a string
 *      prefix. On resolver failure we now FAIL CLOSED (treat as transborder)
 *      instead of falling back to a prefix guess.
 */
import type { MiddlewareHandler } from 'hono';
import { extractText, detectPii, sha256 } from '../lib/pii';
import { sql } from '../lib/db';
import { errors } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AuthenticatedApiKey } from './auth-plan04';
import type { ResolvedModel } from '../routing/resolver';
import { FOREIGN_PROVIDERS } from './transborderGate';

type ResolveModelFn = (slug: string) => Promise<ResolvedModel>;

let resolveModelFn: ResolveModelFn | null = null;

export function setPiiResolveModel(fn: ResolveModelFn | null): void {
  resolveModelFn = fn;
}

// Built once from the single source of truth. Values are provider orgs
// ([a-z0-9-]+) escaped for regex safety.
const FOREIGN_SLUG_PATTERN = new RegExp(
  `^(?:${[...FOREIGN_PROVIDERS].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`
);

/** Exported for tests: is this model slug served by a known foreign provider? */
export function slugLooksTransborder(modelSlug: string): boolean {
  return FOREIGN_SLUG_PATTERN.test(modelSlug);
}

export const piiFilter: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT') return next();

  // Content-type must be JSON (other types not scanned).
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return next();

  let body: Record<string, unknown> | null = null;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return next();
  }
  c.set('rawBody' as never, body as never);
  if (!body) return next();

  const text = extractText(body);
  const hits = detectPii(text);
  if (hits.length === 0) return next();

  const key = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  const modelSlug = typeof body.model === 'string' ? body.model : '';

  // Determine transborder: prefer the resolver (same candidate rows the router
  // uses). Default is the provider-prefix hint — fail-safe for foreign orgs.
  let isTransborder = slugLooksTransborder(modelSlug);
  if (resolveModelFn && modelSlug) {
    try {
      const model = await resolveModelFn(modelSlug);
      const first = model.candidates[0];
      isTransborder = !(first?.ru_residency ?? false);
    } catch (e) {
      // Fail closed: if residency cannot be established, assume the prompt
      // leaves the country. Previously the prefix guess silently allowed it.
      isTransborder = true;
      logger.warn({ err: String(e), modelSlug }, 'pii_resolve_model_failed');
    }
  }

  const policies = (key?.policies ?? {}) as Record<string, unknown>;
  const allow = policies.allow_pii_transborder === true;
  const blockingHits = hits.filter((h) => h.blocking);
  const shouldBlock = isTransborder && !allow && blockingHits.length > 0;

  const orgId = key?.org_id ?? null;
  const requestId = c.get('requestId' as never) as string | undefined;

  for (const h of hits) {
    const action = shouldBlock && h.blocking ? 'block' : h.blocking ? 'pass' : 'warn';
    if (orgId) {
      sql`
        INSERT INTO pii_detections (org_id, request_id, kind, sample_hash, action, model_slug)
        VALUES (${orgId}::uuid, ${requestId ?? null}, ${h.kind},
                ${sha256(h.sample)}, ${action}, ${modelSlug || null})
      `.catch((e) => logger.warn({ err: String(e) }, 'pii_insert_fail'));
    }
  }

  if (shouldBlock) {
    throw errors.forbidden('PII detected; transborder blocked by policy');
  }
  await next();
};