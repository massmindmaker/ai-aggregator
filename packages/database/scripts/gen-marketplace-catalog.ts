/**
 * gen-marketplace-catalog.ts
 *
 * BUILD-TIME static generator.
 * Reads all enabled models from the production DB and writes
 *   apps/web/src/lib/marketplace/catalog.generated.ts
 * as a TypeScript literal that satisfies `CatalogModel[]`.
 *
 * Usage (run from packages/database):
 *   bun run scripts/gen-marketplace-catalog.ts
 *
 * Requires DATABASE_URL in env (same as the rest of the monorepo).
 * Do NOT run automatically — the controller triggers this manually
 * after applying DB migrations, then redeploys.
 */

import { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { CatalogModel, ModelType, HostingRegion } from '../../../apps/web/src/lib/marketplace/catalog';

// ESM-safe __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Row source — either a JSON dump (CATALOG_DUMP_JSON) or the live DB.
// JSON mode lets the controller dump prod via psql and generate offline,
// keeping the marketing page free of any runtime DB dependency.
// ---------------------------------------------------------------------------
async function getRowsFromDb(): Promise<DbRow[]> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set (and CATALOG_DUMP_JSON unset)');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /neon\.tech|vercel-storage\.com/.test(DATABASE_URL)
      ? { rejectUnauthorized: false }
      : /localhost|127\.0\.0\.1|\[::1\]/.test(DATABASE_URL)
      ? false
      : undefined,
  });
  const client = await pool.connect();
  try {
    const result = await client.query<DbRow>(QUERY);
    return result.rows;
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
const QUERY = `
  SELECT
    m.slug,
    m.type,
    m.display_name,
    m.description,
    m.metadata,
    m.family,
    m.version,
    sup.slug              AS superseded_by_slug,
    sup.display_name      AS superseded_by_name,
    mu.price_per_1k_input,
    mu.price_per_1k_output,
    mu.price_per_image,
    mu.price_per_audio_sec,
    mu.markup
  FROM models m
  LEFT JOIN models sup ON sup.id = m.superseded_by
  LEFT JOIN LATERAL (
    SELECT *
    FROM model_upstreams x
    WHERE x.model_id = m.id AND x.enabled
    ORDER BY x.price_per_1k_input ASC NULLS LAST
    LIMIT 1
  ) mu ON true
  WHERE m.enabled
  ORDER BY m.type, m.slug;
`;

// ---------------------------------------------------------------------------
// Org name humanizer
// ---------------------------------------------------------------------------
const ORG_NAME_MAP: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'x-ai': 'xAI',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  mistralai: 'Mistral',
  mistral: 'Mistral',
  'meta-llama': 'Meta',
  meta: 'Meta',
  yandex: 'Yandex',
  sber: 'Сбер',
  stability: 'Stability AI',
  elevenlabs: 'ElevenLabs',
  runway: 'Runway',
  baai: 'BAAI',
  flux: 'Black Forest Labs',
  midjourney: 'Midjourney',
  kandinsky: 'Kandinsky',
  kling: 'Kuaishou',
  suno: 'Suno',
  recraft: 'Recraft',
  ideogram: 'Ideogram',
  topaz: 'Topaz',
  hunyuan: 'Tencent',
  veo: 'Google',
  hailuo: 'Minimax',
  wan: 'Alibaba',
  ltx: 'Lightricks',
  seedance: 'Seedance',
  riffusion: 'Riffusion',
  esrgan: 'ESRGAN',
  codeformer: 'CodeFormer',
  rembg: 'REMBG',
};

function toOrgName(orgSlug: string): string {
  if (ORG_NAME_MAP[orgSlug]) return ORG_NAME_MAP[orgSlug];
  // Title-case fallback
  return orgSlug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Gateway type → ModelType mapping
// ---------------------------------------------------------------------------
function toModelType(gatewayType: string): ModelType {
  switch (gatewayType) {
    case 'chat':
    case 'completion':
      return 'llm';
    case 'embedding':
      return 'embedding';
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    default:
      return 'llm';
  }
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-hash for reproducible stats (no Math.random)
// ---------------------------------------------------------------------------
function slugHash(slug: string): number {
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = (h * 16777619) >>> 0; // unsigned 32-bit
  }
  return h;
}

function deterministicStats(slug: string, modelType: ModelType) {
  const h = slugHash(slug);
  // Derive 5 independent sub-hashes by mixing with different primes
  const h1 = (h * 2654435761) >>> 0;
  const h2 = (h * 2246822519) >>> 0;
  const h3 = (h * 3266489917) >>> 0;
  const h4 = (h * 2654435769) >>> 0;
  const h5 = (h * 374761393) >>> 0;

  // avgRating: 4.4 – 4.9 (step 0.1)
  const avgRating = +(4.4 + (h1 % 6) * 0.1).toFixed(1);

  // totalReviews: 20 – 400
  const totalReviews = 20 + (h2 % 381);

  // weeklyRequests: 1000 – 80000
  const weeklyRequests = 1000 + (h3 % 79001);

  // p50LatencyMs: depends on type
  let latencyMin: number;
  let latencyRange: number;
  switch (modelType) {
    case 'embedding':
      latencyMin = 80;
      latencyRange = 300;
      break;
    case 'image':
    case 'video':
      latencyMin = 3000;
      latencyRange = 30000;
      break;
    case 'audio':
      latencyMin = 500;
      latencyRange = 4000;
      break;
    default:
      latencyMin = 200;
      latencyRange = 1000;
  }
  const p50LatencyMs = latencyMin + (h4 % (latencyRange + 1));

  // uptimePct: 99.0 – 99.95 (step 0.05)
  const uptimeSteps = 20; // 20 possible values × 0.05 = 1.0 range
  const uptimePct = +(99.0 + (h5 % (uptimeSteps + 1)) * 0.05).toFixed(2);

  return { avgRating, totalReviews, weeklyRequests, p50LatencyMs, uptimePct };
}

// ---------------------------------------------------------------------------
// Strip upstream provider mentions from description text.
// Removes routing-layer names (OpenRouter, Kie.ai, Together, Replicate, Fal,
// HF Inference, TG-bridge, Gonka/GonkaGate) while preserving model brand names.
// Patterns handled:
//   "— через Kie.ai"  "через Kie.ai-обёртку"  "Через Replicate."
//   "Доступно через OpenRouter."  "via Fal.ai"  "через TG-bridge: …"
//   "через HF Inference"  "через Together"  ", доступная через GonkaGate"
// ---------------------------------------------------------------------------
const UPSTREAM_RE =
  /(?:(?:—\s*)?(?:доступно\s+)?(?:через|available\s+via|via)\s+(?:openrouter|kie(?:\.ai)?(?:-обёртку)?|together(?:\.ai)?|replicate|fal(?:\.ai)?|hf(?:\s+inference)?|hugging\s*face|tg[- ]?bridge|gonka(?:gate)?)[^.\n]*\.?)/gi;

// Also remove bare standalone "Через Upstream." or "Via Upstream." sentences that
// start a clause (capitalised, preceded by ". " or start-of-string).
const UPSTREAM_CLAUSE_RE =
  /(?:^|(?<=\.\s))(?:Через|Via)\s+(?:Replicate|OpenRouter|Kie(?:\.ai)?|Together(?:\.ai)?|Fal(?:\.ai)?|HF(?:\s+Inference)?|Hugging\s*Face|TG[- ]?bridge|Gonka(?:Gate)?)[^.]*\./gi;

// Handles the gendered adjective form ("доступная/доступное/доступный через
// X") that UPSTREAM_RE's "доступно\s+" (neuter-only) doesn't cover, and
// consumes the leading ", " so no orphan adjective is left behind — e.g.
// "MoE-модель, доступная через GonkaGate." → "MoE-модель.".
const UPSTREAM_ADJ_CLAUSE_RE =
  /,?\s*доступн(?:а|о|ый|ая|ые)\s+через\s+(?:GonkaGate|Gonka|OpenRouter|Kie(?:\.ai)?|Together(?:\.ai)?|Fal(?:\.ai)?|HF(?:\s+Inference)?|Hugging\s*Face|TG[- ]?bridge|Replicate)\b/gi;

function stripUpstream(text: string | null): string | null {
  if (!text) return text;
  let result = text;
  // First pass: remove gendered "доступная через X" clauses (incl. leading comma)
  result = result.replace(UPSTREAM_ADJ_CLAUSE_RE, '');
  // Second pass: remove standalone upstream clauses like "Через Replicate."
  result = result.replace(UPSTREAM_CLAUSE_RE, '');
  // Third pass: remove inline upstream mentions like "через Kie.ai-обёртку"
  result = result.replace(UPSTREAM_RE, '');
  // Clean up artifacts:
  // 1. Collapse multiple spaces
  result = result.replace(/\s{2,}/g, ' ');
  // 2. Remove orphan leading dashes/commas
  result = result.replace(/^\s*[—–-]\s*/, '');
  // 3. Remove orphan trailing dashes/commas
  result = result.replace(/\s*[—–,]\s*$/, '');
  result = result.trim();
  return result || null;
}

// ---------------------------------------------------------------------------
// Strip a trailing "(Kie)" / "(HF)" / etc. routing-layer suffix from display
// names. These suffixes exist purely to disambiguate DB rows that hit
// different upstream brokers for the same model — they must never reach the
// public model name (white-label rule, SECURITY.md).
// ---------------------------------------------------------------------------
const NAME_SUFFIX_RE =
  /\s*\((?:Kie|HF|Hugging\s*Face|Replicate|Fal(?:\.ai)?|Together(?:\.ai)?|OpenRouter|TG[- ]?bridge|Gonka(?:Gate)?)\)\s*$/i;

function stripNameSuffix(name: string): string {
  return name.replace(NAME_SUFFIX_RE, '').trim();
}

// ---------------------------------------------------------------------------
// White-label de-duplication + display-org override.
//
// Some models are reachable through two upstream brokers (e.g. a direct
// route AND a Kie.ai-wrapped route) and exist as two separate DB rows that
// differ only by a routing suffix on the slug. Publishing both as separate
// catalog entries would surface the routing layer as if it were a second
// product. We keep exactly ONE public listing per model — the entry below
// maps the routing-only duplicate onto the row we keep. The dropped row's DB
// data is untouched; this only changes what the static catalog renders.
// ---------------------------------------------------------------------------
const DUPLICATE_OF: Record<string, string> = {
  'elevenlabs-tts-kie': 'elevenlabs-tts-hf',
  'flux-dev-kie': 'flux-dev',
  'flux-pro-1-1-kie': 'flux-pro-1-1',
  'recraft-v3-kie': 'recraft-v3',
  'sd-3-5-kie': 'stable-diffusion-3-5',
};

// A routing-layer prefix that leaked into the DB slug as if it were the
// model's creator org (e.g. "gonka/qwen3-235b" — Gonka is the decentralized
// compute broker we route through, not who made Qwen3). Overrides the
// DISPLAY orgSlug/orgName only; `CatalogModel.slug` (the API id used in code
// samples + gateway routing) is left untouched — routing is unaffected.
// Extend this map, keyed by full DB slug, if another routing-layer org name
// ever leaks the same way.
const DISPLAY_ORG_OVERRIDE: Record<string, { orgSlug: string; orgName: string }> = {
  'gonka/qwen3-235b': { orgSlug: 'qwen', orgName: 'Qwen' },
  // "together" is Together.ai — an inference broker, not Llama's creator.
  // Bucket it into the same display org as the other Llama entry (Meta).
  'together/llama-3.1-70b': { orgSlug: 'meta-llama', orgName: 'Meta' },
};

// Routing suffix baked into flat (no "/") DB slugs — stripped from the
// PUBLIC url segment only. `CatalogModel.slug` keeps the suffix (still
// needed for code samples / gateway routing); `CatalogModel.modelSlug` (the
// URL + lookup key) does not.
const URL_SUFFIX_STRIP_RE = /-(?:kie|hf)$/i;

// ---------------------------------------------------------------------------
// Short description: first sentence, capped at 90 chars
// ---------------------------------------------------------------------------
function shortDesc(description: string | null): string {
  if (!description) return '';
  const sentence = description.split(/[.!?]/)[0].trim();
  return sentence.length <= 90 ? sentence : sentence.slice(0, 87) + '...';
}

// ---------------------------------------------------------------------------
// Featured flagships
// ---------------------------------------------------------------------------
const FEATURED_SLUGS = new Set([
  'anthropic/claude-opus-4-8',
  'openai/gpt-5-5',
  'openai/gpt-5-5-pro',
  'google/gemini-3-5-flash',
  'deepseek/deepseek-v4-pro',
  'x-ai/grok-4-3',
]);

// ---------------------------------------------------------------------------
// Row → CatalogModel
// ---------------------------------------------------------------------------
interface DbRow {
  slug: string;
  type: string;
  display_name: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  family: string | null;
  version: string | null;
  superseded_by_slug: string | null;
  superseded_by_name: string | null;
  price_per_1k_input: string | null;
  price_per_1k_output: string | null;
  price_per_image: string | null;
  price_per_audio_sec: string | null;
  markup: string | null;
}

function rowToCatalogModel(row: DbRow): CatalogModel {
  const slug = row.slug;
  const parts = slug.split('/');
  const orgSlug = parts.length >= 2 ? parts[0] : ((row.metadata.provider_family as string) ?? slug);
  const modelSlug = parts.length >= 2 ? parts.slice(1).join('/') : slug;
  const orgName = toOrgName(orgSlug);
  const modelType = toModelType(row.type);

  // Pricing
  const markup = parseFloat(row.markup ?? '1.0') || 1.0;
  const inputRaw = parseFloat(row.price_per_1k_input ?? '0') || 0;
  const outputRaw = parseFloat(row.price_per_1k_output ?? '0') || 0;
  const imageRaw = parseFloat(row.price_per_image ?? '0') || 0;
  const audioSecRaw = parseFloat(row.price_per_audio_sec ?? '0') || 0;

  const pricing: CatalogModel['pricing'] = {};
  if (inputRaw > 0) pricing.inputPer1k = +((inputRaw * markup).toFixed(6));
  if (outputRaw > 0) pricing.outputPer1k = +((outputRaw * markup).toFixed(6));
  if (imageRaw > 0) pricing.perImage = +((imageRaw * markup).toFixed(4));
  if (audioSecRaw > 0) {
    // per-second → per-minute for UI
    pricing.perMinute = +((audioSecRaw * 60 * markup).toFixed(4));
  }
  if (modelType === 'video' && imageRaw > 0) {
    // For video the price_per_image column stores per-clip price
    pricing.perSecond = +((imageRaw * markup).toFixed(4));
    delete pricing.perImage; // expose as perSecond for video type
  }

  // Set unit label
  switch (modelType) {
    case 'llm':
    case 'embedding':
      pricing.unit = '1K токенов';
      break;
    case 'image':
      pricing.unit = 'изображение';
      break;
    case 'audio':
      pricing.unit = audioSecRaw > 0 ? 'минута' : 'трек';
      break;
    case 'video':
      pricing.unit = 'секунда';
      break;
  }

  // Tags from metadata
  const metaTags = (row.metadata.tags as string[] | undefined) ?? [];

  // Capabilities
  const contextWindow = (row.metadata.context_window as number | undefined) ?? 0;
  const hasTools = metaTags.some((t) => t === 'tools' || t === 'agent');
  const hasVision = metaTags.some((t) => t === 'vision' || t === 'multimodal');
  const capabilities: CatalogModel['capabilities'] = {
    streaming: modelType === 'llm',
    tools: hasTools,
    vision: hasVision,
    jsonSchema: hasTools, // tools models typically support JSON schema
    batch: false,
    contextWindow: contextWindow || undefined,
  };

  // Hosting region
  const rawRegion = row.metadata.hosted_region as string | undefined;
  const VALID_REGIONS = new Set<HostingRegion>(['ru', 'eu', 'us', 'global']);
  const hostingRegion: HostingRegion = VALID_REGIONS.has(rawRegion as HostingRegion)
    ? (rawRegion as HostingRegion)
    : 'global';

  const stats = deterministicStats(slug, modelType);

  const cleanedDescription = stripUpstream(row.description);

  // Display-only overrides — `slug` (API id / gateway routing key) stays raw.
  const orgOverride = DISPLAY_ORG_OVERRIDE[slug];
  const displayOrgSlug = orgOverride?.orgSlug ?? orgSlug;
  const displayOrgName = orgOverride?.orgName ?? orgName;
  const displayModelSlug = URL_SUFFIX_STRIP_RE.test(modelSlug)
    ? modelSlug.replace(URL_SUFFIX_STRIP_RE, '')
    : modelSlug;

  const model: CatalogModel = {
    slug,
    orgSlug: displayOrgSlug,
    orgName: displayOrgName,
    modelSlug: displayModelSlug,
    // Fallback (missing display_name) uses the model-only segment, never the
    // full `org/model` slug — the org segment can itself be a routing-layer
    // name (e.g. "together/llama-3.1-70b" would otherwise show "together").
    name: stripNameSuffix(row.display_name ?? displayModelSlug),
    shortDescription: shortDesc(cleanedDescription),
    description: cleanedDescription ?? '',
    type: modelType,
    hostingRegion,
    tags: metaTags,
    derivedTags: [],
    pricing,
    capabilities,
    stats,
  };

  if (FEATURED_SLUGS.has(slug)) model.featured = true;
  if (row.family) model.family = row.family;
  if (row.version) model.version = row.version;
  if (row.superseded_by_slug) model.supersededBySlug = row.superseded_by_slug;
  if (row.superseded_by_name) model.supersededByName = row.superseded_by_name;

  return model;
}

// ---------------------------------------------------------------------------
// Serialise a CatalogModel to a compact TS literal string
// ---------------------------------------------------------------------------
function serializeValue(v: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (v === null || v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((item) => serializeValue(item, indent + 1)).join(', ');
    // Keep short arrays on one line
    if (items.length < 60) return `[${items}]`;
    return `[\n${v.map((item) => `${padInner}${serializeValue(item, indent + 1)}`).join(',\n')},\n${pad}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(
      ([, val]) => val !== undefined
    );
    if (entries.length === 0) return '{}';
    const lines = entries
      .map(([k, val]) => `${padInner}${k}: ${serializeValue(val, indent + 1)}`)
      .join(',\n');
    return `{\n${lines},\n${pad}}`;
  }
  return JSON.stringify(v);
}

function serializeModel(m: CatalogModel): string {
  return serializeValue(m as unknown as Record<string, unknown>, 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const dumpPath = process.env.CATALOG_DUMP_JSON;
  const allRows: DbRow[] = dumpPath
    ? (JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as DbRow[])
    : await getRowsFromDb();

  console.log(`Loaded ${allRows.length} models (${dumpPath ? dumpPath : 'live DB'}).`);

  // Drop routing-only duplicates (see DUPLICATE_OF) — one public listing per model.
  const rows = allRows.filter((r) => !(r.slug in DUPLICATE_OF));
  const models = rows.map(rowToCatalogModel);

  const catalogLiteral = models.map((m) => `  ${serializeModel(m)}`).join(',\n');

  const output = [
    '// AUTO-GENERATED by packages/database/scripts/gen-marketplace-catalog.ts — do not edit by hand.',
    '// Re-generate: cd packages/database && bun run scripts/gen-marketplace-catalog.ts',
    `// Generated: ${new Date().toISOString().slice(0, 10)} — ${models.length} models`,
    "import type { CatalogModel } from './catalog';",
    '',
    'export const GENERATED_CATALOG: CatalogModel[] = [',
    catalogLiteral,
    '];',
    '',
  ].join('\n');

  const outPath = path.resolve(
    __dirname,
    '../../../apps/web/src/lib/marketplace/catalog.generated.ts'
  );
  fs.writeFileSync(outPath, output, 'utf-8');
  console.log(`Written ${models.length} models to ${outPath}`);

  // ---------------------------------------------------------------------------
  // Legacy URL redirects — every model URL that moves (routing suffix
  // stripped, duplicate dropped, display-org overridden) 301s from its old
  // path to its new one so already-indexed/shared links don't dead-end.
  // Computed programmatically from allRows so it never drifts from the
  // catalog transform above.
  // ---------------------------------------------------------------------------
  const byRawSlug = new Map(allRows.map((r) => [r.slug, r] as const));
  const redirects: Array<{ source: string; destination: string }> = [];
  for (const row of allRows) {
    const rawParts = row.slug.split('/');
    const rawOrgSlug =
      rawParts.length >= 2 ? rawParts[0] : ((row.metadata.provider_family as string) ?? row.slug);
    const rawModelSlug = rawParts.length >= 2 ? rawParts.slice(1).join('/') : row.slug;
    const rawPath = `/marketplace/${rawOrgSlug}/${rawModelSlug}`;

    const canonicalSlug = DUPLICATE_OF[row.slug] ?? row.slug;
    const canonicalRow = byRawSlug.get(canonicalSlug);
    if (!canonicalRow) continue; // DUPLICATE_OF target missing from the row set — skip, nothing to redirect to
    const canonicalModel = rowToCatalogModel(canonicalRow);
    const newPath = `/marketplace/${canonicalModel.orgSlug}/${canonicalModel.modelSlug}`;

    if (rawPath !== newPath) redirects.push({ source: rawPath, destination: newPath });
  }

  const redirectsOutPath = path.resolve(
    __dirname,
    '../../../apps/web/src/lib/marketplace/legacy-redirects.generated.json'
  );
  fs.writeFileSync(redirectsOutPath, JSON.stringify(redirects, null, 2) + '\n', 'utf-8');
  console.log(`Written ${redirects.length} legacy redirects to ${redirectsOutPath}`);
}

main().catch((err) => {
  console.error('gen-marketplace-catalog failed:', err);
  process.exit(1);
});
