# AG-P3: первая исполняемая версия автора

Дата: 28.09.2026. Владелец: AI Aggregator. Это часть AG-only roadmap. Источник требований: `docs/superpowers/plans/2026-09-07-production-continuation.md`, AG-P3, и `docs/ecosystem/payment-and-evidence-design.md`. Текущие `models` и `author_earnings` не доказывают полный авторский цикл.

## Результат

Один автор подаёт поддерживаемый HTTPS OpenAI-compatible text endpoint. Заявка создаёт выключенный `models` listing и отдельную неизменяемую версию. Модератор может утвердить версию только после безопасного probe и проверки прав/условий. Покупательский запрос фиксирует точные `version_id`, digest и price policy до платного вызова. Settlement создаёт одно начисление автору или долговечную задачу сверки. Refund/reversal и mock payout сохраняют одну денежную authority при crash/replay.

## Границы первой волны

1. Для первого adapter поддерживается только HTTPS JSON chat completions без streaming/tools/BYOK и произвольных headers. Автор задаёт URL и token. Outbound использует `@aiag/shared/server.safeFetch` без allowlist; DNS/IP проходят его проверку. Для Bearer token задан `maxRedirects:0`: даже публичный redirect не получает секрет. Ответ ограничен по байтам и времени. Локальные тесты используют только fake transport; live endpoint не вызывается.
2. Существующий `models` остаётся catalog/routing identity. Новая `author_model_versions` хранит `model_id`, `author_user_id`, порядковый номер, canonical public manifest, SHA-256 digest, encrypted token envelope, moderation state и timestamps. Version content не меняется после INSERT; новая редакция создаёт новую строку. Секрет не входит в public manifest, `models.metadata`, API response или audit.
3. Секрет шифруется существующим AES-GCM primitive из `@aiag/upstream-adapters/byok` с отдельным `AUTHOR_ENDPOINT_KEK` и domain-separated subkey. Отсутствие/ошибка KEK отказывает до записи. Поле `authHeader` не выбирает произвольный header: v1 использует только Bearer Authorization.
4. Manifest v1 описывает `adapter:openai_chat_https_v1`, endpoint URL, text-only capability, request/response schema IDs, права/лицензию, consent reference. Сервер нормализует и ограничивает поля; client-supplied price/share/tier — только необязательная заявка для модератора и никогда не authority.
5. Подготовка `models` + version + audit происходит атомарно. Автор определяется серверной сессией. Статус остаётся `draft`, `enabled=false`; запись не становится продаваемой до завершения probe/runtime/version pinning и версионированной ценовой политики.
6. При approval pointer `models.current_author_version_id` меняется только guarded CAS. Платный route допускает только approved pointer, фиксирует version ID/digest в request identity и сохраняет старую версию для уже принятого запроса. Freeze/depublish блокируют новые admission, не переписывают старые receipt.

Probe — потенциально платный внешний эффект. До POST записывается owned operation с exact version/body/key и сроком. Timeout/lost response остаётся `unknown` для оператора; второй независимый probe с новым ключом запрещён. Автоматический replay допускается только при проверенном контракте idempotency автора. Без confirmed probe версия не активируется.

## Денежная часть следующей волны

Существующий `aiag_settle_charge` остаётся единственной authority списания покупателя. Author accrual связывается с settled gateway request и pinned version, имеет unique request identity и явный reconciliation state. Текущий `EXCEPTION ... RAISE WARNING` без durable evidence не считается выполненным начислением. Процент/цена берутся из принятой versioned policy, не из формы или маркетинговых 70/80/85. Payout mock имеет immutable recipient/amount, dispatch identity, unknown state и проверяемый replay; реальная выплата отдельно gated.

## Приёмка

- Неверный manifest, чужой author, повтор slug, закрытый/private IP, encoded IP, DNS rebinding и redirect к private IP отвергаются без записи или платного вызова.
- Токен отсутствует в `models.metadata`, public manifest, ответе API, audit и логах; encrypted envelope расшифровывается только с верным KEK.
- Одновременные submissions не создают две версии одного slug. Изменение manifest или credential создаёт новую version identity; утверждённая версия не редактируется.
- Локальный controlled endpoint доказывает probe/invocation/receipt. Ошибка, timeout или crash не переводят неисполненную версию в `live` и не создают начисление.
- Один оплаченный вызов, повтор и refund дают одно точное начисление и обратную запись; mock payout после lost ACK не отправляется новым переводом.
- Native DB, HTTP, type/build/lint и независимые security/financial review обязательны. Production, реальный provider и деньги не включаются этим документом.

Первый implementation batch закрывает только **атомарную безопасную заявку и неизменяемую candidate version**. Следующие batches закрывают probe/approval/runtime pinning и author money; весь AG-P3 остаётся OPEN до полного end-to-end доказательства.
