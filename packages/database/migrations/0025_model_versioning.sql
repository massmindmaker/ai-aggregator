-- =============================================================================
-- 0025: Add model versioning metadata (family, version, released_at,
--       superseded_by) to the models table.
--
-- Позволяет UI группировать модели одной линейки (family) и отображать
-- бейдж «есть новая версия» (superseded_by IS NOT NULL).
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS; UPDATE идемпотентен по природе;
--   superseded_by-апдейты защищены EXISTS-guard-ом. Безопасно перезапускать.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step A: Add columns + index
-- -----------------------------------------------------------------------------
ALTER TABLE models ADD COLUMN IF NOT EXISTS family        VARCHAR(64);
ALTER TABLE models ADD COLUMN IF NOT EXISTS version       VARCHAR(32);
ALTER TABLE models ADD COLUMN IF NOT EXISTS released_at   DATE;
ALTER TABLE models ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES models(id);

CREATE INDEX IF NOT EXISTS models_family_idx ON models (family);

-- -----------------------------------------------------------------------------
-- Step B: Backfill family + version (32 chat models)
--         Non-chat models (embedding/image/video/audio) — NOT touched → NULL.
-- -----------------------------------------------------------------------------
UPDATE models SET family = 'gpt',           version = '4o'         WHERE slug = 'openai/gpt-4o';
UPDATE models SET family = 'gpt',           version = '4o-mini'    WHERE slug = 'openai/gpt-4o-mini';
UPDATE models SET family = 'o-series',      version = 'o1-mini'    WHERE slug = 'openai/o1-mini';
UPDATE models SET family = 'o-series',      version = 'o3-mini'    WHERE slug = 'openai/o3-mini';
UPDATE models SET family = 'gpt',           version = '5.5'        WHERE slug = 'openai/gpt-5-5';
UPDATE models SET family = 'gpt',           version = '5.5-pro'    WHERE slug = 'openai/gpt-5-5-pro';
UPDATE models SET family = 'gpt',           version = '5.4'        WHERE slug = 'openai/gpt-5-4';
UPDATE models SET family = 'gpt',           version = '5.4-mini'   WHERE slug = 'openai/gpt-5-4-mini';
UPDATE models SET family = 'gpt',           version = '5.4-nano'   WHERE slug = 'openai/gpt-5-4-nano';
UPDATE models SET family = 'claude-opus',   version = '4.8'        WHERE slug = 'anthropic/claude-opus-4-8';
UPDATE models SET family = 'claude-opus',   version = '4.8-fast'   WHERE slug = 'anthropic/claude-opus-4-8-fast';
UPDATE models SET family = 'claude-opus',   version = '4.7'        WHERE slug = 'anthropic/claude-opus-4-7';
UPDATE models SET family = 'claude-sonnet', version = '4.6'        WHERE slug = 'anthropic/claude-sonnet-4-6';
UPDATE models SET family = 'claude-sonnet', version = '4.5'        WHERE slug = 'anthropic/claude-sonnet-4-5';
UPDATE models SET family = 'claude-haiku',  version = '4.5'        WHERE slug = 'anthropic/claude-haiku-4-5';
UPDATE models SET family = 'gemini',        version = '3.5-flash'  WHERE slug = 'google/gemini-3-5-flash';
UPDATE models SET family = 'gemini',        version = '3.1-pro'    WHERE slug = 'google/gemini-3-1-pro';
UPDATE models SET family = 'gemini',        version = '3.1-flash-lite' WHERE slug = 'google/gemini-3-1-flash-lite';
UPDATE models SET family = 'gemini',        version = '2.5-flash'  WHERE slug = 'google/gemini-2-5-flash';
UPDATE models SET family = 'gemini',        version = '2.5-pro'    WHERE slug = 'google/gemini-2-5-pro';
UPDATE models SET family = 'deepseek',      version = 'v4-pro'     WHERE slug = 'deepseek/deepseek-v4-pro';
UPDATE models SET family = 'deepseek',      version = 'v4-flash'   WHERE slug = 'deepseek/deepseek-v4-flash';
UPDATE models SET family = 'deepseek',      version = 'v3'         WHERE slug = 'deepseek/deepseek-v3';
UPDATE models SET family = 'deepseek',      version = 'r1'         WHERE slug = 'deepseek/deepseek-r1';
UPDATE models SET family = 'grok',          version = '4.3'        WHERE slug = 'x-ai/grok-4-3';
UPDATE models SET family = 'grok',          version = '4.20'       WHERE slug = 'x-ai/grok-4-20';
UPDATE models SET family = 'qwen',          version = '3.7-max'    WHERE slug = 'qwen/qwen3-7-max';
UPDATE models SET family = 'mistral',       version = 'medium-3.5' WHERE slug = 'mistralai/mistral-medium-3-5';
UPDATE models SET family = 'llama',         version = '3.3-70b'    WHERE slug = 'meta-llama/llama-3-3-70b';
UPDATE models SET family = 'yandexgpt',     version = '5-lite'     WHERE slug = 'yandex/yandexgpt-5-lite';
UPDATE models SET family = 'yandexgpt',     version = '5-pro'      WHERE slug = 'yandex/yandexgpt-5-pro';
UPDATE models SET family = 'gigachat',      version = 'pro'        WHERE slug = 'sber/gigachat-pro';

-- -----------------------------------------------------------------------------
-- Step C: Backfill superseded_by (11 chains)
--         EXISTS guard prevents FK errors if a target slug is missing.
-- -----------------------------------------------------------------------------
UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'anthropic/claude-opus-4-8')
  WHERE slug = 'anthropic/claude-opus-4-7'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'anthropic/claude-opus-4-8');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'anthropic/claude-sonnet-4-6')
  WHERE slug = 'anthropic/claude-sonnet-4-5'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'anthropic/claude-sonnet-4-6');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'openai/gpt-5-5')
  WHERE slug = 'openai/gpt-5-4'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'openai/gpt-5-5');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'openai/gpt-5-4')
  WHERE slug = 'openai/gpt-4o'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'openai/gpt-5-4');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'openai/gpt-5-4-mini')
  WHERE slug = 'openai/gpt-4o-mini'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'openai/gpt-5-4-mini');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'openai/gpt-5-4-mini')
  WHERE slug = 'openai/o1-mini'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'openai/gpt-5-4-mini');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'openai/gpt-5-4-mini')
  WHERE slug = 'openai/o3-mini'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'openai/gpt-5-4-mini');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'google/gemini-3-5-flash')
  WHERE slug = 'google/gemini-2-5-flash'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'google/gemini-3-5-flash');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'google/gemini-3-1-pro')
  WHERE slug = 'google/gemini-2-5-pro'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'google/gemini-3-1-pro');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'deepseek/deepseek-v4-pro')
  WHERE slug = 'deepseek/deepseek-v3'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'deepseek/deepseek-v4-pro');

UPDATE models
  SET superseded_by = (SELECT id FROM models WHERE slug = 'deepseek/deepseek-v4-pro')
  WHERE slug = 'deepseek/deepseek-r1'
    AND EXISTS (SELECT 1 FROM models WHERE slug = 'deepseek/deepseek-v4-pro');
