# TMA — Product Definition (v2, resolved decisions)

**Date:** 2026-06-02
**Status:** Authoritative for TMA. Supersedes currency + Hermes-runtime points in `2026-06-02-WHAT-WE-ARE-BUILDING.md` per founder decisions of this date.
**Companion anchor:** `/CLAUDE.md` (always-loaded summary).

---

## 0. One-liner

**TMA is a hosted, multi-user marketplace of AI agents that live in Telegram — discover, run, clone-from-template, or build your own; pay per use in crypto credits.** It is NOT the ruble web aggregator (that is a separate product).

The open market gap we fill: existing Hermes/agent UIs are single-operator tools you run on your own machine. **Nobody offers a hosted, multi-user product with a template marketplace + a choice of paid models + a tool market.** That is TMA's lane.

---

## 1. Two products — hard boundary

| | **Aggregator (WEB)** — `ai-aggregator.ru` | **TMA (Telegram)** — this doc |
|---|---|---|
| Offer | Models + agents marketplace for RU + OpenAI-compatible API gateway | Agents marketplace inside Telegram |
| Currency | **Rubles (₽) only** | **Crypto credits (USDT/TON) only** — no ₽ |
| Entity | RF (ИП → кооператив) | Foreign (crypto wallet, x402 facilitator) |
| Code | `apps/web`, `packages/api-gateway` (:4000) | `apps/tg-miniapp` (:3100), `apps/agent-worker` (:3101) |
| Shared | Postgres (Timeweb), the `:4000` gateway as a model provider, model catalog | — |

**Rule:** rubles never appear in TMA; crypto never appears in the WEB aggregator's user-facing billing.

---

## 2. What an agent is

An agent is a **composable spec**, not a single prompt or model:

- **Persona** (`SOUL.md`) — who the agent is, tone, goals.
- **Models** — one or several, by role: chat / image / voice-in / voice-out / vision. Each model has a **provider**.
- **Skills** — reusable text procedures + mini-scripts the agent follows (Hermes "skills hub").
- **Tools / plugins** — callable functions (web search, calc, image-gen today; paid external tools via the broker later).
- **MCP servers** — external tool servers the agent connects to (roadmap).
- **Knowledge / memory** — per-agent data + persistent memory.
- **Schedules (cron)** — recurring autonomous runs (roadmap).

**Per-model provider choice** (the commission rule, firm + in code):
- Model supplied by **AIAG** (routed via `:4000` gateway) → **debit credits + apply markup**.
- Model on the **user's own key/provider** (OpenRouter / Gonka / BYOK / custom URL) → **charge ZERO** (they pay their provider).

---

## 3. Three ways to get an agent

1. **Connect your own Hermes** *(live path)* — user runs a Hermes instance, gives TMA its OpenAI-compatible base URL (`http://host:8642/v1`). TMA becomes the UI/controller: pick our models/providers, use our skills, wire tools, and we meter/bill the AIAG-supplied calls. *(Hermes natively bridges Telegram + ~22 platforms — we do not build the chat bridge.)*
2. **From a public template** — clone a published spec from the marketplace. Card shows model(s) + estimated cost/run. *(Where the agent then runs = see §5.)*
3. **From scratch** — hand-build the spec (persona + models + skills + tools + MCP + knowledge + cron). *(Same run path as #2.)*

**Templates are published, not sold.** Publishing shares the **spec** (model names, skills, tool/MCP definitions with secrets stripped, schedules) so others can clone the setup. It does NOT expose the original agent's API keys, memory, knowledge DB, conversation history, or user profile.

---

## 4. Billing model (crypto credits)

- User holds a **crypto-credit balance** (USDT/TON denominated). *(Code migration pending: today `tg_user_balances` is in ₽ — must move to a single canonical crypto-credit unit.)*
- Top-up via **TON Connect** (TON/USDT).
- Spend: per-call on agent runs (model tokens) + per paid tool call (broker).
- Atomic deduct (race-safe), guarded daily budget, run-start floor — **this layer is built + live (R0 / Phase 15.1).**
- **x402** = the rail for an **agent paying OUTWARD** to an external paid service (foreign entity). Not how users top up. Roadmap.
- First run free; rank templates by real usage; credits primary, crypto optional for top-up. TON is pay-for-compute/tools — **never tradable agent-equity** (avoid the Virtuals casino).

---

## 5. Where agents run — the honest stance

- **Today:** the runner is a **stateless BullMQ → OpenRouter loop** (`apps/agent-worker/src/agent-runner.ts`). No persistent Hermes process.
- **Connect-your-own-Hermes:** the agent runs on the **user's** Hermes — works without our runtime. **This is the live managed-execution story.**
- **Managed Hermes (we host a per-user Hermes):** **R&D / deferred** (founder decision 2026-06-02). Blocked by: 2GB VPS can't host pods, no provisioning code, no security isolation, Hermes has no remote config API. Not shown in the shippable product.

---

## 6. Tools / skills / MCP — roadmap, not live

- **Tool Broker** (spec D3): paid-tool registry, first tool = Firecrawl, our key in-process, per-call metering + atomic deduct + refund-on-error. `rail = key_broker` now, `x402` later.
- **Skills hub**: browse/install reusable procedures; per-agent whitelist.
- **MCP servers**: OAuth 2.1 + PKCE + RFC 8707 for third-party; first-party may skip OAuth.
- Status: specs ready (D2 provider-picker, D3 toolbroker), **no code yet**. Show in Board B (roadmap), not Board A.

---

## 7. Surface map (4 tabs) + live vs roadmap

| Tab | Live today (Board A) | Roadmap (Board B) |
|---|---|---|
| **Agents** | list, create (basic), run, conversation history, daily budget | full provider picker, multi-model spec editor, remix/lineage, run-trace/observability |
| **Market** | template/model list, basic discovery | author/creator profiles, ratings, publish/monetize, deep discovery, tool market (x402) |
| **Wallet** | crypto-credit balance, TON top-up | auto-top-up, full ledger/history, receipts |
| **Profile** | login (Telegram), settings | creator profile, published templates, earnings |
| **(Hermes)** | connect-your-own-Hermes (URL + key) | managed-Hermes dashboard (R&D — Board B only, tagged) |
| **(NFT)** | ⏳ open — hide in A, show in B | Startonus mint (decision pending) |

---

## 8. Scores (critical, 108-scale)

Tech stack **50/108** · Functional **43/108** · UX **59/108**. Worst dims: billing integrity, provider routing, auth, observability, testing, compliance. The functional gap is almost entirely **unbuilt-but-featured** items (managed Hermes, provider picker, tool store, Telegram-deploy, kanban, x402). Everything marketed as live genuinely works.

---

## 9. Immediate consequences of the resolved decisions

1. **Currency migration** (code): `tg_user_balances` ₽ → crypto-credit unit; remove `USD_TO_RUB=90` hardcode; FX/credit policy.
2. **Mockups redraw in crypto credits** (not ₽, not USDT-soup — one canonical credit unit displayed).
3. **Hide** managed-Hermes dashboard/swarm/metrics + tool store + MCP + Telegram-deploy + kanban from Board A.
4. **Promote** connect-your-own-Hermes as the live "bring your runtime" path.
5. **NFT** decision still pending (§7).

---

## 10. Wireframe plan (two layers)

- **Board A — Shippable (honest MVP):** Agents (list/create/run/history/budget), Market (templates+models discovery), Wallet (crypto balance + TON top-up), Profile (login/settings), Connect-your-own-Hermes. All in crypto credits. ~18–22 artboards.
- **Board B — Roadmap vision (tagged R&D):** managed-Hermes provisioning + dashboard, full provider picker, multi-model spec editor, tool market (x402), MCP/skills hub, author profiles + publish/monetize, run-trace, Telegram-deploy, scheduled tasks. ~20–25 artboards.
- Single black-and-white technical visual language (mobile + desktop). Existing board `docs/wireframes/tma/index.html` (41 artboards) is the starting material — re-sort into A/B and fix currency.
