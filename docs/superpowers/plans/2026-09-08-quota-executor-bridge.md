# Quota v2 → stored plaintext executor

Цель: подключить принятый quota DB lifecycle к существующему unused Task5 без изменения публичных routes. Это следующий AG-P1 gate, не108/108 и не production cutover.

Research inputs: D03/D11, принятые gateway admission и durable quotas планы. Решение: сохранить существующие quote/usage DTO, использовать SQL как authority supplier valuation. Deferred: public route/HTTP idempotency, enrollment, recovery worker, BYOK execution, SSE/media.

## Global Constraints

- Только canonical AG feature branch; чужие .Codex и документы сохранить. SQL/migrations/schema, public routes, upstream transport и production не менять.
- Prepared SQL; bigint money без JSnumber; existing31-field projection/parser/timestamps/immutable identity сохранить. Не создавать вторую копию validator/lifecycle.
- Один heavy run под flock /tmp/ai-ecosystem-build.lock. Native только guarded ai_aggregator_test через /tmp/ai-ecosystem-run aggregator. Ни production .env, ни платных upstream/push/deploy.
- Legacy public wrapper exports/signatures сохраняются. Новый unused executor использует только v2, без fallback/enrollment/нового executor.
- Требуются native production postgres.js wrapper path и независимые TS/financial review; mocks не доказательство DB bridge.

## Task 1: Typed v2 wrappers and existing executor integration

Files owned: packages/api-gateway/src/billing/admission.ts; new admission-internal.ts и quota-admission.ts в том же каталоге; stored-chat-attempt.ts и minimal stored-chat-attempt-contract.ts; новые quota wrapper unit/native bridge tests и существующие stored-chat-attempt*.test.ts. Package test registration только если необходимо для обязательного запуска нового native test. admission-result.ts, candidate-quote.ts, token-quote.ts остаются прежними, если нет конкретной доказанной несовместимости.

### Implementation

1. Механически выделить shared transport/projection/identity/prior-facts helpers admission.ts. Сохранить legacy signatures, explicit31-field projection, single-row validation, detached snapshots, microsecond normalizer и transition/replay checks.
2. Добавить admitGatewayChargeV2(args, client?) и recordGatewayChargeOutcomeV2(args, client?). Для этого gate admit typed stored-only: existing base args плюс обязательные declaredSessionId:string|null и supplierQuoteSnapshot. Outcome existing args; common mark/settle/cancel остаются прежними.
3. SQL admit parameter order: org_uuid,billing_uuid,api_key_uuid,client_request_id,route_kind,billing_mode,model_slug,authorized_max_bigint,quote_jsonb,deadline_timestamptz,declared_sid_varchar,supplier_quote_jsonb. Функция aiag_admit_gateway_charge_v2. Outcome aiag_record_gateway_charge_outcome_v2(org_uuid,billing_uuid,actual_bigint,usage_jsonb,outcome_kind). Exact sums .toString()::bigint.
4. SID захватить до первого await. Валиден только exact ASCII [A-Za-z0-9._:-] длиной1…128; никаких trim/case folding, whitespace/newline/Unicode. null явный. Не передавать SID провайдеру/retail quote/public response.
5. Supplier snapshot ровно {version:2,formulaVersion:'catalog-input-output-cents-per-1k-usd-micro-v2',tokenQuote:<тот же captured quote.quoteSnapshot>}. Никакой TS supplier arithmetic, отдельного max/actual/discount/period/policy. Retail snapshot ровно прежний {version:1,tokenQuote,actualChargePolicy:{formulaVersion:'db-input-output-cents-per-1k-legacy-whole-cache-v1',cachingDiscount:exactDecimalString}}. Dispatch/usage version1 unchanged.
6. Task5 dependencies и defaults перевести одновременно на v2 admit/outcome; existing common dispatch/settle/cancel. Отказ v2 enrollment не обходит legacy. Conservative existing SQL error mapping допустим; unknown/parser/lostACK не превращать в доказанный no-sideeffect.
7.31-field result не содержит SID/supplier/version: не придумывать echo/readback. Их exact replay identity доказывается SQL v2 и native tests. Доступные base/prior facts проверять полностью.

### Acceptance / RED→GREEN

- Unit exact function/order, null/valid/case/128/129/whitespace/newline/Unicode SID; mutation detachment; bigint >2^53; microseconds; malformed/missing/extra/zero/multiple result rows; wrong base identity/prior facts; replay.
- Legacy billing-admission и billing-admission-result regression сохраняют expectations.
- Executor: оба v2 callbacks, frozen supplier quote/SID; once-only run, abort/replay/unknown ACK; real admitted transport stub и redirect onePOST сохраняются.
- Native bridge использует настоящий postgres.js SqlClient и production wrappers после environment + connected marker guard. Не заменять wrappers pg-адаптером. Guard можно выполнить через существующий pg helper, затем открыть injectable postgres.js client; закрыть оба, не импортировать singleton доguard.
- Native Task5→v2 admit→common dispatch→stub admitted transport→v2 outcome→settle; readback context/reservations/events, SID/supplier/settled amounts, residual reserved0. Exact replay и changed SID/supplier conflicts; no second provider dispatch. Failure policy/SID доdispatch без provider effect.
- Focused suites, source/test strict types, scoped lint, новый native bridge последовательно подflock. SQL unchanged: не повторять Task6wholematrix/clean68 без нового основания.
- Exact scoped commit, report raw evidence paths, independent reviews. Нельзя принять по unit-only.
