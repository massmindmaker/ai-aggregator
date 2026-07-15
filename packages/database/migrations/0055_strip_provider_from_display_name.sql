-- fix/whitelabel-displayname-finish: models.display_name leaks the upstream
-- routing broker to end users.
--
-- Root cause (verified via SELECT on prod, browser-QA 2026-07-15): dozens of
-- `models` rows carry a "(Kie)" (and other upstream-broker) suffix baked
-- directly into `display_name`, e.g. `dalle-3-kie -> "DALL-E 3 (Kie)"`,
-- `kling-3-0-kie -> "Kling 3.0 (Kie)"`. The static marketplace catalog
-- (catalog.generated.ts) was already cleaned in a prior fix by stripping
-- this suffix at build time — but pages that read `models.display_name`
-- straight from the live DB (home "Top models" widget, the reviews page)
-- render the raw column, so the same suffix leaks there. This migration
-- fixes the data at the source so every future reader (built or not-yet-
-- built) inherits clean names, in addition to the app-level
-- `stripProviderBrand()` guard added alongside it.
--
-- Scope, deliberately narrow:
--  - Only strips a trailing "(Provider)" parenthetical / "через Provider"
--    mention. Does NOT touch `slug` (URL stability, gateway routing) or any
--    pricing/routing column — display_name/description are cosmetic.
--  - Does NOT merge or delete duplicate rows (e.g. `flux-pro-1-1` vs
--    `flux-pro-1-1-kie` both existing with the same clean display name after
--    this runs). That is a data/product decision (model de-dup), tracked as
--    follow-up debt, not done here.
--  - Idempotent: safe to re-run. A row whose display_name/description has
--    already been cleaned is a no-op (the regex simply finds nothing to
--    replace).

BEGIN;

UPDATE models
SET display_name = btrim(
  regexp_replace(
    display_name,
    '\s*\((Kie|Gonka|GonkaGate|OpenRouter|Together|Together\.ai|Replicate|Fal|Fal\.ai|HF|Hugging Face|TG-bridge|TG bridge)\)\s*$',
    '',
    'gi'
  )
)
WHERE display_name IS NOT NULL
  AND display_name ~* '\s*\((Kie|Gonka|GonkaGate|OpenRouter|Together|Together\.ai|Replicate|Fal|Fal\.ai|HF|Hugging Face|TG-bridge|TG bridge)\)\s*$';

-- Same suffix pattern occasionally lands in description too (e.g. a
-- moderator pasted "... — через Kie.ai"). Strip only the trailing
-- parenthetical form here (mirrors display_name); the free-text "через X"
-- prose form is already handled by the catalog generator's stripUpstream()
-- and is out of scope for a blunt regexp UPDATE (higher risk of mangling a
-- real sentence).
UPDATE models
SET description = btrim(
  regexp_replace(
    description,
    '\s*\((Kie|Gonka|GonkaGate|OpenRouter|Together|Together\.ai|Replicate|Fal|Fal\.ai|HF|Hugging Face|TG-bridge|TG bridge)\)\s*$',
    '',
    'gi'
  )
)
WHERE description IS NOT NULL
  AND description ~* '\s*\((Kie|Gonka|GonkaGate|OpenRouter|Together|Together\.ai|Replicate|Fal|Fal\.ai|HF|Hugging Face|TG-bridge|TG bridge)\)\s*$';

COMMIT;
