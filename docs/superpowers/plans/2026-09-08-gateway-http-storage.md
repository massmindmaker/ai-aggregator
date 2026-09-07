# AG gate A: durable HTTP mapping и resultbox

Статус: код a6c0513 принят локально после независимого TypeScript/financial/spec review Approved 08.09; clean69 остаётся UNVERIFIED. Это один Task, без public route activation. Принятый вход: quota `fdd8f22` + `2aa3a7f`, bridge `20187ecd`; source tip при проектировании `acb2793`. Текущие HTTP idempotency mapping и result storage отсутствуют. Номер `0069` свободен при проверке 08.09; worker повторно проверяет до создания файла.

**Goal:** PostgreSQL навсегда закрепляет scoped HTTP key за одним server billing UUID до admission и атомарно сохраняет проверенный sanitized completion вместе с quota v2 outcome. Повтор возвращает состояние/сохранённый ответ; никакой повтор не выдаёт разрешение на новый provider call.

**Research inputs → решение → acceptance → deferred:** D03/D11 из [production continuation](2026-09-07-production-continuation.md); существующие [quota design](2026-09-07-durable-spending-quotas.md), [admission contract](2026-09-07-gateway-charge-admission.md), [принятый bridge](2026-09-08-quota-executor-bridge.md). Решение — additive SQL contracts и native tests в текущем стеке. Acceptance — таблица ниже. TS wrappers, HTTP fingerprint builder, trusted auth/route composition, Task5 callback seam, enrollment/cutover и recovery worker — следующие отдельные gates.

## Границы

- Canonical root `/home/bob/Projects/ai-aggregator`, текущая feature branch. Один владелец перечисленных файлов; чужие `.Codex/`, документы и код не изменять/не откатывать.
- Исторические `0067`, `0068`, существующие lifecycle signatures, `gateway_charge_admission_result` из 31 поля, денежная арифметика, usage v1/supplier v2 контракты остаются неизменными. Новые SQL composite types отдельные.
- Только prepared SQL, exact BIGINT/NUMERIC. Один heavy run под `flock /tmp/ai-ecosystem-build.lock`; только guarded local `ai_aggregator_test` через существующий `/tmp/ai-ecosystem-run aggregator`. Без production, платных upstream, push/deploy, изменения operational scripts, установок и нового framework.
- Gate A не меняет `packages/api-gateway/src`, executor, adapters, routes или Redis. Новый контракт пока unused. Schema TypeScript и native tests проходят TypeScript review; SQL проходит независимое financial/spec review.
- SQL functions — server-only persistence API существующего trusted DB caller. Переданные UUID не являются аутентификацией пользователя сами по себе. Public gateway позже проверяет API credential и передаёт trusted org/key; SQL повторно проверяет существование и актуальную активность key. Новых публичных DB grants / `SECURITY DEFINER` не добавлять.

## Принятая идентичность и порядок следующего gateway gate

HTTP key scope: `(org_id, api_key_id, route_kind='chat', billing_mode='stored', idempotency_key_digest)`. Digest и request fingerprint — каждый exact lowercase hex SHA-256, 64 ASCII символа; SQL TEXT `COLLATE "C"` + anchored regex/length CHECK, без trim/folding. Версия fingerprint/контракта только `1`. Raw key, запросные messages, SID, trace и заголовки в mapping не сохраняются.

Допущение: будущий HTTP key — обязательный отдельный `Idempotency-Key` для этого stored/nonstream пути, 1…128 ASCII `[A-Za-z0-9._:-]`; digest считается от точных UTF-8 bytes. Gate A принимает только digest. `X-Request-Id` остаётся trace и никогда не становится financial UUID или idempotency key.

Fingerprint v1 позже считается gateway из канонического client payload: версия, `chat/stored`, запрошенный model slug, requested routing mode, declared SID (явный null), упорядоченные messages с точными role/content, присутствие и значение client `max_tokens`, нормализованный supported `stream=false`. Absent max и explicit max различаются, даже если текущий default совпал. Не включать trace, raw idempotency key, текущие цены/default max, resolved provider/candidate или policy revision. JSON object order/whitespace не меняют digest; message order/content/SID/model/mode/max presence меняют. Обязательная реализация/тест этого builder — следующий TS gate, SQL его не придумывает и не принимает body клиента вместо digest.

Следующий gateway gate сначала authenticates + validates canonical client identity, затем read/claim существующей mapping до live quote/model-policy revalidation. Exact replay с активным тем же key остаётся доступным после изменения каталога/лимитов. Для действительно нового key current Task5 `createStoredChatAttempt()` уже возвращает `ready.billingRequestId` **до** `run()`; подготовка не вызывает paid side effect. Gateway предлагает этот server-generated UUID claim-функции и вызывает `ready.run()` только после подтверждённого COMMIT/валидного ответа `did_claim=true`, совпавшего с этим UUID. Если между lookup и claim победил другой caller — готовый handle выбрасывается. Нельзя передавать клиентский UUID, подменять `newUuid` клиентским input, восстанавливать новый handle по replay или вызывать run после unknown ACK.

## DB модель v1

Новая migration `packages/database/migrations/0069_gateway_http_storage.sql`, outer BEGIN/COMMIT. Подключить все новые функции точным mirror `packages/database/src/functions/gateway-http-storage.sql`. Не заменять существующие functions ради новой проекции.

### `gateway_http_requests`

Колонки: `billing_request_id UUID PRIMARY KEY` (предложенный сервером), `org_id UUID NOT NULL`, `api_key_id UUID NOT NULL`, `route_kind VARCHAR(32) NOT NULL CHECK ='chat'`, `billing_mode VARCHAR(16) NOT NULL CHECK ='stored'`, `contract_version SMALLINT NOT NULL CHECK =1`, `idempotency_key_digest TEXT COLLATE "C" NOT NULL`, `request_fingerprint TEXT COLLATE "C" NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()`.

Уникальность полного HTTP scope выше и `(org_id,api_key_id,billing_request_id)`. Отдельный FK `org_id → organizations(id) ON DELETE RESTRICT`; отдельный составной key-owner FK `(org_id,api_key_id) → gateway_api_keys(org_id,id) ON DELETE RESTRICT`. Additive UNIQUE `(org_id,id)` в `gateway_api_keys` делает owner доказуемым на уровне БД. Один UUID нельзя связать с несколькими scopes/keys/fingerprints.

**Здесь нет FK на admission:** fresh claim обязан коммититься до admission. FK добавлять только на resultbox. Mapping identity/created_at не обновляются; нет lease, heartbeat, owner token, takeover, reset, TTL или автоматического удаления mapping. No-admission claim после crash остаётся pending навсегда до отдельного будущего reconciliation решения; повторный run запрещён.

### `gateway_http_results`

Колонки: `billing_request_id UUID PRIMARY KEY`, `org_id UUID NOT NULL`, `api_key_id UUID NOT NULL`, `contract_version SMALLINT NOT NULL CHECK =1`, `http_status SMALLINT NOT NULL CHECK =200`, `content_type TEXT NOT NULL CHECK ='application/json'`, `response_body JSONB` (nullable только после expiration), `response_digest TEXT COLLATE "C" NOT NULL`, `stored_at TIMESTAMPTZ NOT NULL`, `expires_at TIMESTAMPTZ NOT NULL`, `payload_expired_at TIMESTAMPTZ`.

FK `(org_id,api_key_id,billing_request_id)` с RESTRICT в **обе** таблицы: HTTP mapping и `gateway_charge_admissions`. Для admission additive UNIQUE `(org_id,api_key_id,billing_request_id)`; существующий PK не менять. Отдельный `(org_id,api_key_id) → gateway_api_keys(org_id,id)` owner FK и org FK также явные. Результат не может существовать без mapping, admission или с чужим owner. Проверять `chat/stored` и quota context v2 внутри writer; не выводить их только из наличия FK.

`response_digest = encode(sha256(convert_to(response_body::text,'UTF8')),'hex')` считается самой БД после strict validation; core PostgreSQL SHA-256, без расширения/клиентского body digest. Это digest канонического SQL JSONB представления, **не** fingerprint HTTP запроса. `expires_at = stored_at + interval '168 hours'`; конечные timestamps, версия/идентичность/status/content type/digest/stored/expiry неизменны. Row CHECK: body object с непустым digest при `payload_expired_at IS NULL`; иначе body SQL NULL и `payload_expired_at >= expires_at`. SQL JSON null не равен SQL NULL и не является корректным body.

Допущение: payload доступен ровно 7×24 часа от первой успешной записи результата; небольшой tombstone с mapping, digest и финансовой связью сохраняется без автоматического удаления. Это bounded retry window при ограниченном хранении текста; бессрочный tombstone исключает повторное использование financial identity после expiry. Семь дней — локальный contract default, не обещание уже активного публичного API и не production retention approval.

Read использует только DB clock, не продлевает TTL и не меняет rows. После срока body не выдаётся, даже если purge ещё не запускался. Новая server-only scoped `aiag_expire_gateway_http_result_v1(org_uuid,billing_uuid)` атомарно зануляет только уже expired body и фиксирует DB `payload_expired_at`; repeat — no-op. Ни clock override, ни future expiry argument у entrypoint нет; scheduling/cleanup worker в этот gate не входит. Для тестов времени — исторические согласованные scoped fixtures, не production clock knob.

Защитить UPDATE identity полей обеих новых таблиц trigger-ом. Для result единственный разрешённый UPDATE — unexpired-body→SQL NULL после DB expiry, с сохранением всех остальных полей, кроме первого `payload_expired_at`. Произвольная замена body/digest/expiry запрещена даже direct UPDATE. Ни одна новая функция не удаляет строки. Привилегированный DB administrator всё ещё может менять схему/удалять тестовые fixtures; SQL contract не обещает защиту от владельца БД. Native cleanup удаляет только UUID своих fixtures, result→mapping→financial fixture в корректном FK порядке, без изменения operational cleanup scripts.

## Санитизированный completion DTO и связность evidence

Authority — `packages/api-gateway/src/upstreams/interface.ts` (`AdmittedChatResponse`), `upstreams/openrouter.ts` (`admittedResponse` и положительная проекция `execute()`), `billing/stored-chat-attempt-contract.ts` (`captureStoredChatEvidence`), `0068` (`aiag_quota_supplier_actual`). Поддерживается ровно текущий pinned plaintext/nonstream ответ, не произвольная OpenAI schema.

| JSON path | SQL v1 validation / evidence |
|---|---|
| root | Ровно `id, object, created, model, choices, usage`; object, не scalar/array/null/double-serialized JSON string |
| `id` | string, 1…256 ASCII `[A-Za-z0-9_-]`; равно `usage_snapshot.completionId` |
| `object` | exact string `chat.completion` |
| `created` | JSON integer 0…9007199254740991; provider timestamp сохраняется, не подменяется DB clock и не используется для retention |
| `model` | string, 1…256 ASCII `[A-Za-z0-9_./:@+-]`; равно `usage_snapshot.reportedModel`, не текущему catalog slug по догадке |
| `choices` | Массив ровно из одного object с exact keys `index,message,finish_reason` |
| `choices[0].index` | JSON integer exact 0 |
| `choices[0].message` | Exact keys `role,content`; role exact `assistant`, content JSON string или JSON null; empty string допустим |
| `choices[0].finish_reason` | exact `stop`, `length` или `content_filter` |
| `usage` | Exact keys `prompt_tokens,completion_tokens,total_tokens`, плюс только optional `cached_input_tokens` |
| usage counts | JSON integer 0…9007199254740991; exact sum `total=prompt+completion`, cached≤prompt; совпадают с corresponding camelCase verified `usage_snapshot.usage` |
| optional cached | Если присутствует — JSON integer, равно `cachedInputTokens`. Если отсутствует — не добавлять: текущий accepted adapter не проецирует cached count в public DTO, даже при ненулевом verified cached count |

Optional cached разрешён существующим type/evidence контрактом. Другие provider fields не добавлять: никакие costs, headers, reasoning, logprobs, system fingerprint, tool/function calls, raw provider payload, input messages, SID, quote или supplier identity не сохраняются в публичном body. На SQL input с extra fields **ошибка**, а не сохранение/молчаливое расширение DTO. Sanitization означает trusted положительную проекцию, SQL проверяет её строго и не превращает произвольный provider blob в разрешённый ответ.

Допущение: `octet_length(convert_to(response_body::text,'UTF8')) <= 1048576` (1 MiB) после JSONB parsing; этот byte cap включает keys/escaping/многобайтные символы. Одна choice и metadata limits уже ограничены текущим adapter; 1 MiB даёт запас для plaintext профиля с max output 16384 tokens и ограничивает durable row. Это storage safety cap, не доказанная верхняя token→byte граница. Не обрезать content и не хранить digest вместо ещё не истёкшего body. Oversize после provider — outcome/result transaction rollback и reconciliation без rerun; следующий seam обязан учитывать эту fail-closed ветку. Native boundary tests используют exact measured canonical byte size, не JS string.length.

В writer success только `outcome_kind='success'`. Existing `aiag_record_gateway_charge_outcome_v2` остаётся единственным authority фактической цены, frozen usage, supplier valuation и quota context. До записи body сверить verified billingRequestId/attemptId/owner с admission и id/model/counts по таблице. Existing v2 функция ещё проверяет frozen selected tuple/profile/formula/max/actual. No guessed price, live catalog lookup, cached discount revaluation или второй financial алгоритм.

## Точные server-only SQL entrypoints

### Claim

`aiag_claim_gateway_http_request_v1(_org_id UUID, _api_key_id UUID, _billing_request_id UUID, _route_kind VARCHAR, _billing_mode VARCHAR, _idempotency_key_digest TEXT, _request_fingerprint TEXT, _contract_version SMALLINT)`.

Возврат отдельного `gateway_http_claim_result_v1`, ровно одна строка в порядке: `contract_version SMALLINT, org_id UUID, api_key_id UUID, billing_request_id UUID, route_kind VARCHAR, billing_mode VARCHAR, idempotency_key_digest TEXT, request_fingerprint TEXT, created_at TIMESTAMPTZ, did_claim BOOLEAN`. Явная проекция, не table `SELECT *` и не изменение existing31. Всегда returned mapping UUID, не автоматически предложенный loser UUID.

- Fresh valid key + absent mapping + globally unused proposed UUID → insert mapping, `did_claim=true` только для этой insertion. Ни admission, ни hold, ни usage/quota/event delta.
- Scope существует + same fingerprint/version → existing immutable mapping, `did_claim=false`, даже если proposed fresh UUID другой; текущие тарифы/policy/SID quotas не переоцениваются. Changed fingerprint → conflict, никакой replacement/новый billing ID.
- Fresh scope с UUID, уже имеющим admission, HTTP mapping другого scope либо другой финансовый смысл, → conflict. SQL не вызывает admission и не привязывает key задним числом к unrelated run.
- Только committed fresh claim ACK даёт будущему gateway право вызвать собственный prepared handle. Ответ функции внутри незакоммиченного caller transaction — ещё не ACK COMMIT. Потерянный ACK/ошибка транспорта/parsing → неизвестно; новая connection делает read/reclaim, получает `did_claim=false` при committed claim и **не** вызывает run. Если committed mapping нет, identity/status остаётся неизвестным для исходного caller до установленного протокола; этот gate не вводит автоматический retry execution.

### Atomic outcome + immutable result

`aiag_record_gateway_http_outcome_v1(_org_id UUID, _api_key_id UUID, _billing_request_id UUID, _idempotency_key_digest TEXT, _request_fingerprint TEXT, _actual_cost_credits BIGINT, _usage_snapshot JSONB, _outcome_kind VARCHAR, _response_body JSONB, _contract_version SMALLINT)`.

Возвращает существующий `SETOF gateway_charge_admission_result` из 31 поля, без добавления body/TTL полей. Это SQL composition, не отдельный второй outcome lifecycle. В рамках одной transaction: locks → exact mapping/owner/version check → strict DTO/evidence validation → existing v2 outcome function → result INSERT → return existing admission projection. First call требует admission `dispatched` и отсутствие result; replay допускается только при уже существующем matching result + admission `outcome_recorded`/`settled`. Outcome существует без result → `HTTP_RESULT_STATE_CONFLICT`, не backfill чужим body. Failed/cancelled/held/legacy v1/wrong owner не проходят.

Начальный `stored_at := clock_timestamp()` захватывается один раз при insertion. Exact replay сравнивает финансовые факты через existing v2, а body через JSONB equality пока payload есть; после purge через recomputed SQL SHA-256. Fingerprint/version/status/content type/owner immutable. Changed completion/content/usage/actual/identity — conflict и zero delta. Semantic JSON object order не конфликтует; arrays/string content/null/optional presence сохраняют смысл. Повтор не заменяет body, не продлевает expiry и не возвращает `did_transition=true` без реального v2 transition.

Revoked/disabled key не останавливает trusted запись результата уже dispatched эффекта: проверяется durable key owner, но не current active flag. Иначе paid effect потеряет финансовое завершение при concurrent revoke. Read/claim ниже обязательно требуют fresh active key. Финансовая запись не является public data access.

Settlement остаётся existing отдельной idempotent функцией. SQL gate не вызывает provider и не возвращает public body до подтверждённого `settled`; если outcome/result committed, а settle ACK потерян, read позже различает settled/pending, backend recovery остаётся отдельным gate.

### Authenticated scoped read

`aiag_read_gateway_http_result_v1(_org_id UUID, _api_key_id UUID, _route_kind VARCHAR, _billing_mode VARCHAR, _idempotency_key_digest TEXT, _request_fingerprint TEXT, _contract_version SMALLINT)`.

Отдельный `gateway_http_read_result_v1`: ровно `contract_version SMALLINT, status TEXT, billing_request_id UUID, http_status SMALLINT, content_type TEXT, response_body JSONB, actual_cost_credits BIGINT, stored_at TIMESTAMPTZ, expires_at TIMESTAMPTZ`. Одна строка, explicit allowlist. Только `ready` имеет body/status200/content type/actual/stored/expiry; `expired` имеет billing UUID и stored/expiry, всё остальное NULL; `pending`/`unavailable` имеют billing UUID, остальные nullable поля NULL; `not_found` имеет все nullable поля NULL. Version всегда1. Status: absent mapping=`not_found`; no admission/held/dispatched/outcome_recorded=`pending`; cancelled либо settled без result=`unavailable`; expired result=`expired` (даже если settlement ещё pending); settled с unexpired validated result=`ready`.

Перед существованием/конфликтом mapping проверить fresh key принадлежность org и `disabled_at IS NULL AND revoked_at IS NULL`. Другой org/key не получает существующий UUID/body/status из чужого scope. Exact fingerprint обязателен; изменённый fingerprint на собственном existing key — conflict. Read не проверяет текущие funds/quota/model allowlist/catalog availability и не повторяет admission/quote: изменение политики не лишает активный key собственного уже оплаченного результата. Credentials/key active auth и billing policy — разные проверки.

Safe projection не содержит usage_snapshot, pricing/quote, supplier costs, API key hash, raw HTTP key/headers/trace/SID. `actual_cost_credits` только оригинальный settled BIGINT; native caller выбирает `actual_cost_credits::text` перед JS. Будущий TS wrapper обязан использовать точный bigint parser и public JSON decimal string, не Number/JSON numeric money. Timestamps сохраняют DB microseconds; не сериализовать их в локальном Date только ради readback. Claims/errors не логируют body или identifiers из чужого scope.

### Expire

`aiag_expire_gateway_http_result_v1(_org_id UUID, _billing_request_id UUID)` → BOOLEAN `true` только если этот вызов впервые удалил expired payload; absent/already purged/not due → false. Только owned scoped row; не принимать api-key как обход auth публичного read. Это trusted maintenance entrypoint без публичного mount, с тем же lock order. Никакого DELETE mapping/result, identity reuse или изменения финансового состояния.

## Locks, isolation, ошибки

Для всех функций порядок: organization row → advisory billing UUID (`pg_advisory_xact_lock(hashtextextended(uuid::text,0))`, тот же namespace existing lifecycle) → admission row если есть → key-owner lock/check где требуется → HTTP mapping row → result row. Никогда не держать HTTP lock перед вызовом existing lifecycle, который впервые возьмёт billing/admission lock. Повторное взятие уже удерживаемых org/billing/admission locks внутри v2 безопасно; wrappers не меняют порядок.

Claim/read находят mapping UUID первоначальным **нелочащим** scoped SELECT после org lock, затем берут billing/admission/key/HTTP в указанном порядке и перепроверяют immutable identity. Если mapping отсутствует, claim использует proposed UUID; read возвращает not_found после current key check. Сериализация same-org через org lock исключает вставку mapping между lookup/claim при соблюдении entrypoints. Cross-org collision proposed UUID не меняет чужую mapping; unique/FK и advisory lock дают conflict, без чтения чужого body. Ошибки не раскрывают conflicting owner.

Fresh active check read/claim держит key row `FOR SHARE` до конца SQL transaction; authoritative revoke/policy writers соблюдают existing org-first contract. Read `VOLATILE`/READ COMMITTED, с locking recheck и DB `clock_timestamp()` после ожидания, не stale auth cache и не `STABLE` snapshot helper. Revoke-first запрещает read; read-first может завершить один авторизованный read, revoke ждёт, после commit новый read запрещён. Долгая транзакция с ранее разрешённым ответом не обещает ретроактивное стирание данных. SERIALIZABLE/REPEATABLE READ serialization failure/lock timeout остаются unknown/retry-read errors, не fresh execution grant.

Input ошибки: `INVALID_HTTP_REQUEST` / `INVALID_HTTP_RESULT` / `HTTP_RESULT_TOO_LARGE`, SQLSTATE `P0001`. Missing/wrong-owner/inactive key: единый `HTTP_ACCESS_DENIED`, `P0005`, до раскрытия mapping. Identity/body mismatch: `HTTP_IDENTITY_CONFLICT`, `P0005`; lifecycle mismatch: `HTTP_RESULT_STATE_CONFLICT`, `P0005`. Existing v2 financial validation errors проходят без маскировки под no-charge. Unexpected SQL/constraint/timeout/connection/serialization error не превращать в `not_found`/`did_claim=true`. В error text только постоянный code, без payload/keys/provider errors. Прежде чем вызывать JSON object/array operators/casts, явно проверять type; malformed input всегда controlled rejection и no mutation.

## Task 1: Additive SQL storage, schema и native доказательство

**Exclusive implementation ownership:** новая `packages/database/migrations/0069_gateway_http_storage.sql`; новая `packages/database/src/functions/gateway-http-storage.sql`; additive schema в `packages/database/src/schema/gateway.ts` и exports в schema index только при необходимости; новая `packages/database/scripts/__tests__/gateway-http-storage.native.integration.test.ts`; новый focused schema test при необходимости; `packages/database/scripts/__tests__/native-baseline.integration.test.ts` только inventory/checksum/mirror assertions; root `package.json` только регистрация новой native suite в `test:database-baseline`. Этот plan редактируется только по конкретному review, никаких соседних docs/runtime files.

1. Worker сверяет current git SHA/status, свободный0069 и ownership; фиксирует SHA-256 существующих SQL до работы. Читает перечисленные source contracts. Создаёт native suite на existing guard/client с assertions до реализации. Guard запускается до DB client/import/mutation, новые реальные соединения также проходят connected marker guard.
2. RED запускает новую suite на installed baseline68; честно помечает missing-function/table RED отдельно от поведенческих assertion RED. Не выдаёт compilation/import failure за доказательство race/fault. После candidate0069 нужны реальные поведенческие concurrency/fault tests по таблице.
3. Реализует tables, constraints/immutability triggers, separate v1 composites, entrypoints и strict DTO validator. Переиспользует exact quota JSON parsers где совместимо, не дублирует финансовый lifecycle. Schema денежные поля — BigInt mode, JSON body — typed supported DTO без расширения gateway contract; schema тесты не подменяют SQL tests.
4. Native tests вызывают installed production SQL functions через prepared bindings, не копии алгоритма. Race — independent real connections с `pg_blocking_pids`/lock barriers и подтверждённым blocked state, не timing sleeps или один Promise.all. Fault triggers/test-only SQL только в UUID своих fixtures и только guarded DB. JSON аргументы bind как objects/JSONB один раз; scalar/double-serialized JSON строки проверяются как malformed input. В этом DB gate postgres.js TS bridge не реализуется.
5. GREEN новая suite, full mandatory database baseline (включая прежние admission/quota/refund и bridge regressions) последовательно, schema tests и types/lint изменённых TS. Migration inventory69 и exact mirror. Fresh69 clean installation проверяется существующим guarded bootstrap/migrate workflow на действительно disposable empty DB; не делать произвольный DROP populated DB. Если текущий helper обеспечивает только rerun на populated test DB, отдельно сообщить этот факт и выполнить clean rehearsal только existing guarded способом, не менять helper scripts. Исходный clean68 evidence не считается clean69.
6. Независимые financial/spec и TypeScript reviews; все substantive findings исправлены и narrow checks повторены. Exact scoped commit после PASS/review; raw commands/results, checksum до/после, migration count и фактический clean/rerun status передать controller. Не обещать public/production readiness.

### Обязательная native matrix

| RED сценарий | GREEN invariant |
|---|---|
| Fresh claim до admission; два same scope callers с разными proposed UUID | одна durable mapping, ровно один did_claim=true; loser получает winner UUID; нет admission/balance/quota/provider effects |
| Scope same, fingerprint изменён; same body JSON order; exact reclaim новым connection | conflict только semantic fingerprint change; immutable original mapping, did_claim=false при replay |
| Same digest другой org/key; same proposed UUID другой scope; wrong owner FK/direct insert | scopes изолированы, UUID глобально не переиспользуется; чужой read ничего не раскрывает |
| Commit claim затем discard ACK; BEGIN claim disconnect до COMMIT; повторные fresh connections | committed mapping не даёт второго grant; uncommitted не оставляет partial row; read/replay не вызывает execution. Это simulated ACK loss, не power-loss proof |
| Claim survived restart без admission, rejected admission, cancelled/held/dispatched/unknown | pending/unavailable projection по контракту; нет takeover/lease/TTL execution/release |
| Real v2 admit→dispatch→atomic outcome/result→settle→read | body только после settled, exact current DTO/evidence/charge, reservations settle ровно один раз |
| Fault trigger result INSERT после real v2 outcome mutation | outcome/context/result вместе rollback; admission остаётся dispatched, supplier actual NULL, balances/reservations/events до/после равны |
| Два atomic writers same body; changed body/id/model/counts/actual/attempt; outcome без result | один INSERT/financial effect; exact replay no delta; mismatches/late backfill rejected |
| Atomic writer commit ACK discarded; reconnect replay и settle; disconnect до COMMIT | durable result+outcome либо оба отсутствуют, никогда split; replay не меняет body/TTL и не запускает provider |
| Active read после model disable/price/quota/policy change; revoke/disable-first и read-first | прежний результат доступен активному owner, свежий revoked read denied; real key lock ordering, нет deadlock |
| Key revoked после dispatch до writer; owner changed/wrong key | trusted outcome сохраняется при revoke; owner mismatch rejected, revoked public read denied |
| Ready expiry boundary `now < expires` / `now >= expires`; purge concurrent read/write replay | DB clock authoritative; expired body never returned, purge keeps mapping/digest; exact write replay после purge не восстанавливает payload/TTL и не допускает changed body |
| Exact7days retention, repeat expire, not-due expire, long expired pending/settled, fresh claim same expired key | owned immutable timestamps; tombstone retained; did_claim=false навсегда; no reexecution |
| Scalar/root array/null/double JSON string; missing/extra/nested provider fields; invalid count/finish/choice/type | controlled error, zero mutations; null/empty text and optional cached presence работают ровно по DTO contract |
| Safe integer edges, numeric strings/fraction/negative/overflow/sum; UTF-8 exact1MiB/+1 | validation fail-closed; bounds считаются как bytes; no truncation/float rounding |
| Exact actual credits >2^53; BIGINT edge compatible financial fixture; public count safe range | projected `::text` и later bigint не теряют точность; read не раскрывает private snapshots/headers/key/SID |
| Immutable direct UPDATE body/digest/owner/expiry; FK delete/owner checks | отказ unauthorized mutation; expiry единственный body UPDATE; tombstone не заменяет identity |
| Migration rerun/clean69, signatures/31fields, frozen0067/0068 and mirrors | additive compatibility, no historical edit, existing suites зелёные |

### Команды RED/GREEN (из canonical root; по одной, без параллельных heavy runs)

Preflight/read-only:

```bash
git status --short
git log -3 --oneline
rg --files packages/database/migrations
sha256sum packages/database/migrations/0067_gateway_charge_admissions.sql packages/database/migrations/0068_gateway_durable_spending_quotas.sql
```

Ожидаемые frozen checksums: `0067=c13bba2c2c6cd8443790ec7587bfd42860ac0a79de10c3edea856f978737b7e3`; `0068=b6ddc2382f92f45c0fcc51f8c8e46027faabf76de457009cb884844ddbb612a6`. Закрепить оба в native baseline, сравнить migration new-function section с mirror и не менять старые mirror files.

RED и затем focused GREEN (existing installed Vitest Node/shebang path):

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator env RUN_NATIVE_DB_INTEGRATION=1 node node_modules/vitest/vitest.mjs run packages/database/scripts/__tests__/gateway-http-storage.native.integration.test.ts
```

Перед GREEN установить candidate0069 существующим guarded migrate, после реализации выполнить mandatory baseline с новой suite:

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run db:test:migrate
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator bun run test:database-baseline
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/vitest/vitest.mjs run packages/database/src/schema/__tests__/gateway.test.ts
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p packages/database/tsconfig.json
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/eslint/bin/eslint.js --no-eslintrc -c packages/api-gateway/.eslintrc.cjs packages/database/src/schema/gateway.ts packages/database/scripts/__tests__/gateway-http-storage.native.integration.test.ts packages/database/scripts/__tests__/native-baseline.integration.test.ts
git diff --check
```

Если добавлен отдельный schema test/export — включить его в focused test/lint, без broad unrelated reformat. Database tsconfig исключает scripts: для native TS tests создать временный `/tmp/ag-http-storage-tsconfig.json` (не repository infrastructure) с содержимым ниже и выполнить отдельную команду. Existing gateway ESLint config применяется явно только как уже принятый набор TS rules; сам файл не изменяется.

```json
{
  "extends": "/home/bob/Projects/ai-aggregator/packages/database/tsconfig.json",
  "compilerOptions": {
    "rootDir": "/home/bob/Projects/ai-aggregator",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false
  },
  "include": [
    "/home/bob/Projects/ai-aggregator/packages/database/scripts/__tests__/gateway-http-storage.native.integration.test.ts",
    "/home/bob/Projects/ai-aggregator/packages/database/scripts/__tests__/native-baseline.integration.test.ts"
  ],
  "exclude": []
}
```

```bash
flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator node node_modules/typescript/bin/tsc --noEmit -p /tmp/ag-http-storage-tsconfig.json
```

Не считать production source types доказательством test types. Не менять scripts инфраструктуры ради проверки. Не запускать DB tests без guard, не подставлять production env. Конкретные blocker этого Task: недоступный guarded local PG, занятый migration number/ownership, несовместимость принятого immutable financial API с atomic wrapper. Gateway mount, production cutover, paid pilot и cleanup scheduler не blockers DB gate и не засчитываются как сделанные.

## Accepted source result

Commit a6c05135ee8206b875549d1e0d41f18ca3eca989. Independent typescript-reviewer/Astra high APPROVED, Critical/Important0. Baseline203/203 (HTTP64), schema9/9, source/native strict types и scoped lint PASS. Полный baseline выполняется --no-file-parallelism из-за общей БД и fault triggers; real connection races внутри tests сохранены.0067/0068 unchanged, exact mirror checked. Применение0069 поверх68 и69rerun доказаны; clean install69 не проверен, existing guarded fixed DB не имеет clean workflow. Это explicit migration/release gap, не отказ от будущей проверки. Публичный маршрут/executor не изменён. Следующий [B1](2026-09-08-http-storage-gateway-bridge.md) подключает typed transport и закрытый outcome seam.
