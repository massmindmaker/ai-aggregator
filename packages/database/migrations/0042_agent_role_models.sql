-- 0042: multimodel per-role — optional per-role model slugs on agents.
--
-- Additive, all nullable. The primary `model_slug` stays the chat/default model;
-- these three are OPTIONAL overrides the worker resolves per task role:
--   image_model_slug  → image generation (image_gen tool)
--   voice_model_slug  → voice / TTS
--   vision_model_slug → image-in-message (vision) input
-- A NULL slot means "use the primary model_slug" (worker fallback).
--
-- No money-path impact: the worker still bills by the model it actually calls
-- (settleRun / markup unchanged); this only adds WHICH slug is chosen per role.
-- Slugs are picked from the registered model registry in the UI exactly like the
-- primary model; an unregistered slug falls back to OpenRouter just like today.
--
-- NOT applied to prod by this task — apply manually before deploy (canon: prod
-- migrations are manual, no tracking).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS image_model_slug  TEXT,
  ADD COLUMN IF NOT EXISTS voice_model_slug  TEXT,
  ADD COLUMN IF NOT EXISTS vision_model_slug TEXT;
