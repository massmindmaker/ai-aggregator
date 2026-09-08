# AG — staged mounted stored-chat HTTP integration

Статус: **APPROVED для локальной MC реализации после независимого architecture/spec review. Runtime переключение и production не разрешены этим документом.** Подготовлен 08.09.2026 после C1a (`a0b6eb8`, локальная приёмка `1382f9b`); C1b принят отдельно: source0f0b395/testfixfb849ae, acceptancefbccc4f. Документ изменяет только план. Все проверки ниже — будущая acceptance matrix, не результаты запусков.

Допущение: первый controlled cutover покрывает только stored plaintext nonstream chat уже принятого executor contract. Это временный ограниченный режим gateway, а не сокращение согласованного продуктового v1. Streaming, BYOK, tools, другие модальности и batches остаются отдельными обязательными gates полной приёмки. Ни число закрытых gates, ни этот режим не дают108/production readiness.

## Канон и конкретный разрыв

Канон: `docs/DEVELOPMENT-ENTRYPOINT.md`, `docs/superpowers/plans/2026-09-07-production-continuation.md`, [admission/executor](2026-09-07-gateway-charge-admission.md), [durable quota v2](2026-09-07-durable-spending-quotas.md), [HTTP SQL storage](2026-09-08-gateway-http-storage.md), [B1 bridge](2026-09-08-http-storage-gateway-bridge.md), [B2 identity](2026-09-08-stored-chat-http-identity.md), [C1](2026-09-08-http-terminal-recovery.md), [fresh auth](2026-09-08-fresh-gateway-auth.md). При старте сверить актуальный accepted C1b SHA и signatures; не переписывать его контракт по этому draft.

Сейчас `packages/api-gateway/src/server.ts` монтирует auth → Redis rate/spending guards → key limits → PII → model status → legacy routes. `routes/v1/chat.ts` делает live resolve/failover/provider и затем `settleCharge`; B1/B2/C1 не подменяют этот путь. Даже при org quota enforcement2 legacy provider-first routes могут тратить до отказа SQL. Replay, вставленный только внутрь chat handler, будет ошибочно зависеть от сегодняшних caps/model/PII checks. Старые billing headers вычисляются через Number/USD и не являются exact receipt нового lifecycle.

Результат этапа: в явно выбранном restricted режиме реальный mounted Hono dispatch использует единственный accepted stored executor, fresh credential boundary, durable HTTP identity и result replay. Все неподдержанные paid operations прекращаются до внешнего эффекта. Default runtime сохраняется до отдельного контролируемого переключения. Нет новой миграции, provider retry/failover, изменения B2 encoding, recovery scanner, public recovery endpoint, AM/Arena source или production deployment.

## Решения режима и конфигурации

Предлагается один startup enum `GATEWAY_HTTP_EXECUTION_MODE=legacy|stored_chat_only`, default `legacy`. Значение валидируется существующим config loader; неизвестное значение приводит к startup failure, не fallback. Имя — новый публично документированный operator contract после review, клиент не может выбирать режим header/query/body. Env читается один раз при запуске; runtime не переключается между запросами и не допускает per-request opt-out.

При `legacy` существующее mounted поведение и header literals остаются прежними, кроме отдельно уже принятой fresh auth. Добавление кода не меняет deployed env и не переводит org policies. Этот факт явно называется compatibility default, а не новой финансовой гарантией legacy режима.

При `stored_chat_only` после общих request-ID/операционных guards и fresh auth выбирается отдельная pipeline ниже. Gate закрывает неподдержанные paths **до** старых middleware, handler, upload/poll, очереди или provider. Legacy chat не вызывается ни при ошибке нового пути, ни при unsupported body. Недоступная конфигурация или quota enforcement не включает legacy fallback.

Для локальной acceptance режим включается только в dedicated guarded fixture process. Последующий live rollout требует отдельного подтверждения по named instance/org inventory, drain старого трафика, opening balances и receipt consumers; этот план не устанавливает live env. Обратное переключение на legacy также не считается безопасным автоматическим rollback: оно открывает старые spend paths. При проблеме остановить новые paid admissions на edge/instance, сохранить ledger/results и возможность контролируемой сверки; не стирать HTTP mappings и не обходить v2 через legacy.

Deployment-wide exclusivity обязательна перед live switch: тот же covered org не должен продолжать создавать расходы через старый gateway replica, batch worker или другой billable entrypoint. Один Hono flag этого не доказывает. Inventory таких writers и drain — отдельная часть controlled rollout checklist, не добавление нового orchestration service.

## Маршруты restricted режима

| Запрос | Поведение |
|---|---|
| `POST /v1/chat/completions`, supported B2 stored plaintext body | Новый durable путь. Idempotency-Key обязателен, billing UUID создаёт server handle |
| Этот же path с stream=true, BYOK header, tools/functions/media | `501 UNSUPPORTED_EXECUTION_CONTRACT`; не claim/admit/provider. B2 malformed input, отличимый от unsupported contract, даёт400 |
| `POST /v1/completions`, `/v1/embeddings`, `/v1/images/generations`, `/v1/video/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/batches` | `501 UNSUPPORTED_EXECUTION_CONTRACT`, никакого legacy handler/queue/job/provider/charge |
| Другие `/v1` mutation methods/paths, включая trailing-slash варианты | Fail closed:501 для распознанной неподдержанной операции,404/405 для отсутствующего маршрута/метода; ноль billable side effects. Не полагаться на один string-prefix denylist, которую обходит alias |
| `GET /v1/models`, `/v1/balance`, `/v1/batches/:id` | Сохраняются существующие auth/ownership read contracts; не получают execute grant и не создают работы |
| Health/metrics/admin вне `/v1` | Не меняются этим gate. Их отдельная авторизация не заменяется gateway API key. Известные internal egress/worker writers учитываются rollout inventory |

Gate не удаляет source модальностей и не объявляет их выполненными. Полная v1 acceptance требует будущей безопасной реализации всех согласованных возможностей; restricted501 — свидетельство отсутствия обхода в этом режиме, не полноценная функциональность продукта.

## Порядок supported HTTP запроса

1. Existing request ID остаётся trace ID, не financial identity. Fresh `requireApiKey` выполняет prepared active-key lookup; `orgId/apiKey.id` берутся только из проверенного контекста. Отсутствие/invalid/revoked/disabled credential →401; resolver outage → фиксированный503. Ни client org/key/billing UUID, ни trace не становятся authority.
2. **RPM применяется ко всем authenticated попыткам, включая ready/rejected replay.** Использовать существующий atomic rolling-window механизм как отдельный RPM-only guard. Redis недоступен → фиксированный503 до claim; RPM exhausted →429 + существующий Retry-After. Это явное operational ограничение доступа, а не повтор spending admission; RPM не списывает credits/quotas. Legacy `daily_usd_cap` часть не исполняется в этой pipeline. Решение позволяет ограничить brute-force/polling; сохранённый result от429/503 не меняется. Read-only retained routes сохраняют existing guards отдельно.
3. До JSON parse ограничить raw body: proposal256KiB, превышение413 без claim/admit. Проверить content type JSON; unsupported415. Detached validated B2 capture получает raw body, Idempotency-Key и declared SID. Отсутствующий/невалидный Idempotency-Key или body, а также присутствующий невалидный SID →400; omitted SID сохраняется какnull по B2, а требование session quota проверяет C1 послеclaim и при необходимости сохраняет SESSION_REQUIRED; public body с billingRequestId/orgId/callback отвергается как unsupported/unknown field. Сохраняются все B2 distinctions, в том числе omitted aiag_mode versus explicit auto, stream absent/false, max_tokens presence. Не использовать мутируемый `rawBody` старой PII pipeline.
4. Построить trusted full SQL scope и выполнить **read v2 до live model/default/policy/quote checks**. Любое состояние кроме not_found обрабатывается таблицей HTTP ниже. Read failure/identity conflict не превращается в not_found. Fresh auth и SQL active-key read остаются mandatory при каждом replay. Snapshot caller-visible fingerprint не зависит от сегодняшних catalog/defaults.
5. Только confirmed not_found разрешает fresh preparation: explicit key policy validation, whitelist, residency/PII constraints, default mode, model availability, exact quote/config и pinned adapter. Применяется accepted candidate/executor support; если обязательное policy свойство нельзя доказанно enforce по текущим данным, отказ до claim/provider, а не игнорирование. Не переносить opaque legacy PII middleware с live side effects на replay. Конкретная fresh-preparation матрица и fixed failure mapping ниже обязательны; неизвестное свойство не игнорируется.
6. Источник exact decimal configuration фиксируется до первого await. Нельзя делать `String(config.CACHING_DISCOUNT)` после Number coercion. Для нового пути валидировать исходную строку того же operator setting либо согласованный exact default существующего pricing contract; не заводить вторую конкурирующую скидку и не брать цены из body. Точные runtime source/default semantics записать в implementation report и покрыть boundary tests. Quote-not-ready остаётся pre-claim ответом, никогда fabricated terminal row.
7. Подготовить accepted ready handle, содержащий новый собственный billing UUID. Выполнить B1 claim с этим UUID. Только fully validated `didClaim=true` **после autocommit ACK** позволяет единственный `run`. `didClaim=false` → read v2 исходного UUID, без run подготовленного handle. Unknown claim ACK →503 и reconciliation через следующий scoped read; не создавать новую попытку и не вызывать rejectUnstarted.
8. Fresh run связывает C1b trusted admit/rejectUnstarted и B1 sole outcome persistence с теми же scoped digests. Callback не приходит от public caller; fallback в default/legacy writer запрещён. Provider one-shot, redirects0, no SSE/failover, frozen mechanics/pricing из принятого executor. Уже admitted request не получает повторный grant из replay. Abort/ACK uncertainty обрабатываются по C1b stage semantics, не по одному generic catch.
9. После confirmed completion использовать durable read-v2 для HTTP success/terminal response. Это связывает fresh response и retry с одной saved projection. Если settle/response read ACK неизвестен, вернуть фиксированный503 без guessed body/charge; следующий тот же POST только читает durable facts. Нельзя вернуть200 до подтверждённого settlement или вызвать provider для восстановления потерянного response.

Есть допустимая гонка двух fresh not_found: обе стороны могут подготовить quote, но только winning committed claim запускает provider. Если проигравший видит pending, он не «помогает» повторным run. Ошибка preparation после confirmed not_found не даёт права overwrite уже появившегося mapping; никакого unconditional upsert отрицательного результата вне C1 wrappers.

## Fresh preparation: конкретный контракт MC2

Источники inventory: `middleware/auth-plan04.ts:51` выбирает свежую key row; `routing/engine.ts:59` задаёт семь известных policy keys; `middleware/key-limits.ts:74` — whitelist и legacy Redis cap, с явным отсутствием RU enforcement; `middleware/pii-filter.ts:30` — regex/hashes и побочные записи; `routing/resolver.ts:74` — cache600s и DB query без status; `middleware/model-status-check.ts:36` пропускает draft/unknown; `billing/candidate-quote.ts:32` — принятый filtered candidate/quote; `config.ts:18` — max output4096 и caching discount0.5. Ни legacy middleware, ни resolver cache не являются authority нового fresh пути.

Проверки ниже выполняются только после confirmed read-v2 not_found. Replay их не вызывает. Auth key/policies берутся из свежей DB auth row и detached capture; это snapshot допуска текущего запроса, не гарантия отмены уже подготовленного/отправленного запроса при последующем изменении routing policy. SQL admission повторно проверяет active key и денежные ограничения атомарно. Не заявлять transaction-wide model/policy revocation, которой текущий SQL не обеспечивает.

| Поле/источник | Enforce/default/reject в restricted fresh path |
|---|---|
| `policies` | Только plain JSON object с семью ключами типа `ApiKeyPolicies`: default_mode, allowed_providers, blocked_providers, forbid_non_ru, allow_pii_transborder, per_session_budget_cap_rub, forbid_streaming_prompts. Любой неизвестный ключ, accessor, malformed value —503 KEY_POLICY_UNAVAILABLE доclaim. Не strip unknown key. DB default{} допустим |
| `default_mode` | Отсутствует →auto; присутствует →строго auto/fastest/cheapest/balanced/ru-only, иначе503. Effective request mode: B2 requestedMode ?? policy default ?? auto; identity хранит исходный nullable mode, не effective default |
| `allowed_providers` / `blocked_providers` | Отсутствуют или[] →нет соответствующего ограничения; иначе массив непустых строк без coercion. Allowed+blocked применяются совместно accepted candidate filter, blocked выигрывает. Пустой eligible pool →503 STORED_CHAT_UNAVAILABLE, не fallback |
| Top-level `model_whitelist` | DB array строк, [] значит unrestricted; malformed/missing actual DB field →503 KEY_POLICY_UNAVAILABLE. Непустой список требует точного requested slug, иначе403 MODEL_NOT_ALLOWED; alias не расширяет доступ |
| Top-level `ru_residency_only`, policy `forbid_non_ru` | Первый обязателен boolean изDB; второй optionalboolean defaultfalse. `true` любого из них принудительно передаёт forbid_non_ru=true в accepted candidate filter. Client mode и allow_pii_transborder не отменяют RU-only. Residency unknown/malformed у DB candidate —candidate invalid/unavailable, не false→разрешено |
| `allow_pii_transborder` | Optionalboolean defaultfalse. На fresh detached plaintext messages вызвать существующий extractText/detectPii. Если blocking hit и allow=false, перед quote удалить все non-RU candidates; ни первый cached candidate, ни slug prefix не доказывают residency. Если после этого нет RU candidate —403 PII_TRANSBORDER_BLOCKED. При allow=true действует обычный pool с прочими ограничениями. FIO warn-only не блокирует. Regex не объявлять полной DLP/юридическим доказательством |
| PII telemetry | Сохранить только existing hashed detection records на fresh branch, без raw sample/body в logs. Best-effort failure не меняет billing grant и не протекает наружу. Replay не сканирует/не пишет detections. При конкурентных fresh preparations telemetry может повториться по trace; это не financial event |
| `forbid_streaming_prompts` | Optionalboolean defaultfalse; обе boolean values допустимы, так как restricted route всегда nonstream. Небулево значение503; streaming route всё равно501 доclaim |
| `per_session_budget_cap_rub` | Отсутствует/null/точный numeric или decimal-string0 допустимы; положительное legacy значение →503 KEY_POLICY_UNAVAILABLE (migration required), отрицательное/malformed тоже503. Не конвертировать RUB в новый cap. Authoritative session cap берётся только SQL quota key policyv2. Omitted SID=null не отвергается здесь; C1 SQL решает SESSION_REQUIRED |
| Monthly/daily quota fields | Не использовать JS Number/Redis spending для допуска. Native SQL проверяет current monthly units и v2 org/key limits; positive ambiguous legacy daily policy остаётся SQL migration refusal. Restricted flag не мигрирует их. Не выдавать такой refusal за нулевой balance/обычный402 |
| Model/upstream/price source | Новый fresh resolver entrypoint обходит Redis read/write, использует тот же reviewed row-to-candidate parser и prepared exact numeric::text projections. DB predicate требует m.enabled=true AND m.status='live', mu.enabled=true, u.enabled=true; тип строгоchat. Нет строки/live candidate →503 MODEL_UNAVAILABLE. Draft/pending/frozen/depublished/unknown не проходят. Старый resolver function/cache/default legacy остаются неизменными |
| Candidate support | Fresh DB facts повторно связываются с process-owned reviewed profile и registered admitted adapter; existing createStoredChatAttempt выбирает один кандидат и фиксирует quote/mechanics. Нет matching profile/adapter/valid quote →503 STORED_CHAT_UNAVAILABLE. Не расширять registry по client JSON |
| Config decimals | Startup capture исходной CACHING_DISCOUNT string, при отсутствии literal '0.5' из existing default; валидировать existing exact charge parser. Не восстанавливать через String(Number). Это две представления одного setting для legacy/restricted, не две настройки. Invalid restricted config отказывает startup. DEFAULT_MARKUP не заменяет точный model_upstreams.markup |
| Token default | Existing validated GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS default4096. Client max_tokens уже B2 validated; existing profile clamp/quote остаётся. Ни public max budget, ни price override не добавлять |
| `preDispatchDeadlineAt` | Один server Date.now snapshot непосредственно перед синхронным createStoredChatAttempt после fresh DB/policy work, deadline +30000ms, ISO UTC; фиксированный local contract constant, caller не задаёт. Между handle/claim/run не продлевать. SQL clock решает истечение. Отказ HTTP-admit до admission сохраняет durable ADMISSION_DEADLINE_EXPIRED. Истечение после held на mark-dispatch запускает accepted cancel path, не negative; confirmed cancelled_no_charge читается как unavailable409, unknown cancel ACK даёт503. Clock skew не даёт обещания30s provider execution: это только pre-dispatch admission window |

Нужны focused RED/negative tests всех строк, включая top-level RU-only при policyfalse, mixed RU/nonRU PII pool, unknown keys, cache с ранееlive моделью после DBfreeze, price revision изDB, default mode change наreplay и отсутствующий SID с включённой/выключенной session quota. В mounted MC06/MC14 добавить эти случаи; новые guards не исполняются на saved result branch.

## HTTP response contract v1 staged режима

Все restricted `/v1` ответы, включая auth/RPM errors, имеют `Cache-Control: private, no-store`: заголовок задаётся в самом начале restricted pipeline доauth, не только успешным handler. JSON error envelope для новых недолговечных ошибок ровно `{error:{code,message,type}}` с фиксированными константами ниже. SQL/raw upstream/key/hash/policy/balance детали не отражаются. Existing fresh auth/RPM errors сохраняют свой согласованный envelope; implementation tests явно различают их и route errors. Body не содержит supplier facts.

| Durable результат / ситуация | HTTP и фиксированный ответ | Следующее разрешённое действие |
|---|---|---|
| ready |200, `application/json`, точный stored completion DTO без новой сериализационной нормализации его значений; exact client receipt headers ниже | Возврат результата, ни charge/provider/quote |
| rejected | Stored http status400/402/409/429, content type/body **из C1 validated immutable row** | Повтор того же key даёт тот же terminal error; изменение условий требует нового намерения/key, не auto-retry |
| pending |202, code `REQUEST_PENDING`, message `Request is pending`, type `request_error`; `Retry-After: 2` | Повторить **тот же** POST/key/body для read; не обещать срок completion и не выдавать execute grant |
| expired |410, `REQUEST_RESULT_EXPIRED`, `Stored response expired`, `request_error` | Не восстановить через provider; не reset TTL/receipt. Новый платный запрос — отдельное явное решение caller |
| unavailable |409, `REQUEST_RESULT_UNAVAILABLE`, `Stored response unavailable`, `request_error` | Same key не reexecutes; supported repair отсутствует для cancelled/legacy missing payload. Не fabricate zero charge |
| `HttpStorageConflictError` из read/claim |409, `REQUEST_CONFLICT`, `Request conflicts with stored state`, `request_error` | Не выдавать generic state conflict за доказанный fingerprint mismatch; не вернуть response и не запускать новый handle |
| Unknown claim/admit/outcome/settle/read ACK или storage/config outage |503, `REQUEST_STATE_UNAVAILABLE`, `Request state unavailable`, `server_error`; `Retry-After: 2` | Сохранить key/body, read reconciliation при следующем запросе. Не объявлять rejected/not_found/zero cost |
| Unsupported execution в restricted режиме |501, `UNSUPPORTED_EXECUTION_CONTRACT`, `Operation unavailable in this execution mode`, `request_error` | Ноль queue/provider/admission; режим не поддерживает операцию |

### Полная классификация входных и подготовительных ошибок

Приоритет: validated stored C1 rejected DTO всегда возвращает свой original status/body; у error/unknown result без такого DTO terminal rejection не придумывается. После вызова handle.run любой reconciliation_required (включая admit access/конфликт, которые executor намеренно сворачивает) →503 REQUEST_STATE_UNAVAILABLE. Нельзя восстановить якобы точный401/409 из потерянного discriminant. Прямые read/claim exceptions доrun классифицируются отдельно ниже.

| Доказанный источник | HTTP / code / message / type |
|---|---|
| JSON parse/B2 identity failure, invalid present SID/key, отсутствующий обязательный body/key |400 / INVALID_STORED_CHAT_HTTP_IDENTITY / Invalid stored chat request / request_error |
| Raw body превышает262144bytes, включая chunked |413 / REQUEST_BODY_TOO_LARGE / Request body too large / request_error |
| Не JSON media type (application/json с optional charset допустим) |415 / UNSUPPORTED_CONTENT_TYPE / JSON content type required / request_error |
| Узкая explicit unsupported body feature (streamtrue, BYOK, tools/functions/media) либо неподдержанный paid path |501 / UNSUPPORTED_EXECUTION_CONTRACT / Operation unavailable in this execution mode / request_error. Классификатор ничего не удаляет перед B2; прочие unknownfields →400 B2 failure |
| Whitelist deny |403 / MODEL_NOT_ALLOWED / Model not allowed for this key / request_error |
| Blocking PII без допустимого RU pool |403 / PII_TRANSBORDER_BLOCKED / Request blocked by data policy / request_error |
| Invalid/unsupported fresh key policy |503 / KEY_POLICY_UNAVAILABLE / Key policy unavailable / server_error |
| Fresh enabled/live DB model/candidate отсутствует |503 / MODEL_UNAVAILABLE / Model unavailable / server_error |
| createStoredChatAttempt.status bad_request |400 / INVALID_STORED_CHAT_REQUEST / Invalid stored chat request / request_error |
| createStoredChatAttempt.status unavailable |503 / STORED_CHAT_UNAVAILABLE / Stored chat unavailable / server_error |
| Прямой HttpStorageAccessError из read/claim при fresh auth→SQL revoke |401 / AUTHENTICATION_REQUIRED / Authentication required / authentication_error; no billing grant/body. Existing auth middleware envelope остаётся прежним, обе ветки покрыты HTTP тестами |
| Прямой HttpStorageConflictError из read/claim |409 / REQUEST_CONFLICT / Request conflicts with stored state / request_error; generic error не доказывает fingerprint mismatch |
| HttpStorageUnavailableError/DB/Redis/unknown exception либо run reconciliation |503 / REQUEST_STATE_UNAVAILABLE / Request state unavailable / server_error; Retry-After2, сохранить key/body |
| Startup invalid enum/exact config |Процесс не стартует; нет HTTPfallback и чтения malformed config изrequest |

Полная таблица результатов `handle.run()` при обязательных C1b seams:

| Discriminant | HTTP действие |
|---|---|
| settled_success / rejected / replay / cancelled_no_charge | Только validated read-v2 текущей identity, затем durable mapping200/terminal status/202/409/410. Не сериализовать guessed run payload; cancellation не становится negative. Ошибка read классифицируется как прямой access/conflict/unavailable из таблицы выше |
| reconciliation_required |503 REQUEST_STATE_UNAVAILABLE без попытки восстановить утраченный discriminant и без нового run |
| not_started | При обязательном rejectUnstarted это нарушение composition contract:503 REQUEST_STATE_UNAVAILABLE, не объявлять безопасный бесплатный отказ |
| Неизвестный/malformed result либо throw |503 REQUEST_STATE_UNAVAILABLE, no fallback/provider retry |

Для новых503 route errors ставить Retry-After2 без обещания автоматического восстановления. Бюджетные402/429 возвращаются только через validated C1 rejected row; operational RPM429 отдельно, по existing counter contract. Никаких raw exception.message/stack/cause в HTTP или generic logs. Неподдержанный known feature определяется bounded parsed JSON доB2, но не создаёт альтернативную canonical identity. Обязательный Idempotency-Key не применяется к другим unsupported paid routes, чтобы501 не требовал бессмысленного ключа.

Для mapping-bearing ready/rejected/pending/expired/unavailable ставить `X-AIAG-Billing-Request-Id` из validated durable row, никогда из caller. Для uncertain transport без проверенного row этот header опустить; предложенный UUID не доказательство committed claim. `X-Request-Id` остаётся новым trace каждого HTTP запроса. Не добавлять новый public GET/recovery API ради polling: этот этап использует idempotent POST replay.

### Exact client charge и отдельные supplier units

На200/ready возвращать `X-AIAG-Receipt-Version: 1`, `X-AIAG-Charged-Microcredits: <canonical decimal string>` и `X-AIAG-Charge-State: settled`, вместе с billing UUID. Значение берётся из validated SQL `actual_cost_credits::text → bigint → decimal`; zero actual даёт строку0. Completion JSON не меняется. На остальных HTTP statuses **нет charge headers**, включая expired: отсутствие поля не означает бесплатный запрос. Receipt принадлежит billing UUID; повторный200 с тем же UUID не означает новое списание у downstream consumer.

Существующий `microCreditsToUsdMicroString` в `billing/token-quote.ts` уже делает точное `amount * 10n`: credit = 1 US cent, microcredit = 1/1000 credit = 10 USD-micro. Для200/ready сохранить также `x-aiag-charged-usd-micro`, вычисленный этим helper из того же authoritative bigint. Это эквивалентная client-charge проекция в прежней единице, не отдельный charge; никакого Number/FX. Например10014900000000000 microcredits дают100149000000000000 USD-micro. Старый literal не переименовывается и не заполняется числом microcredits.

`supplier_actual_usd_micro` — другой факт. В staged public path **не отдавать supplier header** и не вычислять его из retail charge/markup; существующий `x-aiag-upstream-cost-usd-micro` здесь отсутствует. Legacy режим сохраняет существующие header literals/поведение, source `lib/billing-headers.ts` не переименовывается молча. Сохранение client USD-micro header само по себе не делает прежнюю пару consumer-compatible.

AM worker сейчас читает legacy USD-micro pair. Поэтому covered AM traffic **не переводится** в restricted режим до отдельного versioned internal settled receipt contract/consumer cutover: exact client charge и actual supplier cost должны иметь раздельные поля/units и ACL. Caller-controlled header не может обозначить «trusted internal» и открыть supplier cost. Нельзя объявлять этот gate AM revenue integration. Existing edge stripping/white-label policy проверяется отдельно при live rollout; новый client receipt содержит только собственный charge и UUID, без provider identity.

## Recovery и незакрытые финансовые границы

Этот gate не вызывает settlement recovery автоматически из public retry. `outcome_recorded` остаётся202, пока existing trusted C1 recovery не выполнен отдельно. Native acceptance вызывает recovery через отдельный trusted harness connection и доказывает переход subsequent POST202→200 без provider. Публичный org/key не достаточен для internal recovery authority; scanner/scheduler/trigger — следующий отдельный gate. Legacy orphan mapping, dispatched без outcome и held с unknown ACK не получают таймерного terminalize/cancel.

Opening balances остаются binding по quota plan: для existing org сначала оградить legacy writers/inflight, reconcile obligations; monthly charged, daily supplier и continuing-session opening balances нельзя принять за0 из-за переключения режима. Нужны authoritative receipts/usage import либо согласованная чистая граница UTC periods и завершение/миграция sessions. Redis counters недостаточны. Positive ambiguous legacy daily/session policies требуют inventory и explicit mapping; SQL enforcement2 отказ не превращается в default policy.

Native controlled fixtures могут быть clean v2 с нулевыми opening balances, созданными самим harness; это не evidence существующих orgs. Runtime flag не мигрирует policy/ledger. Отдельная live rollout приёмка включает влияние default legacy instances и очередь ранее принятых batches.

Refund/payment cutover не завершён C1 или этим HTTP gate. Сохранить accepted refund-debt/admission/settlement semantics и regression tests, но не включать новые public refund/admin/webhook paths. Existing admission plan требует завершить refund confirmation/admin/webhook review до активации refund route. Новый HTTP receipt не является платёжным receipt RUB/TON и не закрывает chargeback/rails/AM accounting. Отдельные финансовые/cutover gates остаются в entrypoint.

## Ownership и последовательность после независимого review

Один владелец source composition и один heavy run под `/tmp/ai-ecosystem-build.lock`. C1b сначала принят; его author не делает review собственного diff. Все параллельные edits сохраняются. Никаких migrations, database reset, arbitrary env credentials или внешних сообщений.

| Task | Узкий scope | Приёмка |
|---|---|---|
| MC1 — HTTP/config contract | `config.ts`, отдельный route-local contract/response mapper и unit tests; explicit mode и exact-config source | Согласованные status/header/mode semantics, default legacy regression, no unsafe money Number |
| MC2 — composition/gating | `server.ts`, небольшой stored-chat handler/composition; extraction RPM-only без изменения legacy guards; точные route gates | Auth/RPM→B2→read→fresh prep→claim→sole run; unsupported side-effect0; original legacy tests сохраняются |
| MC3 — real mounted harness | Новый registered guarded native HTTP integration suite; использовать существующий PG/Redis helper и Hono app/server entrypoint | Матрица ниже с native SQL, real Redis, stubbed admitted transport и zero legacy/provider/queue sentinels |
| MC4 — evidence | Отдельный accepted source SHA/report/entrypoint после reviews | Scoped units/types/lint, relevant B1/B2/C1/executor+route regression, real mounted matrix. Source accepted, runtime default всё ещёlegacy |

Точные новые file names и suite registration фиксируются root до implementation. Не создавать production-visible DI endpoint; test injection остаётся trusted module boundary, не request data. Если тестовый app factory нужен, production `server.ts` обязан использовать ту же assembly: standalone hand-built Hono fixture без этой связи не доказывает mount.

## Обязательная mounted acceptance matrix

Каждый case идёт через реальный `app.fetch(Request)` production assembly либо loopback HTTP этого entrypoint, с настоящим guarded local PostgreSQL tip71+ и real isolated Redis. Admitted upstream transport stubbed; запрет real network/DNS/paid calls. DB functions не mock, SQL ошибки/locks — настоящие; provider/legacy/queue spies служат sentinels. Для incoming authenticated request использовать default DB auth, не resolver-only substitute. Fixture ownership/direct markers до import/connect/mutation; cleanup по уже принятому dependency order и own IDs, Redis own prefix/database. Test gate не читает production `.env`.

| ID | Сценарий | Доказательство |
|---|---|---|
| MC01 | env отсутствует/legacy, stored_chat_only, invalid mode | Default прежний; invalid startup refuses. Header/query не переключает режим; same source production assembly |
| MC02 | Missing/malformed/unknown/disabled/revoked bearer; DB auth outage |401 либо fixed503; claim/admit/provider/queue0, secret/detail leak0. Fresh lookup на каждом запросе, Redis auth cache не используется |
| MC03 | Missing/invalid key/SID/JSON/content type, oversize chunked body, malicious billingUUID/callback; supported B2 golden variations |400/413/415/501 по классификации, mapping0; raw bytes bounded до parse. Equivalent B2 inputs replay, meaningful differences409 |
| MC04 | Fresh clean v2 stored chat → repeat POST | Один committed claim/admission/provider/result/settlement lifecycle; обе200 одного billing UUID/body/exact charge. Repeat не вызывает quote/model/policy preparation, не добавляет spending/ledger |
| MC05 | Concurrent одинаковые key/body, два fresh not_found | Только один run/provider; loser202 или200 после durable read. Разные fingerprints409. Реальные lock waits наблюдаются, не только Promise.all timing |
| MC06 | Replay после смены model frozen/depublished, key whitelist/default mode/PII settings, balance/caps и нового quota period | Auth active → прежний ready/rejected результат без нового execution admission/PII log/model resolution; отсутствие новой usage/hold. Revoked key всё равно401 |
| MC07 | Real Redis RPM exhausted или unavailable при replay |429/503 до claim, stored result неизменён; после восстановления/окна прежний результат. Spending Redis counters не влияют на v2 path; RPM attempts не становятся financial events |
| MC08 | Все шесть C1 negative codes, включая pre-admit known abort | Stable stored body/status/UUID, financial effects0; provider0. Новые funds/policy не переписывают terminal result; malformed body до claim не создаёт negative |
| MC09 | Lost claim ACK, held admit ACK, dispatch ACK, outcome ACK, settlement ACK | Fixed503/202 по подтверждённым facts, никогда новый run/UUID grant из uncertainty. Сохранить key; reconnect replay читает прежний UUID. Fault-after-commit injection отдельно маркировать как simulated application ACK loss |
| MC10 | outcome_recorded, trusted recovery через другую connection, POST retry |202→200 после confirmed settlement, provider count остаётся1, exact native charge/quotas/receipt без дублей. Public request не вызывает internal recovery |
| MC11 | Cancelled/unavailable, expired live payload и штатный erased tombstone |409/410; no body/charge headers, no TTL reset/provider/guessed result. DB obligation может существовать независимо от истёкшего body |
| MC12 | Exact charge10014900000000000n, BIGINT boundary, actual0 | Microcredits header decimal exact, USD-micro header равен exact bigint×10 через existing helper, no Number conversion, повторные headers/body стабильны. Supplier fact отдельно проверяется DB и никогда не подставляется под client header |
| MC13 | Все unsupported billable routes/aliases, stream/BYOK/tools/media, batches POST |501/404/405 и ноль legacy settle/provider/job/queue/mapping. Batch GET/models/balance retained и scoped; invalid credentials не раскрывают private read |
| MC14 | Current policy cannot be enforced, ambiguous legacy quotas, org enforcement1, invalid exact config, unsupported adapter | Fresh path fails closed до provider; никакого fallback. Существующий durable replay не проходит через эти fresh-only checks |
| MC15 | Revoke между claim/admit; disable после dispatch; abort до admit/после hold/после dispatch | SQL fresh admission denied без negative при access failure; уже dispatched outcome/settlement остаются accountable, public revoked replay denied. Только известный pre-admit abort использует C1 unstarted |
| MC16 | Fault result INSERT, settlement event/quota write, invalid real-driver projection/ACK injection | Full rollback соответствующей transaction; никакого false200/zero cost/fallback writer. Result/admission facts сравнить native readback |
| MC17 | Legacy mode regression + retained read-only endpoints + source callsite inventory | Не скрытое удаление modalities. Restricted pipeline не достигает legacy `settleCharge`, failover/SSE и queues. Internal writers/AM consumers перечислены как rollout gaps, не объявлены switched |
| MC18 | Harness cleanup + unrelated PG/Redis sentinel; headers/log sanitization | Удалены только собственные fixtures; unrelated balances/mappings/keys/counters unchanged, immutable triggers включены. Body/key/hash/upstream diagnostics не попали в logs/public errors; old supplier headers отсутствуют в staged public path |

Verification последовательно: focused HTTP units; accepted B1/B2/C1/executor и relevant existing route regressions; source/test strict tsc и scoped lint; guarded mounted native suite под shared lock. Redis scopes и guarded env source документировать из текущего helper, не придумывать второй runtime. Если app source изменился после mounted run, повторить затронутую matrix на final SHA. Full database baseline нужен при новых SQL changes, которых этот gate не планирует; прежний clean71 не выдавать за mounted proof.

## Stop/acceptance boundary

Независимый review должен явно принять режим/HTTP/RPM/receipt решения или изменить draft до implementation. После реализации закрываются только restricted mounted source и local evidence. Отдельно остаются controlled runtime activation, existing-org opening balances/policies/inflight, internal receipt consumers, refund rails/cutover, recovery automation/unknown operations и весь согласованный v1 modality scope. Live env, production migration/deploy, paid upstream и внешняя публикация не разрешены этим документом.

Root product review: staged режим, default legacy, fresh auth + RPM для replay,256KiB body bound, fixed HTTP statuses и exact charge headers приняты как рабочие defaults для локальной реализации. Separate supplier receipt/AM cutover и все итоговые modalities остаются обязательными. Это не финальное architecture/spec review: C1b и независимый review этого draft ещё открыты, MC implementation не начат.

Architecture review round1: три P2 addressed в этом draft — nullable SID, concrete fresh-preparation inventory и полный source-discriminated mapper. Root выбрал snapshot routing policy (не midflight revocation), fresh uncached live model query и30s pre-dispatch window как explicit local defaults. Независимое повторное review ещё требуется; MC coding не запущен.

Architecture review round2: уточнены разные исходы deadline доadmission и послеheld; все run discriminants теперь имеют явный HTTP путь. Scoped повторное review pending, MC source не начат.

Final architecture/spec review784de06: Approved, все3P2 и уточнение deadline/runvariants закрыты. Root разрешил локальный MC1 из полного private brief; MC2/MC3 зависят от принятого MC1 и своих конкретных briefs. Это не mounted source acceptance и не runtime activation.

MC1 accepted locally08.09.2026: source `41ede0c`, independent TS/spec review Approved, findings нет. Авторские26/26 unit tests и locked source/test types/lint PASS; reviewer independently repeated types/full gateway lint/diffcheck, immutable review artifact verified. MC2 composition и MC3 mounted native matrix ещё не приняты; deployed mode не менялся.

MC2 accepted locally08.09.2026: source `ac23cae`, independent TS/financial/spec review Approved, no priority findings. Авторские570/570 tests26suites, strict source/test types и gateway lint PASS; reviewer независимо повторил types/fullgatewaylint/diffcheck и сверил immutable diff. Production server assembly подключена в явно выбранном restricted mode; default остаётся legacy. Эти tests используют mock storage/preparation/auth seams: native MC01–18 ещё открыты и переходят в MC3. Никакой runtime activation.
