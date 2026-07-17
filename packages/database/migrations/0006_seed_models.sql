-- =============================================================================
-- 0006: Seed marketplace models (LLM / embedding / image / audio / video).
--
-- Заполняет реестр models + model_upstreams реальными популярными моделями
-- через основные upstream-провайдеры: OpenRouter, Yandex, Together, Fal,
-- Replicate, HF Inference. Kie.ai-каталог — отдельным файлом 0006b.
--
-- Идемпотентно: ON CONFLICT DO NOTHING. Безопасно перезапускать.
--
-- Цены — US CENTS pre-markup (USD * 100). ⚠️ Исправлено 2026-07-16: раньше
-- здесь стояло "RUB pre-markup" — неверно, колонка в ЦЕНТАХ, не в рублях;
-- эта опечатка и породила 100×-баг в гейтвее (см. lib/pricing.ts,
-- 0059_pricing_unit_comments.sql, finmodel-build-spec.md "поправка v2").
-- Markup поле задаёт gateway-наценку.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Upstreams
-- -----------------------------------------------------------------------------
INSERT INTO upstreams (id, provider, ru_residency, enabled, latency_p50_ms, uptime, base_url, metadata) VALUES
  ('openrouter',  'openrouter', false, true, 350, 0.985, 'https://openrouter.ai/api/v1',
    jsonb_build_object('docs','https://openrouter.ai/docs','default_markup',1.07)),
  ('yandex',      'yandex',     true,  true, 200, 0.99,  'https://llm.api.cloud.yandex.net',
    jsonb_build_object('docs','https://yandex.cloud/ru/docs/foundation-models','default_markup',1.08)),
  ('together',    'together',   false, true, 400, 0.97,  'https://api.together.xyz/v1',
    jsonb_build_object('docs','https://docs.together.ai/','default_markup',1.15)),
  ('fal',         'fal',        false, true, 500, 0.97,  'https://fal.run',
    jsonb_build_object('docs','https://fal.ai/docs','default_markup',1.12)),
  ('replicate',   'replicate',  false, true, 700, 0.97,  'https://api.replicate.com/v1',
    jsonb_build_object('docs','https://replicate.com/docs','default_markup',1.12)),
  ('hf',          'hf',         false, true, 600, 0.95,  'https://api-inference.huggingface.co',
    jsonb_build_object('docs','https://huggingface.co/docs/api-inference','default_markup',1.15)),
  ('gigachat-tg', 'gigachat',   true,  true, 350, 0.96,  'https://gigachat.devices.sberbank.ru/api/v1',
    jsonb_build_object('docs','https://developers.sber.ru/docs/ru/gigachat/api/overview','default_markup',1.10,'note','via TG bridge'))
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Models (LLM / embedding / image / audio / video)
--    Slug convention: <provider>/<model> для LLM, краткий slug для прочих.
--    Метаданные: tags, hosted_region, provider_family для фильтрации в UI.
-- -----------------------------------------------------------------------------
INSERT INTO models (slug, type, enabled, display_name, description, metadata) VALUES
  -- ===================== LLM (OpenRouter) =====================
  ('openai/gpt-4o', 'chat', true, 'GPT-4o',
    'Флагманская мультимодальная модель OpenAI: текст, изображения, аудио. Поддержка инструментов и JSON-режима.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','tools','vision'],'hosted_region','global','provider_family','openai','context_window',128000)),
  ('openai/gpt-4o-mini', 'chat', true, 'GPT-4o mini',
    'Бюджетная версия GPT-4o — быстрая и дешёвая, подходит для ассистентов и классификации.',
    jsonb_build_object('tags',ARRAY['llm','cheap','tools'],'hosted_region','global','provider_family','openai','context_window',128000)),
  ('openai/o1-mini', 'chat', true, 'o1-mini',
    'Reasoning-модель OpenAI o1 mini: думает дольше, лучше решает задачи логики и кода.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','code'],'hosted_region','global','provider_family','openai','context_window',128000)),
  ('openai/o3-mini', 'chat', true, 'o3-mini',
    'Новое поколение reasoning-моделей OpenAI. Доступно через OpenRouter.',
    jsonb_build_object('tags',ARRAY['llm','reasoning'],'hosted_region','global','provider_family','openai','context_window',200000)),
  ('anthropic/claude-sonnet-4-5', 'chat', true, 'Claude Sonnet 4.5',
    'Флагман Anthropic: лучшая модель для длинного контекста, кода и агентских задач.',
    jsonb_build_object('tags',ARRAY['llm','code','agent','long-context'],'hosted_region','global','provider_family','anthropic','context_window',1000000)),
  ('anthropic/claude-haiku-4-5', 'chat', true, 'Claude Haiku 4.5',
    'Быстрая и дешёвая модель Anthropic. Подходит для high-volume задач.',
    jsonb_build_object('tags',ARRAY['llm','fast','cheap'],'hosted_region','global','provider_family','anthropic','context_window',200000)),
  ('google/gemini-2-5-flash', 'chat', true, 'Gemini 2.5 Flash',
    'Быстрая модель Google Gemini 2.5 — мультимодальная, дешёвая, с большим контекстом.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','fast','vision'],'hosted_region','global','provider_family','google','context_window',1000000)),
  ('google/gemini-2-5-pro', 'chat', true, 'Gemini 2.5 Pro',
    'Топовая модель Gemini 2.5 Pro — reasoning + мультимодальность + 1M контекста.',
    jsonb_build_object('tags',ARRAY['llm','multimodal','reasoning','long-context'],'hosted_region','global','provider_family','google','context_window',2000000)),
  ('deepseek/deepseek-v3', 'chat', true, 'DeepSeek V3',
    'Открытая SOTA-модель от DeepSeek: 671B MoE, очень дёшево и качественно.',
    jsonb_build_object('tags',ARRAY['llm','open','cheap'],'hosted_region','global','provider_family','deepseek','context_window',128000)),
  ('deepseek/deepseek-r1', 'chat', true, 'DeepSeek R1',
    'Reasoning-модель DeepSeek R1 — открытый аналог o1, отличный chain-of-thought.',
    jsonb_build_object('tags',ARRAY['llm','reasoning','open'],'hosted_region','global','provider_family','deepseek','context_window',128000)),

  -- ===================== LLM (Together) =====================
  ('meta-llama/llama-3-3-70b', 'chat', true, 'Llama 3.3 70B',
    'Открытая модель Meta Llama 3.3 70B — флагманская opensource-альтернатива через Together.',
    jsonb_build_object('tags',ARRAY['llm','open'],'hosted_region','global','provider_family','meta','context_window',128000)),

  -- ===================== LLM (Yandex — RU residency) =====================
  ('yandex/yandexgpt-5-lite', 'chat', true, 'YandexGPT 5 Lite',
    'YandexGPT 5 Lite: облегчённая модель с RU-резидентностью данных. Идеально для приватных задач РФ.',
    jsonb_build_object('tags',ARRAY['llm','ru','cheap'],'hosted_region','ru','provider_family','yandex','context_window',32000)),
  ('yandex/yandexgpt-5-pro', 'chat', true, 'YandexGPT 5 Pro',
    'Флагман Yandex Cloud Foundation Models: RU-резидентность, поддержка функций и долгого контекста.',
    jsonb_build_object('tags',ARRAY['llm','ru'],'hosted_region','ru','provider_family','yandex','context_window',32000)),

  -- ===================== LLM (GigaChat — placeholder via TG) =====================
  ('sber/gigachat-pro', 'chat', true, 'GigaChat Pro',
    'GigaChat Pro от Сбера через TG-bridge: RU-резидентность, OAuth-авторизация. Placeholder — endpoint в работе.',
    jsonb_build_object('tags',ARRAY['llm','ru','placeholder'],'hosted_region','ru','provider_family','sber','context_window',32000,'status_note','endpoint pending')),

  -- ===================== Embedding =====================
  ('openai/text-embedding-3-small', 'embedding', true, 'OpenAI text-embedding-3-small',
    'Дешёвый универсальный эмбеддинг от OpenAI (1536-dim). Хорошее соотношение цена/качество.',
    jsonb_build_object('tags',ARRAY['embedding','cheap'],'hosted_region','global','provider_family','openai','dimensions',1536)),
  ('openai/text-embedding-3-large', 'embedding', true, 'OpenAI text-embedding-3-large',
    'Высокоточный эмбеддинг OpenAI (3072-dim) для retrieval и semantic search.',
    jsonb_build_object('tags',ARRAY['embedding'],'hosted_region','global','provider_family','openai','dimensions',3072)),
  ('baai/bge-large-en', 'embedding', true, 'BAAI bge-large-en v1.5',
    'Открытая SOTA-модель эмбеддингов BAAI bge-large через HF Inference. Хороша для RAG.',
    jsonb_build_object('tags',ARRAY['embedding','open'],'hosted_region','global','provider_family','baai','dimensions',1024)),

  -- ===================== Image (Fal / Replicate) =====================
  ('flux-pro-1-1', 'image', true, 'Flux Pro 1.1',
    'Flux Pro 1.1 от Black Forest Labs — фотореализм SOTA-уровня. Через Fal.ai.',
    jsonb_build_object('tags',ARRAY['image','realistic','photo'],'hosted_region','global','provider_family','flux')),
  ('flux-dev', 'image', true, 'Flux Dev',
    'Открытая dev-версия Flux — баланс качества и цены. Через Replicate.',
    jsonb_build_object('tags',ARRAY['image','open'],'hosted_region','global','provider_family','flux')),
  ('stable-diffusion-3-5', 'image', true, 'Stable Diffusion 3.5',
    'Stable Diffusion 3.5 от Stability AI через Fal.ai. Универсальный image-gen.',
    jsonb_build_object('tags',ARRAY['image','open'],'hosted_region','global','provider_family','stability')),
  ('recraft-v3', 'image', true, 'Recraft v3',
    'Recraft v3 — лучшая модель для векторных иллюстраций, дизайна и иконок. Через Fal.ai.',
    jsonb_build_object('tags',ARRAY['image','vector','design'],'hosted_region','global','provider_family','recraft')),

  -- ===================== Audio =====================
  ('whisper-large-v3', 'audio', true, 'Whisper Large v3',
    'Whisper Large v3 от OpenAI — транскрипция аудио на 100+ языков. Через Replicate.',
    jsonb_build_object('tags',ARRAY['audio','stt','transcription'],'hosted_region','global','provider_family','openai','operation','stt')),
  ('elevenlabs-tts-hf', 'audio', true, 'ElevenLabs TTS (HF)',
    'ElevenLabs Text-to-Speech через HF Inference: реалистичные голоса.',
    jsonb_build_object('tags',ARRAY['audio','tts','voice'],'hosted_region','global','provider_family','elevenlabs','operation','tts','unit','second'))
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Routing (model_upstreams)
-- -----------------------------------------------------------------------------
-- LLM: per-1k-tokens RUB (USD * ~100)
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output, markup)
SELECT m.id, s.upstream_id, s.upstream_model_id, s.price_in, s.price_out, s.markup
FROM (VALUES
  -- OpenRouter LLM
  ('openai/gpt-4o',                 'openrouter', 'openai/gpt-4o',                 0.50::numeric, 1.50::numeric, 1.07::numeric),
  ('openai/gpt-4o-mini',            'openrouter', 'openai/gpt-4o-mini',            0.015::numeric, 0.06::numeric, 1.07::numeric),
  ('openai/o1-mini',                'openrouter', 'openai/o1-mini',                0.30::numeric, 1.20::numeric, 1.07::numeric),
  ('openai/o3-mini',                'openrouter', 'openai/o3-mini',                0.30::numeric, 1.20::numeric, 1.07::numeric),
  ('anthropic/claude-sonnet-4-5',   'openrouter', 'anthropic/claude-sonnet-4.5',   0.30::numeric, 1.50::numeric, 1.07::numeric),
  ('anthropic/claude-haiku-4-5',    'openrouter', 'anthropic/claude-haiku-4.5',    0.10::numeric, 0.50::numeric, 1.07::numeric),
  ('google/gemini-2-5-flash',       'openrouter', 'google/gemini-2.5-flash',       0.0075::numeric, 0.030::numeric, 1.07::numeric),
  ('google/gemini-2-5-pro',         'openrouter', 'google/gemini-2.5-pro',         0.125::numeric, 0.50::numeric, 1.07::numeric),
  ('deepseek/deepseek-v3',          'openrouter', 'deepseek/deepseek-v3',          0.0275::numeric, 0.110::numeric, 1.07::numeric),
  ('deepseek/deepseek-r1',          'openrouter', 'deepseek/deepseek-r1',          0.055::numeric, 0.219::numeric, 1.07::numeric),
  -- Together
  ('meta-llama/llama-3-3-70b',      'together',   'meta-llama/Llama-3.3-70B-Instruct-Turbo', 0.088::numeric, 0.088::numeric, 1.15::numeric),
  -- Yandex (RU)
  ('yandex/yandexgpt-5-lite',       'yandex',     'yandexgpt-lite/latest',         0.020::numeric, 0.040::numeric, 1.08::numeric),
  ('yandex/yandexgpt-5-pro',        'yandex',     'yandexgpt/latest',              0.080::numeric, 0.240::numeric, 1.08::numeric),
  -- GigaChat (placeholder)
  ('sber/gigachat-pro',             'gigachat-tg','gigachat/pro',                  0.150::numeric, 0.150::numeric, 1.10::numeric),
  -- Embeddings (per-1k input only; output=0)
  ('openai/text-embedding-3-small', 'openrouter', 'openai/text-embedding-3-small', 0.002::numeric, 0::numeric, 1.07::numeric),
  ('openai/text-embedding-3-large', 'openrouter', 'openai/text-embedding-3-large', 0.013::numeric, 0::numeric, 1.07::numeric),
  ('baai/bge-large-en',             'hf',         'BAAI/bge-large-en-v1.5',        0.005::numeric, 0::numeric, 1.15::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, price_in, price_out, markup)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;

-- Image: per-image RUB
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output, price_per_image, markup)
SELECT m.id, s.upstream_id, s.upstream_model_id, 0::numeric, 0::numeric, s.per_image, s.markup
FROM (VALUES
  ('flux-pro-1-1',          'fal',       'fal-ai/flux-pro/v1.1',           5.50::numeric, 1.12::numeric),
  ('flux-pro-1-1',          'replicate', 'black-forest-labs/flux-1.1-pro', 4.00::numeric, 1.12::numeric),
  ('flux-dev',              'replicate', 'black-forest-labs/flux-dev',     2.50::numeric, 1.12::numeric),
  ('flux-dev',              'fal',       'fal-ai/flux/dev',                3.00::numeric, 1.12::numeric),
  ('stable-diffusion-3-5',  'fal',       'fal-ai/stable-diffusion-v35',    3.50::numeric, 1.12::numeric),
  ('recraft-v3',            'fal',       'fal-ai/recraft-v3',              4.00::numeric, 1.12::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, per_image, markup)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;

-- Audio: per-second RUB
INSERT INTO model_upstreams (model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output, price_per_audio_sec, markup)
SELECT m.id, s.upstream_id, s.upstream_model_id, 0::numeric, 0::numeric, s.per_sec, s.markup
FROM (VALUES
  ('whisper-large-v3',      'replicate', 'openai/whisper-large-v3', 0.025::numeric, 1.12::numeric),
  ('elevenlabs-tts-hf',     'hf',        'elevenlabs/multilingual-v2', 0.30::numeric, 1.15::numeric)
) AS s(model_slug, upstream_id, upstream_model_id, per_sec, markup)
JOIN models m ON m.slug = s.model_slug
ON CONFLICT (model_id, upstream_id) DO NOTHING;
