# AG — staged mounted stored-chat HTTP integration

Статус: **DRAFT для независимого product/financial/TypeScript review. Реализация и переключение runtime ещё не разрешены этим документом.** Подготовлен 08.09.2026 после C1a (`a0b6eb8`, локальная приёмка `1382f9b`); C1b ещё реализуется и должен быть отдельно принят до начала этого этапа. Документ изменяет только план. Все проверки ниже — будущая acceptance matrix, не результаты запусков.

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
| Этот же path с stream=true, BYOK header, tools/functions/media/unknown generation fields | `501 UNSUPPORTED_EXECUTION_CONTRACT`; не claim/admit/provider. B2 malformed input, отличимый от unsupported contract, даёт400 |
| `POST /v1/completions`, `/v1/embeddings`, `/v1/images/generations`, `/v1/video/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/batches` | `501 UNSUPPORTED_EXECUTION_CONTRACT`, никакого legacy handler/queue/job/provider/charge |
| Другие `/v1` mutation methods/paths, включая trailing-slash варианты | Fail closed:501 для распознанной неподдержанной операции,404/405 для отсутствующего маршрута/метода; ноль billable side effects. Не полагаться на один string-prefix denylist, которую обходит alias |
| `GET /v1/models`, `/v1/balance`, `/v1/batches/:id` | Сохраняются существующие auth/ownership read contracts; не получают execute grant и не создают работы |
| Health/metrics/admin вне `/v1` | Не меняются этим gate. Их отдельная авторизация не заменяется gateway API key. Известные internal egress/worker writers учитываются rollout inventory |

Gate не удаляет source модальностей и не объявляет их выполненными. Полная v1 acceptance требует будущей безопасной реализации всех согласованных возможностей; restricted501 — свидетельство отсутствия обхода в этом режиме, не полноценная функциональность продукта.

## Порядок supported HTTP запроса

1. Existing request ID остаётся trace ID, не financial identity. Fresh `requireApiKey` выполняет prepared active-key lookup; `orgId/apiKey.id` берутся только из проверенного контекста. Отсутствие/invalid/revoked/disabled credential →401; resolver outage → фиксированный503. Ни client org/key/billing UUID, ни trace не становятся authority.
2. **RPM применяется ко всем authenticated попыткам, включая ready/rejected replay.** Использовать существующий atomic rolling-window механизм как отдельный RPM-only guard. Redis недоступен → фиксированный503 до claim; RPM exhausted →429 + существующий Retry-After. Это явное operational ограничение доступа, а не повтор spending admission; RPM не списывает credits/quotas. Legacy `daily_usd_cap` часть не исполняется в этой pipeline. Решение позволяет ограничить brute-force/polling; сохранённый result от429/503 не меняется. Read-only retained routes сохраняют existing guards отдельно.
3. До JSON parse ограничить raw body: proposal256KiB, превышение413 без claim/admit. Проверить content type JSON; unsupported415. Detached validated B2 capture получает raw body, Idempotency-Key и declared SID. Отсутствующий/невалидный key/SID/body →400; public body с billingRequestId/orgId/callback отвергается как unsupported/unknown field. Сохраняются все B2 distinctions, в том числе omitted aiag_mode versus explicit auto, stream absent/false, max_tokens presence. Не использовать мутируемый `rawBody` старой PII pipeline.
4. Построить trusted full SQL scope и выполнить **read v2 до live model/default/policy/quote checks**. Любое состояние кроме not_found обрабатывается таблицей HTTP ниже. Read failure/identity conflict не превращается в not_found. Fresh auth и SQL active-key read остаются mandatory при каждом replay. Snapshot caller-visible fingerprint не зависит от сегодняшних catalog/defaults.
5. Только confirmed not_found разрешает fresh preparation: explicit key policy validation, whitelist, residency/PII constraints, default mode, model availability, exact quote/config и pinned adapter. Применяется accepted candidate/executor support; если обязательное policy свойство нельзя доказанно enforce по текущим данным, отказ до claim/provider, а не игнорирование. Не переносить opaque legacy PII middleware с live side effects на replay. Allowed-policy/default/candidate inventory и fixed failure codes должны пройти отдельный source review.
6. Источник exact decimal configuration фиксируется до первого await. Нельзя делать `String(config.CACHING_DISCOUNT)` после Number coercion. Для нового пути валидировать исходную строку того же operator setting либо согласованный exact default существующего pricing contract; не заводить вторую конкурирующую скидку и не брать цены из body. Точные runtime source/default semantics записать в implementation report и покрыть boundary tests. Quote-not-ready остаётся pre-claim ответом, никогда fabricated terminal row.
7. Подготовить accepted ready handle, содержащий новый собственный billing UUID. Выполнить B1 claim с этим UUID. Только fully validated `didClaim=true` **после autocommit ACK** позволяет единственный `run`. `didClaim=false` → read v2 исходного UUID, без run подготовленного handle. Unknown claim ACK →503 и reconciliation через следующий scoped read; не создавать новую попытку и не вызывать rejectUnstarted.
8. Fresh run связывает C1b trusted admit/rejectUnstarted и B1 sole outcome persistence с теми же scoped digests. Callback не приходит от public caller; fallback в default/legacy writer запрещён. Provider one-shot, redirects0, no SSE/failover, frozen mechanics/pricing из принятого executor. Уже admitted request не получает повторный grant из replay. Abort/ACK uncertainty обрабатываются по C1b stage semantics, не по одному generic catch.
9. После confirmed completion использовать durable read-v2 для HTTP success/terminal response. Это связывает fresh response и retry с одной saved projection. Если settle/response read ACK неизвестен, вернуть фиксированный503 без guessed body/charge; следующий тот же POST только читает durable facts. Нельзя вернуть200 до подтверждённого settlement или вызвать provider для восстановления потерянного response.

Есть допустимая гонка двух fresh not_found: обе стороны могут подготовить quote, но только winning committed claim запускает provider. Если проигравший видит pending, он не «помогает» повторным run. Ошибка preparation после confirmed not_found не даёт права overwrite уже появившегося mapping; никакого unconditional upsert отрицательного результата вне C1 wrappers.

## HTTP response contract v1 staged режима

Все supported route ответы, включая errors, имеют `Cache-Control: private, no-store`. JSON error envelope для новых недолговечных ошибок ровно `{error:{code,message,type}}` с фиксированными константами ниже. SQL/raw upstream/key/hash/policy/balance детали не отражаются. Existing fresh auth/RPM errors сохраняют свой согласованный envelope; implementation tests явно различают их и route errors. Body не содержит supplier facts.

| Durable результат / ситуация | HTTP и фиксированный ответ | Следующее разрешённое действие |
|---|---|---|
| ready |200, `application/json`, точный stored completion DTO без новой сериализационной нормализации его значений; exact client receipt headers ниже | Возврат результата, ни charge/provider/quote |
| rejected | Stored http status400/402/409/429, content type/body **из C1 validated immutable row** | Повтор того же key даёт тот же terminal error; изменение условий требует нового намерения/key, не auto-retry |
| pending |202, code `REQUEST_PENDING`, message `Request is pending`, type `request_error`; `Retry-After: 2` | Повторить **тот же** POST/key/body для read; не обещать срок completion и не выдавать execute grant |
| expired |410, `REQUEST_RESULT_EXPIRED`, `Stored response expired`, `request_error` | Не восстановить через provider; не reset TTL/receipt. Новый платный запрос — отдельное явное решение caller |
| unavailable |409, `REQUEST_RESULT_UNAVAILABLE`, `Stored response unavailable`, `request_error` | Same key не reexecutes; supported repair отсутствует для cancelled/legacy missing payload. Не fabricate zero charge |
| Scope fingerprint конфликт |409, `IDEMPOTENCY_CONFLICT`, `Idempotency key already used for another request`, `request_error` | Исправить caller intent; не вернуть чужой response |
| Unknown claim/admit/outcome/settle/read ACK или storage/config outage |503, `REQUEST_STATE_UNAVAILABLE`, `Request state unavailable`, `server_error`; `Retry-After: 2` | Сохранить key/body, read reconciliation при следующем запросе. Не объявлять rejected/not_found/zero cost |
| Unsupported execution в restricted режиме |501, `UNSUPPORTED_EXECUTION_CONTRACT`, `Operation unavailable in this execution mode`, `request_error` | Ноль queue/provider/admission; режим не поддерживает операцию |

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
