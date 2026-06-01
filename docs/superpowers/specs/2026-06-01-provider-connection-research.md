# Подключение провайдеров — Deep research + build plan

**Status:** RESEARCH + BUILD-PLAN (decision feed)
**Date:** 2026-06-01
**Owner:** AIAG core
**Repo:** `C:\Users\боб\projects\aggregator`
**Builds on:** `docs/superpowers/specs/2026-05-30-provider-picker-toolbroker-spec.md` (the D1/D2/D3 spec)
**Constraints honored:** D#13 bare-metal (no Docker for app), no-local-runtime (verify on VPS `ai-aggregator.ru`), white-label upstream strategy, two-entity split (agentic surface ≠ RF web card surface), AES-256-GCM reuse.

---

## Part 1 — Where we are (ground truth from the repo)

### 1.1 The 30-05 spec: what it defines

The prior spec (`2026-05-30-provider-picker-toolbroker-spec.md`) defines three deliverables:

- **D1 — `connection_type` constraint fix.** A migration aligning the `agents_connection_type_chk` CHECK to the value the code writes (`'external_openai'`).
- **D2 — Per-agent Provider Picker.** The big one. Generalize binary `connection_type` (`aiag` | `external_openai`) into an OpenCode-style provider system:
  - `providers` table (mirrored daily from `models.dev/api.json`): `id, name, npm_adapter, api_base, env_keys, enabled, markup, synced_at`. **`markup` + `enabled` are ops-owned, never overwritten by sync.**
  - `models_catalog` table (named to avoid colliding with the gateway's canonical `models`): `provider_id, model_id, ctx, max_out, cost_in, cost_out, tool_call, reasoning, modalities_in/out, status('live'|'stale'|'disabled')`.
  - New `agents` columns: `provider_id, model_id, auth_ref, base_url_override`.
  - `agent_provider_credentials` — separate encrypted credential table (AES-256-GCM), `kind IN ('aiag','apikey','gateway','openrouter','custom_url')`, `encrypted_key BYTEA`, `key_hint`, `base_url`.
  - 4 connection kinds shipped: **aiag** (default, zero new code), **openrouter**, **apikey** (BYO), **custom_url** (generalized P1A).
  - Daily catalog-sync BullMQ repeatable job in `apps/agent-worker`. Never hard-deletes; marks stale.
  - Generalized `resolveUpstream()`: generic OpenAI-compatible client + native Anthropic/Google branches, Bedrock/Azure stub-throw.
  - Provider→model→credential UI in `/agents/new` + `/agents/[id]`, metadata-gated tool toggles (`tool_call=false` ⇒ disable tools).
- **D3 — Tool Broker** (foundation only, Firecrawl first). `tools` registry shaped as a **superset of an x402 Bazaar listing** (so `rail='x402'` slots in later with no schema change), `tool_calls` ledger, atomic-deduct (`UPDATE balance WHERE balance >= cost RETURNING`), in-process `key_broker` rail that injects OUR Firecrawl key. x402 *outgoing* is reserved-only (stub throw).

**Markup ownership** (from the spec): `providers.markup` applies when `kind='aiag'` routes through our gateway; external kinds (`openrouter`/`apikey`/`custom_url`) ⇒ `isExternal=true` ⇒ cost stays 0 (user pays their own provider). Tool broker has its own `markup_pct` per tool.

### 1.2 SPECCED vs actually BUILT

| Item | Specced | Built in code? |
|------|---------|----------------|
| **D1 constraint fix** | yes | **SHIPPED.** `packages/database/migrations/0022_agents_connection_type_fix.sql` exists and allows `('aiag','external_openai')`, idempotent. |
| `providers` / `models_catalog` tables | yes (as `0023`) | **NOT BUILT.** No such migration; `0023` is `0023_agent_memory.sql` (unrelated). |
| `agents.provider_id/model_id/auth_ref/base_url_override` | yes | **NOT BUILT.** `agents` still has only `connection_type/external_base_url/external_api_key_encrypted/external_model_slug` (migrations `0021`+`0022`). |
| `agent_provider_credentials` | yes | **NOT BUILT.** |
| Catalog-sync job (models.dev) | yes | **NOT BUILT.** Worker (`apps/agent-worker/src/index.ts`) consumes only the `agent-run` queue; no second queue, no cron, no `catalog-sync.ts`. |
| Generalized `resolveUpstream()` | yes | **NOT BUILT.** Current `resolveUpstream()` (`agent-runner.ts:33-52`) is the binary aiag/external_openai branch. |
| `tools` / `tool_calls` broker | yes (D3) | **NOT BUILT.** `apps/agent-worker/src/tools.ts` has only static `TOOL_DEFS` (web_search, calc, image_gen, memory). No DB-driven tools, no broker, no Firecrawl. |
| Provider picker UI | yes | **NOT BUILT.** `/agents/new` + `/agents/[id]` still use the binary "Свой агент" checkbox. |

**Migration numbering drifted.** The spec assumed `0022=D1`, `0023/0024=D2`, `0025=D3`. Reality: `0022`=D1 (shipped), but `0023_agent_memory`, `0024_refresh_models_2026_05`, `0025_model_versioning` are already taken. **The provider-picker migrations must start at `0026`.**

### 1.3 What plumbing ALREADY exists (reusable building blocks)

**BYOK + crypto (fully reusable):**
- AES-256-GCM at `apps/tg-miniapp/src/lib/crypto.ts` and mirrored `apps/agent-worker/src/crypto.ts`: `encryptSecret(plain)→Buffer(iv|ct|tag)`, `decryptSecret(blob)→string`, `hintFromSecret(plain)→'***abcd'`. Key env `TMA_KEY_ENCRYPTION_KEY` (64 hex / 32 bytes), already provisioned. Returns a `bytea`-ready Buffer.
- The agents POST route (`apps/tg-miniapp/app/api/tma/agents/route.ts:86-103`) already encrypts a user key, stores `external_api_key_encrypted` + `external_api_key_hint`, and **never returns the key** (only the hint). This is the exact BYOK pattern D2 generalizes.

**SSRF guard (reusable):** `apps/tg-miniapp/src/lib/external-agent.ts` — `validateExternalUrl()` (HTTPS-only; blocks loopback, RFC1918, link-local, `169.254.169.254`, `.local/.internal/.lan`, IPv6 `::1`) + `probeExternalEndpoint()` (`GET {base}/models` with bearer, tolerant of `{data:[]}`/`{models:[]}`). The new "test connection" for any provider reuses this.

**Worker upstream path (the thing to generalize):**
- `resolveUpstream(agent)` (`agent-runner.ts:33`) → `{url, apiKey, model, isExternal}`. For `external_openai`: decrypts `external_api_key_encrypted`, normalizes base→`/chat/completions`. For `aiag`: uses `OPENROUTER_API_KEY` env + `https://openrouter.ai/api/v1/chat/completions` (so today "aiag" agents actually go straight to OpenRouter, **not** through our gateway at `127.0.0.1:4000`).
- `callModel()` (`agent-runner.ts:94`) is a generic OpenAI `chat/completions` POST. Already adapter-agnostic enough for openrouter/apikey/custom_url; needs branches for Anthropic/Google.
- Cost: `estimateCostRub()` uses a hard-coded `PRICING` map (7 models) + `FALLBACK_PRICE`; `USD_TO_RUB=90`. D2 sources per-token price from `models_catalog` instead.
- `executeTool(name, args, ctx)` returns `{result, cost_rub}`; `agent-runner.ts:274` accumulates `exec.cost_rub`. The broker fallthrough plugs in here cleanly.

**Gateway (the "aggregator as a provider" rail):** `packages/api-gateway` is the OpenAI-compatible Hono gateway. Its routing catalog is `upstreams` / `models` / `model_upstreams` (`0004_gateway_core.sql`), with `getUpstream(provider)` (`upstreams/registry.ts`) dispatching to real adapters (`openrouter`, `kie`, `ollama`, `groq`) or `mock`. Billing via `aiag_settle_charge` stored fn + `gateway_transactions` (idempotent partial-unique on `(request_id, source)`). **This is what `kind='aiag'` should target** (`http://127.0.0.1:4000/v1`) — but the worker currently bypasses it. Closing that gap is part of D2.

**Marketplace catalog (the static-generated 73 models):** `packages/database/scripts/gen-marketplace-catalog.ts` reads `models`+`model_upstreams` from prod (or a `CATALOG_DUMP_JSON`) and emits `apps/web/src/lib/marketplace/catalog.generated.ts` as a TS literal. Includes a `stripUpstream()` white-label scrubber (removes "через OpenRouter/Kie/…"). **No live models.dev sync exists** — confirmed. The catalog and the provider system are separate: the marketplace is *our* gateway models for the web buyer; the provider picker is the *agent's* upstream selection.

### 1.4 Gaps that matter for the build

- **PATCH `/agents/[id]` cannot edit connection.** `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:73-130` only updates name/description/system_prompt/tools/model_slug/budget. There is **no way to change an existing agent's provider/credentials** — D2's edit path must add this (the 30-05 spec lists it but it's worth flagging as net-new, not a tweak).
- **`agents`/`agent_runs` have no Drizzle TS schema** — they live in SQL migrations + raw `postgres-js`. New provider tables follow the same style (no Drizzle churn).
- **Worker "aiag" ≠ gateway.** Today an `aiag` agent hits OpenRouter directly with the shared `OPENROUTER_API_KEY`. If `kind='aiag'` is meant to route through our gateway (for white-label markup + billing), that's a behavioral change to verify carefully.

---

## Part 2 — Best-practices research

### 2.1 OpenCode multi-provider model (the reference design)

OpenCode (sst/anomalyco) supports 75+ providers by combining the **Vercel AI SDK** with the **models.dev** registry (same team maintains both). The structure to copy:

- **Registry-driven.** At startup OpenCode fetches the models.dev registry, which maps every provider → an npm AI-SDK package (`npm`), an auth flow, a base URL (`api`), env var names (`env`), and a model list with capabilities. User config (`opencode.json`) is *merged on top* of registry data — for built-in providers you don't repeat npm/baseURL, you only override or append models.
- **Three auth methods per provider:**
  1. **api key** — most providers; `/connect` → pick provider → paste key. Stored locally (`auth.json`).
  2. **oauth** — browser flow (GitHub Copilot, Anthropic Pro/Max, xAI). `/connect` opens a browser.
  3. **env vars** — Bedrock/Vertex use `AWS_PROFILE`/`GOOGLE_CLOUD_PROJECT` etc. (no stored secret).
- **Custom OpenAI-compatible provider:** `/connect` → "Other" → provider ID → API key, then `opencode.json` block with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, `options.apiKey`, and an explicit `models` map. Model-level `baseURL`/`apiKey` override is a live feature-request (issues #11287, #5674) — i.e. even OpenCode is still hardening per-model overrides.

**Mapping to AIAG:** the 30-05 spec's `providers.npm_adapter` = OpenCode's `npm`; `api_base` = `api`; `env_keys` = `env`; `agent_provider_credentials.kind` = OpenCode's auth method. The big divergence we *intentionally* keep: **OAuth/subscription providers are banned** under our white-label + RKN posture, so we ship api-key + custom-url only and never the oauth flow. That removes the hardest auth surface OpenCode carries.

### 2.2 models.dev/api.json — confirmed shape & sync

- **Endpoint:** `https://models.dev/api.json`, no auth, single JSON blob. Pre-generated at build time from TOML files (so it's a static file; cache-friendly).
- **Shape:** top-level object keyed by provider id. Each provider:
  ```
  { id, name, npm, env: [..], api?, models: { [modelId]: Model } }
  ```
  Each model:
  ```
  { id, name, family?, attachment?, reasoning?, tool_call?, temperature?,
    open_weights?,
    cost: { input, output, cache_read?, cache_write?, input_audio?, output_audio? },  // USD / 1M tokens
    limit: { context, output },
    modalities: { input: [..], output: [..] } }
  ```
- **Coverage:** 75+ providers (research recap from the founder cited "137 providers / ~5000 models" — models.dev keeps growing; treat counts as "thousands of models"). The earlier number is consistent with continued growth.
- **Sync mapping** (matches the 30-05 spec exactly): `npm→npm_adapter`, `api→api_base`, `env→env_keys`, `cost.input/output→cost_in/cost_out`, `limit.context/output→ctx/max_out`, `tool_call→tool_call`, `reasoning→reasoning`, `modalities→modalities_in/out`. The `attachment` flag (file/image input) is an extra signal we can fold into `modalities_in` gating.
- **Cadence:** the registry updates whenever providers add models (community PRs to the TOML). A **daily** pull is more than enough; the file is static and cache-friendly. Stale-mark, never hard-delete (agents may reference a model that disappeared).
- **Size:** a single multi-thousand-model JSON; the 30-05 spec's "~2 MB" estimate is the right order of magnitude. Streaming-parse not required; a daily `fetch().json()` in the worker is fine.

### 2.3 BYOK security patterns

Industry consensus for an aggregator storing user provider keys:

- **Encrypt at rest with AES-256-GCM** (authenticated encryption) — exactly what AIAG already has in `crypto.ts`. Keys decrypt **in-memory just before the upstream request**, never logged, never returned by any GET (only a `***abcd` hint). AIAG's existing pattern already does this.
- **Envelope encryption (the upgrade path):** per-record DEK wrapped by a master KEK; master key unwrapped once at process start and held in memory (no per-request KMS call). AIAG today uses a single static key (`TMA_KEY_ENCRYPTION_KEY`) — acceptable for v1; envelope/KMS is a later hardening, not an MVP blocker.
- **Key travels the wire once** (at registration); thereafter only the server-side ciphertext moves. AIAG's POST-once-store-ciphertext flow already matches.
- **SSRF for custom base URLs:** the must-haves are HTTPS-only, block private/loopback/link-local ranges, and block cloud metadata (`169.254.169.254`). AIAG's `validateExternalUrl()` covers all of these. One residual gap worth noting: **DNS-rebinding** (a public hostname that resolves to a private IP at fetch time) is not fully closed by a pre-flight string check — a belt-and-suspenders fix is to also validate the *resolved* IP at request time, or run agent egress through a fixed allowlist/proxy. Flag for hardening, not MVP.

### 2.4 x402 (HTTP 402 agent payments) — 2026 status

- **Maturity:** open-sourced by Coinbase (May 2025), donated to the **x402 Foundation under the Linux Foundation** (Apr 2, 2026). By late Apr 2026: ~69k active agents, ~165M transactions, ~$50M cumulative volume. Founding members include Google, Visa, Stripe, AWS, Mastercard, Circle, Microsoft, Shopify, Amex. **It is production-viable in 2026** for agent-to-API micropayments.
- **Facilitator concept:** a hosted service that does on-chain verify + settle so the resource server doesn't run a node. Flow: client hits resource → `402` with `accepts[]` (payment options) → client signs a USDC authorization → facilitator verifies/settles (Base/Solana) → resource served. Coinbase runs a fee-free hosted facilitator; Stripe also documents x402 support.
- **Aggregator angle:** AIAG could let agents **pay autonomously** for external paid tools/resources via x402 *outgoing* (the agent-worker does the 402→sign→retry handshake). This belongs on the **foreign agentic entity** (per the two-entity split), never the RF web card surface. AWS Bedrock AgentCore Payments (Preview, May 2026) shows the shape: wallet management + policy-based spend caps + audit trail.
- **AIAG recommendation:** keep x402 *reserved-only* exactly as the 30-05 spec does — `tools.rail='x402'` + `accepts`/`trust` jsonb columns present, dispatch wired with a `x402_outgoing_not_implemented` throw. Ship the **`key_broker` rail first** (we hold the key, meter, deduct credits). x402 outgoing becomes a real phase once a concrete paid x402 resource is worth integrating; the data model already absorbs it with zero migration.

---

## Part 3 — Concrete build plan (phased, file-level)

Fits the existing architecture: reuses gateway `upstreams`/`models`, the tg-miniapp `crypto.ts`/`external-agent.ts`, the static catalog generator, and the worker's `executeTool` cost path. **All new tables live in SQL migrations + raw `postgres-js`** (no Drizzle). **Migrations renumbered to start at `0026`** (0022–0025 are taken). Verification = VPS only.

### Phase ordering (value × risk)

```
P0  MVP  — apikey/custom_url BYOK provider picker on a SEEDED (not yet synced) catalog   [highest value, lowest risk]
P1       — models.dev catalog-sync job + metadata-gated UI                                [unlocks the full registry]
P2       — generalized resolveUpstream native adapters (Anthropic, Google)                [breadth of providers]
P3       — kind='aiag' through OUR gateway (white-label markup + billing closed)          [revenue correctness]
P4       — Tool Broker key_broker rail (Firecrawl)                                         [new revenue surface]
P5       — x402 outgoing (deferred; data model already ready)                              [future]
```

### P0 — MVP first slice (the smallest valuable thing to ship next)

**Goal:** an agent owner can connect **their own key** (BYO OpenAI/OpenRouter/any OpenAI-compatible URL) per agent, picking from a small **seeded** provider list — *without* waiting on the full models.dev sync. This is ~70% of "подключение провайдеров" value and reuses everything that already exists.

Why this is the MVP: the binary `external_openai` path already works end-to-end (encrypt, store, decrypt, call, SSRF-guard). P0 just (a) splits the single credential into a real `agent_provider_credentials` row, (b) introduces a tiny seeded `providers` table (5–8 rows: openai, anthropic-via-openrouter, openrouter, google, deepseek, custom), and (c) turns the binary checkbox into a kind→provider→key picker. No sync job, no native adapters yet (everything routes through the existing generic OpenAI `chat/completions` path, which already covers openai/openrouter/custom_url).

- **DB** `packages/database/migrations/0026_provider_picker_core.sql`:
  - `providers` (id, name, npm_adapter, api_base, env_keys, enabled, markup, synced_at) — **seed 5–8 rows manually** (openai `https://api.openai.com/v1`, openrouter, google, deepseek, plus a `custom` sentinel).
  - `agent_provider_credentials` (id, agent_id, provider_id, kind, encrypted_key BYTEA, key_hint, base_url, created_at) with the two CHECKs from the 30-05 spec.
  - `ALTER TABLE agents ADD provider_id, model_id, auth_ref, base_url_override`.
- **API** (tg-miniapp):
  - `app/api/tma/providers/route.ts` (**create**) — `GET` enabled providers (from the seed).
  - `app/api/tma/agents/route.ts` (**edit**) — accept `provider_id`, `model_id`, `connection_kind`, `api_key`, `base_url_override`; on non-aiag kind: `encryptSecret(api_key)` → insert credential → set `agents.auth_ref`. Return `key_hint` only.
  - `app/api/tma/agents/[id]/route.ts` (**edit PATCH**) — add the same credential write path (closes the "can't edit connection" gap).
  - Reuse `validateExternalUrl()` for `custom_url`; reuse the existing `test-external` probe.
- **Worker** (agent-worker):
  - `src/db.ts` (**edit**) — extend `AgentRow` with `provider_id/model_id/auth_ref/base_url_override`; add `loadProvider(id)` + `loadCredential(authRef)`.
  - `src/agent-runner.ts` (**edit**) — `resolveUpstream()` gains a provider/credential branch (generic OpenAI only); **back-compat**: `provider_id IS NULL` ⇒ existing aiag/external_openai logic untouched.
- **UI** (tg-miniapp):
  - `app/agents/new/page.tsx` + `app/agents/[id]/page.tsx` (**edit**) — replace "Свой агент" checkbox with a Connection section (kind segmented control → provider dropdown → model free-text/dropdown → key input). `src/lib/providers.ts` (**create**) typed client.
- **Parallelizable:** the migration + worker changes are independent of the UI; API and UI can be built against a stubbed provider list. Native adapters and sync are explicitly out.
- **MVP acceptance (VPS):** create an agent with a BYO OpenAI key → it runs via the generic path, `agent_provider_credentials` holds an AES-GCM blob, GET never returns the key, legacy `external_openai` agents still run, and an existing agent's connection can now be edited.

### P1 — models.dev catalog-sync + metadata-gated UI

- **DB** `0027_models_catalog.sql`: `models_catalog` (per the 30-05 spec) + index on `(provider_id, tool_call)`; widen `providers` upsert columns. `0028_seed_disable_banned_providers.sql`: `UPDATE providers SET enabled=false` for oauth/subscription-only providers.
- **Worker** `src/catalog-sync.ts` (**create**) — daily `fetch(models.dev/api.json)` → upsert providers + models_catalog, stale-mark, **never touch ops-owned `enabled`/`markup`**. `src/index.ts` (**edit**) — register a `catalog-sync` BullMQ repeatable job (`pattern: '0 4 * * *'`) + a second Worker (in-process, D#13-compliant).
- **API** `app/api/tma/providers/[id]/models/route.ts` (**create**) — `GET` `status='live'` models for a provider.
- **UI** (**edit**) — model dropdown populated from the catalog; **gate tool toggles on `tool_call`**, vision affordances on `modalities_in includes 'image'`.
- **Parallelizable:** sync job (worker) and the catalog read API/UI are independent; can run in two parallel tracks once `0027` lands.

### P2 — Generalized native adapters (Anthropic, Google)

- **Worker** `src/adapters/{openai,anthropic,google}.ts` (**create**) — request/response builders selected by `provider.npm_adapter`. Generic OpenAI is the default (already works); Anthropic Messages (`/v1/messages`, `x-api-key`, `anthropic-version`) + Google `:generateContent` as native branches; Bedrock/Azure throw `provider_not_supported_yet`. `src/agent-runner.ts` (**edit**) — dispatch in `callModel()`. Cost sourced from `models_catalog.cost_in/out` with the `PRICING`-map fallback.
- **Parallelizable per adapter** (each adapter is an isolated file with its own request shape).

### P3 — `kind='aiag'` through OUR gateway (white-label + billing)

- **Worker** `resolveUpstream()` for `kind='aiag'` targets `http://127.0.0.1:4000/v1/chat/completions` with `AIAG_GATEWAY_KEY` (a gateway api-key), so aiag agents get our markup + `gateway_transactions` billing + white-label, instead of hitting OpenRouter directly. **Behavioral change — verify carefully on VPS.** Apply `provider.markup` for cost accounting.
- **Risk note:** today aiag agents work via OpenRouter directly; this rewires them. Ship behind a feature check; keep the OpenRouter path as fallback if the gateway model isn't present.

### P4 — Tool Broker (key_broker rail, Firecrawl)

- **DB** `0029_tool_broker.sql`: `tools` (x402-superset shape) + `tool_calls` ledger + Firecrawl seed rows (`firecrawl_scrape`, `firecrawl_search`, `rail='key_broker'`).
- **Worker** `src/broker.ts` (**create**, in-process, injects `FIRECRAWL_API_KEY`; `rail='x402'`⇒throw stub). `src/billing.ts` (**create/edit**) — `atomicDeduct(uid,cost)` / `refund` / `recordToolCall` keyed off the **existing** billing balance ledger (confirm the exact table in `packages/billing` / `gateway_transactions`; do not invent a new balance table). `src/tools.ts` (**edit**) — DB-driven tool defs, broker fallthrough in `executeTool` (returns `{result, cost_rub:user_price_credits}`, plugging into the existing `agent-runner.ts:274` accumulation), union in `pickToolDefs`.
- **Ops:** add `FIRECRAWL_API_KEY` to `/srv/aiag/shared/.env`.

### P5 — x402 outgoing (deferred)

Data model already carries `rail='x402'` + `accepts`/`trust`. When a concrete paid x402 resource is worth it, implement the 402→sign→retry handshake in `broker.call()` behind the existing stub. No migration needed. Lives on the agentic entity only.

### Cross-cutting

- **Migration order:** `0026` (P0) → `0027`/`0028` (P1) → `0029` (P4). P2/P3 are code-only (no migrations). **Renumbered from the 30-05 spec** because 0022–0025 are taken.
- **Crypto/SSRF reuse:** all key encryption via the existing `encryptSecret/decryptSecret/hintFromSecret`; all custom-URL validation via `validateExternalUrl()`. No new crypto. DNS-rebinding hardening = later.
- **White-label preserved:** only `kind='aiag'` (P3) routes through our gateway with hidden upstream names + markup; BYO kinds are the user's own provider (cost 0, names are the user's concern).
- **No Drizzle churn; verify on VPS only.**

---

## Appendix — sources

- OpenCode providers/config: https://opencode.ai/docs/providers/ , https://deepwiki.com/sst/opencode/3.3-provider-and-model-configuration
- models.dev API: https://deepwiki.com/anomalyco/models.dev/7.1-json-api-endpoint , https://github.com/anomalyco/models.dev , https://opencode.ai/docs/models/
- BYOK encryption: https://shortcut.ai/enterprise/byok , https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/ , https://databunker.org/use-case/bring-your-own-key-encryption/
- x402: https://www.x402.org/ , https://aws.amazon.com/blogs/industries/x402-and-agentic-commerce-redefining-autonomous-payments-in-financial-services/ , https://docs.stripe.com/payments/machine/x402 , https://www.alchemy.com/blog/how-x402-brings-real-time-crypto-payments-to-the-web
