# Feat-3 — Wireframes vs Monetization intent (product assessment)

Read-only assessment, 2026-06-03. Sources: `docs/wireframes/tma/index.html` (screens S17, S18, S29, S30, S34, S35, S36), `docs/specs/2026-06-03-monetization.md`, REAL-vs-FANTASIZED table in `/CLAUDE.md`, `docs/specs/research/SYNTHESIS.md` (D-0, D-1, D-12).

---

## Feature 1 — SKILLS / MCP attach (S18 tools, S29 skills hub, S30 MCP servers)

### What the wireframe promises
- **S17 — Провайдер-пикер (label: «скоро»):** a list of model sources — AIAG-шлюз (managed, +наценка, selected), OpenRouter (свой ключ, комиссия 0), OpenAI/Anthropic BYOK (комиссия 0), Gonka (GNK-кошелёк, 0), Custom URL. The picker is the screen that encodes the commission rule: AIAG-supplied = markup, own key/provider = 0. Honest note already on-board: «схема есть (миграция 0026), но resolve в воркере + пикер не связаны end-to-end».
- **S18 — Оснастить тулзами (label: «скоро»):** toggle list — Web Search (DuckDuckGo, встроенный, бесплатно), Firecrawl (1 кр, «скоро»), Image-gen (Kie, платно), Calc (бесплатно), Memory KV (встроенная). Note states the 4 built-in tools (web_search/calc/image_gen/memory) **work live and are counted in cost**; Firecrawl is NOT built; the editor screen itself is «скоро».
- **S29 — Маркет скиллов (label: R&D):** browse/＋add reusable SKILL.md procedures from authors (@skillsmith, @research). Footer: «скиллы шарятся в шаблоне · ключи приватны».
- **S30 — MCP-серверы (label: R&D):** connect third-party servers (Notion, Google Sheets) via OAuth 2.1 + PKCE, plus «Свой MCP» (bearer, per-agent).

### What a user would do
Open an agent → open Tools/Skills/MCP → toggle a capability on, or add a skill from the hub, or OAuth-connect an MCP server → the agent can now call that capability during a run. This is a **capability-attach** flow, not a checkout flow.

### Is it a money feature or free BYOK-style capability?
**Mostly a free, BYOK-style capability — with a thin paid edge.** Three tiers visible on the boards:
1. **Free built-ins (live):** web_search (DuckDuckGo), calc, memory — zero charge, no money path.
2. **BYOK / OAuth-your-own (R&D):** MCP servers (S30) and author skills (S29) the user connects with **their own** OAuth/keys — by the firm commission rule (own key/provider = 0 commission), AIAG charges nothing for the connection itself. These are capability features, not revenue.
3. **Paid-tool edge (R&D, not built):** Firecrawl / image-gen via the tool broker (monetization flow #2 "Paid tools" — per-call AIAG markup). This IS revenue, but the broker, the `tool_calls` ledger, and x402 **do not exist** (S27 R&D note confirms). The only money currently flowing through the tools surface is the model markup any tool's LLM step incurs (S18's "counted in cost"), not a tool fee.

**Verdict:** Skills/MCP attach is a **capability/retention feature first** (BYOK-free), with a deferred paid-tool markup as the only monetization, and that monetization is R&D-blocked on the unbuilt tool broker. It is NOT the headline money feature and should not be sold as one. Provider-picker (S17) is the only one of these that is "скоро" rather than "R&D" because the substrate (migration 0026) is already on prod; it just isn't wired end-to-end.

---

## Feature 2 — BUY / RENT AGENT (author-rent: S34 author profile, S35 publish, S36 remix)

### What author-rent requires end-to-end
Per `2026-06-03-monetization.md` (flow #4 + the author-rent section) and the boards:

1. **Publish template (S35):** author marks what is public (persona+prompt, model names, skills/tools/MCP **defs**) vs private (keys/tokens, memory/knowledge/history), then picks **Бесплатно** OR **Назначить цену** (e.g. «50 кр / в месяц» or per-deploy). Needs publish/clone/lineage tables (the "substrate" in SYNTHESIS step 14).
2. **Clone / remix (S36, S14):** another user forks the spec — inherits persona/model/skills, keeps lineage attribution to the original author. S14 + S13 note both flag «Клонировать — скоро»; only built-in `lib/agent-templates` exist today, no published author market.
3. **Rent payment (renter side):** at run/deploy the renter pays model usage (AIAG markup) + tools + deploy + **a separate «аренда автора: X кр» line** = exactly the author's set sum. Needs a deterministic charge against the renter's credit balance.
4. **Author payout (S34):** author accrues earnings («доход 4 300 кр»), sees renters/clones, and **«Вывести доход → баланс»**. Monetization doc specifies this must be a **separate author-payout sweep** (distinct pass from the renter debit) to avoid `tg_user_balances` lock contention, plus **self-deal exclusion** and **BYOK-run zero-accrual**.

The whole feature is labelled **«скоро»** on S34/S35/S36, and S34/S35 carry explicit honest notes: «публикация и аренда шаблонов ещё не построены; цифры — демо».

### What is BLOCKED on the unbuilt money foundation — be explicit

**The author-rent CHARGE/PAYOUT is the only part with a partial reprieve; everything around it is blocked.**

- **Blocked on D-0 (gateway must return realized margin — consolidated but NOT deployed):** The renter's bill is `model markup + tools + deploy + author rent`. The **model-markup and tool-markup components** are exactly the numbers D-0 fixes. Today the worker invents its own price (hardcoded `PRICING × USD_TO_RUB = 90`) and **discards the gateway's real cost, so realized margin is not a number any code can read** (monetization §"What authors lose money on"; SYNTHESIS RK-2). Until D-0 ships, AIAG's *own* revenue lines on a rented agent (markup, tools, deploy) settle off cost, not margin → the platform can lose money on every rented run. D-0 is consolidated in Wave-0 but **not deployed**, so this is a live blocker.
- **Blocked on D-1 (USD-pegged credit ledger — NOT built):** Author rent debits the renter and credits the author **in spendable credits**. There is no USD-pegged credit unit yet — the code still debits a **RUB** balance (`tg_user_balances`), and `USD_TO_RUB = 90` is still live in two places. The monetization doc states author rent needs "the USD-credit ledger (D-1)" before it can ship. A "X кр/мес" rent has no canonical unit to settle in until D-1 migrates `tg_user_balances` → integer micro-USD. **D-1 is not built.**
- **The narrow reprieve:** because author rent is a **fixed author-set amount** (deterministic, not margin-derived), the *rent line itself* is technically safe to compute **before** D-0. But it still cannot ship before **D-1** (no credit unit), and AIAG's surrounding revenue lines on the same agent stay D-0-blocked. So shipping rent-before-D-0 would mean paying authors correctly while AIAG bills its own cut off cost — a half-built money path SYNTHESIS RK-2 explicitly warns against.
- **Additional substrate gaps (not D-0/D-1, but required):** publish/clone/lineage tables, the separate author-payout sweep, self-deal exclusion in the accrual hook, single-hop attribution, dust floor, and BYOK zero-accrual tests (SYNTHESIS D-12 step 14; prod migrations are manual/untracked per RK-8).

### Money-feature verdict
Author-rent is the **real monetization play** (it is THE founder decision, flow #4), but it is **end-to-end blocked**: D-1 (credit unit) is a hard gate with no workaround, and D-0 (margin authority, consolidated-not-deployed) gates AIAG's own cut on every rented run. The boards correctly label all three screens «скоро» with «не построены / демо» notes. **Do not surface buy/rent as live; it depends on two foundation pieces, one not built (D-1) and one not deployed (D-0).** Note: AIAG takes **0% of the rent** — its revenue is the D-0-dependent markup/tools/deploy, which is exactly why D-0 must precede any rent launch.

---

## One-line table

| Feature | Boards label | Money role | Blocker |
|---|---|---|---|
| Skills/MCP attach (S18/S29/S30) | скоро / R&D | Free BYOK capability; thin paid-tool markup edge | Paid edge blocked on unbuilt tool broker (not D-0/D-1) |
| Provider-picker (S17) | скоро | Encodes commission rule | Substrate live (mig 0026), not wired end-to-end |
| Buy/Rent agent (S34/S35/S36) | скоро | **The real monetization (author-rent)** | **D-1 (credit ledger, not built) + D-0 (margin, consolidated-not-deployed)** |
