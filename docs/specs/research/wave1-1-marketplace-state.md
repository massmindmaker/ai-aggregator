# Wave 1.1 — TMA marketplace / templates / cloning: state of the code (read-only audit)

**Date:** 2026-06-04 · **Scope:** what EXISTS today for templates, cloning, and the two-sided
agent marketplace in the TMA (`apps/tg-miniapp` + `apps/agent-worker`). Product terms + file:line.
**TL;DR:** there is **no** publish-template / clone-agent / author-rent mechanism in TMA today.
Templates are 6 hardcoded TypeScript objects; `/market` is a read-only **model** catalog. The
two-sided market (publish / clone / rent / author-income) is fully wireframed but unbuilt.

---

## (1) Is there ANY publish-template or clone-agent mechanism today?

**NO.** Evidence:

- **Templates are hardcoded, not user data.** `apps/tg-miniapp/src/lib/agent-templates.ts:14`
  is a static `AGENT_TEMPLATES: AgentTemplate[]` of **6** entries (writer / coder / analyst /
  researcher / marketer / personal). A template = `{kind, emoji, name, description, systemPrompt,
  suggestedTools, defaultModelSlug}` (`:4`). They exist only to **pre-fill** the create form;
  there is no templates table, no author, no price, no DB row.
- **Create reads templates, never writes them.** `app/api/tma/agents/route.ts:77` calls
  `getTemplate(templateKind)` purely to default `name/description/systemPrompt/tools/modelSlug`
  (`:79-86`), then `INSERT INTO agents` (`:165`). No "publish" endpoint, no `is_public` write.
- **Edit (`PATCH`) and `DELETE` have no clone/publish branch.** `app/api/tma/agents/[id]/route.ts`
  exposes only `GET` / `PATCH` (`:108`) / `DELETE` (`:241`). `PATCH` edits the owner's own agent
  in place (name, prompt, model, tools, budget, connection, MCP). Nothing forks or publishes.
- **The only "Clone" affordance is a disabled wireframe chip.** In the wireframes (`s05`,
  `docs/wireframes/tma/index.html:463`) the clone button carries a `скоро` (soon) chip; the
  inline note at `:459` says verbatim: *«Клонировать» — скоро*. No clone route exists in code.
- **Grep is clean.** `publish|clone|remix|is_public|template_id|author_id|fork` across
  `apps/tg-miniapp` matches **only** `market/page.tsx` + `api/tma/marketplace/route.ts`, and
  there it is the SQL `status IN ('live','active','published')` **model** filter
  (`app/market/page.tsx:27`) — unrelated to template publishing.
- **What `/market` actually is:** a **MODEL catalog**, NOT an agent/template marketplace.
  `app/market/page.tsx:18` `getModels()` selects from the `models` table; the detail page
  `app/market/[slug]/page.tsx:21` shows one model; `UseInAgentButton.tsx:11` just stashes
  `aiag_selected_model_slug` in `localStorage` and routes to `/agents/new` (consumed at
  `app/agents/new/page.tsx:108-118`). So the live "marketplace" is **model discovery →
  pre-fill the model slug of a NEW agent**, not cloning someone else's agent.
- **No public/discovery list of others' agents.** `GET /api/tma/agents` (`route.ts:31`) is
  hard-scoped `WHERE tg_user_id = ${tgUserId}` — a user only ever sees **their own** agents.
  There is no "for you" feed, no public author catalog (wireframe `s03` note confirms: only
  «Мои» is live).

### Adjacent precedent that is NOT this (do not reuse as-is)

`packages/database/migrations/0014_contest_marketplace.sql` DOES implement an author-publish /
author-earnings system — **but for the WEB aggregator (`apps/web`, rubles), publishing MODELS,
not TMA agent templates.** It adds `models.author_user_id` (`:58`), `models.status`
lifecycle `draft|…|live|…|depublished` (`:71`), `published_model_id` (`:34`), and an
`author_earnings` accrual table keyed to `users(id)` (UUID). The TMA agent world is keyed to
**`tg_user_id BIGINT`** and has no `users(id)` link. So this is the author-rent pattern living
on the **wrong side of the two-product split** — useful as a reference for accrual mechanics,
but it cannot be pointed at `agents` without a new TMA-side schema.

---

## (2) Agent state: what a template would SHARE (spec) vs KEEP PRIVATE

The `agents` row is the agent. Columns (migrations `0018` base, `0020-0028` additive):

| Column | Source | Publish? (per wireframe s35) |
|---|---|---|
| `template_kind` | `0018_agents.sql:7` | share — categorization |
| `name`, `description` | `0018:8-9` | share |
| `system_prompt` | `0018:10` | **share** — persona/prompt (s35 «Персона + промпт ✓») |
| `tools` (JSONB) | `0018:11` | **share** — skill/tool defs (s35 «Скиллы + тулзы + MCP-дефы ✓») |
| `model_slug` | `0018:12` | **share** — model *name* only (s35 «Модели (имена) ✓») |
| `budget_rub_monthly` | `0018:13` | owner default; not part of shared spec |
| `connection_type` | `0021:6` | share the *type* (aiag vs external), never the key |
| `external_base_url` | `0021:7` | borderline — a custom URL may be private infra |
| `external_api_key_encrypted` | `0021:8` | **PRIVATE** — AES-GCM secret (s35 «Ключи / токены 🔒») |
| `external_api_key_hint` | `0027` | private (only last-4 shown to owner) |
| `external_model_slug` | `0021:9` | share (a model name) |
| `mcp_endpoint_url` | `0028:17` | share the *def* (s35 «MCP-дефы ✓»); a private URL stays private |
| `mcp_auth_encrypted` | `0028:18` | **PRIVATE** — AES-GCM auth header (s35 «токены 🔒») |

**Private, and NOT on the `agents` row (separate tables / runtime):**
- **Memory** — `agent_memory(agent_id, key, value)` (`0023_agent_memory.sql:6`). Per-agent KV
  facts. s35 marks «Память, знания, история 🔒».
- **History / conversation** — `agent_runs` (`0018:21`): `input`, `output`, `cost_rub`, tokens,
  status. Per-agent run log; private.
- **Secrets are decrypted only at run time** in the worker: `agent-runner.ts:88`
  `decryptSecret(agent.external_api_key_encrypted)` and `:440` for the MCP auth header — they are
  never returned by the API (`[id]/route.ts:54` returns only the derived boolean `mcp_auth_set`,
  `:29` returns `external_api_key_hint`, never the ciphertext).

**This maps cleanly onto the canon "share spec, keep keys/memory/data/history private" rule**
(see `/CLAUDE.md` templates section). A "spec" = the share-column subset above (persona, prompt,
tools, model names, connection *type*, MCP *def*); a "publish" must strip every `*_encrypted`
column and never touch `agent_memory` / `agent_runs`.

---

## (3) Which screens are wireframed for publish / clone / rent / author-income?

All in `docs/wireframes/tma/index.html`, group **I · Двусторонний рынок** — all tagged
`скоро` (soon), i.e. target-view, not live:

- **s34 · Профиль автора + доход** (`:1086`). Author profile: «N шаблонов · ★», stat cards
  **арендаторов / клоны / доход** (all labeled `демо`), per-template rent rows
  («50 кр/мес · 62», or «бесплатно»), and the monetization rule spelled out verbatim (`:1103`):
  *«Ты получаешь ровно назначенную сумму аренды. AIAG зарабатывает на моделях/тулзах/деплое,
  а не на твоей цене — процента нет.»* CTA **«Вывести доход → баланс»**. Matches founder
  decision #7 (author-rent, 0% commission).
- **s35 · Опубликовать шаблон** (`:1112`). The publish sheet. Two explicit lists:
  **публично** = Персона+промпт / Модели(имена) / Скиллы+тулзы+MCP-дефы (✓);
  **приватно** = Ключи/токены / Память,знания,история (🔒). Access toggle
  **«Бесплатно» | «Назначить цену»** (`:1128`), price field «50 кр» × «в месяц» (`:1133`),
  note «Аренда / мес или за деплой. Получаешь ровно эту сумму — AIAG не берёт процент.»
  This screen is the exact contract for the share/private split above.
- **s36 · Ремикс / lineage** (`:1144`). Clone-with-changes. Shows origin attribution
  («оригинал от @ainews»), fork/remix counters (`демо`), inherited chips
  (персона / модель / скиллы / тулзы), a "what you change" field, and a **lineage** promise
  («оригиналу атрибуция, тебе — твой ремикс»). CTA **«Создать ремикс»**.
- **s05 · Карточка агента + RUN** (`:444`, tagged `live` for RUN). The discovery/run card that
  WOULD host clone: a `⎘ Клонировать` ghost button exists but carries `скоро` (`:463`); the note
  (`:459`) states clone is not built and there are no ★-review / run-count tables (those numbers
  are `демо`).
- **s14 · Из шаблона (галерея)** (`:685`, tagged `live`). The template gallery — but the note
  (`:690`) is explicit: these are the **built-in** `lib/agent-templates`, **NOT** a published
  author market; "авторских хэндлов и клонов чужих шаблонов пока нет".
- Supporting: **s03** home feed («Для тебя» is `скоро`, only «Мои» live, `:301`); **s37 Профиль**
  has a live row «Мои шаблоны / доход ›» (`:1172`) that currently has no backing screen/data.

So the entire two-sided loop — **publish (s35) → discover (s03/s05) → clone/remix (s05/s36) →
author income (s34)** — is designed and consistent with the founder author-rent decision, and
**none of it is implemented**.

---

## (4) Cleanest place in existing code to add a templates table + publish/clone routes

The current code is small, additive-migration-friendly, and already isolates secrets — so the
minimal, lowest-risk shape is:

**Schema (new migration, e.g. `0031_agent_templates.sql`).** Follow the project's additive,
`tg_user_id BIGINT` convention (NOT `users(id)` — that's the web side). One table:

```
agent_templates (
  id UUID PK,
  author_tg_user_id BIGINT NOT NULL,     -- matches agents.tg_user_id
  source_agent_id UUID NULL,             -- provenance (the agent it was published from)
  parent_template_id UUID NULL,          -- s36 lineage / remix chain
  name, description, system_prompt TEXT,
  tools JSONB, model_slug TEXT,
  connection_type VARCHAR,               -- TYPE only, never the key
  mcp_endpoint_url TEXT NULL,            -- def only; founder may choose to omit private URLs
  price_credits NUMERIC DEFAULT 0,       -- 0 = free; else author-rent (s35)
  rent_period VARCHAR NULL,              -- 'month' | 'deploy'
  status VARCHAR DEFAULT 'draft',        -- draft | published | depublished
  clone_count INT DEFAULT 0, created_at, updated_at
)
```
Deliberately **no** `*_encrypted` / `*_hint` columns and **no** FK to `agent_memory` /
`agent_runs` — that enforces the share/private split at the schema level (point 2). Note the DB
CLAUDE.md warning: prod migrations are **manual + untracked** and DDL needs
`sudo -u postgres psql aiag`.

**Routes (mirror the existing agents routes exactly — same auth header, same `postgres`
client, same SSRF/crypto helpers already imported):**

1. **Publish** → `app/api/tma/agents/[id]/publish/route.ts` (`POST`). Reuse the `loadAgent(id,
   tgUserId)` ownership guard already in `[id]/route.ts:46`, then copy the **share-subset**
   columns into `agent_templates`, **explicitly dropping** `external_api_key_encrypted` /
   `external_api_key_hint` / `mcp_auth_encrypted`. Set `price_credits` / `rent_period` / `status`
   from the body (s35). This is the natural sibling of the existing `PATCH`/`DELETE` in that file.
2. **Public template catalog** → `app/api/tma/templates/route.ts` (`GET`) +
   `app/api/tma/templates/[id]/route.ts` (`GET`). Mirror `app/api/tma/marketplace/route.ts`
   (it already does the read-only `WHERE status IN (...)` shape) but over `agent_templates`.
   This is what the `s14` gallery and `s03` "Для тебя" feed should consume instead of the
   hardcoded `AGENT_TEMPLATES`.
3. **Clone / remix** → `app/api/tma/templates/[id]/clone/route.ts` (`POST`). The inverse of
   publish: `SELECT` the template, `INSERT INTO agents` for the **caller's** `tg_user_id`
   (set `parent_template_id` for lineage, leave all `*_encrypted` NULL so the cloner supplies
   their own key via the existing BYOK edit flow), `clone_count = clone_count + 1`. This reuses
   the **same INSERT shape** already in `app/api/tma/agents/route.ts:165`.

**Why here:** every needed primitive already exists and is colocated —
`loadAgent` ownership guard + `postgres` client + `encryptSecret`/`hintFromSecret` +
`validateExternalUrl` (all imported in the two agents route files), the additive-migration
pattern (`0021`/`0028`), and the read-only catalog pattern (`marketplace/route.ts`). Publish/
clone touch **zero** money-path code in `agent-worker` — they only move spec columns between
`agents` and a new `agent_templates` table. **Author-rent billing (debit cloner, accrue to
author, withdraw — s34/s35) is a separate, later money-path slice**, not part of this table +
routes step; it would need its own ledger work coordinated with `tg_user_balances` (which is
itself mid-migration ₽→credit per the TMA CLAUDE.md).

---

### File index (load-bearing)
- `apps/tg-miniapp/src/lib/agent-templates.ts` — 6 hardcoded templates (the only "templates" today).
- `apps/tg-miniapp/app/api/tma/agents/route.ts` — `GET` (own agents only `:36`), `POST` create.
- `apps/tg-miniapp/app/api/tma/agents/[id]/route.ts` — `GET`/`PATCH`/`DELETE`; `loadAgent` guard `:46`.
- `apps/tg-miniapp/app/market/page.tsx` + `[slug]/page.tsx` + `UseInAgentButton.tsx` — MODEL catalog.
- `apps/tg-miniapp/app/api/tma/marketplace/route.ts` — read-only models list (catalog pattern to copy).
- `apps/tg-miniapp/app/agents/{page,new/page,[id]/page}.tsx` — agent UI (list/create/detail+edit).
- `apps/agent-worker/src/agent-runner.ts:88,440` — where `*_encrypted` is decrypted at run time only.
- `packages/database/migrations/0018,0021,0023,0027,0028` — agents schema (base + external + memory + hint + MCP).
- `packages/database/migrations/0014_contest_marketplace.sql` — WEB-side author-publish (MODELS, `users(id)`), NOT TMA.
- `docs/wireframes/tma/index.html` — s05 `:444`, s14 `:685`, s34 `:1086`, s35 `:1112`, s36 `:1144`.
