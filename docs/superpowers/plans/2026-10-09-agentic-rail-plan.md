# Агентский рельс (A+C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless-агент регистрируется по TON-кошельку, сам пополняет баланс (Gram + USDT), сам управляет ключами/лимитами/роутинг-политикой, работает через /v1 и MCP-фасад.

**Architecture:** Новый identity-слой (agent_principals = org без human-user, владелец — системный юзер по паттерну 0060) поверх существующих денег: тон-инвойсы/settle-воркер/квоты v2 не переписываются. Гейтвей получает публичные /v1/agent/* роуты + agent-обёртки invoice-функций; MCP монтируется в тот же процесс гейтвея.

**Tech Stack:** TypeScript (Hono-стек гейтвея), PostgreSQL SQL-миграции (plpgsql, SECURITY-инварианты репо), vitest + RUN_NATIVE_DB_INTEGRATION, `@modelcontextprotocol/sdk` (новая зависимость packages/api-gateway).

**Spec:** `docs/superpowers/specs/2026-10-09-agentic-rail-design.md` (решения владельца — в brainstorm `2026-10-09-agentic-audience-brainstorm.md` §7.1).

Все пути ниже — от корня worktree `/home/bob/Projects/ai-aggregator/.worktrees/ag-author-version-20260928/`.

## Global Constraints

- Деньги: BIGINT микрокредиты; 1 кредит = 1¢ = 1000 микро; 1 USDT = 100 кредитов = 100 000 микро; потолок `9223372036854775807`, человекочитаемый потолок 2^53−1 не снимать.
- SQL: только prepared/parameterized; изменения денег — guarded `UPDATE … WHERE … RETURNING` в транзакции.
- Bun: команды запускать `/opt/bun-1.4.2/bun` (в PATH старый 1.3.13).
- Тяжёлые прогоны по одному: `flock /tmp/ai-ecosystem-build.lock …`; изолированные БД: `scripts/with-native-test-services.sh …` (или `/tmp/ai-ecosystem-run aggregator …`).
- Native-интеграционные тесты: сначала `bun run db:test:bootstrap && bun run db:test:migrate`, затем `RUN_NATIVE_DB_INTEGRATION=1 vitest run --no-file-parallelism <путь>`.
- Коммиты при блокировке Mimosa: `export MIMOSA_GIT_GATE_MODE=warn`; push при блокировке: разово `MIMOSA_NO_GIT_GATE=1` (pre-existing находки корня, не наши).
- Прод-шаги (миграции на прод, mainnet-runtime, gram-витрина, фиат) — запрещены без явной команды владельца. Всё живёт в testnet (`network='-3'`).
- Не трогать: фиат-гейты, web-checkout людей, admin-поверхность, глобальный каталог роутинга.
- Формат ключей не меняем: `sk_aiag_(live|test)_…`, SHA-256, `gateway_api_keys`.

## Review Focus

1. **Повторная регистрация того же кошелька** → `409 AGENT_ALREADY_REGISTERED`, второй org не создаётся — тест в Task 4.
2. **Challenge старше 120 c или переиспользованный** → отказ регистрации — тест в Task 3.
3. **Settle инвойса с `expected_sender IS NULL`** не должен ломать существующий воркер-путь (underpayment/чужой отправитель → review, не крэш) — native-тест в Task 5.
4. **Ключ с `expires_at` в прошлом** → 401 `KEY_EXPIRED` на каждом /v1-роуте (auth-мидлварь, не отдельные роуты) — тест в Task 2.
5. **USDT transfer_notification без reference в forward_payload** → не матчится ни на один инвойс, не зачисляется, попадает в неразобранные — тест в Task 9.
6. **rotate_key** → старый plaintext мёртв немедленно (тот же lookup по hash) — тест в Task 7.

---

### Task 1: Миграция 0104 — agent principals + challenges + системный юзер

**Files:**
- Create: `packages/database/migrations/0104_agent_principals.sql`
- Test: `packages/database/scripts/__tests__/agent-principals.native.integration.test.ts`

**Interfaces:**
- Produces: таблицы `agent_principals(id,org_id,network,address,address_raw,status,created_at,revoked_at)`, `agent_wallet_challenges(id,purpose,payload_hash,network,domain,issued_at,expires_at,consumed_at,principal_id,proof_digest)`; юзер `aiag-agents@aiag.local` (email-UNIQUE, is_active); функция `aiag_agent_owner_user_v1() RETURNS UUID` (id системного юзера; SECURITY DEFINER-free, обычная STABLE).

- [ ] **Step 1: Написать миграцию**

```sql
-- 0104_agent_principals.sql
-- Agent identity rail: headless principals, wallet challenges, service owner user.
-- No monetary writes here. Testnet-only in v1 (network CHECK).
BEGIN;

INSERT INTO users(id, email, name, is_active, is_banned)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'aiag-agents@aiag.local', 'AIAG Agent Service', TRUE, FALSE)
ON CONFLICT (email) DO NOTHING;

CREATE FUNCTION aiag_agent_owner_user_v1() RETURNS UUID LANGUAGE SQL STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT id FROM users WHERE email='aiag-agents@aiag.local' LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION aiag_agent_owner_user_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiag_agent_owner_user_v1() TO PUBLIC;

CREATE TABLE agent_principals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
 network TEXT NOT NULL CHECK(network='-3'),
 address TEXT NOT NULL CHECK(length(address)=48 AND address ~ '^[A-Za-z0-9_-]{48}$'),
 address_raw TEXT NOT NULL CHECK(address_raw ~ '^0:[0-9a-f]{64}$'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 revoked_at TIMESTAMPTZ,
 CHECK(revoked_at IS NULL OR (status='revoked' AND revoked_at>=created_at))
);
CREATE UNIQUE INDEX agent_principals_active_address ON agent_principals(network,address) WHERE status='active';
CREATE INDEX agent_principals_org ON agent_principals(org_id);

CREATE TABLE agent_wallet_challenges (
 id UUID PRIMARY KEY,
 purpose TEXT NOT NULL CHECK(purpose IN('register','revoke')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash ~ '^[0-9a-f]{64}$'),
 network TEXT NOT NULL CHECK(network='-3'),
 address TEXT NOT NULL CHECK(length(address)=48),
 domain TEXT NOT NULL CHECK(length(domain) BETWEEN 3 AND 300),
 issued_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 proof_digest TEXT,
 principal_id UUID REFERENCES agent_principals(id) ON DELETE RESTRICT,
 CHECK(expires_at=issued_at+INTERVAL '120 seconds'),
 CHECK(proof_digest IS NULL OR (length(proof_digest)=64 AND proof_digest ~ '^[0-9a-f]{64}$')),
 CHECK((consumed_at IS NULL AND proof_digest IS NULL AND principal_id IS NULL) OR (consumed_at IS NOT NULL AND proof_digest IS NOT NULL))
);
CREATE INDEX agent_wallet_challenges_address ON agent_wallet_challenges(address,issued_at);
CREATE INDEX agent_wallet_challenges_expiry ON agent_wallet_challenges(expires_at);

COMMIT;
```

Примечание к исполнителю: сверь фактические NOT NULL-колонки `users` в `0001`-миграции (email/name/is_active/is_banned) и подстрой INSERT (если есть password_hash NOT NULL и т.п. — сгенерируй совместимый фиктивный hash по образцу 0060 `agents-market@aiag.local`, строка ~64-90 миграции 0060_tma_own_org.sql).

- [ ] **Step 2: Написать native-тест**

По образцу `packages/database/scripts/__tests__/native-baseline.integration.test.ts` (шапка: импорт test-db helpers, `RUN_NATIVE_DB_INTEGRATION`-гейт). Проверки:

```ts
it('creates service owner user once (idempotent)', …)          // SELECT aiag_agent_owner_user_v1() IS NOT NULL
it('rejects second active principal for same address', …)      // INSERT → unique violation агентских active_address
it('challenge TTL is exactly 120s and single-use guard columns hold', …) // INSERT невалидного expires_at → CHECK violation
it('principal revocation requires status+timestamp', …)        // UPDATE только revoked_at без status → CHECK violation
```

- [ ] **Step 3: Прогнать**

```bash
flock /tmp/ai-ecosystem-build.lock bash -c 'cd /home/bob/Projects/ai-aggregator/.worktrees/ag-author-version-20260928 && /opt/bun-1.4.2/bun run db:test:bootstrap && /opt/bun-1.4.2/bun run db:test:migrate && RUN_NATIVE_DB_INTEGRATION=1 /opt/bun-1.4.2/bun run vitest run --no-file-parallelism packages/database/scripts/__tests__/agent-principals.native.integration.test.ts'
```

Expected: PASS (миграция применилась, 4 теста зелёные).

- [ ] **Step 4: Commit**

```bash
export MIMOSA_GIT_GATE_MODE=warn
git add packages/database/migrations/0104_agent_principals.sql packages/database/scripts/__tests__/agent-principals.native.integration.test.ts
git commit -m "feat(db): agent principals, wallet challenges, service owner"
```

---

### Task 2: Миграция 0105 + auth — TTL ключей (expires_at)

**Files:**
- Create: `packages/database/migrations/0105_agent_key_expires_at.sql`
- Modify: `packages/api-gateway/src/middleware/auth-plan04.ts:51-97` (SELECT + проверка)
- Test: `packages/api-gateway/src/__tests__/auth-key-expiry.test.ts`

**Interfaces:**
- Produces: `gateway_api_keys.expires_at TIMESTAMPTZ NULL`; в `AuthenticatedApiKey` добавляется `expires_at: string | null`; HTTP 401 c code `KEY_EXPIRED`.

- [ ] **Step 1: Миграция**

```sql
-- 0105_agent_key_expires_at.sql
BEGIN;
ALTER TABLE gateway_api_keys ADD COLUMN expires_at TIMESTAMPTZ
  CHECK(expires_at IS NULL OR expires_at>created_at);
COMMIT;
```

- [ ] **Step 2: Пишущий тест (unit, мок resolver)**

Тест мокает `setApiKeyResolver` (экспорт уже есть, auth-plan04.ts:45): валидный ключ с `expires_at` в будущем → проходит; в прошлом → `errors.unauthorized`-подобный ответ с телом `{error:{code:'KEY_EXPIRED'}}`; NULL → проходит. Форма ответа сверяется с существующим `errors`-хелпером гейтвея (`src/lib/errors.ts` — если код ошибки не вкладывается в существующую схему, расширить схему, не ломая старые коды).

- [ ] **Step 3: Реализация**

В `resolveFromDb` (auth-plan04.ts:55-64): добавить `expires_at` в SELECT. В `requireApiKey` после `if (!apiKey) throw errors.unauthorized();`:

```ts
if (apiKey.expires_at && Date.parse(apiKey.expires_at) <= Date.now()) {
  throw errors.unauthorized('KEY_EXPIRED');
}
```

(сверь сигнатуру errors.unauthorized — принимает ли code/message; если нет — добавь перегрузку).

- [ ] **Step 4: Прогнать**

```bash
flock /tmp/ai-ecosystem-build.lock bash -c '/opt/bun-1.4.2/bun run vitest run packages/api-gateway/src/__tests__/auth-key-expiry.test.ts'
```

Expected: PASS. Плюс type-check: `/opt/bun-1.4.2/bun run --filter @aiag/api-gateway type-check` (из корня worktree).

- [ ] **Step 5: Commit** — `feat(gateway): optional key expiry enforcement`

---

### Task 3: Сервис-слой agent-auth в packages/database

**Files:**
- Create: `packages/database/src/agent-auth.ts`
- Modify: `packages/database/src/index.ts` (реэкспорт, если там баррель)
- Test: `packages/database/src/__tests__/agent-auth.test.ts` (unit — мок postgres.js через существующий паттерн тестов пакета; если пакет не мокает pg — сделай native-тест, переместив в `scripts/__tests__/agent-auth.native.integration.test.ts`)

**Interfaces:**
- Consumes: таблицы Task 1; верификатор `verifyTonWalletProof` из `packages/shared/src/ton-wallet-proof.ts` (сигнатуру сверить; она принимает address/network/proof/domain и возвращает результат-объект).
- Produces:
  - `issueAgentChallenge({ address, network, domain }): Promise<{ challengeId, payload, expiresAt }>` — payload = `aiag:agent:register:-3:${randomBytes(32).toString('hex')}`;
  - `consumeAgentRegister({ challengeId, address, proof }): Promise<{ principalId, orgId, key: string }>` — верификация proof → в одной транзакции: consume challenge (guarded UPDATE … WHERE consumed_at IS NULL AND expires_at>now() RETURNING), создать org (owner = `aiag_agent_owner_user_v1()`, slug `agent-<uuid8>`, name `agent:<address.slice(0,8)>`), principal, первый ключ `sk_aiag_live_…` c `policies = '{"kind":"agent","s2s_key_minting":true}'::jsonb`, rpm 60. Ошибки: `AGENT_CHALLENGE_EXPIRED`, `AGENT_ALREADY_REGISTERED` (unique violation active_address → маппинг), `AGENT_PROOF_INVALID`.

- [ ] **Step 1: Failing-тест** — контракты выше (для unit: подмок `sql` из `packages/database/src/client`-паттерна; для native: реальные INSERT'ы).
- [ ] **Step 2: Run → fail** (модуля нет).
- [ ] **Step 3: Реализация** — по образцу `packages/database/src/ton-wallet-auth.ts:27-123` (issue/consume/revoke), но: без browser_hash/ticket, INSERT-орг по образцу `apps/web/src/lib/dashboard/org.ts:18-59` (сверь обязательные колонки organizations), генерация ключа — `packages/api-gateway/src/lib/api-key.ts` вынесен в shared? Если генератор живёт только в гейтвее — подними `generateApiKey`/`hashKey` в `packages/shared/src/api-key.ts` и импортируй в обоих местах (гейтвей переходит на shared-импорт, диф минимальный).
- [ ] **Step 4: Run → pass; type-check.**
- [ ] **Step 5: Commit** — `feat(db): agent register service layer`

---

### Task 4: Роуты /v1/agent/challenge и /v1/agent/register

**Files:**
- Create: `packages/api-gateway/src/routes/v1/agent-register.ts`
- Modify: `packages/api-gateway/src/server.ts` (монтировка ПУБЛИЧНО, без requireApiKey — рядом с /health, до auth-очереди /v1; см. `server.ts:75-118`)
- Test: `packages/api-gateway/src/__tests__/agent-register-route.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `POST /v1/agent/challenge {address, network:'-3'} → 200 {challengeId, payload, expiresIn:120}`; `POST /v1/agent/register {challengeId, address, proof} → 201 {principal_id, org_id, key, key_prefix}` (plaintext один раз) | 409 AGENT_ALREADY_REGISTERED | 400 AGENT_PROOF_INVALID | 410 AGENT_CHALLENGE_EXPIRED. Rate-limit: Redis sliding window 6/5мин на address + 60/мин глобально (по образцу `middleware/rate-limit-plan04.ts:15-53`, отдельные ключи счётчиков `agentreg:addr:`/`agentreg:glob:`).

- [ ] **Step 1: Failing-тест** — Hono-приложение с мокнутым сервисом Task 3: happy path (201, key в ответе ровно один раз), двойная регистрация (409), протухший challenge (410), proof-мусор (400). Review Focus #1 пиннится здесь.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Реализация** — zod-схема тела (по образцу других v1-роутов), вызовы Task 3, ответы без идентификации внутренностей (никаких SQL-текстов наружу).
- [ ] **Step 4: Run → pass; type-check.**
- [ ] **Step 5: Commit** — `feat(gateway): headless agent registration endpoints`

---

### Task 5: Миграция 0106 — agent topup invoice SQL (Gram + USDT)

**Files:**
- Create: `packages/database/migrations/0106_agent_topup_core.sql`
- Test: `packages/database/scripts/__tests__/agent-topup.native.integration.test.ts`

**Interfaces:**
- Consumes: `ton_invoices` (0072), FX-валидация `aiag_ton_payload_v1`/`aiag_ton_time_v1` (0072 — сверить имена по файлу), allowlist `ton_asset_allowlist` (0098).
- Produces:
  - `aiag_create_agent_ton_invoice_v1(_key_id UUID, _payload JSONB, _fingerprint TEXT) RETURNS JSONB` — авторизация: ключ принадлежит org принципала (`agent_principals JOIN gateway_api_keys ON keys.org_id=principals.org_id`, ключ жив, principal active). Тело — префикс валидации `aiag_create_ton_invoice_v1` (0072:263-284) с отличиями: `owner_user_id := aiag_agent_owner_user_v1()`, `purpose := 'agent_topup'`, `expected_sender := NULL` (payload его не содержит), idempotency: `(_key_id, _payload->>'idempotencyKey')` — для этого добавить частичный UNIQUE-индекс `ton_invoices_agent_idem ON ton_invoices((owner_user_id), org_id, idempotency_key) WHERE purpose='agent_topup'` только если базового уникального ключа недостаточно (сверь существующие индексы 0072:79-84 — уникальность settle-дедупа не idempotency; если общего нет — создай отдельный, не трогая чужие строки: WHERE purpose='agent_topup').
    - Ассеты: `asset_kind='native'` (Gram: amount из quote-валидации как у людей — reuse `aiag_ton_payload_v1`) и `asset_kind='jetton'` + `master_address` USDT: amount_atomic = `ceil(credits×10^6/100)` = `credits×10000` (микро→USDT-атомы: 1 кредит=1000 микро; 1 USDT=10^6 атомов=100 кредитов ⇒ атомы = микро×10). FX-peg валидируется без оракула: `CHECK amount_atomic = grant_microcredits×10` внутри ветки jetton.
  - `aiag_read_agent_ton_invoice_v1(_key_id UUID, _invoice UUID) RETURNS JSONB` — чтение по ключу (JOIN на principal org), поля статуса как у `aiag_ton_invoice_json_v1`.
- Rate/invariant: min grant 100 кредитов (100_000 микро), max `9223372036854775807` — в теле функции.

- [ ] **Step 1: Миграция** (код по каркасу выше; сверка с реальными сигнатурами 0072 обязательна — читать `aiag_ton_payload_v1` и повторить её вызов, а не копировать, где можно переиспользовать).
- [ ] **Step 2: Native-тест** — happy gram (инвойс с expected_sender NULL), happy usdt (peg-матч), idempotency-конфликт, не-агентский ключ → TON_NOT_AUTHORIZED-аналог `AGENT_NOT_AUTHORIZED`, grant<100 → `AGENT_GRANT_TOO_SMALL`, settle инвойса с NULL-sender (Review Focus #3: зачисление проходит, чужой отправитель/сумма — review-причины из 0072 сохраняются).
- [ ] **Step 3: Прогнать** (как Task 1 Step 3).
- [ ] **Step 4: Commit** — `feat(db): agent topup invoices (gram+usdt)`

---

### Task 6: Роуты /v1/agent/topup и /v1/agent/invoices/:id

**Files:**
- Create: `packages/api-gateway/src/routes/v1/agent-topup.ts`
- Modify: `packages/api-gateway/src/server.ts` (монтировка ПОСЛЕ requireApiKey + rateLimit)
- Test: `packages/api-gateway/src/__tests__/agent-topup-route.test.ts`

**Interfaces:**
- Consumes: Task 5 SQL; FX-policy источник — читать активную политику как web-checkout (`packages/database/src/ton-wallet-checkout.ts` паттерн; для USDT политика не нужна — peg).
- Produces: `POST /v1/agent/topup {asset:'gram'|'usdt', credits: строка-число ≥100, idempotencyKey} → 201 {invoiceId, network:'tvm:-3', asset, recipient, amountAtomic, reference, expiresAt, transferHint:{mode:'native-comment'|'jetton-forward-payload', masterAddress?, minForwardAtomic}}`; `GET /v1/agent/invoices/:id → 200 {status, grantMicrocredits, settledAt?}`. Rate 12/5мин на ключ (Redis).

- [ ] **Step 1: Failing-тест** — happy gram/usdt (201, структура transferHint), мин.100 (422), идемпотентный повтор (тот же invoiceId), rate-limit (429). Кредиты парсятся строкой → BigInt, никакого Number.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Реализация.**
- [ ] **Step 4: Run → pass; type-check.**
- [ ] **Step 5: Commit** — `feat(gateway): headless agent topup endpoints`

---

### Task 7: Ключи агента: list/rotate/revoke (+mint уже есть)

**Files:**
- Create: `packages/api-gateway/src/routes/v1/agent-keys.ts`
- Create: `packages/database/migrations/0107_agent_key_meta.sql` (`ALTER TABLE gateway_api_keys ADD COLUMN meta JSONB NOT NULL DEFAULT '{}'::jsonb` — сюда `rotated_from_hash`)
- Test: `packages/api-gateway/src/__tests__/agent-keys-route.test.ts`

**Interfaces:**
- Consumes: `/v1/organization/keys` POST (минт суб-ключей уже работает: первый ключ имеет `s2s_key_minting:true`) — НЕ дублировать: в `agent-keys.ts` для mint — редирект-семантика или внутренний вызов того же хендлера.
- Produces:
  - `GET /v1/agent/keys → 200 [{id,name,key_prefix,expires_at,created_at,last_used_at,revoked_at}]` (без plaintext);
  - `POST /v1/agent/keys/:id/rotate → 200 {key, key_prefix}` — guarded `UPDATE gateway_api_keys SET key_hash=<new>, key_prefix=<new>, meta=jsonb_set(meta,'{rotated_from_hash}',to_jsonb(old.key_hash)) WHERE id=? AND org_id=? AND revoked_at IS NULL AND disabled_at IS NULL RETURNING id` — старый plaintext мёртв сразу;
  - `POST /v1/agent/keys/:id/revoke → 200 {id, revoked_at}` — `UPDATE … SET revoked_at=now(), disabled_at=now() WHERE … AND revoked_at IS NULL RETURNING`.
  - Guard: агент может управлять только ключами СВОЕЙ org (org_id из auth-контекста), rotate доступен и по собственному ключу (id из ответа auth-слоя).

- [ ] **Step 1: Failing-тест** — Review Focus #6: после rotate старый ключ → 401, новый → 200; list не содержит plaintext; revoke чужой org-ключ (подделка id) → 404.
- [ ] **Step 2-4: fail → реализация → pass + type-check.**
- [ ] **Step 5: Commit** — `feat(gateway): agent key lifecycle api`

---

### Task 8: Миграция 0108 quota-writers + роуты /v1/agent/policy

**Files:**
- Create: `packages/database/migrations/0108_agent_quota_writers.sql`
- Create: `packages/api-gateway/src/routes/v1/agent-policy.ts`
- Test: `packages/api-gateway/src/__tests__/agent-policy-route.test.ts`, `packages/database/scripts/__tests__/agent-quota-writer.native.integration.test.ts`

**Interfaces:**
- Consumes: `gateway_quota_key_policies`/`gateway_quota_org_policies` (0068:5-18), `ApiKeyPolicies` (`routing/engine.ts:80-88`).
- Produces:
  - SQL: `aiag_set_agent_key_quota_v1(_key_id UUID, _session_micro BIGINT NULL, _monthly_credits BIGINT NULL)` и `aiag_set_agent_org_quota_v1(_org_id UUID, _daily_supplier_usd_micro BIGINT NULL)` — upsert guarded, NULL = снять лимит; при установке v2 — зачистка legacy-полей ключа (`daily_usd_cap=NULL`, `policies=jsonb_set(policies,'{per_session_budget_cap_rub}','0')`) чтобы не ловить `QUOTA_POLICY_MIGRATION_REQUIRED` (0068:421-438).
  - `GET /v1/agent/policy → 200 {policies, quotas}`; `PUT /v1/agent/policy` — zod: `{default_mode?, allowed_providers?, blocked_providers?, forbid_non_ru?, allow_pii_transborder?, model_whitelist?, session_micro_limit?, monthly_credits_limit?}` — routing-часть мержится в `gateway_api_keys.policies` (unknown-ключи → 400), квоты → SQL-функции. Всё опционально; зажимание clampToIssuer-семантикой не требуется для собственного ключа, но суб-ключ не может превысить issuer при минте (уже есть).

- [ ] **Step 1: Failing native+unit тесты** — writer: set→set→NULL (снятие), legacy-чистка верифицируется SELECT'ом; роут: PUT с мусорным полем → 400, happy → 200 и следующий GET возвращает новое.
- [ ] **Step 2-4: fail → реализация → pass.**
- [ ] **Step 5: Commit** — `feat(gateway): agent routing policy and quota self-service`

---

### Task 9: USDT-приём в воркере (jetton reconciliation)

**Files:**
- Modify: `apps/worker/src/ton-payment-evidence.ts` (jetton-ветка: TonCenter `/jetton/transfers?direction=in&address=<merchant-jetton-wallet>&limit=16`)
- Modify: `apps/worker/src/ton-payment-verifier.ts` (jetton-событие: те же MC-depth≥2)
- Create: `apps/worker/src/ton-jetton-evidence.ts` (парсер transfer_notification: opcode `0x7362d09c`, source-адрес, forward_payload → reference-строка, amount; verify мастер-контракта по allowlist)
- Create: `packages/database/migrations/0109_usdt_allowlist_and_sources.sql` (INSERT в `ton_asset_allowlist`: USDT mainnet `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` kind='jetton' decimals=6 + testnet-мастер из env-значения — тестовый адрес зафиксировать на имплементации по крану testnet.ton.org; расширение листинга источников: строки `ton_reconciliation_sources` с asset='usdt' для обоих сетей — по схеме 0102:191-244)
- Test: `apps/worker/src/__tests__/ton-jetton-evidence.test.ts` (unit, мок TonCenter-ответов), `apps/worker/src/__tests__/ton-jetton-reconcile.native.integration.test.ts` (native: событие с reference → observed→confirmed; без reference → не матчится — Review Focus #5; фейковый мастер → отбраковка)

**Interfaces:**
- Consumes: reconciliation-луп `ton-payment-bootstrap.ts:48` (30 c), sources-листинг, settle 0098.
- Produces: jetton-evidence записи в `ton_chain_events` с payload, где `reference` извлечён из forward_payload; матчинг — существующий (UNIQUE network+recipient+tx+message не меняется).

- [ ] **Step 1: Failing unit-тесты парсера** — валидная нотификация (reference извлечён), без forward_payload (reference NULL → «unknown»), bounce (out_msgs>0) → отбраковка, мастер не из allowlist → отбраковка.
- [ ] **Step 2-4: fail → реализация (worker-ветки guarded `if asset='jetton'`) → pass + native.**
- [ ] **Step 5: Commit** — `feat(worker): usdt jetton reconciliation`

---

### Task 10: 402-JSON при нехватке средств (topup-хинт)

**Files:**
- Modify: `packages/api-gateway/src/billing/settle.ts:109-125` (preflight-отказ) и `packages/api-gateway/src/billing/admission-internal.ts:136-158` (P0003-маппинг)
- Test: `packages/api-gateway/src/__tests__/insufficient-funds-hint.test.ts`

**Interfaces:**
- Produces: единое тело для всех денег-отказов:
```json
{"error":{"code":"insufficient_funds","message":"…","topup":{"default_asset":"gram","endpoint":"POST /v1/agent/topup","min_credits":100,"assets":["gram","usdt"]}}}
```
HTTP 402 (не менять код статуса — уже 402), заголовок `Retry-After: 30`. Для не-агентских (человеческих) ключей поле `topup` не добавлять (человек ходит в web) — различие по `policies->>'kind'='agent'`.

- [ ] **Step 1: Failing-тест** — агентский ключ + нулевой баланс → тело с topup-хинтом; человеческий ключ → тело без topup; статус 402 в обоих.
- [ ] **Step 2-4: fail → реализация → pass.**
- [ ] **Step 5: Commit** — `feat(gateway): machine-readable 402 topup hint`

---

### Task 11: MCP-фасад (/mcp в гейтвее)

**Files:**
- Create: `packages/api-gateway/src/mcp/server.ts` (McpServer + StreamableHTTP-транспорт из `@modelcontextprotocol/sdk/server/*`)
- Create: `packages/api-gateway/src/mcp/tools.ts`
- Modify: `packages/api-gateway/package.json` (+`@modelcontextprotocol/sdk` — точную мажор-версию ставит `bun add`, lockfile обновить), `packages/api-gateway/src/server.ts` (mount `POST /mcp` после requireApiKey)
- Test: `packages/api-gateway/src/__tests__/mcp-facade.test.ts`

**Interfaces:**
- Consumes: всё выше (topup/policy/keys-функции) + `/v1/chat/completions` (внутренний вызов, non-stream).
- Produces tools (префикс `aiag_`): `list_models`, `get_balance`, `create_topup_invoice{asset,credits,idempotencyKey}`, `get_invoice_status{invoiceId}`, `set_routing_policy{...}`, `list_keys`, `rotate_key{keyId}`, `revoke_key{keyId}`, `chat_completion{model,messages,max_tokens?}`. Resource `aiag://catalog`. Auth — тот же Bearer-ключ (requireApiKey перед /mcp). Ошибки гейтвея → JSON-RPC error с теми же code/message.

- [ ] **Step 1: Failing контракт-тест** — initialize handshake, tools/list содержит все 9, tools/call `get_balance` возвращает баланс-мок, `chat_completion` проксирует, 401 без ключа.
- [ ] **Step 2-4: fail → реализация (tools дёргают уже существующие хендлеры/функции — никакой новой бизнес-логики) → pass + type-check.**
- [ ] **Step 5: Commit** — `feat(gateway): mcp facade for agents`

---

### Task 12: Документация + smoke-чек

**Files:**
- Create: `docs/api/agent-rail.md` (регистрация → топап → политика → /v1 → /mcp; curl-примеры всех вызовов; transferHint-разбор: как агент строит Gram-перевод с comment=reference и USDT-jetton-transfer с forward_payload=reference, minForward 0.000000001)
- Modify: `docs/ecosystem/ECOSYSTEM-START-HERE.md` (короткая секция «агентский рельс: статус, что включено/выключено»)

**Steps:**
- [ ] **Step 1:** Написать док (полные curl-примеры, включая proof-подпись через ton-proof-item-v2 — сослаться на `packages/shared/src/ton-wallet-proof.ts` как референс формата).
- [ ] **Step 2:** Прогнать весь новый набор: `flock … vitest run <все новые тест-файлы>` — всё зелёное.
- [ ] **Step 3:** Commit — `docs: agent rail api guide`.

---

## Порядок и зависимости

1→2→3→4 (identity-цепочка); 5 после 3; 6 после 5; 7 после 3+2; 8 после 2; 9 после 5 (независим от 6-8); 10 после 6; 11 после 6+7+8; 12 последним. Фазы ревью: после Tasks 1-5 (деньги+identity — обязательный второй проход), после 6-8, после 9-11.

## Self-review плана

- Покрытие спека: C1=T1,3,4; C2=T2,7; C3=T5,6; C4=T9; C5=T8; C6=T10; C7=T11; доки=T12; §10 x402 — осознанно вне плана (этап 2). Допущения спека §9.1 (owner) закрыты паттерном service-user в T1.
- Placeholder-scan: «сверить сигнатуру»-шаги — это проверки совместимости с реальным кодом в момент исполнения, не пропуски контента; каждый содержит точный файл:строку.
- Типы: `credits` везде строка→BigInt; `expires_at` ISO-строка в API; SQL-имена зафиксированы.
- Review Focus: 6 пунктов, каждый пиннится тестом в указанной задаче.
