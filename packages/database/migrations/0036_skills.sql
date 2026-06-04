-- 0036_skills.sql
-- Screen 29 «Маркет скиллов» v1 — a light catalog table for KNOWLEDGE skills
-- (a SKILL.md-shaped instruction doc that gets prepended to an agent's system
-- prompt on install). NO money path, NO new runtime, NO executable scripts.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0036_skills.sql
-- Additive + idempotent: re-running is a no-op (CREATE TABLE/INDEX IF NOT EXISTS,
-- and the seed uses ON CONFLICT DO NOTHING keyed on the unique `name`).
--
-- SECURITY (share-spec, keep-secrets — enforced at the SCHEMA level, like
-- agent_templates 0031): this table has ZERO secret columns. There is NO
-- *_api_key, NO *_auth, NO *_encrypted column. A knowledge skill is public,
-- shareable instruction text only — there is physically nowhere to store a key.
--
-- FRONTMATTER SHAPE: we adopt the agentskills.io SKILL.md frontmatter verbatim
-- for forward-compat (import/export real SKILL.md files later):
--   name        1..64 chars, [a-z0-9-] only  → UNIQUE slug
--   description 1..1024 chars, "what it does AND when to use it"
--   license     optional
--   author/version live in a metadata JSONB map (the spec's metadata field)
-- `body` is the Markdown instruction text we attach to the agent prompt.
--
-- NOTE: executable `scripts/` bundles + `/skill-name` slash invocation +
-- open community submission are DEFERRED («скоро»/R&D) — they need a script
-- sandbox + managed-Hermes we do not have (see docs/specs/research/2026-06-04-R15-skills-hub.md).

CREATE TABLE IF NOT EXISTS skills (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SKILL.md frontmatter (agentskills.io spec) — PUBLIC, no secrets ----------
  name               TEXT NOT NULL,                    -- slug, [a-z0-9-], 1..64
  title              TEXT,                             -- human display name (RU)
  description        TEXT NOT NULL,                    -- what + when, <=1024
  body               TEXT NOT NULL DEFAULT '',         -- the instruction Markdown
  license            TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}',      -- {author, version, ...}

  author_tg_user_id  BIGINT,                           -- NULL = first-party seed
  visibility         TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'unlisted' | 'private'
  install_count      INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_skills_public
  ON skills(visibility, created_at DESC) WHERE visibility = 'public';

-- First-party seed: a few starter knowledge skills (instruction docs). These
-- install by PREPENDING `body` to the chosen agent's system_prompt — no exec.
INSERT INTO skills (name, title, description, body, metadata) VALUES
  (
    'seo-review',
    'SEO-ревью',
    'Проверяет текст или страницу по чек-листу SEO: заголовки, мета, плотность ключей, структура, перелинковка. Используй, когда нужно оценить или улучшить SEO материала.',
    E'Ты — SEO-редактор. Когда пользователь даёт текст или URL, проверь по чек-листу:\n1. Title и H1: один H1, есть ключ, до 60 символов.\n2. Meta description: 140–160 символов, с ключом, призывом.\n3. Структура: H2/H3 логичны, абзацы короткие.\n4. Ключи: основной + LSI, без переспама.\n5. Внутренние ссылки и alt у картинок.\nВыдай список проблем и конкретные правки, по приоритету.',
    '{"author": "aiag", "version": "1.0.0"}'
  ),
  (
    'meeting-summary',
    'Резюме встречи',
    'Превращает расшифровку или заметки встречи в краткое резюме: решения, задачи с ответственными, открытые вопросы. Используй для протоколов и follow-up.',
    E'Ты составляешь протокол встречи. Из присланного текста выдели строго:\n• Итог (2–3 предложения).\n• Решения (буллеты).\n• Задачи: «— [ответственный] что сделать, к какому сроку».\n• Открытые вопросы.\nНе придумывай фактов, которых нет в тексте.',
    '{"author": "aiag", "version": "1.0.0"}'
  ),
  (
    'legal-check',
    'Юридическая проверка',
    'Делает первичный разбор договора или оферты: стороны, предмет, ответственность, риски, спорные пункты. НЕ заменяет юриста — даёт пользователю карту рисков.',
    E'Ты — ассистент для первичного разбора документов. Разбери присланный договор:\n1. Стороны и предмет.\n2. Обязанности и сроки.\n3. Ответственность и штрафы.\n4. Риски и однобокие пункты (отметь явно).\n5. Что уточнить у юриста.\nВажно: всегда добавляй дисклеймер, что это не юридическая консультация.',
    '{"author": "aiag", "version": "1.0.0"}'
  )
ON CONFLICT (name) DO NOTHING;
