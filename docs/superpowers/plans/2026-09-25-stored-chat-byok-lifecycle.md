# Stored chat BYOK: durable fixed-fee lifecycle

Дата 25.09.2026. Статус: implementation contract следующего AG-P1 пакета после принятого durable SSE `23ce262` / `ee52740`.

## Scope

Добавить локально принимаемый durable BYOK для `POST /v1/chat/completions` только non-stream в текущем самом полном explicit mode `stored_chat_embeddings_completions_stream`.

Default `legacy` и старые stored modes сохраняют прежнюю семантику. Stream+BYOK, embeddings+BYOK, completions+BYOK и media+BYOK остаются отдельными gates.

BYOK здесь означает: caller передаёт `X-Upstream-Key`, платит своему provider напрямую, а Aggregator удерживает и списывает фиксированную platform fee. BYOK не бесплатен.

## Frozen contract

- Public body остаётся strict stored-chat v1 (`stream:false`) со всеми текущими model/key/policy/PII проверками.
- Provider credential — opaque visible-ASCII value длиной 1..4096 bytes. Пустой, whitespace-only, control или non-ASCII header отвергается до durable claim.
- Raw provider credential никогда не пишется в PostgreSQL, Redis, logs, snapshots или errors. В request fingerprint входит только SHA-256 exact header bytes.
- HTTP identity: `routeKind='chat'`, `billingMode='byok_fee'`, `contractVersion=3`.
- Canonical tuple включает model/mode/SID/messages/max_tokens/stream=false и provider-key digest.
- Same org/key/route/idempotency key не может создать одновременно `stored` и `byok_fee`: cross-mode reuse = `409 REQUEST_CONFLICT`, а не второй provider effect.
- Fixed fee читается из exact operator input `BYOK_FEE_CREDITS_EXACT` (default `"1"`) и преобразуется существующим `calculateByokFee`. В режиме durable BYOK fee обязан быть >0 и помещаться в PostgreSQL BIGINT.
- Admission использует уже существующий `billing_mode='byok_fee'`, quota v2 и exact supplier-zero contract:
  - supplier quote `{version:2,formulaVersion:'byok-zero-v2'}`;
  - pricing `{version:2,formulaVersion:'byok-fee-microcredits-v2',upstreamId,feeMicrocredits}`;
  - usage `{version:2,formulaVersion:'byok-fee-microcredits-v2',billingRequestId,attemptId,upstreamId,verified:true}`;
  - supplier reserved/actual = 0.
- Provider candidate обязан быть existing reviewed chat profile/mechanics. V1 не обходит registry/profile/policy.
- Candidate с configured egress proxy отвергается: caller credential не передаётся через Aggregator-managed proxy.
- После confirmed dispatch выполняется ровно один pinned provider call с caller key.
- Provider response проходит существующий admitted-chat strict parser. Provider token usage не является billing authority для fixed fee.
- Успешный provider response → durable sanitized chat response → `actualCostCredits = exact fee` → settle → replay.
- Provider error, malformed response или ACK loss после dispatch остаётся `dispatched` / unknown hold без redispatch, refund или guessed charge.
- Durable response validator для contractVersion 3 проверяет sanitized chat response shape и self-consistent provider usage, но billing usage snapshot сверяет fixed-fee contract, а не token counts.
- Settled replay возвращает обычный JSON chat response + authoritative platform-fee receipt headers. Raw BYOK key для replay не нужен.
- Recovery worker может рассчитывать только coherent `outcome_recorded` BYOK row с valid contract3 result/quota facts; unknown dispatched BYOK не выбирается.
- Additive migration `0080_gateway_stored_chat_byok.sql`; migrations <=0079 immutable.
- No production activation, paid provider call, deploy, stored encrypted-key vault, key management UI or provider registry bypass.

## Acceptance

1. Unit: identity secret redaction/digest, exact fee, candidate/policy selection, one dispatch, no proxy, provider error hold, immutable snapshots.
2. Native mounted: real Hono/auth/PostgreSQL/Redis/admitted OpenRouter adapter; mock only `fetchUpstream`; caller key differs from platform key and transport authorization proves caller key used.
3. Exact default fee fixture: 1 credit = 1000 microcredits. Starting PAYG 5000 → hold1000 → settled1000; supplier reserve/actual0; balance4000; one ledger row.
4. Concurrent same identity/provider1; changed BYOK key/body =409; stored-vs-BYOK same idempotency key =409.
5. Provider error after dispatch: admission remains dispatched/held1000, no result/ledger, worker selects0, no retry.
6. Forced settle failure after durable result: recovery worker settles once even after API-key revoke/result expiry; second run selects0; replay after re-enable returns stored response without network.
7. Old modes/default remain unchanged; stream+BYOK stays501.
8. One independent financial/SQL/security/TypeScript review after focused/native/types/build/lint checks.
