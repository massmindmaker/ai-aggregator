# AG-7 / Task 2 — Claims сайта vs runtime: найденные расхождения

Дата: 30.09.2026. Ветка: `feat/ag-author-version-20260928`. Worktree:
`.worktrees/ag-author-version-20260928`. Коммитов нет.

Сверка велась **по коду**, не по документации. Эталон runtime:

| Что | Где в коде |
|---|---|
| Sold v1 scope моделей (STT из продажи снят) | `apps/web/src/lib/marketplace/catalog.ts:104` `isSoldV1Model`; `packages/api-gateway/src/catalog/public-catalog.ts:208-213` (SQL); `packages/database/migrations/0093_depublish_stt_v1.sql` (`enabled=FALSE`, `depublished_reason='v1_scope_stt_deferred'`, триггер `sold_v1_stt_guard`) |
| Какие типы моделей вообще могут быть `available` | `public-catalog.ts:519-521` — только `chat` и `embedding`; всё прочее → `unavailable('no_admitted_deployment')` |
| Рекламный capability-контракт чата | `public-catalog.ts:638-651` (`streaming:false`, `toolCalling:false`, `structuredOutput:false`), `:608` (`tools`/`functions`/`tool_choice` → unsupported), `:609` (`multimodalMessageContent:'reject'`), `:619` (`stream` — `const:false`) |
| Единица цены | `apps/web/src/lib/marketplace/pricing-calc.ts:1-22,41-47` — **кредиты** (1 кредит = 1 цент), не рубли; то же в gateway `config.ts:45-52` |
| Какие маршруты смонтированы | `packages/api-gateway/src/server.ts:118-158` (`stored_chat_*`) / `:159-177` (`legacy`) |
| rpm/лимиты | `packages/database/migrations/0004_gateway_core.sql:100` — `gateway_api_keys.rpm_limit INTEGER NOT NULL DEFAULT 60`, на ключ; подписка эту колонку **не пишет** (grep `rpm_limit` в `apps/web/src` — 0 совпадений) |
| Тарифы | `apps/web/src/lib/payments/providers.ts:200-204` `TIERS = { basic, starter, pro }` |

---

## Расхождения

### C1 — CRITICAL. Сайт рекламирует STT/Whisper, которого в продаже нет

Миграция `0093_depublish_stt_v1` намеренно вывела STT из продаваемой v1, и все три слоя это соблюдают. Витрина — нет.

| Путь:строка | Что обещает сайт | Что делает runtime | Критичность |
|---|---|---|---|
| `apps/web/src/app/page.tsx:27` (metadata description) | «GPT-5, Claude, Flux, Veo, **Whisper** и открытые модели» | STT недоступен: `isSoldV1Model` режет, SQL режет, БД `enabled=FALSE` | CRITICAL |
| `apps/web/src/app/page.tsx:410` (hero) | то же, в H1-подписи | то же | CRITICAL |
| `apps/web/src/app/page.tsx:76` | карточка сценария «Audio / Voice»: «**Whisper**, ElevenLabs, Suno, XTTS. **STT**, TTS, voice cloning» | STT не продаётся; в каталоге остаётся 4 audio-модели, из них tts/music, ни одной STT | CRITICAL |
| `apps/web/src/app/page.tsx:338` | плавающая карточка «**whisper / large-v3**», «audio · 0.08 ₽/мин» | модели `whisper-large-v3` в витрине нет вообще; и `/v1/audio/transcriptions` смонтирован только в `stored_chat_embeddings_completions_stream_media*` (`server.ts:123-126`), в `legacy` — 404 | CRITICAL |
| `apps/web/src/app/docs/page.tsx:270` | раздел «Модели»: «flux-1.1-pro, sdxl, **whisper-large-v3** — Картинки и аудио. Хостим в РФ» | STT нет; плюс `flux-1.1-pro`, `sdxl`, `claude-sonnet-4`, `claude-opus-4`, `gigachat-max` отсутствуют в `catalog.generated.ts` вообще | CRITICAL |
| `apps/web/src/app/(marketing)/marketplace/scenarios/page.tsx:21` | легенда модальностей `stt: 'Распознавание речи'` | ни один сценарий не имеет модальности `stt` (`scenarios.ts:9-13` — её нет в `ScenarioModality`) | MEDIUM |

`CodeExampleTabs.tsx:97` (`speech-to-text → 'unsupported'`) и `sold-v1-scope.test.ts` — единственные места, где STT-claim учтён; всё остание выше — нет.

### C2 — CRITICAL. Сравнительная таблица обещает модальности, которые каталог отдаёт как unavailable

`apps/web/src/app/page.tsx:209` — «✓ **LLM + image + audio**» в строке «Каталог моделей».
Runtime: `public-catalog.ts:521` — `if (model.type !== 'chat') return unavailable(model, 'no_admitted_deployment')`. Image/video/audio в `/v1/catalog` **не могут** быть `available` ни в одном режиме, включая media-режимы (media-маршруты обслуживают не каталог, а прямые вызовы). Плюс маршруты `/v1/images|video|audio/*` в `legacy` смонтированы (`server.ts:173-175`), но в любом `stored_chat_*` — 501, если нет `..._stream_media` (`server.ts:139-142`).
Критичность: CRITICAL.

### C3 — CRITICAL. Карточка модели показывает capability-бейджи, которые runtime отвергает

`apps/web/src/app/(marketing)/marketplace/[org]/[model]/page.tsx:316,320,324,328` рендерят «Streaming», «Tool-calling», «Vision», «JSON schema» = да/нет **из статического сгенерированного каталога**. В нём `streaming:true` у 36/36 LLM, `tools:true` у 9, `vision:true` у 14, `jsonSchema:true` у 9.

Runtime (`public-catalog.ts:638-651`) для проданной v1 объявляет ровно обратное: `streaming:false`, `toolCalling:false`, `structuredOutput:false`, а `:608` перечисляет `tools/functions/tool_choice` в `unsupportedExecutionFields`, `:609` — `multimodalMessageContent:'reject'`, `:619` — `stream: const false`. То есть 9 моделей получают «Tool-calling: да» при ответе 501 `unsupported_execution_contract`.
Критичность: CRITICAL.

### C4 — CRITICAL. Цены на главной в рублях, а биллинг в кредитах

| Путь:строка | Что обещает | Что делает runtime |
|---|---|---|
| `apps/web/src/app/page.tsx:25` (title) | «оплата в **₽**» | единица расчёта — кредиты |
| `page.tsx:125,133,141,149` | «0.2 ₽ / 1k tok», «0.04 ₽ / img», «0.35 ₽ / 1k tok», «0.12 ₽ / img» | каталог отдаёт цены в кредитах; `formatPriceLabel` печатает «кр» (`pricing-calc.ts:94-106`) |
| `page.tsx:325,333,341` | «0.04 ₽/img», «0.2 ₽/1k tok», «0.08 ₽/мин» | то же; и числа не выводятся ни из какого источника — захардкожены |
| `page.tsx:377` | «оплата в ₽ · без VPN» | кредиты |
| `page.tsx:664` | «Цены в ₽, деплой в РФ-регионе» | кредиты |

Цифры вручную и не бьются с каталогом: например `openai/gpt-5-5` в `catalog.generated.ts` = `inputPer1k 0.9`, а на главной «0.2 ₽». Комментарий над каталогом в самом `page.tsx:15-20` утверждает, что «числа витрины выведены из живого каталога, никогда не вручную» — для блока цен это неверно.
Критичность: CRITICAL.

### C5 — CRITICAL. Главная продаёт два тарифа, которых нет в коде

`page.tsx:255-283` — пять тарифов: Basic 990, Starter 2490, **Growth 4490**, Pro 6990, **Business 29900**. В `providers.ts:200-204` только `basic/starter/pro`. Growth и Business купить нечем: `getTier()` вернёт `null` → 400 `BAD_TIER` (`api/subscriptions/create/route.ts:44-50`).
Там же несуществующие обещания внутри существующих тарифов: «+1000₽ на баланс» / «-10% на запросы» / «5 API-ключей» / «Retention логов 90 дней» — в коде нет ни скидки по тарифу (grep `discount` в `providers.ts` — 0), ни лимита ключей, ни настройки retention. Реально выдаётся `credits_limit` из `TIERS[tier].credits` (`create/route.ts:65-77`), то есть кредиты, а не рубли на баланс.
Критичность: CRITICAL.

### C6 — HIGH. Тарифная страница обещает rpm, который gateway никогда не выдаёт

`apps/web/src/app/pricing/PricingClient.tsx:39,56,73` — «60 запросов в минуту» / «300» / «500».
Runtime: `0004_gateway_core.sql:100` `rpm_limit INTEGER NOT NULL DEFAULT 60` на строку `gateway_api_keys`; middleware берёт `k.rpm_limit` (`rate-limit-plan04.ts:39`). Ничто в `apps/web/src` не пишет `rpm_limit` при активации подписки (0 совпадений). То есть все три тарифа получают 60, и «300/500» недостижимы ни при какой оплате.
Критичность: HIGH.

### C7 — HIGH. Документация и примеры кода учат стримингу, который запрещён

- `apps/web/src/app/docs/page.tsx:209` — «`stream` — потоковая выдача (SSE)».
- `docs/page.tsx:288` — пример `stream=True`.
- `apps/web/src/components/marketplace/CodeExampleTabs.tsx:110` — в copy-paste curl для каждой chat-модели `"stream": true`.

Runtime: `public-catalog.ts:619` — `stream: { const: false, normalizedDefault: false }`, то есть `stream:true` = `unsupported_execution_contract`; `stored-chat.ts:210,355` отдаёт `unsupported_execution_contract` и 501. Единственный режим, где стрим разрешён, — `stored_chat_embeddings_completions_stream*` (`server.ts:119-122` + `stored-chat.ts:202-204`), и в нём capability всё равно объявлен как `streaming:false`.
Критичность: HIGH.

### C8 — HIGH. Playground предлагается для моделей, которые маршрут чата выполнить не может

`[org]/[model]/page.tsx:368` — кнопка «Попробовать в Playground» на странице **каждой** модели, включая image/video/audio/embedding. `api/playground/run/route.ts:95` всегда шлёт `POST /v1/chat/completions`, а `:78` пропускает любой slug, продающийся в витрине. Для image/audio/embedding модели это гарантированный отказ.
Дополнительно `route.ts:104` шлёт `stream: true` (см. C7) и `:88-90,164-165` в не-production без `GATEWAY_SYSTEM_API_KEY` отдаёт **заглушку** — при этом страница Playground обещает «Ответы не заготовлены: playground обращается к той же модели, что и API» (`playground/page.tsx:106-108`).
Критичность: HIGH.

### C9 — MEDIUM. Фильтр каталога предлагает типы, под которые нет ни одной модели

`apps/web/src/components/marketplace/FilterPanel.tsx:29-38` — `ALL_TYPES` включает `code`, `multimodal`, `text-to-speech`. В `catalog.generated.ts` реальные типы: `llm 36 / image 15 / video 10 / audio 5 / embedding 3`. Три фильтра дают пустую страницу. Тот же список — в `MODEL_TYPE_LABEL_RU` (`catalog.ts:143-153`).
Критичность: MEDIUM.

### C10 — MEDIUM. Раздел «Модели» в документации перечисляет несуществующие slug'и

`apps/web/src/app/docs/page.tsx:255-270`: из 9 названных моделей в `catalog.generated.ts` **нет** `claude-sonnet-4`, `claude-opus-4`, `gigachat-max`, `flux-1.1-pro`, `sdxl` (плюс `whisper-large-v3` скрыт фильтром). В каталоге есть `anthropic/claude-sonnet-4-5|4-6`, `flux-pro-1-1`, `flux-dev`, `sber/gigachat-pro`.
Критичность: MEDIUM.

### C11 — LOW. Статистика на карточке модели выводится из детерминированного хеша

`page.tsx` (блок «Рейтинг / Запросов / Uptime») печатает `model.stats.*`, которые `gen-marketplace-catalog.ts:171-217` генерирует из хеша slug'а. Тот же источник уже признан ненадёжным для structured data в самом файле (`buildProductJsonLd` убрал `aggregateRating` из-за выдуманных рейтингов, комментарий на `:110-120`). На странице они остались как видимые числа.
Критичность: LOW (это уже сознательное решение по JSON-LD; вопрос только к видимому UI).

---

## Что сошлось (проверено, расхождений нет)

- `isSoldV1Model` (`catalog.ts:104-112`) точно повторяет предикаты SQL в `public-catalog.ts:208-213` и `0093_depublish_stt_v1.sql`: тот же набор (`operation='stt'`, slug `whisper-large-v3`, теги `stt`/`transcription`). Русский тег «аудио» намеренно не режется — TTS/image/video остаются продаваемыми, это верно.
- `scenarios.ts` не содержит STT: модальностей `chat/image/tts/embedding`, ни один `recommendedModelSlug` не содержит whisper, теги без stt. Все 5 `recommendedModelSlug` при этом реально существуют в `catalog.generated.ts` (проверено).
- Формат цены в каталоге: `formatPriceLabel`/`formatCredits` печатают «кр» и не накладывают второй markup (`pricing-calc.ts:19-21`) — сходится с `rawCents × markup` на стороне gateway.
- Structured data карточки использует `priceCurrency: 'USD'` и конвертирует кредиты в USD только для schema.org — это явно оговорено и не противоречит биллингу.
- Лимит playground «5 запросов в сутки на IP» (`playground/page.tsx:101`) совпадает с `FREE_LIMIT = 5` и с fail-closed guard'ом (`run/guard.ts`).

---

## Что не удалось доказать (UNVERIFIED, не PASS)

- **Фактический режим gateway в проде.** `GATEWAY_HTTP_EXECUTION_MODE` не задан ни в `.env.example`, ни в `ops/ecosystem.config.cjs` (там только `sharedEnv` из `/srv/aiag/shared/.env`, которого нет в checkout). В коде default — `legacy` (`config.ts:28`). C2/C7/C8 описывают поведение по коду; реальный режим развёрнутого сервиса не проверен.
- **Реальные цены в БД.** Каталог витрины — статический сгенерированный TS-файл от 2026-07-16; что лежит в `model_upstreams.price_per_1k_input` в проде, не проверялось.
- **`/v1/models` vs каталог.** `routes/v1/models.ts` отдаёт все `enabled`-модели без STT-фильтра; защита держится только на `enabled=FALSE` из миграции 0093. Расхождение сейчас не проявляется (миграция applied), но это более тонкий барьер, чем у `/v1/catalog`.

---

## Как проверять

`e2e/claims-vs-runtime.spec.ts` — 12 статических тестов (сверка исходников витрины с контрактом
runtime; без сети, без БД, без денег) + 3 браузерных, которые идут только при
`AIAG_E2E_OWNED_SERVER=1` и `baseURL=http://127.0.0.1:3107` (как `e2e/auth.setup.ts`).

На момент написания статическая часть падает по C1–C6, C9, C10 — это ожидаемо: тест
фиксирует расхождения как дефекты витрины, а не как «нужно починить тест». Каждый
fallback-ассерт печатает `путь:строка` конкретного места.
