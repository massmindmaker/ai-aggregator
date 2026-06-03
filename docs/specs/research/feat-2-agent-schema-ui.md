# Feat-2 — Agent data model, TMA create/edit UI, and provider-connection backend (read-only investigation)

Date: 2026-06-03. Scope: map what an agent stores, what is ALREADY built for provider/BYOK connection, and where a provider-picker / skills / MCP attach UI would slot into the create/edit flow. All claims are file:line-cited from the working tree on branch `plan/15.1-r0-billing-identity` (NOT yet on prod — prod migrations are manual/untracked, so "applied" below means "the migration file exists and the worker/route code expects it", not "verified live on the VPS").

---

## 1) What does an agent store?

The `agents` table is the single config record. It has grown across 4 migrations; nothing is normalized out into a separate "spec" — an agent is one flat row.

Base shape — `packages/database/migrations/0018_agents.sql:4-17`:
- `id` UUID, `tg_user_id` BIGINT (owner), `template_kind` VARCHAR(40) (which starter template), `name`, `description`, `status` (`active`/`deleted`).
- **Persona:** `system_prompt` TEXT NOT NULL. There is NO separate `SOUL.md`, persona table, image/voice/vision model split, knowledge, or cron — the product canon's "composable SPEC" is, today, just a system prompt + one chat model. (`0018:10`)
- **Model:** `model_slug` TEXT — a single OpenRouter-style slug (e.g. `anthropic/claude-3.5-sonnet`). One model only; no separate chat/image/voice/vision models. (`0018:12`)
- **Tools:** `tools` JSONB array of string ids, default `[]`. (`0018:11`) The allowed set is hardcoded in the UI to 4 worker-implemented tools (`web_search`, `calc`, `image_gen`, `memory` — `apps/tg-miniapp/app/agents/new/page.tsx:11-16`), matching `apps/agent-worker/src/tools.ts`. No skills, no MCP servers, no tool broker — those columns/tables do not exist.
- **Budget:** `budget_rub_monthly` NUMERIC(12,2) default 1000 (`0018:13`); a daily-budget guard column was added in `0020_agents_daily_budget.sql`. Note: still named/denominated in **₽** even though TMA is supposed to be crypto-credits (unit migration pending — see `/CLAUDE.md`).
- **Runs:** separate `agent_runs` table (`0018:21-35`) — input/output/status/`cost_rub`/tokens. This is the conversation history + per-run billing ledger.
- **Memory:** `0023_agent_memory.sql` adds an `agent_memory` k/v store (read by the worker's `memory` tool).

**Connection / provider config — two parallel column sets co-exist on `agents`:**

A. Legacy "external OpenAI-compatible endpoint" (Path 1, BYO full endpoint) — `0021_agents_external_connection.sql:5-9`, constraint fixed in `0022`:
- `connection_type` VARCHAR(20) default `'aiag'`; CHECK now allows `('aiag','external_openai')` (`0022:12-13` — note 0021 originally wrote `'external'`, a bug that 0022 fixes to match the code's `'external_openai'`).
- `external_base_url`, `external_api_key_encrypted`, `external_api_key_hint` (populated in route.ts), `external_model_slug`.

B. NEW provider-catalog path (migration 0026, the P0 "provider-picker" foundation) — `0026_provider_catalog.sql`:
- New table `providers` (catalog, 8 seeded: openai/anthropic/google/deepseek/mistral/groq/openrouter/custom; all `api_key` auth, OpenAI-compatible) — `0026:31-55`.
- New table `agent_provider_credentials` (per-agent encrypted BYO key: `enc_key` AES-256-GCM base64, `key_hint`, `base_url`, `model_id`, `UNIQUE(agent_id)` = one connection per agent) — `0026:65-77`.
- 4 new nullable columns on `agents`: `provider_id` (FK→providers), `model_id`, `auth_ref` (soft FK→agent_provider_credentials.id), `base_url_override` — `0026:89-93`. The discriminator is **`provider_id IS NOT NULL ⇒ new catalog path`** (`0026:84`, `apps/agent-worker/src/db.ts:27-28`).

So an agent stores: owner, template, persona (system prompt), ONE chat model slug, a tools-id array, a ₽ budget, status, and ONE of three mutually-exclusive routing configs (aiag-gateway / legacy external endpoint / new provider-catalog credential).

---

## 2) What is ALREADY built for connecting a provider / BYOK?

**Migration 0026 — code-expected, additive-only.** It creates `providers` + `agent_provider_credentials` + the 4 agent columns, idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, seed `ON CONFLICT DO NOTHING`). Whether it's physically applied on prod is unverifiable from the repo (manual/untracked migrations per `packages/database/CLAUDE.md`); treat "applied" as a deploy checklist item, not a given.

**`GET /api/providers` — BUILT, but in the WRONG product.** It exists at `apps/web/src/app/api/providers/route.ts:30-58` — that is **apps/web (the RUBLE aggregator on ai-aggregator.ru), NOT the TMA.** It returns the enabled provider catalog (`SELECT id,name,api_base,auth_kind,requires_base_url FROM providers WHERE enabled ORDER BY sort`), read-only, no auth. **There is NO `/api/providers` route under `apps/tg-miniapp`** (confirmed: `apps/tg-miniapp/app/api/tma/` contains only agents/auth/marketplace/nft/topup/wallet — no providers dir). The TMA UI does not call it anywhere. So the catalog endpoint is reachable from the web app but is NOT wired into the TMA, which is where the provider picker actually needs it.

**BYOK write route to store a provider credential — DOES NOT EXIST.** Nothing inserts into `agent_provider_credentials`. Grep across `apps/` finds the table referenced in exactly ONE file — `apps/agent-worker/src/db.ts` — and only as a READ (`SELECT … FROM agent_provider_credentials c JOIN providers p`, `db.ts:101-119`). The TMA create route (`apps/tg-miniapp/app/api/tma/agents/route.ts`) and edit route (`.../agents/[id]/route.ts`) write ONLY the legacy `external_*` columns (`route.ts:105-131`) and NEVER set `provider_id`/`auth_ref`/`model_id`/`base_url_override` (confirmed: zero matches for those columns in either route file). So an agent can never be created on the new provider-catalog path through the UI today — the discriminator column is never populated.

**Does the worker read it? — YES, fully.** `resolveUpstream` (`apps/agent-worker/src/agent-runner.ts:57-110`) already implements all three branches, most-specific-first:
1. `if (agent.provider_id)` → `loadProviderCredential(agent.auth_ref)` → decrypt `enc_key` → route to provider base+`/chat/completions`, model = `agent.model_id ?? cred.model_id ?? DEFAULT_MODEL`, **`isExternal:false` (billable through us)** — `agent-runner.ts:61-73`.
2. `else if connection_type==='external_openai'` → legacy endpoint, **`isExternal:true` (zero charge)** — `:75-88`.
3. `else` → aiag `:4000` gateway (markup), with OpenRouter direct fallback if `AIAG_GATEWAY_KEY` unset — `:90-109`.
The credential loader (`db.ts:98-130`) JOINs provider catalog and returns the ciphertext as a Buffer (base64-decoded, decrypt deferred to resolveUpstream). The agent SELECT already pulls `provider_id` (and the 0026 columns) — `db.ts:58-72`.

**Cross-check of the memory claim "provider P0 remaining = BYOK-write + worker resolveUpstream + TMA UI":**
- BYOK-write: **CORRECT — still missing.** No route inserts `agent_provider_credentials`.
- worker resolveUpstream: **STALE/INCORRECT — already BUILT.** The provider-picker branch (R0-6) is fully implemented in `agent-runner.ts:61-73` + `db.ts:98-130`. This is the one item the memory lists as remaining that is actually done. (The R0 execution memory is newer and consistent with this; the older provider-P0 memory note is the stale one.)
- TMA UI: **CORRECT — still missing.** The UI has no provider picker and no `/api/providers` call.
- Additional gap the claim omits: **`GET /api/providers` is only in apps/web, not in the TMA** — the TMA needs its own (TMA-authed) providers endpoint or a cross-call, plus the create/edit route must learn to write the 0026 columns.

Net: the **read side (worker) is done**; the **write side (a TMA route that creates the credential + sets `agent.provider_id/auth_ref/model_id`) and the TMA-side catalog endpoint + picker UI are the real remaining P0 work.** Plus migration 0026 must be confirmed applied on prod.

---

## 3) How the create/edit UI adds tools/model today, and where a provider-picker / skills / MCP attach UI would slot in

**Create flow** — `apps/tg-miniapp/app/agents/new/page.tsx`:
- Step 1: pick a template card (`AGENT_TEMPLATES`, `:180-198`).
- Step 2: a single flat form with these controls, in order (`:210-441`):
  - **Имя** (name) — `:214-224`.
  - **System prompt** textarea — `:226-236`.
  - **Модель (slug OpenRouter)** — a free-text input, NOT a picker; user types a slug — `:238-247`. (A model slug can also be handed off via `localStorage 'aiag_selected_model_slug'` from the marketplace — `:97-107`.)
  - **Инструменты** (tools) — 4 hardcoded checkboxes — `:249-292`.
  - **Бюджет ₽/мес** — `:295-311`.
  - **🌐 Свой агент (URL + ключ)** — the existing BYO block: a checkbox that reveals URL / API key / optional model inputs + a "Проверить соединение" button hitting `POST /tg/api/tma/agents/test-external` (`:43-81`, block at `:313-419`). On submit it sends `connection_type:'external_openai'` + `external_*` fields (`:128-132`). **This is the legacy Path-1 block — it is exactly where a provider-CATALOG picker would replace/augment the free-form URL+key.**
- Submit → `POST /tg/api/tma/agents` (`:115-134`).

**Edit flow** — `apps/tg-miniapp/app/agents/[id]/page.tsx`: inline edit mode (`startEdit` `:65-75`) exposes the SAME subset — name, description, system_prompt, model_slug (free text), tools (4 checkboxes), budget — and PATCHes `/tg/api/tma/agents/[id]` (`:77-111`). It does NOT expose any connection/provider fields at all (the external-agent block is create-only).

**Where a provider-picker would slot in:** replace/extend the "🌐 Свой агент" block (`new/page.tsx:313-419`). Concretely: fetch the catalog from a TMA `GET /api/providers` (to be added) → render a provider `<select>` (OpenAI/Anthropic/…/Custom). Selecting a provider whose `requires_base_url=true` ('custom') reveals the URL field; all show an API-key field + a model field (free text or a per-provider model list). On submit, send `provider_id` + `model_id` (+ `base_url` for custom) + the raw key to a write route that (a) `encryptSecret(key).toString('base64')`, (b) INSERTs `agent_provider_credentials`, (c) sets `agents.provider_id/auth_ref/model_id`. This mirrors the existing `test-external` + encrypt pattern already used for the legacy path (`route.ts:97-102` uses `encryptSecret`/`hintFromSecret` + `validateExternalUrl`). The DESIGN.md "Provider picker" component (AIAG / OpenRouter / BYOK / Gonka / Custom rows, "свой = 0 комиссии") is the intended visual.

**Where skills / MCP attach UI would slot in:** there is NO backend for these (no columns, no tables, no worker support — `tools` JSONB is the only extensibility point, and it is a closed list of 4). A skills/MCP attach UI would be **new construction**, not a wiring task: it would visually sit as additional sections in the same create/edit form (after Tools), but each needs (1) a schema (e.g. `agent_skills` / `agent_mcp_servers` tables or extend `tools` JSONB shape), (2) worker runtime support in `agent-runner.ts`/`tools.ts`, and (3) the picker UI. Per `/CLAUDE.md` reality table, MCP servers / skills hub are R&D and must be labelled `скоро/R&D`, not shown as working.

---

## Quick reference (file:line)
- Agent schema: `packages/database/migrations/0018_agents.sql:4-38` (base) · `0020_agents_daily_budget.sql` (daily budget) · `0021_agents_external_connection.sql:5-19` + `0022_agents_connection_type_fix.sql:9-14` (legacy external) · `0023_agent_memory.sql` (memory) · `0026_provider_catalog.sql:31-93` (provider catalog + creds + 4 agent cols).
- Worker read path (DONE): `apps/agent-worker/src/agent-runner.ts:57-110` (resolveUpstream, 3 branches) · `apps/agent-worker/src/db.ts:58-72` (agent SELECT incl. provider_id) · `db.ts:98-130` (loadProviderCredential).
- Catalog endpoint (web only): `apps/web/src/app/api/providers/route.ts:30-58`. NO equivalent in tg-miniapp.
- TMA create route (writes legacy external_* only, never 0026 cols): `apps/tg-miniapp/app/api/tma/agents/route.ts:59-134`.
- TMA edit route (no connection fields): `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:82-130`.
- Create UI (model=free text, 4 tool checkboxes, legacy external block): `apps/tg-miniapp/app/agents/new/page.tsx:11-16, 238-247, 249-292, 313-419`.
- Edit UI: `apps/tg-miniapp/app/agents/[id]/page.tsx:65-111`.
