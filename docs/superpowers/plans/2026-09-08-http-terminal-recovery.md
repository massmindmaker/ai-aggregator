# AG C1 — durable pre-admit rejection и settlement recovery

Статус: **APPROVED для C1a после независимого повторного architecture/financial/spec review**. Исправление убирает новые DELETE guards, сохраняет существующий native cleanup/FK contract и явно защищает PL/pgSQL FOUND в admission guard. Остальные решения были approved in principle; это не общая приёмка. Это конкретный следующий локальный increment, не разрешение на public cutover. Документ подготовлен по текущим SQL/executor и принятым [0069](2026-09-08-gateway-http-storage.md), [0068](2026-09-07-durable-spending-quotas.md), [B1](2026-09-08-http-storage-gateway-bridge.md), [B2](2026-09-08-stored-chat-http-identity.md). Fresh auth `0fde334` — отдельная волна с собственной приёмкой; здесь auth не меняется. Источники: `gateway-charge-admission.sql`, `gateway-durable-spending-quotas.sql`, `gateway-http-storage.sql`, `billing/stored-chat-attempt.ts`, `http-storage.ts`.

Допущение: scope остаётся server-only stored plaintext/nonstream chat, identity v1, quota v2, одна попытка и один provider POST. C1a разрешён к локальной реализации после независимого review; C1b зависит от отдельной приёмки C1a.

## Конкретная проблема и результат

После успешного committed HTTP claim текущий executor может вернуть `rejected` без admission. `aiag_read_gateway_http_result_v1` видит mapping без admission и всегда возвращает pending. Второй раз запускать запрос нельзя, а durable причины отказа нет. Отдельно сохранённые атомарно success outcome и completion остаются pending, если процесс умер до settlement ACK.

После C1 подтверждённый детерминированный SQL admission reject атомарно создаёт immutable terminal запись, которую повторный запрос читает с тем же UUID и тем же ответом. Запоздавший admit любого текущего v1/v2 пути для этого UUID запрещён в БД. Recovery для сохранённого `outcome_recorded` вызывает существующий settlement без provider, новых цен, нового hold и новой usage. Неизвестная операция остаётся неизвестной; отсутствие admission само по себе не становится отрицательным исходом или разрешением повтора.

## Решения, которые review должно принять вместе

1. Отдельная таблица отрицательных исходов: существующая `gateway_http_results` требует admission FK и success DTO, поэтому её не превращать в универсальный error store.
2. Admission reject фиксировать **внутри нового SQL HTTP-admit wrapper**, через subtransaction вокруг единственного вызова `aiag_admit_gateway_charge_v2`. Не добавлять TS callback «сохрани PAYMENT_REQUIRED»: текущий transport mapper объединяет все P0003 и теряет точное доказательство.
3. В общий `aiag_admit_gateway_charge_impl` добавить узкий terminal guard под существующими org/advisory locks, до policy/funds изменений. Одной проверки в новом wrapper недостаточно: старый v1/v2 вызов может прийти поздно. Исторические миграции не редактировать.
4. Recovery — отдельный server-only вызов для конкретных trusted org/key/billing UUID. Никакого worker/scheduler, массового lease claim или public endpoint в C1. Вызывать существующий settlement; отдельного финансового алгоритма нет.
5. Новый read API v2 возвращает terminal rejection; identity/fingerprint и claim остаются v1. Не расширять существующий composite/read wrapper v1 несовместимыми status/nullability.
6. Известный синхронный abort **до вызова admit** закрывается отдельным fenced `not_started` исходом. Timeout/ACK uncertainty никогда не вызывает этот метод. Автоматическое закрытие abandoned mapping по возрасту не входит в C1.

## Durable состояния

HTTP mapping неизменяем через UPDATE и сохраняется всеми поддержанными runtime API во всех строках. Direct administrative DELETE не является поддержанным runtime API; точная граница и test cleanup ниже. «Нет admission» ниже — результат проверки под org/advisory locks, а не eventually-consistent GET.

| Durable факты | Read v2 | Допустимое действие |
|---|---|---|
| Нет mapping | not_found | Только обычный fresh claim; read не выдаёт execution grant |
| Mapping, нет admission и negative | pending | Не повторять execute/admit при неизвестной предыдущей операции; не terminalize по таймеру |
| Mapping + terminal negative, admission отсутствует | rejected | Вернуть неизменный error; ноль provider/hold; новый claim того же scope возвращает прежний UUID |
| held | pending | C1 recovery не изменяет; существующий подтверждённый cancel path остаётся отдельным |
| dispatched, outcome отсутствует | pending | Reconciliation; не provider retry, не release и не negative |
| outcome_recorded + валидный HTTP success result + quota v2 evidence | pending, либо expired при истёкшем payload | Recovery может только settle |
| settled + валидный живой success payload | ready | Replay сохранённого ответа и точного charge |
| settled + истёкший payload | expired | Не восстанавливать response через provider; receipt существует отдельно от payload |
| cancelled либо legacy outcome/settled без HTTP result | unavailable | Не фабриковать HTTP completion/negative; вне C1 repair |
| Одновременно negative и admission/result либо расходятся owner/evidence | error/conflict | Fail closed, никакой settlement/повтор |

## SQL schema и неизменяемость

Следующая свободная миграция, предварительно `0070_gateway_http_terminal_recovery.sql`, outer BEGIN/COMMIT; номер перепроверить в момент implementation. Новый exact mirror `packages/database/src/functions/gateway-http-terminal-recovery.sql`; current admission mirror обновляется только на replacement одной существующей функции. Freeze SHA256 `0067`, `0068`, `0069`; все старые signatures и 31-field admission composite сохраняются.

`gateway_http_rejections`:

- `billing_request_id UUID PRIMARY KEY`, `org_id UUID NOT NULL`, `api_key_id UUID NOT NULL`.
- Composite FK `(org_id,api_key_id,billing_request_id)` → `gateway_http_requests`, ON DELETE RESTRICT; owner key FK → `gateway_api_keys(org_id,id)`, ON DELETE RESTRICT. Admission FK отсутствует намеренно.
- `result_version SMALLINT NOT NULL CHECK (=1)`, `rejection_code TEXT NOT NULL` из закрытого списка ниже, `http_status SMALLINT`, `content_type TEXT CHECK (='application/json')`, `response_body JSONB NOT NULL`, `terminal_at TIMESTAMPTZ NOT NULL CHECK (isfinite(...))`.
- SQL строит `response_body` по фиксированной таблице code/status/message, ровно `{error:{code,message,type}}`, без входного текста, key, fingerprint, модели, provider error, policy/balance или stack. CHECK/validator проверяет точное соответствие DTO к версии/code/status, включая отсутствие лишних полей и малый byte cap (2048 canonical UTF8 JSONB bytes).
- Negative не содержит usage, fabricated admission, zero-priced settlement или ledger receipt. Это доказанный no-admission outcome; финансовые поля read остаются NULL.
- UPDATE negative допускает только NEW IS NOT DISTINCT FROM OLD. **Новые BEFORE DELETE guards не добавляются ни к mapping, ни к negative.** Existing0069 UPDATE immutability и DELETE/FK semantics не меняются. Negative owner FK запрещает DELETE mapping, пока negative существует (SQLSTATE23503), как existing result FK для success. Ни один поддержанный runtime entrypoint не удаляет negative или mapping, не снимает FK и не переиспользует UUID/digest; отдельного delete API не появляется.
- Negative body состоит из несекретных констант; поддержанные runtime API сохраняют его вместе с mapping бессрочно, TTL только у existing success payload (168 часов). Код/тело negative нельзя переписать после пополнения баланса, смены policy, нового месяца, key revoke либо client disconnect. Это retention contract поддержанного приложения, не обещание защиты от привилегированного произвольного SQL DELETE. Правила удаления аккаунта/PII требуют отдельного принятого retention контракта; C1 их не добавляет.
- Согласованность negative vs admission обеспечивают lock protocol + admission guard + все новые writers; прямые DML на финансовые таблицы не становятся поддержанным runtime API. Acceptance проверяет отсутствие direct DELETE negative/mapping и обходного admission INSERT в gateway runtime callsites; подготовка/очистка guarded synthetic fixtures — отдельная явно ограниченная тестовая операция. Если runtime role уже имеет прямые DML-права, это существующая trust boundary; не заявлять, что C1 технически запрещает злоупотребление этими правами. Общая DB-role модель и account deletion не входят в scope.

### Решение review: совместимость cleanup без расширения runtime scope

Текущий DB HTTP storage native suite удаляет собственные result→mapping строки в afterEach (`gateway-http-storage.native.integration.test.ts`, cleanup около234), и отдельно требует FK SQLSTATE23503 при попытке удалить mapping с result (около719). B1 driver harness делает такой же scoped cleanup (`http-storage-bridge.native.integration.test.ts`, около211). Добавление DELETE triggers нарушает оба принятых контракта, не исправляя сам late-admit race.

Выбран минимальный вариант: сохранить existing DELETE semantics и добавить новый FK child negative плюс UPDATE immutability. Financial fence остаётся в общем admission impl; живой terminal row нельзя обойти ни поздним v1/v2 admit, ни новым HTTP wrapper. Поддержанные APIs никогда не удаляют fence. Privileged прямое удаление child, затем parent остаётся вне гарантии, ровно как administrative удаление existing success result/admission. Disposable DB на каждую native suite ради нового запрета не требуется; existing clean rehearsal остаётся отдельной проверкой migration compatibility, без изменений runner.

Новые C1 native suites используют existing guarded local fixture и собственный ledger **успешно созданных** synthetic org/user IDs. Каждый key/billing ID связан с этим owner; IDs не принимаются из env, prefix match, arbitrary allowlist или пользовательского запроса. Ledger owner фиксируется только после успешного INSERT RETURNING; ошибку duplicate owner INSERT нельзя превращать в разрешение cleanup существующих данных.

Cleanup новой suite после завершения/закрытия всех её racing connections идёт в отдельной transaction: проверить точный owner для ожидаемых fixture IDs, удалить `gateway_http_rejections` по conjunctive org/key/billing predicates, затем owned HTTP results и mappings, затем существующий dependency-ordered financial/key/org/user cleanup. Если создание дочернего row имело uncertain ACK, сначала scoped read под уже подтверждённым собственным org; это разрешает удалить только принадлежащий ему row. Любое обнаруженное расхождение owner — fail closed и отчёт, не расширение predicate. Не использовать TRUNCATE, CASCADE, DISABLE TRIGGER, session_replication_role, production-role escalation или добавленный generic cleanup endpoint. Existing DB/B1 cleanup paths не меняются: их fixtures negative не создают. Новая C1b suite владеет собственным cleanup, где negative удаляется первым.

Acceptance новой cleanup: suite завершается без owned residual rows, unrelated sentinel org/key/mapping и его balance/quota snapshot остаются неизменными; cleanup failure не скрывается тестовым PASS. Существующие DELETE-with-child assertions сохраняют23503. В самой runtime acceptance terminal fence не удаляется для подготовки late-admit tests; funds/policy меняются штатным fixture setup и late admit должен по-прежнему отвергаться.

### Точный allowlist SQL rejection

Ловить только сочетание SQLSTATE и `MESSAGE_TEXT`, возникшее из вложенного вызова accepted admission. Не ловить весь P0001/P0003/P0005 как business rejection.

| SQLSTATE / MESSAGE_TEXT | Durable code | HTTP status | Фиксированный message / type |
|---|---|---|---|
| P0003 / INSUFFICIENT_FUNDS | PAYMENT_REQUIRED | 402 | Payment required / billing_error |
| P0003 / QUOTA_EXCEEDED | QUOTA_EXCEEDED | 429 | Spending quota exceeded / billing_error |
| P0001 / ADMISSION_DEADLINE_EXPIRED | ADMISSION_DEADLINE_EXPIRED | 409 | Admission deadline expired / request_error |
| P0001 / QUOTA_SESSION_REQUIRED | SESSION_REQUIRED | 400 | Session identifier required / request_error |
| P0005 / REFUND_BLOCKED | REFUND_BLOCKED | 402 | Billing admission blocked / billing_error |
| Отдельный explicit no-admit call, без перехвата exception | REQUEST_NOT_STARTED | 409 | Request not started / request_error |

Последние два business SQL кода не исправлять через нынешний generic TS mapper: DB wrapper возвращает типизированный committed результат. Quota, funds, refund и deadline rejection становятся окончательными для **этого** idempotency key; новая попытка после изменения условий требует нового key. Unknown P0003, serialization/deadlock/lock timeout, P0004, connection loss, invalid snapshots, arithmetic overflow, enforcement/policy migration errors, auth mismatch/revocation и malformed driver row не входят в allowlist. Они не пишут negative.

## Lock protocol и SQL API

Все функции — prepared server-only SQL, без нового SECURITY DEFINER или доверия body UUID. Верхняя блокировка всегда `organizations(id) FOR UPDATE`, затем `pg_advisory_xact_lock(hashtextextended(billingUUID::text,0))`, затем admission row `FOR UPDATE`, если существует. Никогда не брать request/result/negative row либо quota bucket до org lock. Все существующие финансовые функции остаются под тем же org lock; quota bucket/reservation order сохраняется из0068. Нет сетевого вызова внутри DB transaction.

### 1. `aiag_admit_gateway_http_charge_v1`

Параметры: ровно существующие12 аргументов `aiag_admit_gateway_charge_v2` плюс `_idempotency_key_digest TEXT`, `_request_fingerprint TEXT`, `_contract_version SMALLINT`. Порядок12: org, billing UUID, key, client_request_id, route, mode, model, authorized max, quote, deadline, declared SID, supplier quote. Route chat, mode stored и identity version1 проверяются. Новый `gateway_http_admit_result_v1` composite: `org_id UUID`, `api_key_id UUID`, `billing_request_id UUID`, `status TEXT` (`admitted`/`rejected`), `admission gateway_charge_admission_result` nullable, `rejection_code TEXT` nullable, `http_status SMALLINT` nullable, `response_body JSONB` nullable, `terminal_at TIMESTAMPTZ` nullable, `did_transition BOOLEAN`. Returned UUID/owner берутся из locked mapping и строго сравниваются TS с входом; TS также проверяет весь возвращённый admission anchor. Admitted требует nonnull admission и NULL всех rejection полей; rejected требует NULL admission и nonnull всех rejection полей, boolean did_transition в обеих ветках.

Порядок:

1. Проверить identity; взять org/advisory/admission locks. Прочитать immutable mapping и проверить весь scope, billing UUID, digest, fingerprint/version. Mapping должен уже существовать после committed claim. Чтение mapping до вызова financial impl не берёт request row lock: immutable identity защищена org protocol; это сохраняет порядок policy/key locks impl.
2. Если negative существует: проверить отсутствие admission/result и точный owner; проверить fresh active key как для public-facing admission; вернуть original negative `did_transition=false`, без чтения новых цен/лимитов и без вызова impl. Не проверять новые frozen quote поля для этого replay: HTTP fingerprint уже фиксирует клиентское намерение. Остальные mutable execution inputs не authority для replay.
3. Внутри `BEGIN … EXCEPTION … END` вызвать единственный `aiag_admit_gateway_charge_v2` с уже frozen args. Успех после выхода из вложенного блока проверяет owner/active key и locked mapping, затем возвращает существующий 31-field admission, включая его did_transition. Explicit active check обязателен также для existing admission replay: impl возвращается раньше своих fresh-key checks. Совпадающий admission replay **не разрешает provider**, как и сейчас. Policy/key/quota locks acquisition и финансовые checks остаются в impl.
4. В exception handler через GET STACKED DIAGNOSTICS сопоставить точную пару из allowlist; все другие ошибки `RAISE`. PostgreSQL rollback вложенного блока должен отменить org debit, admission/context, частичные quota buckets/reservations/events и hold events. Org/advisory/admission locks, полученные **до** вложенного блока, остаются до outer COMMIT.
5. После распознанного reject: проверить key owner и active status; затем mapping `FOR UPDATE`, negative row `FOR UPDATE`, ещё раз отсутствие admission/result. Вставить immutable negative c server clock и фиксированным DTO. Любой error вставки/проверки откатывает весь wrapper, не возвращает rejected. Если key уже не активен — access error, negative не фиксируется.
6. Для success/reject внешний autocommit ACK — граница достоверности. Внутри пользовательского transaction callback возвращённая строка не grant: после COMMIT. Query cancellation/outer rollback убирает negative; прежний committed claim остаётся pending.

В actual implementation проверить точный порядок аргументов existing signature, не пересоздавать quote calculation. Guard в `aiag_admit_gateway_charge_impl` выполняется **сразу после existing org/advisory lock и до existing admission SELECT**: `IF EXISTS (SELECT 1 FROM gateway_http_rejections WHERE billing_request_id=_billing_request_id) THEN RAISE ... 'HTTP_TERMINAL_REJECTION_EXISTS'/P0005; END IF;`. EXISTS не берёт negative row lock раньше admission; общий org/advisory protocol уже сериализует supported writers. Следующие существующие `SELECT a.* INTO _existing ... FOR UPDATE; IF FOUND THEN ...` остаются непосредственно рядом и неизменны. Нельзя вставлять PERFORM/SELECT либо проверку с новым FOUND между ними. Так admission existence и31-field replay не зависят от FOUND, оставшегося после lookup negative. Guard до existing-return также ловит невозможное coexistence. Не менять money/quota алгоритм и остальные assertions. В новой миграции публикуются guard и negative writers атомарно.

### 2. `aiag_reject_unstarted_gateway_http_request_v1`

Параметры: full scoped identity + billing UUID; code не принимается от вызывающего. Возвращает тот же rejection projection с фиксированным `REQUEST_NOT_STARTED`.

Под org/advisory/admission → key owner/active → mapping → negative locks: принять только существующий точный mapping и отсутствие admission/result. Существующий negative вернуть неизменным (включая другой первоначальный код), не перезаписывать. Новый negative вставить атомарно. Если admit уже держит org lock, дождаться его исхода: committed held/dispatched/outcome/settled/cancelled приводит к conflict, ни release, ни negative. Если negative выиграл, общий admission guard отклоняет любой последующий admit. Отсутствие ещё не committed admission проверяется только после тех же locks.

Вызывать только в trusted executor при **синхронно известном** aborted signal до первой admit invocation. Метод не получает generic error, stage из body, timeout или возраст mapping. Он отсутствует в recovery API. Его нельзя использовать для stale orphan, unknown admit ACK, dispatch/provider failure. Abort после admit идёт по существующему confirmed cancel; после mark-dispatch invocation действующие правила финансового завершения сохраняются.

### 3. `aiag_read_gateway_http_result_v2`

Параметры identity как у v1; новый composite содержит прежние9 полей и `rejection_code TEXT` десятым. Active credential и точный org/key scope обязательны. Под existing lock order проверить forbidden coexistence; если negative найден, вернуть `status='rejected'`, original billing UUID, stored http status/content type/body, `stored_at=terminal_at`, `expires_at=NULL`, `actual_cost_credits=NULL`, code из строки. Никакой повторной оценки policy/catalog/баланса.

Для всех прежних состояний semantics и9-field projection v1 сохраняются, `rejection_code=NULL`; предпочесть delegation существующему v1 после scoped terminal check под тем же transaction/locks. Парсер v2 проверяет ровно10 полей и status-dependent nullability; rejected допускает expires NULL, ready требует positive DTO и BIGINT ::text, expired не отдаёт payload/charge. V1 остаётся совместимым и не используется новой HTTP composition.

### 4. `aiag_recover_gateway_http_settlement_v1`

Параметры `_org_id UUID, _api_key_id UUID, _billing_request_id UUID`; возвращает unchanged `gateway_charge_admission_result` (31 поля). Это internal accounting operation, **не публичная проверка credentials**: exact key ownership проверяется, revoked/disabled key допускается, как при existing outcome persistence. Маршрут чтения с отозванным ключом по-прежнему запрещён.

Под org/advisory/admission → key ownership `FOR SHARE` → request/result/negative locks:

- Проверить полный same org/key/billing scope, mapping chat/stored/version1, отсутствие negative, admission route/mode, только state outcome_recorded или settled, outcome_kind success, attempt/upstream/quote/pricing/usage anchors, quota context version2 с тем же owner и supplier actual.
- Требовать существующую HTTP result строку с тем же owner/version, status200, canonical digest и допустимой expiry/nullability. Для живого payload `aiag_http_validate_response(body,usage)` должен совпасть с stored digest. Для expired payload с `response_body=NULL` проверить установленный immutable tombstone, expiry timestamps и сохранённый digest; создание нового outcome/result, заполнение body или вызов provider запрещены. Expired success всё равно можно settle, потому что финансовые evidence остаются в admission/quota context.
- Проверить authoritative supplier evidence: сохранённый supplier_usage_snapshot соответствует usage_snapshot; supplier_actual равен accepted `aiag_quota_supplier_actual(admission,actual,usage)` и не выше frozen supplier max. Это повторная проверка frozen facts, не lookup текущих цен. Actual charge обязан быть ненулевым либо нулевым ровно как в сохранённом outcome и не выше authorized max.
- Один раз вызвать `aiag_settle_admitted_gateway_charge(org,billing)` в той же transaction. Он выполняет native guarded money changes, original quota reservations/buckets, release/refund-debt/expired-subscription и ledger/events. На settled replay вернуть ту же31-field проекцию did_transition=false; receipt/event uniqueness остаётся штатной.
- Отсутствие/несогласованность любого required fact — fixed state/access conflict и ноль изменений. Для held/dispatched/cancelled/missing outcome/result recovery не вызывает cancel/admit/outcome/provider.
- Подтверждение settled только после autocommit ACK. Lost settlement ACK допускает только повтор **этого settlement recovery** либо durable read; никогда не createStoredChatAttempt/run. Если committed settlement найден, повтор не создаёт второй transaction/event.

Выбор кандидатов не требует `FOR UPDATE SKIP LOCKED` в C1: будущий scanner читает UUID hints без финансовых row locks и по одному вызывает этот wrapper, который заново проверяет факты. Не добавлять scanner сейчас и не брать admission lock до org через внешний queue query.

## Gateway composition и exact receipt

Создать `billing/http-terminal-recovery.ts` с узкими typed wrappers для четырёх новых API. Prepared explicit projections; 31-field admission parser переиспользуется без JSON numeric round-trip. SQL nested admission composite разворачивать в явные колонки с `BIGINT::text` и точными UTC timestamps; не отдавать composite driver object на доверии. DTO/args detach/freeze до первого await, error messages только фиксированные. Unknown/malformed transport всегда unavailable/reconciliation.

В `StoredChatAttemptDependencies` добавить OPTIONAL trusted `admitAttempt` seam с discriminated result `{kind:'admitted',admission}` / `{kind:'rejected',code,billingRequestId}`, и OPTIONAL `rejectUnstarted` seam для случая signal aborted до invocation. Default path остаётся accepted v2; supplied admit seam — единственный admission writer, fallback запрещён. Перед возвращением rejected seam проверяет committed terminal DTO/identity; failure → reconciliation_required stage admit. Расширить closed rejection code union только перечисленными durable codes. Готовый handle по-прежнему создаёт собственный UUID; resume factory отсутствует. Для rejectUnstarted failure добавить точный stage `pre_admit_terminal`, чтобы неизвестность не маскировалась not_started. HTTP composition обязана включать оба terminal seams и B1 sole persistOutcome вместе; ни один callback не поступает из request body.

C1 native harness готовит ready handle, claims его UUID, вызывает run только после valid fresh ACK; replay branch вызывает read v2 без новой модели/quote/attempt run. Новая mounted composition, изменение публичного chat route, policy resolver и активация recovery trigger остаются отдельным task. Если подготовка quote не ready, она сейчас случается до claim: её нельзя незаметно переносить после claim и оставлять новый known reject gap. Malformed B2 body/key до claim не требует durable mapping.

Денежный contract: internal `actualCostCredits` — bigint, SQL всегда ::text; это **microcredits**, не Number и не RUB. Для будущего JSON receipt использовать `{version:1,billingRequestId,chargedMicrocredits:"10014900000000000",unit:"microcredits",state:"settled"}` с десятичной строкой из authoritative admission. В C1 не менять OpenAI completion body и не добавлять денежные JSON numbers. Unit/name legacy SQL actual_cost_credits не переименовывать миграцией.

Supplier cost отдельный факт: `supplier_actual_usd_micro` в quota v2, единица USD micro, не client chargedMicrocredits и не AM revenue. Public HTTP read его не раскрывает. Если AM нужен supplier receipt, следующий отдельный internal versioned receipt contract должен брать **settled** AG admission + quota context с точными decimal strings и caller authority; AM не должен вычислять supplier actual из retail charge, RUB или текущего каталога. C1 сохраняет эти anchors, но не создаёт cross-product API/outbox/AM изменения.

## ACK uncertainty — обязательная таблица поведения

| Место потери подтверждения | Единственное безопасное следующее действие |
|---|---|
| claim ACK неизвестен | scoped read/claim reconciliation; replay never grants run; ни новый billing UUID, ни rejectUnstarted |
| SQL business reject внутри HTTP admit committed, ACK потерян | read v2 получает original rejected; provider0, финансовые side effects0 |
| HTTP admit rolled back/сеть оборвалась, результата нет | pending/reconciliation; неизвестный исход не превращать в business reject |
| admit committed held, ACK потерян | no dispatch grant; held recovery отдельно, C1 negative запрещён |
| dispatch ACK неизвестен | no provider retry/negative/cancel; dispatched reconciliation |
| outcome+body committed, ACK потерян | recovery validated outcome_recorded→settled; provider никогда не вызывается |
| outcome/result write rolled back | dispatched остаётся pending; recovery без result отказывает, не дописывает guessed evidence |
| settle committed, ACK потерян | повтор recovery/read подтверждает settled, ledger/quota events не дублируются |
| client disconnect после known reject или outcome | durable запись остаётся; credential scope и retention не меняются |

Этот этап устраняет forever-pending для **атомарно записываемого известного** rejection. Он не утверждает, что legacy orphan mapping или crash между claim и любой следующей операцией автоматически восстановлены. Для них нет достаточного durable proof; последующий безопасный abandoned-claim design должен иметь отдельный fencing/lease contract. Наличие pending в этой ветке честнее фиктивного отказа и повторного списания.

## Ownership, порядок реализации и native acceptance

Два последовательных Tasks с отдельной приёмкой, один owner на каждый path. Не трогать fresh auth, B2 identity encoding, routes, provider adapter, AM/Arena, конфиги, historical SQL, index tools. Root package/native inventory changes только после координации с root; соседние workers не откатывать. Коммиты выполняет root/выделенный последовательный owner, не общий index параллельно.

## Task 1: C1a — SQL + native acceptance
 Exclusive paths: новая `packages/database/migrations/0070_gateway_http_terminal_recovery.sql` (номер перепроверить), новый `packages/database/src/functions/gateway-http-terminal-recovery.sql`, current `packages/database/src/functions/gateway-charge-admission.sql` только guard replacement, additive `packages/database/src/schema/gateway.ts`/schema exports, новые `packages/database/scripts/__tests__/gateway-http-terminal-recovery.native.integration.test.ts` и focused schema tests, existing native baseline только inventory/checksum/mirror compatibility assertions. Root регистрирует suite последовательно. Завершение: весь SQL/native matrix ниже, baseline, clean next-tip/rerun, source/native types/lint, независимое financial/spec review. Ни gateway source/seams, ни mount в этом Task.

## Task 2: C1b — TS bridge + closed test composition
 Старт после принятия C1a. Exclusive paths: новый `packages/api-gateway/src/billing/http-terminal-recovery.ts` (малый parser рядом только при необходимости), `stored-chat-attempt.ts` и `stored-chat-attempt-contract.ts` только optional seam/result variants; новые `packages/api-gateway/src/__tests__/http-terminal-recovery.test.ts` и `http-terminal-recovery-bridge.native.integration.test.ts`, existing stored-chat tests только regression; admission-internal export только если необходим для переиспользования31-field projection, без change semantics. Root регистрирует suite последовательно. Завершение: focused units + existing billing/B1/B2/executor regression, strict source/test types/lint, real-driver bridge matrix по ACK/abort/recovery, независимое TypeScript/financial/spec review. SQL/migrations/auth/public routes неизменны. Trusted mounted route composition — следующий отдельный Task после C1b.

1. Preflight exact HEAD/status, сверка принятых contracts и auth scope, свободного migration номера и frozen SHA256; native fixture guard перед client/import/mutation. Написать focused unit contracts и native behavioral fixtures до implementation. Missing-function RED отмечать отдельно от behavioral RED.
2. SQL increment: таблица/immutability, current admission guard, атомарный HTTP admit, unstarted reject, read v2, single-record recovery и точные mirrors. Guard и новые writers появляются в одной migration transaction.
3. Gateway increment: strict wrapper parsers/seams, old default path regression. Не вводить публичный helper, который по одному billing UUID создаёт новую runnable попытку.
4. Native acceptance через реальный postgres.js и существующий guarded local PostgreSQL; fake provider только в harness. Один heavy run под `flock /tmp/ai-ecosystem-build.lock`; native fault suites последовательно, реальные racing connections внутри отдельных tests. Ни paid/network provider, ни production DB.
5. Required scoped units, strict source/test types/lint, database baseline (SQL изменён), guarded clean migration + rerun next tip. Frozen historical hashes, exact mirror,31-field and v1 compatibility assertions обязательны. Не считать old clean69 доказательством clean70. Независимые TS и financial/spec reviews до source acceptance; после acceptance отдельный mounted composition/cutover task.

| Native test / fault | Доказательство acceptance |
|---|---|
| Каждый allowlisted funds/quota/deadline/session/refund reject после committed claim | Exactly1 immutable negative, stable read/replay status/body/UUID; admission/context/hold/transactions отсутствуют; balances и quota counters до/после равны |
| Quota reject после первого successful reservation в другом dimension | Subtransaction rollback всех созданных buckets/reservations/events и org debit; negative всё-таки committed |
| Negative INSERT failure trigger | Никакого false rejected ACK, negative отсутствует, финансовые изменения откатились; claim остаётся pending |
| COMMIT reject + simulated application ACK loss, reconnect | Read v2 terminal error, zero provider; второй admit wrapper возвращает original negative |
| Concurrent duplicate SQL HTTP admit | Не более одного hold либо одного negative; общий UUID; replay did_transition=false не выдаёт execution grant |
| Negative commits, затем funds/policy исправлены и старый v1/v2 admit приходит | Общий guard запрещает оба entrypoints; balances/quotas/ledger неизменны, original error не переписан |
| Две реальные connections: paused admit перед COMMIT против rejectUnstarted; обратный порядок | Admit winner → reject conflict, negative0; negative winner → late admit conflict, admission0. Проверять отсутствие второго provider и финансового следа |
| Signal aborted до invocation / после admit / после dispatch | Только первый использует unstarted terminal seam; остальные accepted cancel/reconciliation semantics, no fallback writer |
| Unknown P0003/message, P0004, timeout, malformed row и lost admit/dispatch ACK | Ни negative, ни automatic provider retry; state соответствует durable facts |
| Different org/key/SID/fingerprint; revoke между claim и admit; revoked replay/read | Никакой scope leak; admission/read denied; immutable negative не изменяется; recovery existing obligation всё равно допустим по trusted internal owner |
| outcome+HTTP result committed; процесс/ACK потерян до settle | Fresh recovery получает settled; original balance/quota release, один settlement event/receipt, provider count остаётся1 |
| Два recoveries + штатный executor settle конкурентно | Один financial transition; последующие settled replay; balances, original quota periods и supplier actual без дублей |
| Fault settlement transaction/event/quota terminal insert | Полный rollback settlement; outcome/result сохраняются; повтор recovery succeeds once |
| Held/dispatched/cancelled/no mapping/no HTTP result/negative/foreign owner/несогласованный supplier evidence | Recovery меняет0 строк денег/quota, fixed failure; никогда не вызывает outcome/admit/cancel/provider |
| Success payload expired и стёрт штатным expire, outcome_recorded ещё не settled | Recovery settles financial evidence, body остаётсяNULL и read expired; no retention reset/provider replay |
| Exact amount10014900000000000n (>2^53), boundary BIGINT и zero actual | Driver ::text→bigint exact, receipt decimal string exact; supplier USD-micro отдельно; unsafe Number rejected |
| Negative UPDATE, mapping DELETE с negative/result, repeated claim после TTL success | UPDATE отвергнут; parent DELETE с child даёт23503; supported expire не удаляет mapping/negative, claim возвращает original UUID и прежний negative |
| Новый C1 scoped cleanup + unrelated sentinel; существующие DB/B1 cleanup | Negative удаляется только в owned test teardown до parent; owned rows отсутствуют, sentinel snapshots неизменны; old cleanup и23503 assertions проходят безtriggerdisable/cascade |
| Fresh admit без negative; matching v1/v2 existing admission replay; terminal negative перед late admit | FOUND regression: первая попытка создаёт held, replay возвращает31-field did_transition=false, terminal guard отвергает late admit с нулём financial changes |
| Migration apply/rerun/clean, old v1 lifecycle и B1/B2 regression | Historical hashes и31-field signature unchanged; legacy non-HTTP requests работают прежним образом |

Acceptance заканчивается локальными SQL/wrapper/seam гарантиями. В документе implementation report явно перечисляет оставшиеся unknown-operation reconciliation, fresh trusted composition, mounted billable route/refund cutover и receipt integration gates; score108/production release из C1 не следуют.

Root execution ruling: C1a локальная реализация разрешена после independent plan Approved. C1b не стартует до принятия C1a. Новые тесты, baseline и clean70/rerun обязательны; старый clean69 не переименовывать в новую приёмку.

## C1a review correction: append-only validation migration

0070 candidate был применён к guarded local DB до выявления spec mismatch в helper error mapping. Его SHA `b38ebb05871648feed2085526b89cdfced8e69328c645b4b0f6a944c664a6efa` теперь сохраняется; никаких reset, подмены schema_migrations или редактирования применённого SQL. Ownership C1a расширен на `0071_gateway_http_recovery_validation.sql`: только replacement recovery с remap известных helper P0001/P0005 к фиксированному state conflict, settlement вне catch. Current mirror и проверки latest definition учитывают0071. Native inventory и чистая приёмка теперь71, команда `db:test:clean71`; подготовленный clean70 не был принят и не является доказательством нового tip. Исторические0067–0070 неизменны. Это исправление прежнего контракта C1a, не public activation.

C1a принят локально: source `a0b6eb8`, root clean profile `f4cd433`; независимые financial/spec/TS findings закрыты. Baseline263/263, C1native50, schema/inventory37, source/native types/lint PASS. Realclean71:71apply→71skip, objects verified, own target dropped, canonical unchanged, gaps[]. C1b пока не выполнен; public route и recovery trigger не активированы.

## C1b локальная приёмка

Source `0f0b395`, test-only review fix `fb849ae`: independent spec/financial/TS Approved. Четыре prepared wrappers и optional sole admission/pre-admit terminal seams приняты; native harness соединяет их с B1 outcome writer и выдаёт run только после fresh claim ACK. Candidate focused57 (11 native), regression403, baseline274, strict source/test types и scoped lint PASS. После единственного cleanup замечания native12/12, types/lint PASS; runtime byte-identical candidate, поэтому прежние baseline/regression не переименовываются в новые запуски. Новый тест доказал RED→GREEN на настоящем rollback с подавленным ACK, проверяет13owned relations и неизменный sentinel. SQL/миграции/публичные routes не менялись. C1 завершён локально; следующий gate — независимо принятая mounted composition, затем receipt/recovery/refund/cutover.
