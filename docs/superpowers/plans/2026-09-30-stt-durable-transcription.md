# План: STT/transcription (durable stored transcription) — закрытие AG-5

Дата: 30.09.2026. Ветка: `feat/ag-author-version-20260928`. Миграции: `0093`, `0094`, `0095`.
Источник: этот план документирует уже реализованный код, который остался без плана и
чекпоинта. Задача плана — зафиксировать фактическое состояние, а не переписать работу.

## Статус

Код, миграции и тесты приняты локально. **Независимое ревью не проводилось.**
Runtime-активация намеренно выключена: это отдельный release gate, не следствие тестов.

## Что реализовано

1. **HTTP identity** (`packages/api-gateway/src/billing/stored-transcription-http-identity.ts`):
   строгий bounded multipart-парсер собственной реализации (не qs/formidable), whitelist
   полей, sha256 аудио, отказ BYOK (`x-upstream-key` → 501), лимиты тела 25 МБ + 64 КБ.
2. **WAV handling** (`stored-transcription-wav.ts`): RIFF PCM-парсер (chunks `fmt`/`data`,
   валидация `blockAlign`/`byteRate`), расчёт `frames`/`durationMs`/`billableMs` с минимумом
   10 секунд биллинга: `greatest(10000, _duration)`.
3. **Groq upstream** (`upstreams/groq.ts`, `admittedTranscription`): пин `whisper-large-v3`,
   отказ до сетевого вызова при неверной модели/аудио/прокси, fail-closed без
   `GROQ_API_KEY`, единый multipart POST с `verbose_json`, валидация ответа
   (`text`/`duration`/`x_groq.id`, лимит 1 МБ), **без retry**.
4. **Durable state machine** (`stored-transcription-attempt.ts`):
   `admit → dispatch → provider → outcome → settle`, на каждой стадии
   `reconciliation_required` при сбое; replay восстанавливает существующий
   claimed/held/completed job.
5. **Exactly-once settlement, два уровня:**
   - БД (миграция `0094`): идемпотентный claim по
     `(org, key, route, idempotency_digest)` с `MEDIA_IDENTITY_CONFLICT` при смене
     fingerprint; триггер `aiag_guard_transcription_prediction_job_v1` делает job
     неизменяемым (`STT_JOB_IMMUTABLE`); settlement только через
     `settle_admitted_gateway_charge` в одной транзакции с ключом
     `gw:<billing_request_id>`. Replay-тест подтверждает `receipts = 1`.
   - `0093`: триггер `aiag_block_sold_v1_stt` запрещает включать STT в продаваемую v1.

## Граница: STT вне продаваемой v1

Миграция `0093_depublish_stt_v1` выводит транскрипцию из продажи с причиной
`v1_scope_stt_deferred`, пока не реализованы: durable multipart identity (частично,
в этой волне), доверенная длительность для биллинга, точная квитанция и recovery.
`0094` держит mapping в `enabled = FALSE`.

**`501` не считается реализацией.** Пока флаг не поднят осознанно, STT не входит в состав
продаваемого v1, и каталог не должен показывать эти модели — это обеспечено фильтром
`isSoldV1Model` в `apps/web` и SQL-фильтром в `catalog/public-catalog.ts`.

## Пробелы, которые нужно закрыть (обязательно до активации)

- [ ] **Независимое security/financial review** этой волны. Приёмочный скрипт должен
      включать: exactly-once при повторе, отказ при смене fingerprint, отсутствие retry к
      провайдеру после неопределённого исхода, корректный минимум биллинга 10 с.
- [ ] **Решение о биллинге длительности:** `billableMs` = `greatest(10000, duration)` —
      это conservative-правило. Требуется явное продуктовое решение, считается ли недобор
      разницей и как это отражается в квитанции.
- [ ] **План активации** с явным gate: что должно быть зелёным, чтобы поднять флаг,
      и кто принимает решение.
- [ ] **Чекпоинт и машинночитаемые evidence** в `docs/consolidation/` (отсутствуют).
- [ ] Открыть question: BYOK для STT возвращает 501 — это осознанное решение или долг?

## Связь с роадмапом

Этап **AG-5** (`docs/ecosystem/2026-09-28-aggregator-only-roadmap.md`): «закрыть
обязательные продаваемые v1 modalities… `501` не считается реализацией». Настоящий
честный статус: **STT не входит в состав v1 на текущем решении**, поэтому AG-5
не блокируется ожиданием STT. Если владелец позже решит включить STT в v1, блок
включается и требует полного цикла ниже плюс внешнего ревью.
