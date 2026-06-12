> 🔴 DEPRECATED (2026-06-13). Актуальный SoT = docs/canon/AIAG-CANON.md. Этот файл исторический; статусы not-built/deferred здесь УСТАРЕЛИ (MCP/author-rent/schedules/iNFT/provider-picker/cloneable = LIVE; managed-Hermes = курс-на-реальный). Не доверять статусам — сверять с каноном.

# TMA — User Workflows → Function → Readiness map (2026-06-03)

> ⚠️ **УСТАРЕЛО ЧАСТИЧНО (поправка 2026-06-12).** Этот документ помечает `NOT-BUILT` /
> `BRANCH` многое, что **с тех пор ПОСТРОЕНО**: templates marketplace + publish/clone/rent
> (author-rent), provider-picker e2e, MCP + OAuth, schedules, kanban (read-only),
> transfer/iNFT (Phase 16), серверный реконсилер пополнений, строгий ton-proof,
> D-1 ₽→USD-credits, DEFAULT_MODEL-фикс (gpt-4o-mini), call_agent (A2A). **Не доверять
> readiness-тегам ниже без сверки** с актуальной картой `docs/specs/2026-06-12-forensic-audit.md`
> (раздел «задумано vs реально vs забыто»). Реально ещё забыто/не построено: мультимодель
> per-role, run-trace ledger, AI-builder «из слов», предсказание цены до запуска, free-first-run.

**Purpose:** Enumerate EVERY AIAG-TMA user workflow and map each step, screen-by-screen, to the
exact Hermes/backend function it calls — and whether that function actually exists. So the design
matches functions exactly (no decorative buttons that imply capabilities the backend cannot do).

**Inputs:** `2026-06-02-tma-product-definition.md`, `2026-06-03-monetization.md`, research
`SYNTHESIS.md` + `R-02` (Hermes control-plane) + `R-04`/`R-09`/`R-10`, `CLAUDE.md`, and the boards
`docs/wireframes/tma/index.html` (38 artboards) + `docs/wireframes/showcase.html`.

**Grounding:** readiness was code-verified against `apps/tg-miniapp/app/api/tma/*`,
`apps/agent-worker/src/*`, and `packages/database/migrations/*`, not just docs.

## Legend (readiness)

| Tag | Meaning |
|---|---|
| **LIVE** | Built + on prod (R0 / Phase 15.1). Genuinely works today. |
| **BRANCH** | Schema or partial code exists (e.g. migration 0026 provider catalog, external-agent route) but the full path (worker resolve + UI) is NOT wired end-to-end. On `plan/15.1-r0-billing-identity`, not merged. |
| **NOT-BUILT** | No code/table. Wireframe-only. Needs our control-plane or new infra. |
| **HERMES-CANNOT** | The screen implies a Hermes capability that Hermes does NOT expose remotely (per R-02): no remote config REST API; config is file-write + `hermes gateway restart` on the host; we must build a co-located control-plane sidecar. |

**Hermes reality anchor (R-02):** Today there is NO Hermes runtime in the live path at all — the
"runner" is a stateless `BullMQ → OpenRouter/gateway` loop (`apps/agent-worker/src/agent-runner.ts`).
"Connect-your-own-Hermes" only treats a Hermes as an OpenAI-compatible URL (`/v1`). Managed Hermes
(provisioning, config, skills, MCP, cron dashboards) is R&D and **infra-blocked** (2 GB VPS). Hermes
has no `POST /api/model/set`-style remote API; its dashboard control-plane (~50 FastAPI endpoints) is
**loopback-only, no-auth**, so it is reachable ONLY by a sidecar we run inside the agent's isolation
boundary — which does not exist yet.

---

## Code-verified reality (the spine every row rests on)

| Capability | Reality (code) | Readiness |
|---|---|---|
| Telegram login + initData verify + 24h HS256 JWT | `app/api/tma/auth/verify/route.ts` + `src/lib/verify-init-data.ts` + `middleware.ts` (HS256 pinned, CVE header strip) | LIVE (but R1-3: `!==` non-constant-time compare + 24h replay window — D-8 fix pending) |
| Agent CRUD | `app/api/tma/agents/route.ts` + `[id]/route.ts` | LIVE |
| Agent spec fields accepted | `template_kind`, `name`, `system_prompt` (≤8000), `tools[]` (flat array), **single** `model_slug`, `budget_rub_monthly`, + external (`connection_type`, `external_base_url`, `external_api_key`, `external_model_slug`) | LIVE — **NO** per-model-role slots, **NO** per-model provider field, **NO** `SOUL.md` file, **NO** skills/MCP/cron/knowledge |
| Run an agent | `app/api/tma/agents/[id]/run/route.ts` → inserts `agent_runs` (pending) → BullMQ `agent-run` (202). Worker `runAgent()` does one OpenRouter/gateway loop, settles, DMs the user a card | LIVE — **async enqueue, NOT SSE-streamed to client**; no "first run free" logic; no run-trace ledger |
| Tools available in worker | `web_search` (DuckDuckGo HTML scrape — **free**, NOT paid Firecrawl), `calc` (free), `image_gen` (Kie nano-banana — paid), `memory` (Postgres KV) | LIVE (4 built-in; cost added into `totalCostRub`, guarded). **No tool broker, no Firecrawl, no per-tool catalog/registry, no x402** |
| Budget guard | monthly + daily, pre-run + mid-run + settle, atomic `UPDATE…WHERE…RETURNING` | LIVE (`db.ts` `getOrResetDailyBucket`/`settleRun`) |
| Billing unit | `tg_user_balances.balance_rub` (₽), `USD_TO_RUB=90` hardcoded; gateway path debits balance + markup; external/BYOK = 0 | LIVE but **₽, not USD-pegged credits** (D-1 migration pending); double-debit risk (gateway org + tg_user_balances) per R-04 |
| Top-up | `topup/init` builds a **native-TON** transfer (nano-TON, opcode-0 comment tag), `topup/check/[id]` client-poll watcher (last-20-tx, 10-min window) | LIVE — **TON-only**; NOT USDT-jetton, NOT USDC, NOT multi-crypto, NOT HOT-multichain; 4 funds-loss modes (R-04); no server reconciler cron |
| Wallet link | `wallet/link` (ton-proof **not yet verified**), `wallet` lists TON wallets + `balance_rub` | LIVE (link works; proof unverified) |
| Provider catalog / BYOK | migration 0026: `providers` (8 seeded), `agent_provider_credentials` (encrypted), `agents.provider_id/model_id/auth_ref/base_url_override` cols | BRANCH — schema exists; worker `resolveUpstream` for `provider_id` + TMA picker UI **not wired** end-to-end |
| Delivery to Telegram | `apps/agent-worker/src/bot-api.ts` raw `fetch` `sendMessage` from the single AIAG bot to the user's own `telegram_id` (a "run finished" card). Card still says ₽. | LIVE (DM card only) — **NO grammY, NO Telegram Business, NO per-user bot, NO business_connection** (R-10) |
| Templates marketplace | `marketplace/route.ts` returns **models only** (from `models` table). | **NOT-BUILT** as a template/author market — no `templates`/`publish`/`clone`/`lineage`/`author_earnings` tables or endpoints anywhere |
| Managed Hermes (provision/config/status/skills/MCP/cron) | none | NOT-BUILT + HERMES-CANNOT (infra-blocked, no control-plane) |

---

## JOURNEY 1 — Onboarding & login  →  readiness: **LIVE** (one security fix pending)

| # | Step (screen) | Backend / Hermes function called | Supported? | Readiness |
|---|---|---|---|---|
| 1.1 | Splash "Запусти AI-агента", `Начать` (s01) | none (client nav) | n/a | LIVE |
| 1.2 | Consent toggles 152-ФЗ + ToS, `Войти` (s02) | `WebApp.initData` → `POST /tma/auth/verify` → `verifyInitData()` → mint HS256 JWT (24h), cache in Telegram CloudStorage | YES (`verify-init-data.ts`) | LIVE — **flag:** `!==` compare is non-constant-time + 24h replay window; D-8 patch (`timingSafeEqual` + 600s + Redis nonce) pending |
| 1.3 | First-run home, 0 agents, `Запусти первого · бесплатно` (s03b) | `GET /tma/agents` (empty) → curated starter list | YES (list); **"первый прогон бесплатно" copy** | LIVE list — **MISMATCH:** no free-first-run code exists; the run always settles real cost. Either build a free-run grant or drop the "бесплатно" promise |
| **MISMATCH** | s02 shows the **152-ФЗ consent** as a live gate | Consent is UI-only; no PD-localization, no RF-infra split (RK-4, FD-3) | partial | LIVE as a checkbox; the legal substance it implies is NOT factored (founder-deferred) |

---

## JOURNEY 2 — Discover an agent, then run it  →  readiness: **LIVE** (streaming/tool-approve/run-trace are not)

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 2.1 | Home feed "Для тебя" / Каталог / Мои (s03/s04) | `GET /tma/agents` (Мои); "Для тебя"/Каталог feed = **no recommender/ranking code** | Мои: YES. Feed ranking: NO | Мои LIVE; **MISMATCH:** "Для тебя", ★rating, "48k запусков", catalog of *other authors'* agents imply a public agent directory + usage ranking that does not exist (only your own agents are listed) |
| 2.2 | Loading skeleton / empty-search (s04b) | client states over `GET /tma/agents` | YES | LIVE |
| 2.3 | Agent card + RUN, starter chips, "~6 кр/прогон", `Запустить бесплатно` (s05) | `POST /tma/agents/[id]/run` {input} → 202 + BullMQ | YES (run) | LIVE run — **MISMATCH:** "Запустить бесплатно"/"1-й прогон бесплатно" (no free-run code); ★4.9/312 отз. (no reviews table); `⎘ Клонировать` (no clone endpoint) |
| 2.4 | Chat composer-chip, model pill "Opus·AIAG ~12 кр · сменить" (s08) | `POST …/run` per message; model resolved by worker `resolveUpstream` | YES (send/run) | LIVE — **MISMATCH:** "сменить" model inline implies per-run model switch UI not built; cost shown pre-run is an estimate, real settle is post-run |
| 2.5 | "Агент думает" streaming trace, "−3 кр Firecrawl", `остановить ⏹` (s08b) | would need SSE token stream + live tool-cost events + run-cancel | **NO** | **MISMATCH (big):** run route is async-enqueue (202), worker does non-streaming `generateText`-style loop and DMs a card. No SSE to client, no live trace, no stop/cancel, no Firecrawl. Per R-05/D-5, billed call must NOT stream. Redraw as "agent working… (notify on done)" |
| 2.6 | Low-credits blocking + inline top-up (s08c) | run-start balance floor (worker) + `topup/init` | partial | LIVE concept (worker refuses billable run when balance < cost); **inline "+500 кр" in chat** = needs the top-up sheet wired into the run gate (BRANCH) |
| 2.7 | Tool-approve card "Агент хочет вызвать Firecrawl · 1 раз/Сессию/Всегда" (s09) | per-call tool approval + Firecrawl broker | **NO** | NOT-BUILT — no approval gate, no Firecrawl, no per-call consent. Tagged «скоро» (honest) |
| 2.8 | Runs / history list + stats (s10) | `agent_runs` rows (worker writes status/cost) | YES | LIVE |
| 2.9 | Failed run — reason + "Кредиты не списаны" + "↻ Повторить бесплатно" (s10b) | worker `markFailed` (no debit on failure) | partial | LIVE (failure recorded, no charge on fail); **MISMATCH:** "↻ Повторить" = re-enqueue exists, "бесплатно" framing OK only because failed runs aren't charged; "Сменить модель" inline not built |
| 2.10 | Run-trace ledger (tokens, tool spend, timeline) (s11) | per-step trace store + token/tool accounting surfaced | **NO** | NOT-BUILT — tagged «скоро». No trace persistence; cost is a single settle figure |

---

## JOURNEY 3 — Create from template ("2 клика")  →  readiness: **LIVE (local templates)**, BRANCH for marketplace

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 3.1 | Create → choose path (s12) | client nav | n/a | LIVE |
| 3.2 | Template gallery (s14) | served from **`lib/agent-templates`** (in-code templates), NOT the marketplace | YES (local) | LIVE for the built-in templates; **MISMATCH:** the gallery implies a *published, multi-author* template market — that backing does not exist |
| 3.3 | "2 клика →" instantiate | `POST /tma/agents` with `template_kind` → `getTemplate()` fills name/prompt/tools/model | YES | LIVE |
| **MISMATCH** | Card shows author handle (`@dev`) + "~12 кр/прогон" + clone-from-other-user | no author attribution, no cross-user clone, no per-template cost estimator | NO | the social/marketplace layer is NOT-BUILT |

---

## JOURNEY 4 — Create from words (AI builder)  →  readiness: **BRANCH** (create works; the AI-drafts-a-spec step is the question)

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 4.1 | "Опиши агента", chat (s13) | an LLM call that turns NL → a spec draft (name/prompt/model/tone) | **partial** | the conversion-LLM-call is not a named endpoint; **the only persisted output is what `POST /tma/agents` accepts** (name/system_prompt/tools/model_slug). So "AI собрал черновик" must reduce to those fields |
| 4.2 | Draft card "Дерзкий постовик · GPT-5.5 · 3 варианта", `Настроить`/`Создать ✓` | `POST /tma/agents` | YES | LIVE (the create) — **flag:** keep the draft within the accepted-fields envelope; "Вывод: 3 варианта" is prompt text, not a structured field |

---

## JOURNEY 5 — Create from scratch (Configure)  →  readiness: **LIVE for basics; provider/multi-model/tools/budget editors are BRANCH/NOT-BUILT**

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 5.1 | Name + Персona(SOUL) textarea (s15) | `POST /tma/agents` `name` + `system_prompt` (NOT a `SOUL.md` file — that's a Hermes-only file with no remote API) | YES (as system_prompt) | LIVE — **flag:** labelling it "SOUL" implies Hermes persona file; in our path it's just `system_prompt`. Honest if framed as the agent's prompt |
| 5.2 | "Модели · 1 ›" row (tagged «скоро» inline) | multi-model spec editor | NO | NOT-BUILT (correctly chipped «скоро»). Today exactly **one** `model_slug` |
| 5.3 | "Провайдер · AIAG ›" row («скоро») | provider picker over `providers`/`agent_provider_credentials` | partial | BRANCH — schema exists (0026), resolve+UI not wired |
| 5.4 | "Тулзы · 2 ›" row («скоро») | per-agent tool whitelist editor | partial | tools[] IS persisted on the agent and honored by the worker, but the **editor screen** + paid-tool catalog is NOT-BUILT; the 4 built-ins are fixed |
| 5.5 | "Бюджет агента · 50 кр/день ›" («скоро») | `budget_rub_monthly` (create) + `daily_budget_rub` (0020) | partial | the budget **values** are enforced LIVE; the **editor screen** is NOT-BUILT (set at create / default 1000₽) |
| 5.6 | `Создать агента` | `POST /tma/agents` | YES | LIVE |

---

## JOURNEY 6 — Connect-your-own-Hermes  →  readiness: **LIVE (as an OpenAI-compatible URL)**

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 6.1 | "Свой Hermes" — paste `http://addr:8642/v1` + key + "use our tools" toggle (s19) | `POST /tma/agents` `connection_type:'external_openai'` + `external_base_url` + encrypted `external_api_key` + `validateExternalUrl()` SSRF guard | YES | LIVE — **flag:** this is just "external OpenAI-compatible endpoint", not Hermes-aware. Hermes' `/v1` works because it's OpenAI-compatible; we do NOT talk to its dashboard/control-plane |
| 6.2 | Validate via `/models` (s19, s19b errors: 401/timeout/CORS) | a `GET /v1/models` probe to the pasted URL | YES | LIVE (`test-external` route exists). Honest error states |
| 6.3 | "use our tools/skills" toggle (s19) | injecting AIAG tools into a *user-run* Hermes loop | **NO** | **MISMATCH:** when the agent runs on the user's OWN Hermes, our worker is not in that loop, so "use our tools/skills" cannot be honored unless they route chat through us. Either drop the toggle for external, or define it as "route through AIAG and attach tools" |
| **MISMATCH** | s12/s19 wording "свой рантайм + наши тулзы/память" | R-02: their tools run in their Hermes; our tool broker isn't built anyway | NO | scope the promise to "your models via your endpoint, billed 0" |

---

## JOURNEY 7 — Pick provider per model  →  readiness: **BRANCH** (schema only)

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 7.1 | Provider picker: AIAG / OpenRouter / BYOK / Gonka / Custom URL (s17, «скоро») | resolver reads `agents.provider_id` → `agent_provider_credentials` (0026) | partial | BRANCH — tables seeded (8 providers), worker `resolveUpstream` for `provider_id` branch + the picker UI **not wired**. Per D-6, native (Anthropic/Google) BYO keys must route **through the gateway** or they 404 |
| 7.2 | Commission copy "свой ключ → 0 комиссии" | worker `isExternal ⇒ cost 0` | YES (rule in code for external_openai) | the rule is LIVE for `external_openai`; for the `provider_id` path it depends on the unbuilt resolve |
| 7.3 | Gonka option | `gonka.ts` upstream (copy of `openrouter.ts`) | NO | NOT-BUILT (D-4 spike) |
| **MISMATCH** | "лучший маршрут / uptime 99.9% / p50 410мс" on model card (s07) | no routing-health/observability surfaced to TMA | NO | decorative metrics — either wire from gateway health or remove |

---

## JOURNEY 8 — Equip tools  →  readiness: **partial** (4 built-ins LIVE; market/broker NOT-BUILT)

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 8.1 | "Что умеет агент" toggles: Web Search / Firecrawl / Image-gen / Calc (s18, «скоро») | per-agent `tools[]` whitelist; worker `pickToolDefs` | partial | the **4 built-ins** (web_search/calc/image_gen/memory) are honored LIVE; **Firecrawl is NOT built** (web_search is DuckDuckGo scrape); the toggle editor screen is NOT-BUILT |
| 8.2 | Tool market (Firecrawl, x402 Bazaar) (s27) | tool broker: catalog `tools` + ledger `tool_calls` + reserve/settle/refund | NO | NOT-BUILT (R&D, D-9 spec ready). No tables |
| 8.3 | Tool detail pay-per-call "ключ у нас · списываем атомарно · ошибка→возврат" (s28) | broker per-call metering + daily-budget increment | NO | NOT-BUILT (R&D). The "atomic debit + refund" is the D-9 design, not code |
| 8.4 | Skills hub (s29) | skills registry + per-agent whitelist | NO | NOT-BUILT (R&D). Hermes has skills, but we have no skills table/installer |
| 8.5 | MCP servers OAuth (Notion/Sheets/custom) (s30) | `@modelcontextprotocol/sdk` outbound OAuth + `mcp_oauth_credentials` table | NO | NOT-BUILT (R&D, R-09/D-11). Needs `agent_tokens` first; no MCP tables |

---

## JOURNEY 9 — Top up wallet (multi-crypto)  →  readiness: **LIVE for TON only; "multi-crypto" is a MISMATCH**

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 9.1 | Balance "1 250 кр ≈ 12.5 USDT", `+ Пополнить` (s31) | `GET /tma/wallet` → `balance_rub` | partial | LIVE balance — but it's **₽** internally, displayed as "кр/USDT". Credit unit migration (D-1) pending |
| 9.2 | Top-up sheet: amount chips + **TON / USDT(TON·TRC-20·ERC-20) / USDC-multichain via HOT** (s32) | `topup/init` → builds a **native-TON** transfer (nano-TON + comment tag); TON Connect `sendTransaction` | **TON only** | LIVE for TON; **MISMATCH (big):** USDT-jetton, TRC-20/ERC-20, USDC, and HOT-multichain are all shown but **NOT built**. `topup/init` only emits a native-TON message. Per R-04 these need jetton `0x0f8a7ea5` transfer + master allowlist + per-chain indexers |
| 9.3 | "Ждём подтверждение… зачислим в фоне + уведомление" (s32b) | `topup/check/[id]` client poll (last-20-tx, 10-min) | partial | LIVE poll — **MISMATCH:** "зачислим в фоне, можно закрыть" promises a **server reconciler** that does NOT exist; if the user closes the app the topup can stay pending forever (R-04 loss-mode 1). Build the reconciler cron before making this promise |
| 9.4 | Wallets (TON · HOT) in profile (s37) | `wallet/link` (ton-proof unverified) | partial | TON link LIVE; HOT = just appears in TON Connect picker (no code); proof not verified |

---

## JOURNEY 10 — Set agent budget  →  readiness: **LIVE (enforcement); editor screen NOT-BUILT**

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 10.1 | "Карта агента" daily limit / per-call limit / allowed tools (s33, «скоро») | `agents.daily_budget_rub`/`budget_rub_monthly`/`spent_today_rub`; worker pre/mid/settle guards | partial | the **daily + monthly guard is LIVE and atomic**; **per-call limit** and the **editor UI** are NOT-BUILT |
| 10.2 | "Делегированный лимит без раскрытия ключа · отзыв в 1 тап · аудит-лог" | a delegated-wallet/spend-cap with audit log | **NO** | **MISMATCH:** there's no delegated wallet, no per-call cap, no audit log. It's a budget number on the agent row. Reframe as "daily/monthly spend cap" |
| 10.3 | "Лимит не больше баланса" copy | run-start floor + balance check | YES | LIVE (worker refuses billable run when balance insufficient) |

---

## JOURNEY 11 — Publish template (free / rent) + earn  →  readiness: **NOT-BUILT** (entire journey)

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 11.1 | "Опубликовать" — public(spec)/private(keys,memory) split + Бесплатно/Назначить цену + "50 кр/мес" (s35, «скоро») | sanitizing exporter (R-02 F8) + `templates`/`publish` table + author price | **NO** | NOT-BUILT — no publish endpoint, no templates table, no spec-sanitizer. Per R-02 a public template must strip `.env`/memory/sessions; that exporter doesn't exist |
| 11.2 | Author profile: arendators / clones / "доход 4 300 кр" / `Вывести доход → баланс` (s34, «скоро») | author-earnings accrual + payout sweep to `tg_user_balances` | **NO** | NOT-BUILT — no author_earnings, no withdraw. **Blocked on D-0** (margin isn't a readable number) per R-11; author-rent itself is a fixed sum (deterministic) but still needs the credit ledger + payout sweep + self-deal exclusion |
| 11.3 | "AIAG не берёт процент" copy | pass-through author rent | n/a (policy) | policy is sound (monetization doc) but the accrual code doesn't exist |
| **MISMATCH** | the whole two-sided market (rank by usage, ratings, renters) | no renter→author money flow, no ranking, no ratings | NO | the entire creator economy is wireframe-only |

---

## JOURNEY 12 — Clone / Remix  →  readiness: **NOT-BUILT**

| # | Step (screen) | Backend / Hermes function | Supported? | Readiness |
|---|---|---|---|---|
| 12.1 | `⎘ Клонировать` on agent card (s05) | clone a (your-own or public) spec into a new agent | **NO** | NOT-BUILT — no clone endpoint. Cloning your OWN agent could be a thin `POST /tma/agents` copy; cloning **others'** needs the template/market layer |
| 12.2 | Remix + lineage "наследуем persona/model/skills · оригиналу атрибуция" (s36, «скоро») | lineage/attribution table + single-hop accrual | **NO** | NOT-BUILT — no lineage table, no attribution. Depends on Journey 11 |

---

## JOURNEY 13 — Manage a managed-Hermes (config / skills / MCP / cron)  →  readiness: **NOT-BUILT + HERMES-CANNOT**

| # | Step (screen) | Backend / Hermes function | Supported? (R-02) | Readiness |
|---|---|---|---|---|
| 13.1 | Provisioning "Поднимаем твой облачный Hermes · под 512 МБ · спит когда не нужен" (s21, R&D) | provision a per-user Hermes pod | **NO** | NOT-BUILT + infra-blocked. **MISMATCH:** "спит когда не нужен / 512 МБ" is false — the resident `hermes gateway` pins ~300–600 MB and does NOT hibernate (R-01 review). 2 GB VPS can't host pods |
| 13.2 | Status dashboard CPU/RAM/uptime + `⏸ Сон` (s22, R&D) | read pod metrics + sleep/wake | **NO** | NOT-BUILT. No provisioner, no metrics, no sleep |
| 13.3 | Config "У Hermes нет remote-API → инъекция конфига + рестарт", Персона/Модели/Скиллы/Тулзы·MCP, `Применить и перезапустить` (s23, R&D) | per R-02: file-write `config.yaml`/`SOUL.md` + `hermes gateway restart`, OR loopback dashboard API (`PUT /api/config`, `/api/skills/toggle`, `POST /api/mcp/servers`, `/api/cron/jobs`) **via a sidecar we build** | **HERMES-CANNOT remotely** | NOT-BUILT. The screen's own copy is honest ("нет remote-API"); but the sidecar control-plane (the only safe caller of the loopback dashboard) does not exist. Persona has NO endpoint at all → file write only |
| 13.4 | Knowledge / memory (pgvector, "приватна, не в шаблон") (s24, R&D) | `CREATE EXTENSION vector` + `agent_memory_vectors` + ingest | **NO** | NOT-BUILT (D-5 Phase 0). Today only a flat `agent_memory` KV exists |
| 13.5 | Schedules / cron "Hermes :8642 /api/jobs" (s25, «скоро») | Hermes cron via dashboard `POST /api/cron/jobs` (sidecar) OR our own scheduler | **HERMES-supports natively**, but only via the unbuilt sidecar; we have no scheduler | NOT-BUILT |
| 13.6 | Kanban / swarm task board (s26, R&D) | Hermes swarm-state surfaced as a board | **NO** | NOT-BUILT. Hermes has no swarm-state API we read; this is aspirational |

---

## JOURNEY 14 — Deliver to Telegram  →  readiness: **LIVE (DM card only); "agent in your own chats" NOT-BUILT**

| # | Step (screen) | Backend / Hermes function | Supported? (R-10) | Readiness |
|---|---|---|---|---|
| 14.1 | Run-finished DM card from AIAG bot with deep-link back to TMA | `bot-api.ts` raw `fetch sendMessage` to user's `telegram_id` after settle | YES | LIVE — **flag:** `buildRunCompletedMessage` still says "₽"; fix to credits |
| 14.2 | "Agent answers in the user's own Telegram / business chats" (implied by product 0-liner "agents that live in Telegram") | grammY + Telegram **Business** (`business_connection_id`) as a separate pm2 process; `tg_business_connections` table | **YES (Bot API 7.2, official, no ban)** but **NOT built** | NOT-BUILT — no grammY, no Business, no per-user bot. Requires user Premium + manual bot-add. **Gate:** who pays for inbound business-chat answers (FD-5) is unresolved |
| 14.3 | Cron-delivered digests "в @news" (s25) | scheduler → run → deliver via business connection | **NO** | NOT-BUILT (depends on 13.5 + 14.2) |

---

## TOP MISMATCHES — design implies a function the backend/Hermes cannot do

Ranked by how badly the screen over-promises vs. code reality.

1. **Streaming "agent думает" + live tool-cost trace + stop (s08b).** Run is async-enqueue (202) →
   worker does a non-streaming loop → DMs a card. There is NO SSE to the client, no live trace, no
   cancel, and **Firecrawl is not a built tool** (web_search is a free DuckDuckGo scrape). Per
   R-05/D-5 the *billed* call must NOT stream anyway (LiteLLM returns `usage:null` → settle at ₽0).
   → Redraw as "agent is working → notify on done"; reserve streaming for a separate display pass.

2. **"Multi-crypto" top-up: USDT-jetton / TRC-20 / ERC-20 / USDC / HOT-multichain (s32).** `topup/init`
   emits ONLY a native-TON transfer. None of the other rails exist. Jetton needs the `0x0f8a7ea5`
   transfer shape + `forward_ton_amount ≥ 0.05 TON` + master allowlist (R-04). → Until built, show
   TON only (and USDT-on-TON next), not a multi-chain menu.

3. **"Зачислим в фоне, можно закрыть" top-up confirmation (s32b).** The only watcher is a client poll
   (last-20-tx, 10-min). No server reconciler → closing the app can strand funds (R-04 loss-mode 1).
   → Build the reconciler cron BEFORE promising background crediting.

4. **The entire two-sided creator market — publish/rent/earn/withdraw + clone-others/remix/lineage
   (s34, s35, s36) and the "Для тебя"/Каталog discovery of *other authors'* agents (s03, s04, s05).**
   `marketplace/route.ts` returns **models only**. There are NO templates/author/earnings/lineage/
   ratings tables or endpoints. Author rent is blocked on D-0 (margin) per R-11. → This is wireframe-
   only; "Мои агенты" + local templates are the honest scope today.

5. **Managed-Hermes "спит когда не нужен / 512 МБ" provisioning (s21) + status/config/sleep (s22–23).**
   No provisioner; 2 GB VPS can't host pods; the resident `hermes gateway` pins ~300–600 MB and does
   NOT hibernate (R-01). Hermes has NO remote config API — config is file-write + restart via a
   **sidecar we have not built** (R-02). Persona (SOUL.md) has no endpoint at all. → Keep on Board B,
   tagged R&D; the s23 copy ("нет remote-API") is the one honest line.

6. **"Свой Hermes → use our tools/skills" toggle (s19, s12 copy).** When the agent runs on the user's
   OWN Hermes our worker isn't in the loop, so we cannot inject our tools/skills/memory there. → Scope
   to "your models via your `/v1` endpoint, billed 0"; drop or redefine the "our tools" toggle.

7. **Per-model provider picker + per-role multi-model slots (s16, s17) and "лучший маршрут / p50 410мс
   / uptime 99.9%" health (s07).** Schema for BYO providers exists (0026) but resolve+UI aren't wired
   (BRANCH); multi-model and routing-health are NOT-BUILT. Native BYO Anthropic/Google keys 404 unless
   routed through the gateway (D-6). → Ship single-model + AIAG/external first; chip the rest «скоро»
   (the board already does on s15/s16/s17).

8. **"Первый прогон бесплатно" (s03b, s05).** No free-run grant exists in code; every run settles real
   cost (or fails free). → Either implement a one-time free-run credit, or drop the promise.

9. **Tool-approve "1 раз / Сессию / Всегда" + run-trace ledger (s09, s11) + per-call budget + delegated
   wallet/audit-log (s33).** No per-call approval, no trace persistence, no per-call cap, no delegated
   wallet. Daily/monthly budget IS enforced. → Reframe s33 as "daily/monthly spend cap"; keep s09/s11
   on the roadmap board (already «скоро»).

10. **initData security (s02 is "live").** The live `verifyInitData` uses a non-constant-time `!==`
    compare and a 24h replay window (R-10/D-8). It "works" but is the flagged R1-3 hole. → Ship the
    `timingSafeEqual` + 600s + Redis-nonce patch; no UI change, but the "live + secure" claim needs it.

**Net:** The honest shippable surface today = Journeys **1, 2 (minus streaming/tool-approve/trace),
3 (local templates), 4, 5 (basics), 6 (as external endpoint), 9 (TON only), 10 (enforcement),
14.1 (DM card)**. Journeys **7, 8, 11, 12, 13** and the streaming/multi-crypto/marketplace parts of
2/9 are BRANCH or NOT-BUILT — they belong on Board B (R&D), and several (managed Hermes, "our tools on
your Hermes") are HERMES-CANNOT until we build a control-plane sidecar and put real infra under it.
