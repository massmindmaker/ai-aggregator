# Task6 — durable spending quotas в AI Aggregator

Дата решения: 2026-09-07. **Статус: принято локально 2026-09-08 — реализация `fdd8f22`, test-only follow-up `2aa3a7f`; независимые financial/spec и TypeScript review Approved.**

Проверки: clean replay68, baseline127/127; после уточнения application ACK-loss итоговый quota run85/85 и строгие TypeScript checks PASS. Production/public routes не активированы. Остались неблокирующие follow-ups: regression на retail half-up boundary с частичным cache, разделение растущего native test harness при расширении, старое предупреждение Vite CJS.

**Goal:** атомарно учитывать settled+reserved расход месячного ключа, дневной организации и объявленной сессии вместе с существующим admission lifecycle.

**Architecture:** additive v2 DB entrypoints, сохранение принятого31-полевого результата и существующей финансовой арифметики. Ни один публичный маршрут не активируется этим этапом.

База source: принятый executor `b6266cb7e89648a230625dcc0e541ca37940d4f3`; native migration tip `0067_gateway_charge_admissions.sql`. SHA256 исторической0067: `c13bba2c2c6cd8443790ec7587bfd42860ac0a79de10c3edea856f978737b7e3`. Номер0068 повторно проверить перед созданием. Историческую0067 не менять.

## Решение и граница

Следующий узкий gate — native DB quota lifecycle для новых явно v2 admissions, плюс schema mirror и настоящий native RED/GREEN. Он не включает подключение executor, production inventory, миграцию положительных legacy policies, routes, reconciliation worker, BYOK executor, media или SSE. Эти gates следуют отдельно. Полная product readiness не следует из приёмки Task 6.

Binding units/owners уже установлены controller rulings, их не переоткрывать: key/month charged microcredits (включая BYOK fee), org/day supplier USD-micro (BYOK0), key/declared-session charged microcredits в новой v2 policy. Monthly legacy-name column читается точно ×1000 без FX. Положительные ambiguous legacy daily/session требуют inventory/cutover, никакого min/max/last-write, guessed FX или reinterpretation.

Принятые технические решения для реализации Task6:

1. Session — lifetime ключа и exact declared SID, без TTL, sliding expiry и автоматического reset. Повтор того же SID всегда использует тот же bucket; изменение лимита/revision не создаёт новый bucket. Новое поколение/reset потребует отдельного API и review. API-key rotation создаёт нового владельца, не снимая org/day guard.
2. Supplier base valuation v2: сумма frozen catalog input/output rates по verified usage, без retail markup и без retail whole-cost cachingDiscount. Округление вверх один раз в USD-micro на admission/outcome. Это бюджетная стоимость по каталогу, не доказательство provider invoice. Cache-aware supplier accounting потребует отдельного frozen supplier-cache tariff/formula; retail discount нельзя автоматически объявить supplier discount. Для cents/1k формула: `ceil(10 × (input_rate × prompt_tokens + output_rate × completion_tokens))` USD-micro, с одним итоговым округлением и точной decimal arithmetic.
3. Принят интерфейс A ниже: новые v2 admit/outcome entrypoints, прежний 31-field result; common dispatch/settle/cancel понимают v2 row. Session validation contract: ASCII `[A-Za-z0-9._:-]{1,128}`, exact case-sensitive bytes, без trim/lowercase/Unicode normalization. SID объявляет caller, принадлежность `(org,key)` даёт только trusted authentication. Это workflow label, не доказательство личности пользователя.

Эти решения приняты в рамках одобренной архитектуры. SQL increment не блокируется будущим production inventory: local fixtures используют явно чистые v2 policies.

## Наблюдаемые принятые контракты

- `packages/database/src/functions/gateway-charge-admission.sql`: каждый lifecycle call блокирует organization, затем billing UUID advisory lock, затем admission. Exact replay проверяется прежде новых eligibility checks. Settlement/cancel учитывают refund debt и captured subscription expiry. Result type имеет явно перечисленные31 поля, не `SETOF admissions`.
- `packages/database/migrations/0067_gateway_charge_admissions.sql`: immutable quote/pricing/usage facts, одна authoritative admission, положительный authorized max, outcome≤max; dispatched unknown сохраняет hold. На данный момент quota rows отсутствуют.
- `packages/api-gateway/src/billing/admission.ts`, `admission-result.ts`: wrapper проверяет snapshot equality и prior facts; не добавлять server quota snapshot внутрь возвращаемого quote JSON, поскольку это сломает accepted equality. Typed BIGINT parsing и microsecond timestamps уже приняты.
- `billing/stored-chat-attempt.ts`, `stored-chat-attempt-contract.ts`: snapshot version1, frozen candidate prices/profile/cap и verified usage; factory не принимает declared session и не выдаёт supplier amount. Поэтому Task 6 **не подключается автоматически** к Task 5.
- `billing/candidate-quote.ts`, `token-quote.ts`: цены cents/1k, maxima across eligible candidates, selected candidate actual; discount относится к whole retail charge. Supplier amount нельзя получить делением уже округлённого charged amount на markup.
- `packages/database/scripts/test-db-guard.ts`: обе URL, `AIAG_TEST_DATABASE=1`, `127.0.0.1:15432/ai_aggregator_test`, connected identity и marker; guard до production imports. Existing native admission suite имеет реальные function calls и `pg_blocking_pids` barriers.

## Добавляемая схема

Предпочтительно отдельные tables в `packages/database/src/schema/gateway.ts`; не копировать monetary organization schema в другой модуль. Все суммы Drizzle `bigint(...,{mode:'bigint'})`; decimals — строки.

1. `gateway_quota_org_policies`: `org_id PK/FK RESTRICT`, `enforcement_version SMALLINT` (1/2, отсутствие строки=1), `daily_supplier_usd_micro_limit_v2 BIGINT NULL CHECK >=0`, `revision BIGINT >0`, timestamps. `NULL`=disabled; v2 zero=explicit hard zero, не legacy disabled. Никакого backfill из key.daily_usd_cap. В Task6 production rows не переводятся в2.
2. `gateway_quota_key_policies`: `api_key_id PK/FK RESTRICT`, `org_id`, `session_microcredits_limit_v2 BIGINT NULL CHECK >=0`, `revision BIGINT >0`, timestamps. API будущего setter принимает canonical integer **string**, не JS number. Monthly authority пока current `gateway_api_keys.cost_limit_monthly_rub`: exact numeric credits×1000, NULL/legacy0=disabled, отрицательное/невалидное fail closed. Не создавать вторую competing monthly config. Session absent v2=disabled, а positive legacy session всё равно migration-required.
3. `gateway_quota_buckets`: surrogate UUID PK; `org_id`, `kind` (`key_month_charged_v2`,`org_day_supplier_v2`,`key_session_charged_v2`), `api_key_id nullable`, `declared_session_id nullable COLLATE "C"`, `period_start/end timestamptz nullable`, `reserved_amount BIGINT>=0`, `settled_amount BIGINT>=0`. Три partial unique indexes: `(org_id,api_key_id,period_start)` monthly; `(org_id,period_start)` daily; `(org_id,api_key_id,declared_session_id)` session. CHECK обеспечивает правильный owner/period/session shape; monthly/day `start<end`; lifetime session имеет оба period поля NULL. Не ставить cap на bucket: policy меняется, admitted limit snapshots остаются на reservation.
4. `gateway_charge_quota_contexts`: `billing_request_id PK/FK RESTRICT`, `quota_version=2`, immutable org/key/SID, `admitted_at`, `supplier_formula_version`, `supplier_quote_snapshot JSONB`, `supplier_authorized_max_usd_micro BIGINT>=0`, `supplier_actual_usd_micro BIGINT nullable`, `supplier_usage_snapshot JSONB nullable`. Actual и usage all-or-none; actual≤max. Политики и DB periods не дописываются в accepted admission.quote_snapshot. Context отличает v2 admission без зависимости от JSON marker клиента.
5. `gateway_charge_quota_reservations`: `(billing_request_id,bucket_id) PK`, `kind`, immutable `limit_snapshot BIGINT NULL`, `policy_snapshot JSONB` (safe version, owner, source value, revision или exact monthly value), `reserved_max BIGINT>=0`, `actual_amount nullable BIGINT`, `state` (`reserved`,`settled`,`released`), terminal timestamp. FK на context/bucket; unique `(billing_request_id,kind)`; owner invariants проверяются lifecycle и composite FK где удобно. State CHECK: reserved actual NULL; settled 0≤actual≤max; released actual0. Финальные rows не удалять.

Quota event audit: отдельная `gateway_charge_quota_events` с PK `(billing_request_id,kind,event_kind)`, bucket FK, exact reserved/settled/released deltas и timestamp. Amounts не складываются с balance ledger; это самостоятельная проекция политики. INSERT terminal audit вместе с counters и admission state; unique conflicts откатывают всю транзакцию. Для запрета прямого изменения immutable facts использовать тот же доверенный DB-write boundary, что0067; если нужны grants/triggers, отдельный явно scoped hardening, без заявления абсолютной tamper-proof защиты SECURITY INVOKER.

На **каждом** v2 admission вести monthly+daily usage даже при NULL cap. При наличии валидного SID вести session usage даже при NULL session cap. Это не даёт disable/re-enable обнулить usage или забыть unknown. Если ранее session policy disabled и SID не объявлялся, при дальнейшем включении нельзя приписать прошлые unlabelled запросы конкретной session; semantics — admission-time coverage, не ретроактивный global user cap. Active session cap + missing SID всегда отказ до hold/provider.

## SQL-интерфейсы и совместимость

### Принятый интерфейс A

```sql
aiag_admit_gateway_charge_v2(
  _org_id uuid, _billing_request_id uuid, _api_key_id uuid,
  _client_request_id varchar, _route_kind varchar, _billing_mode varchar,
  _model_slug varchar, _authorized_max_credits bigint,
  _quote_snapshot jsonb, _pre_dispatch_deadline_at timestamptz,
  _declared_session_id varchar, _supplier_quote_snapshot jsonb
) RETURNS SETOF gateway_charge_admission_result;

aiag_record_gateway_charge_outcome_v2(
  _org_id uuid, _billing_request_id uuid,
  _actual_cost_credits bigint, _usage_snapshot jsonb, _outcome_kind varchar
) RETURNS SETOF gateway_charge_admission_result;
```

Supplier maximum/actual **не отдельные доверенные суммы параметров**: SQL выводит их из проверенного versioned frozen supplier quote/selected pricing/verified usage; numeric declared maxima при наличии в JSON обязаны совпасть с recomputation. Для initial DB contract stored допускается только точный accepted plaintext-token shape/version, BYOK supplier quote — versioned zero marker. Это не реализует BYOK execution.

В new migration создать private implementation helpers для admit/outcome (например `aiag_admit_gateway_charge_impl` с quota context и `aiag_record_gateway_charge_outcome_impl` с expected version). Существующие SQL signatures вызывают legacy branch; новые — v2 branch. Сам helper валидирует допустимый version, policy и context, не имеет unsafe bypass/GUC. Один authoritative hold/outcome implementation; не поддерживать две расходящиеся копии финансовой арифметики. Допустимо вместо extraction общее именованное core с явными extra nullable args; **не перегружать existing signature optional defaults**, чтобы legacy resolution не стало неоднозначным.

В той же additive migration заменить bodies existing mark/settle/cancel для v2-aware проверки и переходов. Старые rows идут по принятой legacy ветке, v2 rows обязательно затрагивают quota. Old outcome entrypoint отказывает на v2 context, чтобы обход v2 evidence path не создавал неполный outcome. Common mark проверяет chosen supplier candidate membership и exact tuple/cap/prices/version перед grant. Общие settle/cancel могут вызываться existing wrappers:31 fields, signatures, quote JSON и did_transition semantics прежние.

Old admit: exact replay прежнего UUID остаётся valid после policy changes. Новый v1 admission при org enforcement2 отказывает `QUOTA_V2_REQUIRED`; при legacy1 работает как прежде. V2 admit требует enforcement2. Принятый Task5 остаётся v1 и unused; после явного org switch он получает safe pre-dispatch refusal, а не невидимый обход. Native legacy fixtures enforcement1 проходят без переписывания ожиданий.

Новый TS wrapper `billing/quota-admission.ts` и его type/identity tests — отдельный следующий integration increment после native DB approval. В Task6 нет изменений `billing/admission.ts`, `stored-chat-attempt*`, маршрутов или middleware. Native DB tests используют SQL entrypoints напрямую и31-field regression contract.

## Транзакция, lock order и replay

Общий порядок: `organization FOR UPDATE → existing billing advisory lock → admission FOR UPDATE → org/key policy rows и gateway_api_keys по UUID ASC → buckets по (kind, owner, period, SID) ASC → reservations/events`. New admission до INSERT всё равно берёт advisory UUID lock. Все операции, берущие более одного такого ресурса, соблюдают этот порядок; не использовать policy/key→organization. Native policy fixture/setter тоже organization-first. Это сохраняет accepted organization→payment refund order: quotas не берут payment locks. Общий org lock уже сериализует same-org quota изменения, child order нужен для дальнейших writers/поддержки.

Fresh admit, **одна SQL statement transaction**:

1. Валидировать identity/basic finite shapes, взять org/advisory/admission. Exact existing v2 replay сравнивает original org/key/trace/model/mode/max/quote/deadline/SID/supplier quote и возвращается без чтения новой policy/нового периода. V1↔v2 UUID reuse — conflict. Client trace одинаковый на двух server billing UUID не dedupe.
2. Проверить current key org/revoked/disabled и current DB policy. Взять все нужные key locks deterministic; org-wide legacy daily check рассматривает active keys. В initial Task6 любой positive unresolved legacy daily в covered org либо positive legacy session у current key => `QUOTA_POLICY_MIGRATION_REQUIRED`, даже если v2 limit уже задан. Malformed/negative unknown legacy policy fail closed; NULL/доказанно disabled0 не phantom cap. Никакой автоимпорт/автоматическое acknowledgement.
3. Захватить `admitted_at := clock_timestamp()` **после ожидания locks**; не caller time и не transaction-start `now()`. В UTC вычислить calendar month/day `[start,end)` от этого значения. Persist same admitted_at in quota context and admission created_at; deadline validated against it и фактическим dispatch time. Не добавлять injectable public clock.
4. Валидировать supplier quote и вычислить max, создать/find buckets для всех dimensions. Для каждой dimension reserve only if `settled::numeric+reserved::numeric+max::numeric <= current_limit` либо current_limit NULL. Дополнительно bound final sums≤BIGINT_MAX. Guarded `UPDATE ... WHERE ... RETURNING`; ошибка любой dimension откатывает предыдущие rows и hold.
5. В том же transaction выполнить accepted refund guard и bucket hold arithmetic, вставить admission/context/reservations/events. FK inserts могут идти после admission INSERT; порядок проверки не означает отдельный commit. Policy snapshots содержат exact owner/limits/UTC period; отказ не оставляет пустые buckets/financial effects.

Record outcome v2: common locks, matching stored attempt/upstream/profile and selected frozen tariff; verified counts, bounds и formula version валидируются. Immutable charged actual≤authorized; supplier actual≤reserved supplier max и chosen supplier max. Сохранять оба actual/evidence атомарно; **quota reserved ещё не освобождать**. Exact replay сверяет обе формулы/evidence, конфликт откатывается. Нет no-charge от timeout/network.

Settle: common locks; в одной транзакции accepted charge receipts/hold release/debt math + каждому original bucket `reserved -= reserved_max; settled += actual`, reservation CAS reserved→settled, quota event + state settled. Не перепроверять current tighter cap: расход уже санкционирован. Outcome_recorded и unknown до settlement продолжают занимать full maximum, это консервативно и исключает окно двойной ёмкости.

Cancel: только held; та же транзакция accepted funding restoration + quota reserved decrement, state released, audit. Dispatched/outcome_recorded не cancellable. Unknown не освобождается по дедлайну/TTL/process death. Exact terminal replay не меняет counters/events/receipts. Любая потеря DB ack — read/replay той же identity, не новая финансовая операция.

## Точная арифметика и период

Цены catalog `NUMERIC(18,10)` cents/1k. Пусть I,O exact decimals, C context, M cap, P/Q verified prompt/completion. Supplier maximum candidate = `ceil(10 * (I*C + greatest(O-I,0)*M))`; reservation=max среди frozen eligible candidates. Supplier actual = `ceil(10*(I*P+O*Q))` по selected candidate; multiplication factor10 — cents/1k→USD-micro conversion, без FX и без промежуточного retail rounding. BYOK supplier maximum=actual0. Actual0 charged и positive supplier могут сосуществовать из-за retail cache formula; обе quota dimensions считаются независимо.

В SQL intermediates unrestricted NUMERIC c явными bounds digit/scale до cast; никакого `float8`, floating JSON casts, bigint multiplication before widening, `round()` на промежуточных элементах. Count range nonnegative safe integer (≤9007199254740991), safe exact sum/context/cap checks, canonical decimal strings и supported version. Числовой cast в BIGINT только после целочисленности и 0..9223372036854775807. Accumulated `(settled+reserved)` также bound даже при unlimited policy. В JSON money — canonical strings. Проверить NaN/Infinity/exponent/negative/fractional integer явной validation, не полагаться на implicit casts PostgreSQL.

UTC period принадлежит admission, settlement after midnight/month boundary пишет **старый** bucket. Новые calls занимают новый bucket. Unknown старого периода сохраняет старую reservation и org money hold; не вычитать его из нового day/month quota, не delete старую строку. Session lifetime bucket при этом один. Никакого Redis TTL как источника истины. Clock rollover tests вызывают реальный SQL helper period calculation с фиксированным аргументом (pure helper, не public admit clock); actual admission-time locking проверяется отдельно. Для settle old-period fixture допускается подготовка согласованной исторической admission/reservation через scoped test fixture, но lifecycle mutations и arithmetic должны выполнять реальные функции; не копировать settlement SQL в тест.

## Cutover/legacy граница

Initial Task6 разрешает explicit clean v2 fixtures и новые/чистые orgs; не выдаёт функцию mass-enroll/backfill. Legacy admissions без context остаются version1. Не выдумывать для них supplier costs/SID. До перевода существующей org: остановить/оградить новые legacy dispatches, reconciliate pre-v2 held/dispatched/outcome_recorded; daily thresholds inventory разрешить по владельцу, session values заменить operator-approved versioned policy; затем atomically switch с проверкой отсутствия uncovered inflight.

Кроме inflight нужен текущий **settled period opening balance**: месячный key spend, дневной supplier spend и продолжающиеся sessions до cutover нельзя молча принять за0. Требуется проверяемый импорт по авторитетным receipts/usage либо cutover на согласованной границе чистых UTC periods и явное завершение/миграция старых sessions. Redis best-effort counters не доказательство точного opening balance. Если данных не хватает — existing-org enforcement switch остаётся blocked; native Task6 это не блокирует.

При enforcement2 fresh legacy admit запрещён; это защищает новый admission API, но legacy paid routes ещё используют прежний `aiag_settle_charge_credits` после provider. SQL quota gate сам по себе их не выключает. Полная гарантия появится лишь после route inventory/cutover или explicit disable **до внешнего side effect**. Public Task5 activation запрещена до trusted session/config/supplier composition и native end-to-end проверки.

## Native RED / race / fault matrix

Новая suite `packages/database/scripts/__tests__/gateway-charge-quota.native.integration.test.ts`, включить в обязательный `test:database-baseline`. Existing guarded clients; independent real connections и `pg_blocking_pids` barriers, не timing sleeps/Promise.all как единственное доказательство. Все tested lifecycle paths вызывают installed migration functions; test-only SQL разрешён для fixtures/barriers/fault triggers и read assertions, не для копии quota алгоритма.

| RED сценарий | Проверяемый итог |
|---|---|
| Adequate org funds; same-key monthly max70+70 vs cap100 | ровно1 admission; loser не снимает funds/не оставляет reservation/events |
| Разные keys same org, supplier max70+70 vs daily100 | ровно1; shared org supplier owner доказан |
| Same key+SID vs разные SID / другой key same SID | session contention только correct owner; monthly/org продолжают действовать |
| Cap disabled → spend/reserve → cap enabled; policy tighten/disable/re-enable | usage/unknown не сброшены; snapshot старого admitted остаётся payable; new excess rejected |
| Policy/key revoke writer и admit на org lock, оба порядка | current authoritative policy/active key; не auth-cache; нет deadlock |
| Monthly decimal10.01 credits, >2^53, BIGINT edge, zero vs NULL, invalid numeric | exact10010 microcredits; bounds/fail-closed без overflow mutations |
| Exact admit replay через period/policy change; changed trace/SID/tariff/org/key/max; v1↔v2 reuse | replay no delta; любой changed identity conflict без mutation |
| Same client trace два server UUID; SID совпадает с trace или billing text | trace не financial key; SID только scope, отдельные reservations |
| Two settlement callers / settle concurrent cancel / dispatch concurrent cancel | один terminal event/counter effect; post-dispatch cancel rejected |
| outcome0, supplier>0; actual>max в каждой dimension; BYOK fee | independent dimensions, zero valid evidence; overflow rejects; BYOK month/session count fee, day0 |
| supplier fractional rates/tiny costs/candidates разные markup, chosen cheaper | ceiling once; max covers all; selected immutable tariff, no inferred FX/retail division/cache |
| Forged selected tuple/profile/version/counts, missing supplier outcome, old outcome on v2 | rejected before terminal accounting; funded unknown persists |
| Fault trigger на quota event INSERT после hold / на final quota UPDATE после funding settlement | всю transaction откатить: balance, admission, quota, usage receipt, audit unchanged |
| BEGIN call real admit/record/settle, disconnect before COMMIT | no committed partial effect; new client proves durable state |
| Call committed then intentionally discard ack; new connection exact replay | once-only durable effect; no new UUID/paid retry |
| Restart/reconnect at held, dispatched, outcome_recorded, settled | held release only valid cancel; dispatched unknown retained; outcome_recorded settlement replay safe |
| UTC month/day helper boundaries + historical old-period unknown/settle + new admission | original period updated, new period separate; lifetime session shared; no TTL release |
| Pre-v2 row replay/terminal with policy changed2; fresh v1 under2; positive legacy configured | old confirmed operations recover; new bypass rejected; explicit migration-required |
| Refund-before/after quota settlement/cancel + audit injected failure | accepted funding/debt equalities retained together с quota counters |
| Legacy31 result regression, migration checksum/mirror, schema BigInt | existing wrappers/Task5 fixtures unchanged; no schema signature drift |

RED capture честно отделяет missing new function/module от assertion-level RED. Нужны реальные race/fault assertions после установки candidate migration; мок не заменяет native concurrency proof. Disconnect-before-commit не выдавать за kill-server/power-loss test. Не добавлять production kill hooks. Unknown → recovered provider outcome относится к later reconciliation writer fencing review.

## Минимальный implementation order и файлы

1. До кода worker сверяет baseline SHA/tip и ownership, читает принятые A, lifetime session и supplier formula/rounding из этого плана и существующие narrow contracts. Никаких code-intelligence caches как authority.
2. Добавить native suite с явным pre-implementation RED, using existing guard; fixtures без positive legacy. Register suite в root `package.json`, expected migration/schema inventory в `native-baseline.integration.test.ts`.
3. Создать `packages/database/migrations/0068_gateway_durable_spending_quotas.sql` (номер перепроверить), `packages/database/src/functions/gateway-durable-spending-quotas.sql` с exact new-function mirror; обновить current `gateway-charge-admission.sql` mirror для replaced functions. Историческую0067 не править. Включить atomic schema/function transition, schema bigint mapping и exports если нужны.
4. Green native quota suite + existing admission/refund/baseline regression, sequential under `flock /tmp/ai-ecosystem-build.lock`, through `/tmp/ai-ecosystem-run aggregator ...`; использовать existing installed Node/shebang Vitest flow. Только guarded localPG, no env copying/install/network. После native run database types и narrow schema checks. Сохранить точные команды/RED/GREEN и checksum0067 до/после.
5. Независимый SQL/financial/spec review плюс TypeScript review изменённых schema/tests; никаких React файлов. Scoped commit только перечисленного increment. Root acceptance = unused DB prerequisite, не production claim.
6. Следующий отдельный brief: new quota wrapper/evidence adapter + trusted auth/session/exact config composition вокруг accepted Task5, без предварительного public mount. Затем existing-org inventory/opening-balances/inflight cutover и complete-route activation gates.

Реальные blockers **узкого Task6**: невозможность guarded localPG verification; несогласованный migration number/ownership. Production legacy inventory, opening balances, trusted route composition и unknown recovery — blockers последующих activation gates, их нельзя использовать как причину не реализовывать additive native prerequisite.
