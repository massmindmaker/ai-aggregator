/**
 * White-label guard for model display names.
 *
 * Root cause (2026-07-15 QA): `models.display_name` in Postgres carries a
 * routing-layer suffix like "DALL-E 3 (Kie)" for rows that hit an upstream
 * broker (Kie.ai, Gonka, OpenRouter, ...). That suffix must never reach an
 * end user (white-label rule, SECURITY.md) — it names an internal broker,
 * not the model.
 *
 * A one-time DB migration strips the suffix from existing rows (see
 * packages/database/migrations), and the static catalog generator
 * (`packages/database/scripts/gen-marketplace-catalog.ts`) already strips it
 * at build time via its own `stripNameSuffix`. This helper is the same
 * pattern for the runtime paths that read `models.display_name` directly
 * from the live DB (the home "Top models" widget, the reviews page) — so a
 * freshly-inserted dirty row can never leak before the next catalog
 * regeneration/migration catches it.
 *
 * Keep the provider list in sync with `NAME_SUFFIX_RE` in
 * gen-marketplace-catalog.ts.
 */
const PROVIDER_SUFFIX_RE =
  /\s*\((?:Kie|HF|Hugging\s*Face|Replicate|Fal(?:\.ai)?|Together(?:\.ai)?|OpenRouter|TG[- ]?bridge|Gonka(?:Gate)?)\)\s*$/i;

export function stripProviderBrand(name: string | null | undefined): string {
  if (!name) return '';
  return name.replace(PROVIDER_SUFFIX_RE, '').trim();
}
