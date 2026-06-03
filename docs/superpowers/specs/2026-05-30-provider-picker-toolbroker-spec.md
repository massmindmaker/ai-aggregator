# Sprint — Provider Picker + Tool Broker foundation (Implementation Spec)

**Status:** IMPLEMENTATION-READY (concrete tasks, no code yet)
**Date:** 2026-05-30
**Owner:** AIAG core
**Repo:** `C:\Users\боб\projects\aggregator` (monorepo: `apps/web`, `apps/tg-miniapp`, `apps/agent-worker`, `packages/api-gateway`, `packages/database`)
**Builds on:** Phase 15 (`2026-05-08-phase15-tg-miniapp-design.md`), P1A "connect your own OpenAI-compatible agent" (commits `84a762e`, `3697476`).

---

## 0. TL;DR

Three deliverables, ordered by dependency:

1. **D1 — connection_type constraint bug fix** (tiny, blocking). A new migration aligns the `agents_connection_type_chk` CHECK constraint to the value the code actually writes (`'external_openai'`). *A separate agent is implementing this; documented here for completeness.*
2. **D2 — Per-agent Provider Picker** (the big one). Generalize the binary `connection_type` (`aiag` | `external_openai`) into a real OpenCode-style provider system: `providers` + `models` catalog mirrored daily from `models.dev/api.json`, per-agent `provider_id` / `model_id`, credentials in a separate encrypted `agent_provider_credentials` table, a daily catalog-sync job, a generalized `resolveUpstream()` in the worker, and a provider→model→credential UI in agent create/edit.
3. **D3 — Tool Broker data model** (foundation only). A `tools` registry table shaped as a superset of an x402 Bazaar listing, plus the metering + atomic-deduct flow and a `key_broker`-rail broker endpoint that injects OUR key. **Firecrawl is the first tool.** x402 *outgoing* adapter is future, noted only.

### Ground-truth audit (read before implementing)

| Fact | Source |
|------|--------|
| Code writes `connection_type = 'external_openai'` | `apps/tg-miniapp/app/api/tma/agents/route.ts:87`, `apps/agent-worker/src/db.ts:23`, `apps/agent-worker/src/agent-runner.ts:34` |
| Migration constraint only allows `'aiag' \| 'external'` | `packages/database/migrations/0021_agents_external_connection.sql:14` |
| **Canonical value = `'external_openai'`** (the code wins; constraint is the bug) | confirmed across all 3 code sites above |
| `agents` / `agent_runs` tables live ONLY in SQL migrations — **no Drizzle TS schema** for them (grep `connection_type\|agents` in `packages/database/src` → no files) | `packages/database/migrations/0018_agents.sql`, `0020_agents_daily_budget.sql`, `0021_…` |
| ⇒ D1 is **migration-only**; no Drizzle/TS constraint to touch | — |
| AES-256-GCM crypto already exists, mirrored in two places (`encryptSecret`/`decryptSecret`/`hintFromSecret`, key `TMA_KEY_ENCRYPTION_KEY`, bytea layout `iv(12)\|ct\|tag(16)`) | `apps/tg-miniapp/src/lib/crypto.ts`, `apps/agent-worker/src/crypto.ts` |
| Worker is a BullMQ consumer of queue `agent-run`, concurrency 4, healthcheck on `:3101`. No cron loop yet | `apps/agent-worker/src/index.ts` |
| Run enqueue path: API route inserts `agent_runs` row (`status='pending'`) then `queue.add('run', {runId})` | `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts` |
| Existing tools: `web_search` (DDG scrape), `calc`, `image_gen` (Kie). Dispatcher = `executeTool(name,args)` returning `{result, cost_rub}` | `apps/agent-worker/src/tools.ts` |
| Latest migration = `0021`. Next numbers: `0022`, `0023`, `0024` | `packages/database/migrations/` |

### Constraints honored throughout

- **D#13 bare-metal:** no Docker for the app. Catalog-sync runs as a pm2/BullMQ repeatable job inside `apps/agent-worker`, not a container.
- **No-local-runtime rule:** this spec contains **no test/run commands**. All verification happens on VPS `ai-aggregator.ru` after deploy (see acceptance criteria, which are described as observable VPS states, not commands to run locally).
- **Two-entity split:** the tool-broker / x402 layer lives conceptually on the *foreign entity* (the agentic surface), exactly as the Phase 16 x402 spec frames it. The RF "white" entity (web card payments) never sees x402 or the broker. D3 tables/endpoints are scoped to the agent-worker + mini-app surface only.

---

## D1 — Fix the `connection_type` constraint bug

### Goal
Make the DB constraint accept the value the code already writes, so external-agent inserts stop being a latent `CHECK` violation. Minimal, reversible, no code-string churn.

### Scope
- **IN:** one new forward migration that drops the old constraint and recreates it with the correct value set; align the row-level "external requires url" guard so it keys off `'external_openai'` too.
- **OUT:** changing any `'external_openai'` string in TypeScript (risky, touches 3 files + UI; the value is canonical). No Drizzle change (no TS schema for `agents`).

### Data model (migration only)
`packages/database/migrations/0022_fix_connection_type_constraint.sql`:

```sql
-- The code (route.ts, agent-runner.ts, db.ts) writes 'external_openai',
-- but 0021 constrained connection_type to ('aiag','external'). Align the
-- constraint to the canonical code value. Forward-only; idempotent.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_connection_type_chk;
ALTER TABLE agents
  ADD CONSTRAINT agents_connection_type_chk
  CHECK (connection_type IN ('aiag', 'external_openai'));

-- 0021's row-level guard used connection_type = 'aiag' OR url IS NOT NULL,
-- which is still correct (any non-aiag kind needs a url) — but restate it
-- explicitly so the intent survives the provider-picker migration (0023).
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_external_requires_url_chk;
ALTER TABLE agents
  ADD CONSTRAINT agents_external_requires_url_chk
  CHECK (connection_type = 'aiag' OR external_base_url IS NOT NULL);
```

> **Note for the D2 implementer:** D2 (migration `0023`) widens `connection_type` semantics via the new `agent_provider_credentials.kind`. When D2 lands, `connection_type` becomes a *legacy* discriminator kept for backward-compat; the `agents_connection_type_chk` may be dropped entirely in `0023` once `provider_id` is the source of truth. D1 must ship first and independently so prod stops violating the constraint.

### File-by-file task list
1. **CREATE** `packages/database/migrations/0022_fix_connection_type_constraint.sql` — content above.
2. **VERIFY** the migration runner picks up `0022` in lexical order (it already globs `migrations/*.sql`; no index file to edit).

### Acceptance criteria
- [ ] After deploy on VPS, inserting an agent with `connection_type='external_openai'` (via `/agents/new` → "Свой агент") succeeds (currently would violate the CHECK).
- [ ] `\d agents` on the VPS Postgres shows `agents_connection_type_chk` allowing `'aiag'`/`'external_openai'`.
- [ ] No TypeScript file changed.

---

## D2 — Per-agent Provider Picker

### Goal
Replace the binary `connection_type` with a real provider system modeled on OpenCode / models.dev: **adapter + baseURL + apiKey|token + model**, with a daily-synced catalog so the UI and worker are metadata-driven (tool toggle only when the model supports tool-calling, vision only when it accepts image input). Ship 4 connection kinds; keep the existing AIAG-gateway path as zero-new-code default.

### Scope
- **IN:**
  - `providers` + `models` catalog tables, mirrored daily from `https://models.dev/api.json` (~2 MB).
  - New `agents` columns: `provider_id`, `model_id`, `auth_ref`, `base_url_override`.
  - `agent_provider_credentials` — separate encrypted credential table (reuses existing AES-256-GCM).
  - 4 connection kinds: **aiag** (default), **openrouter**, **apikey** (BYO), **custom_url** (generalized P1A).
  - Daily catalog-sync job inside `apps/agent-worker`.
  - Generalized `resolveUpstream()`: one generic OpenAI-compatible client + ~6 native branches selected by `provider.npm_adapter`.
  - Provider→model→credential UI in `/agents/new` and `/agents/[id]`.
- **OUT (explicit):**
  - **Subscription / OAuth providers** (ChatGPT-Plus-style, Anthropic-subscription) — these are *banned providers* under our white-label upstream strategy and RKN posture. Note kept; no UI, no `kind='subscription'`.
  - Per-model price negotiation, BYO-billing reconciliation beyond `isExternal ⇒ cost 0`.

### Data model

#### New migration `0023_provider_catalog.sql`

```sql
-- Providers mirrored from models.dev/api.json (daily). One row per provider.
CREATE TABLE IF NOT EXISTS providers (
  id           VARCHAR(64) PRIMARY KEY,         -- models.dev provider id, e.g. 'openai','anthropic','openrouter','google'
  name         TEXT NOT NULL,
  npm_adapter  TEXT,                            -- models.dev "npm" field, e.g. '@ai-sdk/openai','@ai-sdk/anthropic'
  api_base     TEXT,                            -- default base URL from catalog
  env_keys     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["OPENAI_API_KEY", ...] env names the catalog advertises
  enabled      BOOLEAN NOT NULL DEFAULT true,   -- ops kill-switch (banned providers set false)
  markup       NUMERIC(6,3) NOT NULL DEFAULT 1.10, -- AIAG markup applied when kind='aiag' routes through our gateway
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-provider model catalog.
CREATE TABLE IF NOT EXISTS models_catalog (
  provider_id   VARCHAR(64) NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,                  -- models.dev model id, e.g. 'gpt-4o','claude-3-5-sonnet'
  display_name  TEXT,
  ctx           INTEGER,                        -- context window (limit.context)
  max_out       INTEGER,                        -- limit.output
  cost_in       NUMERIC(12,6),                  -- cost.input  (USD / 1M tokens)
  cost_out      NUMERIC(12,6),                  -- cost.output (USD / 1M tokens)
  tool_call     BOOLEAN NOT NULL DEFAULT false, -- models.dev tool_call
  reasoning     BOOLEAN NOT NULL DEFAULT false, -- models.dev reasoning
  modalities_in  JSONB NOT NULL DEFAULT '[]'::jsonb, -- modalities.input  e.g. ["text","image"]
  modalities_out JSONB NOT NULL DEFAULT '[]'::jsonb, -- modalities.output e.g. ["text"]
  status        VARCHAR(16) NOT NULL DEFAULT 'live', -- 'live' | 'stale' (dropped from last sync) | 'disabled'
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_models_catalog_toolcall ON models_catalog(provider_id, tool_call);

-- agents → provider linkage (additive; legacy connection_type/external_* stay for backward-compat)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS provider_id        VARCHAR(64) REFERENCES providers(id),
  ADD COLUMN IF NOT EXISTS model_id           TEXT,            -- model within the provider catalog
  ADD COLUMN IF NOT EXISTS auth_ref           UUID,            -- → agent_provider_credentials.id (nullable for kind='aiag')
  ADD COLUMN IF NOT EXISTS base_url_override  TEXT;            -- per-agent override (custom_url)

-- Encrypted per-agent credential store (separate table, NOT inline on agents).
CREATE TABLE IF NOT EXISTS agent_provider_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider_id   VARCHAR(64) REFERENCES providers(id),
  kind          VARCHAR(20) NOT NULL,           -- 'aiag'|'apikey'|'gateway'|'openrouter'|'custom_url'
  encrypted_key BYTEA,                           -- AES-256-GCM blob (iv|ct|tag); NULL for kind='aiag'
  key_hint      VARCHAR(12),                     -- '***abcd' for UI (hintFromSecret)
  base_url      TEXT,                            -- effective base URL for this credential
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apc_kind_chk CHECK (kind IN ('aiag','apikey','gateway','openrouter','custom_url')),
  -- non-aiag kinds need a key; aiag uses our gateway env key
  CONSTRAINT apc_key_required_chk CHECK (kind = 'aiag' OR encrypted_key IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_apc_agent ON agent_provider_credentials(agent_id);
```

> **Naming note:** the catalog table is `models_catalog`, **not** `models` — `models` is already the canonical gateway routing table (`packages/database/src/schema/models-marketplace.ts`, migration `0004_gateway_core.sql`). Do not collide.

#### Connection kinds (the 4 we ship)

| kind | base_url | credential | new code? | Notes |
|------|----------|------------|-----------|-------|
| `aiag` | our gateway `http://127.0.0.1:4000/v1` (OpenAI-compatible) | none (worker uses gateway env key) | **zero** | default; cost accounted via `provider.markup` |
| `openrouter` | `https://openrouter.ai/api/v1` | one OpenRouter key | minimal | reuses existing OpenRouter path; per-agent key instead of shared `OPENROUTER_API_KEY` |
| `apikey` | `provider.api_base` from catalog | BYO provider key | small | e.g. user pastes their own OpenAI/Anthropic key; routed direct |
| `custom_url` | `base_url_override` | optional key | **generalize P1A** | the current `external_openai` flow; any OpenAI-compatible endpoint |

`kind='gateway'` is reserved in the enum for a future second internal gateway; no UI in this sprint.

### API

**Catalog (read, for UI):**
- `GET /tg/api/tma/providers` → `{ providers: [{ id, name, enabled, models_count }] }` (only `enabled=true`).
- `GET /tg/api/tma/providers/:id/models` → `{ models: [{ model_id, display_name, ctx, tool_call, reasoning, modalities_in, modalities_out }] }` (only `status='live'`).

**Agent create/update (extend existing route):**
- `POST /tg/api/tma/agents` and `PATCH /tg/api/tma/agents/:id` accept new body fields:
  ```ts
  provider_id?: string;
  model_id?: string;
  connection_kind?: 'aiag'|'openrouter'|'apikey'|'custom_url'; // → agent_provider_credentials.kind
  api_key?: string;            // encrypted server-side; never returned
  base_url_override?: string;  // custom_url only
  ```
  Server: on non-`aiag` kind, `encryptSecret(api_key)` → insert `agent_provider_credentials` row → set `agents.auth_ref`. Response returns `key_hint` only, never the key (mirror existing `external_api_key_hint` behavior in `route.ts:130`).

**Catalog sync (internal, no HTTP):** BullMQ repeatable job, not an endpoint.

### Catalog sync job

- **Where:** `apps/agent-worker/src/catalog-sync.ts`, scheduled from `apps/agent-worker/src/index.ts` via a BullMQ `Queue.upsertJobScheduler` (or `repeat: { pattern: '0 4 * * *' }`) on a new queue `catalog-sync`, consumed by a second `Worker`. Respects D#13 (in-process, bare-metal; no container, no OS cron).
- **What:** `fetch('https://models.dev/api.json')` (~2 MB) → parse → upsert `providers` and `models_catalog`. models.dev shape is `{ [providerId]: { name, npm, env, api?, models: { [modelId]: { name, limit:{context,output}, cost:{input,output}, tool_call, reasoning, modalities:{input,output} } } } }`.
- **Staleness:** before upsert, mark all rows `status='stale'`; rows seen in the new payload → `status='live'`, `synced_at=NOW()`. Never hard-delete (agents may reference them).
- **Markup / enabled:** `providers.markup` and `providers.enabled` are **ops-owned** — sync must NOT overwrite them (UPSERT updates only catalog-derived columns; `ON CONFLICT … DO UPDATE SET name=…, npm_adapter=…, api_base=…, env_keys=…, synced_at=NOW()` — explicitly excludes `enabled`, `markup`).
- **Banned providers:** seed a one-time migration row-set or an ops list that sets `enabled=false` for subscription/OAuth-only providers so they never surface in the picker.

### Worker resolution — generalized `resolveUpstream()`

Rewrite `apps/agent-worker/src/agent-runner.ts:33-52` (`resolveUpstream`). New shape:

```
resolveUpstream(agent):
  1. Load agent.provider_id (+ providers row) and agent.auth_ref (+ credential row).
     Back-compat: if provider_id is NULL, fall back to legacy connection_type
     ('aiag' → gateway; 'external_openai' → custom_url from external_* columns).
  2. baseURL  = credential.base_url || agent.base_url_override || provider.api_base
  3. apiKey   = credential.kind === 'aiag'
                   ? process.env.AIAG_GATEWAY_KEY      // our gateway env key
                   : decryptSecret(credential.encrypted_key)
  4. model    = agent.model_id || agent.model_slug || DEFAULT_MODEL
  5. adapter  = provider.npm_adapter   // selects the request builder
  6. isExternal = credential.kind !== 'aiag'   // external ⇒ cost stays 0
```

**Adapter branches** (selected by `provider.npm_adapter`; default = generic OpenAI-compatible):

| adapter | branch |
|---------|--------|
| `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, openrouter, custom | **generic OpenAI** `POST {base}/chat/completions` (current code path — already works for aiag/openrouter/custom_url) |
| `@ai-sdk/anthropic` | Anthropic Messages API (`/v1/messages`, `x-api-key`, `anthropic-version`) — request/response shape translation |
| `@ai-sdk/google` | Google Generative AI (`:generateContent`) |
| `@ai-sdk/amazon-bedrock` | Bedrock signed request (note: AWS SigV4 — heavier; can stub-throw `provider_not_supported_yet` if out of time) |
| `@ai-sdk/azure` | Azure OpenAI (`/openai/deployments/{model}/chat/completions?api-version=…`) |
| gateway/openrouter | generic OpenAI + routing headers (current `HTTP-Referer`/`X-Title`) |

> **Pragmatic cut:** ship the **generic OpenAI branch fully** (covers aiag, openrouter, apikey-for-openai, custom_url — the 4 kinds we actually ship) + **Anthropic + Google** native branches. Bedrock/Azure may land as `provider_not_supported_yet` throwers wired to the same dispatch, completed in a follow-up. This keeps the sprint shippable without SigV4 work.

Cost: keep `estimateCostRub` but source per-token prices from `models_catalog.cost_in`/`cost_out` (fallback to the hard-coded `PRICING` map) so accounting tracks the live catalog.

### UI

`apps/tg-miniapp/app/agents/new/page.tsx` and `apps/tg-miniapp/app/agents/[id]/page.tsx`:

1. Replace the "🌐 Свой агент (URL + ключ)" checkbox block with a **Connection** section:
   - **Kind selector** (segmented): `AIAG (по умолчанию)` · `OpenRouter` · `Свой ключ` · `Свой URL`.
   - **Provider dropdown** (`GET /providers`, hidden when kind=`aiag`/`custom_url`).
   - **Model dropdown** (`GET /providers/:id/models`); for `aiag` it lists our gateway models, for `custom_url` it stays a free-text field (endpoint may not expose `/models`).
   - **Credential input** per kind: none (aiag) · one key (openrouter / apikey) · url+optional key (custom_url). Reuse the existing "Проверить соединение" test against `/tg/api/tma/agents/test-external` for `custom_url`.
2. **Metadata-gated tool UI:** when the selected `models_catalog` row has `tool_call=false`, disable/hide the tool toggles (so users can't attach `web_search`/`image_gen`/Firecrawl to a non-tool model). Show vision-only affordances when `modalities_in` includes `"image"`.
3. Preserve the existing template prefill flow and the `aiag_selected_model_slug` localStorage handoff from `/market/[slug]`.

### File-by-file task list

| # | File | Action |
|---|------|--------|
| 1 | `packages/database/migrations/0023_provider_catalog.sql` | **create** — tables + agent columns + credentials (above) |
| 2 | `packages/database/migrations/0024_seed_disable_banned_providers.sql` | **create** — `UPDATE providers SET enabled=false` for subscription/OAuth providers (runs after first sync; or a guarded `INSERT … ON CONFLICT` ops list) |
| 3 | `apps/agent-worker/src/catalog-sync.ts` | **create** — fetch models.dev, upsert `providers`+`models_catalog`, stale-marking |
| 4 | `apps/agent-worker/src/index.ts` | **edit** — register `catalog-sync` queue + repeatable scheduler + worker |
| 5 | `apps/agent-worker/src/db.ts` | **edit** — extend `AgentRow` with `provider_id`/`model_id`/`auth_ref`/`base_url_override`; add `loadProvider(id)`, `loadCredential(authRef)` |
| 6 | `apps/agent-worker/src/agent-runner.ts` | **edit** — rewrite `resolveUpstream()`; adapter dispatch in `callModel()`; cost from catalog |
| 7 | `apps/agent-worker/src/adapters/` (`openai.ts`, `anthropic.ts`, `google.ts`) | **create** — per-adapter request/response builders (generic OpenAI fully; Anthropic+Google native; Bedrock/Azure throw `provider_not_supported_yet`) |
| 8 | `apps/tg-miniapp/app/api/tma/providers/route.ts` | **create** — `GET` enabled providers |
| 9 | `apps/tg-miniapp/app/api/tma/providers/[id]/models/route.ts` | **create** — `GET` live models for provider |
| 10 | `apps/tg-miniapp/app/api/tma/agents/route.ts` | **edit** — accept `provider_id`/`model_id`/`connection_kind`/`api_key`/`base_url_override`; write `agent_provider_credentials` + `auth_ref` |
| 11 | `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts` | **edit** (or create PATCH) — same credential write path for edit |
| 12 | `apps/tg-miniapp/app/agents/new/page.tsx` | **edit** — Connection section (kind→provider→model→credential), metadata-gated tools |
| 13 | `apps/tg-miniapp/app/agents/[id]/page.tsx` | **edit** — same Connection editor for existing agents |
| 14 | `apps/tg-miniapp/src/lib/providers.ts` | **create** — typed client helpers for the two catalog endpoints |

### Acceptance criteria

- [ ] After deploy + first catalog-sync run on VPS, `providers` has ≥ the major adapters and `models_catalog` has thousands of rows (`models.dev` is large); `synced_at` is recent.
- [ ] Creating an agent with **kind=aiag** stores `provider_id` pointing at the gateway provider, `auth_ref=NULL`, and runs through the existing gateway path with **no new credential row** and cost accounted via `provider.markup`.
- [ ] Creating an agent with **kind=openrouter / apikey / custom_url** stores an `agent_provider_credentials` row with an AES-GCM `encrypted_key` (decryptable by the worker), `key_hint` shown in UI, and the key is **never** returned by any GET.
- [ ] The model dropdown only shows `status='live'` models; selecting a `tool_call=false` model disables tool toggles in the UI.
- [ ] Worker `resolveUpstream()` resolves all 4 kinds; a legacy `external_openai` agent (no `provider_id`) still runs via the back-compat fallback.
- [ ] A run against an Anthropic-adapter provider with a valid BYO key returns a completion (native branch translates request/response).
- [ ] `provider.enabled=false` providers do not appear in `GET /providers`.
- [ ] Daily sync does NOT overwrite ops-set `enabled`/`markup`.

---

## D3 — Tool Broker data model (foundation only, Firecrawl first)

### Goal
Lay the data + execution foundation for a paid-tool broker so agents can call external paid tools through AIAG with our markup. Ship **Firecrawl** end-to-end on the `key_broker` rail (we inject OUR Firecrawl key, meter usage, deduct credits atomically). Shape the registry as a **superset of an x402 Bazaar listing** so the same table later carries `x402`-rail tools with no schema change. x402 *outgoing* adapter is **future, noted only**.

### Scope
- **IN:** `tools` registry table; the metering + atomic-deduct flow (`UPDATE balance WHERE balance >= cost RETURNING`); a broker endpoint the agent-worker calls that injects OUR key (`key_broker` rail); Firecrawl as the first registered tool; worker `executeTool` dispatch for broker tools.
- **OUT (noted only):** x402 *outgoing* adapter (agent-worker paying an external x402 resource) — future; the `rail='x402'` enum value + `accepts`/`trust` jsonb columns are reserved now so no migration is needed later. No Bazaar *discovery* crawler in this sprint (manual seed of Firecrawl).
- **Entity placement:** broker + future x402 live on the **foreign agentic entity** (per Phase 16 split). No web-UI surface.

### Data model `0025_tool_broker.sql`

```sql
-- Tool registry — superset of an x402 Bazaar listing so x402-rail tools
-- slot in later with zero schema change.
CREATE TABLE IF NOT EXISTS tools (
  id              VARCHAR(64) PRIMARY KEY,        -- 'firecrawl_scrape', 'firecrawl_search', ...
  display_name    TEXT NOT NULL,
  category        VARCHAR(40) NOT NULL,           -- 'web','data','media',...
  provider        TEXT NOT NULL,                  -- 'firecrawl'
  source          VARCHAR(24) NOT NULL,           -- 'bazaar' | 'manual_key_broker'
  resource_url    TEXT,                           -- upstream endpoint (Firecrawl API URL or x402 resource)
  input_schema    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- JSON Schema for tool params (given to the model)
  output_schema   JSONB NOT NULL DEFAULT '{}'::jsonb,
  upstream_price  NUMERIC(12,6),                  -- what the upstream charges per call (USD)
  pricing_model   VARCHAR(24) NOT NULL DEFAULT 'per_call', -- 'per_call' | 'per_unit' | 'subscription_amortized'
  markup_pct      NUMERIC(6,3) NOT NULL DEFAULT 1.30, -- AIAG markup
  user_price_credits NUMERIC(12,4) NOT NULL,      -- final ₽-credits charged to the agent owner per call
  rail            VARCHAR(16) NOT NULL DEFAULT 'key_broker', -- 'x402' | 'key_broker'
  accepts         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- x402 accepts[] (reserved; empty for key_broker)
  trust           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- x402 trust signals (reserved)
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tools_rail_chk CHECK (rail IN ('x402','key_broker')),
  CONSTRAINT tools_source_chk CHECK (source IN ('bazaar','manual_key_broker'))
);

-- Per-call ledger so usage is auditable and idempotent.
CREATE TABLE IF NOT EXISTS tool_calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tg_user_id    BIGINT NOT NULL,
  tool_id       VARCHAR(64) NOT NULL REFERENCES tools(id),
  cost_credits  NUMERIC(12,4) NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ok', -- 'ok' | 'insufficient_funds' | 'upstream_error'
  request       JSONB,
  response_meta JSONB,                              -- size, status, NOT full body
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id, created_at DESC);

-- Seed Firecrawl (the first tool). markup 1.30, key_broker rail.
INSERT INTO tools (id, display_name, category, provider, source, resource_url,
                   input_schema, upstream_price, user_price_credits, rail, enabled)
VALUES
 ('firecrawl_scrape','Firecrawl Scrape','web','firecrawl','manual_key_broker',
  'https://api.firecrawl.dev/v2/scrape',
  '{"type":"object","properties":{"url":{"type":"string"},"formats":{"type":"array","items":{"type":"string"}}},"required":["url"]}'::jsonb,
  0.001, 1.0, 'key_broker', true),
 ('firecrawl_search','Firecrawl Search','web','firecrawl','manual_key_broker',
  'https://api.firecrawl.dev/v2/search',
  '{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]}'::jsonb,
  0.001, 1.5, 'key_broker', true)
ON CONFLICT (id) DO NOTHING;
```

> **Balance source of truth:** the atomic deduct targets the existing user-balance ledger used by `settle_charge` (`packages/billing`) — agent-worker already accounts `cost_rub` per run. The broker reuses that ledger; `tool_calls` is the per-call audit trail, the balance row is the money. Implementer must confirm the exact balance column/table in `packages/billing` and key the atomic UPDATE off it (do not invent a new balance table).

### Metering + atomic-deduct flow

```
Agent emits tool_call → executeTool('firecrawl_scrape', args):
  1. Load tools row (enabled, rail='key_broker', user_price_credits).
  2. ATOMIC DEDUCT (single statement, race-safe — matches our D#-atomic rule):
        UPDATE <balance_table>
           SET balance = balance - :cost
         WHERE user_id = :uid AND balance >= :cost
        RETURNING balance;
     → 0 rows ⇒ insert tool_calls(status='insufficient_funds');
       return tool_result {error:'insufficient_balance', topup_link}
       (agent reads error, offers top-up — same pattern as the budget path
        already in agent-runner.ts).
  3. Call broker endpoint (injects OUR Firecrawl key) with args.
  4. On upstream error → REFUND (UPDATE balance = balance + :cost) +
     tool_calls(status='upstream_error'); return {error}.
  5. On success → tool_calls(status='ok', response_meta) ; return {result}.
```

### Broker endpoint (key_broker rail)

- **Where:** `apps/agent-worker/src/broker.ts` — a server-side function (in-process, called from `executeTool`), NOT a public HTTP route. It injects `process.env.FIRECRAWL_API_KEY` (stored in `/srv/aiag/shared/.env`, per the API-keys memory) and proxies to `tools.resource_url`. Keeping it in-process means the OUR-key never crosses a network boundary the agent controls.
- **Contract:** `broker.call(tool, args) → { ok, data?, error? }`. The OUR-key is added as the `Authorization: Bearer` header to the upstream Firecrawl call; the agent never sees it.
- **Future x402 rail:** when `rail='x402'`, `broker.call` would instead run the x402 outgoing handshake (402 → sign `PAYMENT-SIGNATURE` → retry). **Out of scope this sprint** — leave a `if (tool.rail === 'x402') throw new Error('x402_outgoing_not_implemented')` stub so the dispatch is wired.

### Worker dispatch integration

`apps/agent-worker/src/tools.ts`:
- Add a DB-driven tool-def loader: alongside the static `TOOL_DEFS`, load `enabled` rows from `tools` and expose their `input_schema` as function defs (so the model sees `firecrawl_scrape`/`firecrawl_search`).
- In `executeTool`, add a fallthrough: if `name` is not a built-in (`web_search`/`calc`/`image_gen`) but matches a `tools.id`, route to the broker/metering flow and return `{result, cost_rub: user_price_credits}` so the existing `agent-runner.ts:275` cost accumulation works unchanged.
- `pickToolDefs(agent.tools)` must union built-ins + enabled broker tools when filtering by the agent's whitelist (so an agent can whitelist `firecrawl_scrape`).

### File-by-file task list

| # | File | Action |
|---|------|--------|
| 1 | `packages/database/migrations/0025_tool_broker.sql` | **create** — `tools` + `tool_calls` + Firecrawl seed (above) |
| 2 | `apps/agent-worker/src/broker.ts` | **create** — `key_broker` rail: inject OUR Firecrawl key, proxy upstream; x402 stub-throw |
| 3 | `apps/agent-worker/src/billing.ts` (or extend `db.ts`) | **create/edit** — `atomicDeduct(uid,cost)`, `refund(uid,cost)`, `recordToolCall(...)` keyed off the existing billing balance ledger |
| 4 | `apps/agent-worker/src/tools.ts` | **edit** — DB-driven tool defs, broker fallthrough in `executeTool`, union in `pickToolDefs` |
| 5 | `apps/agent-worker/src/agent-runner.ts` | **edit (minimal)** — none required if `executeTool` keeps `{result, cost_rub}` shape; confirm cost path |
| 6 | (env) `/srv/aiag/shared/.env` on VPS | **add** `FIRECRAWL_API_KEY` (ops step, not code) |

### Acceptance criteria

- [ ] `tools` table on VPS has the two Firecrawl rows, `rail='key_broker'`, `enabled=true`.
- [ ] An agent whitelisting `firecrawl_scrape` gets the tool def (from `input_schema`) in its model call and the model can invoke it.
- [ ] A successful Firecrawl call deducts `user_price_credits` from the owner balance via a single atomic `UPDATE … WHERE balance >= cost RETURNING`, writes a `tool_calls` row `status='ok'`, and the OUR Firecrawl key never appears in the agent's view of the tool result.
- [ ] Insufficient balance ⇒ no upstream call, `tool_calls.status='insufficient_funds'`, tool returns `{error:'insufficient_balance'}`, agent offers top-up.
- [ ] Upstream Firecrawl error ⇒ the deducted credits are refunded and `tool_calls.status='upstream_error'`.
- [ ] A `rail='x402'` tool throws `x402_outgoing_not_implemented` (dispatch wired, feature deferred).

---

## Cross-cutting notes

- **Migration order:** `0022` (D1) → `0023`/`0024` (D2) → `0025` (D3). D1 must ship and deploy first; D2's `0023` may later drop `agents_connection_type_chk` once `provider_id` is authoritative.
- **Crypto reuse:** all key encryption uses the existing `encryptSecret`/`decryptSecret`/`hintFromSecret` (`apps/tg-miniapp/src/lib/crypto.ts` + worker mirror). No new crypto. Key env `TMA_KEY_ENCRYPTION_KEY` already provisioned.
- **No Drizzle churn:** `agents`/`agent_runs` have no TS schema; the new `providers`/`models_catalog`/`agent_provider_credentials`/`tools`/`tool_calls` likewise live in SQL migrations + raw `postgres-js` queries (matching the existing agent code style). Add Drizzle definitions only if a later web-admin surface needs them.
- **Verification = VPS only** (`ai-aggregator.ru`), after deploy via the existing green pipeline. No local dev/test/Docker per the no-local-runtime rule and D#13.
- **Banned providers / RKN:** subscription-OAuth providers stay disabled (`providers.enabled=false`); white-label upstream strategy preserved (user-facing names hidden where `kind='aiag'` routes through our gateway).

## Acceptance Checklist (spec phase)

- [x] D1: goal / scope / migration-only data model / file list / acceptance
- [x] D2: goal / scope / providers+models_catalog+agent cols+credentials data model / catalog API / sync job / generalized resolveUpstream / UI / file list / acceptance
- [x] D3: goal / scope / tools+tool_calls data model / metering+atomic-deduct / key_broker endpoint / Firecrawl seed / file list / acceptance
- [x] Grounded in real paths/columns (route.ts, agent-runner.ts, db.ts, tools.ts, crypto.ts, 0018/0021 migrations)
- [x] Canonical `connection_type` value confirmed = `'external_openai'`
- [x] Constraints honored: D#13 bare-metal, no-local-runtime, two-entity split, banned providers, AES-GCM reuse
- [x] x402 outgoing explicitly deferred (reserved columns, stub throw)
