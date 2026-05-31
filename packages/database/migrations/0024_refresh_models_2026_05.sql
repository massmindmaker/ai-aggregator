-- =============================================================================
-- 0024: Refresh LLM model catalog — May 2026 flagship models.
--
-- Добавляет актуальные флагманские LLM (Anthropic, OpenAI, Google, xAI,
-- DeepSeek, Qwen, Mistral) по данным OpenRouter на май 2026 г.
-- Все модели роутятся через upstream `openrouter`.
--
-- Идемпотентно: ON CONFLICT DO NOTHING. Безопасно перезапускать.
--
-- Конвертация цен: price_per_1k_RUB = usd_per_1M × 0.1
-- (верифицировано на 0006: Sonnet $3/$15 per 1M → 0.30/1.50 RUB per 1k)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Models
-- -----------------------------------------------------------------------------
INSERT INTO models (slug, type, enabled, display_name, description, metadata) VALUES
  -- ===================== Anthropic =====================
  ('anthropic/claude-opus-4-8', 'chat', true, 'Claude Opus 4.8',
    'Флагман Anthropic Opus 4.8 — топ reasoning, код и агентские задачи, 1M контекст.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','code','agent','vision','multimodal','long-context'],'hosted_region','global','provider_family','anthropic','context_window',1000000)),
  ('anthropic/claude-opus-4-8-fast', 'chat', true, 'Claude Opus 4.8 Fast',
    'Ускоренный Opus 4.8 — низкая задержка при сохранении качества флагмана.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','code','agent','vision','multimodal','long-context','fast'],'hosted_region','global','provider_family','anthropic','context_window',1000000)),
  ('anthropic/claude-opus-4-7', 'chat', true, 'Claude Opus 4.7',
    'Предыдущий флагман Anthropic Opus 4.7 — надёжный выбор для сложных задач с 1M контекстом.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','code','agent','vision','multimodal','long-context'],'hosted_region','global','provider_family','anthropic','context_window',1000000)),
  ('anthropic/claude-sonnet-4-6', 'chat', true, 'Claude Sonnet 4.6',
    'Sonnet 4.6 — оптимальный баланс цены и качества от Anthropic, 1M контекст.',
    jsonb_build_object('tags',ARRAY['llm','code','agent','vision','multimodal','long-context'],'hosted_region','global','provider_family','anthropic','context_window',1000000)),

  -- ===================== OpenAI =====================
  ('openai/gpt-5-5', 'chat', true, 'GPT-5.5',
    'Флагман OpenAI GPT-5.5 — мультимодальная модель нового поколения.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','vision','code','agent'],'hosted_region','global','provider_family','openai','context_window',1050000)),
  ('openai/gpt-5-5-pro', 'chat', true, 'GPT-5.5 Pro',
    'GPT-5.5 Pro — максимальная версия GPT-5.5 с усиленным reasoning.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','multimodal','vision','code','agent'],'hosted_region','global','provider_family','openai','context_window',1050000)),
  ('openai/gpt-5-4', 'chat', true, 'GPT-5.4',
    'GPT-5.4 — рабочая лошадка OpenAI: надёжный баланс цены и качества.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','vision','code'],'hosted_region','global','provider_family','openai','context_window',1050000)),
  ('openai/gpt-5-4-mini', 'chat', true, 'GPT-5.4 mini',
    'GPT-5.4 mini — быстрая и дешёвая версия GPT-5.4 для массовых задач.',
    jsonb_build_object('tags',ARRAY['llm','fast','cheap'],'hosted_region','global','provider_family','openai','context_window',400000)),
  ('openai/gpt-5-4-nano', 'chat', true, 'GPT-5.4 nano',
    'GPT-5.4 nano — сверхдешёвая модель для high-volume сценариев.',
    jsonb_build_object('tags',ARRAY['llm','fast','cheap'],'hosted_region','global','provider_family','openai','context_window',400000)),

  -- ===================== Google =====================
  ('google/gemini-3-5-flash', 'chat', true, 'Gemini 3.5 Flash',
    'Gemini 3.5 Flash — быстрая мультимодальная модель Google с большим контекстом.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','vision','fast','cheap'],'hosted_region','global','provider_family','google','context_window',1050000)),
  ('google/gemini-3-1-pro', 'chat', true, 'Gemini 3.1 Pro',
    'Gemini 3.1 Pro — мощная мультимодальная модель Google с поддержкой reasoning.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','vision','reasoning'],'hosted_region','global','provider_family','google','context_window',1050000)),
  ('google/gemini-3-1-flash-lite', 'chat', true, 'Gemini 3.1 Flash-Lite',
    'Gemini 3.1 Flash-Lite — самая дешёвая модель Google с большим контекстом.',
    jsonb_build_object('tags',ARRAY['llm','fast','cheap'],'hosted_region','global','provider_family','google','context_window',1050000)),

  -- ===================== xAI =====================
  ('x-ai/grok-4-3', 'chat', true, 'Grok 4.3',
    'Grok 4.3 от xAI — мощная мультимодальная модель с реальновременным доступом к данным.',
    jsonb_build_object('tags',ARRAY['llm','vision','multimodal'],'hosted_region','global','provider_family','xai','context_window',1000000)),
  ('x-ai/grok-4-20', 'chat', true, 'Grok 4.20',
    'Grok 4.20 от xAI — расширенный вариант с 2M контекстом.',
    jsonb_build_object('tags',ARRAY['llm','vision','multimodal','long-context'],'hosted_region','global','provider_family','xai','context_window',2000000)),

  -- ===================== DeepSeek =====================
  ('deepseek/deepseek-v4-pro', 'chat', true, 'DeepSeek V4 Pro',
    'DeepSeek V4 Pro — открытая SOTA-модель: конкурентное качество по минимальной цене.',
    jsonb_build_object('tags',ARRAY['llm','open','cheap'],'hosted_region','global','provider_family','deepseek','context_window',1050000)),
  ('deepseek/deepseek-v4-flash', 'chat', true, 'DeepSeek V4 Flash',
    'DeepSeek V4 Flash — сверхдешёвая открытая модель для high-volume задач.',
    jsonb_build_object('tags',ARRAY['llm','open','cheap','fast'],'hosted_region','global','provider_family','deepseek','context_window',1050000)),

  -- ===================== Qwen =====================
  ('qwen/qwen3-7-max', 'chat', true, 'Qwen 3.7 Max',
    'Qwen 3.7 Max — флагман Alibaba с 1M контекстом и сильным multilingual.',
    jsonb_build_object('tags',ARRAY['llm','long-context','open'],'hosted_region','global','provider_family','qwen','context_window',1000000)),

  -- ===================== Mistral =====================
  ('mistralai/mistral-medium-3-5', 'chat', true, 'Mistral Medium 3.5',
    'Mistral Medium 3.5 — сбалансированная европейская LLM с контекстом 262k.',
    jsonb_build_object('tags',ARRAY['llm','code'],'hosted_region','global','provider_family','mistral','context_window',262144))
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Routing (model_upstreams) — все через openrouter, markup 1.07
-- -----------------------------------------------------------------------------
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output, markup)
SELECT m.id, s.upstream_id, s.upstream_model_id, s.price_in, s.price_out, s.markup
FROM (VALUES
  -- Anthropic
  ('anthropic/claude-opus-4-8',       'openrouter', 'anthropic/claude-opus-4.8',       0.50::numeric,   2.50::numeric,  1.07::numeric),
  ('anthropic/claude-opus-4-8-fast',  'openrouter', 'anthropic/claude-opus-4.8-fast',  1.00::numeric,   5.00::numeric,  1.07::numeric),
  ('anthropic/claude-opus-4-7',       'openrouter', 'anthropic/claude-opus-4.7',       0.50::numeric,   2.50::numeric,  1.07::numeric),
  ('anthropic/claude-sonnet-4-6',     'openrouter', 'anthropic/claude-sonnet-4.6',     0.30::numeric,   1.50::numeric,  1.07::numeric),
  -- OpenAI
  ('openai/gpt-5-5',                  'openrouter', 'openai/gpt-5.5',                  0.50::numeric,   3.00::numeric,  1.07::numeric),
  ('openai/gpt-5-5-pro',              'openrouter', 'openai/gpt-5.5-pro',              3.00::numeric,  18.00::numeric,  1.07::numeric),
  ('openai/gpt-5-4',                  'openrouter', 'openai/gpt-5.4',                  0.25::numeric,   1.50::numeric,  1.07::numeric),
  ('openai/gpt-5-4-mini',             'openrouter', 'openai/gpt-5.4-mini',             0.075::numeric,  0.45::numeric,  1.07::numeric),
  ('openai/gpt-5-4-nano',             'openrouter', 'openai/gpt-5.4-nano',             0.02::numeric,   0.125::numeric, 1.07::numeric),
  -- Google
  ('google/gemini-3-5-flash',         'openrouter', 'google/gemini-3.5-flash',         0.15::numeric,   0.90::numeric,  1.07::numeric),
  ('google/gemini-3-1-pro',           'openrouter', 'google/gemini-3.1-pro-preview',   0.20::numeric,   1.20::numeric,  1.07::numeric),
  ('google/gemini-3-1-flash-lite',    'openrouter', 'google/gemini-3.1-flash-lite',    0.025::numeric,  0.15::numeric,  1.07::numeric),
  -- xAI
  ('x-ai/grok-4-3',                   'openrouter', 'x-ai/grok-4.3',                   0.125::numeric,  0.25::numeric,  1.07::numeric),
  ('x-ai/grok-4-20',                  'openrouter', 'x-ai/grok-4.20',                  0.125::numeric,  0.25::numeric,  1.07::numeric),
  -- DeepSeek
  ('deepseek/deepseek-v4-pro',        'openrouter', 'deepseek/deepseek-v4-pro',        0.0435::numeric, 0.087::numeric, 1.07::numeric),
  ('deepseek/deepseek-v4-flash',      'openrouter', 'deepseek/deepseek-v4-flash',      0.0098::numeric, 0.0197::numeric,1.07::numeric),
  -- Qwen
  ('qwen/qwen3-7-max',                'openrouter', 'qwen/qwen3.7-max',                0.125::numeric,  0.375::numeric, 1.07::numeric),
  -- Mistral
  ('mistralai/mistral-medium-3-5',    'openrouter', 'mistralai/mistral-medium-3-5',    0.15::numeric,   0.75::numeric,  1.07::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, price_in, price_out, markup)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;
