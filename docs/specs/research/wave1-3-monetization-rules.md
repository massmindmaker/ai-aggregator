# Wave 1-3 — Monetization Rules (author-rent model) — extracted

> Read-only extraction. Sources (verbatim):
> - `docs/specs/2026-06-03-monetization.md` (authoritative monetization doc; refines synthesis D-12)
> - `/CLAUDE.md` founder decision #7 (author-rent)
> - `docs/wireframes/tma/index.html` artboards **S34** (Профиль автора + доход), **S35** (Опубликовать шаблон), **S36** (Ремикс / lineage)
>
> Currency: **USD-pegged crypto credit** ("кр"), multi-crypto top-up (TON + others). Stars deferred. ₽ removed from TMA. Author earnings land in `tg_user_balances` (the spendable balance).

---

## (1) The money split — what the renter pays, and the 0% confirmation

When a user runs / rents a paid-template agent, the credit balance is debited across up to **four** distinct lines (monetization doc §"The flows"):

| Line | Who sets it | Where it goes | Notes |
|---|---|---|---|
| **1. Model usage** | AIAG markup on `:4000` gateway | **AIAG revenue** | If the user runs on **their own key/provider** (BYOK / OpenRouter / Gonka-wallet) → **0** (they pay their provider directly). |
| **2. Paid tools** | AIAG markup (broker: Firecrawl, image-gen, …), per-call | **AIAG revenue** | |
| **3. Deploy / runtime** | AIAG deploy/subscription charge (infra cost: shared ~18GB VPS now, dedicated later) | **AIAG revenue** | |
| **4. Author rent** | The **author's exact set sum** | **goes to the author** (pass-through) | Only charged if the agent came from a **paid** template. |

**AIAG takes 0% on author rent — CONFIRMED.** Exact wording from the doc:
- "The renting user pays **exactly the sum the author set**. The author **receives that sum** in spendable credits (`tg_user_balances`)."
- "**AIAG takes NO percentage cut of the author rent** (no 5%, no commission). Author rent is pass-through."
- "AIAG's revenue from a template = the **model markup + tools + deploy** the renter consumes — NOT the author's rent."
- Tradeoff noted for later: "AIAG does not profit directly from author rent. If a platform fee is ever wanted, that is a future founder decision; for now it is 0%."

Wireframe corroboration (S34, line in author profile): "Ты получаешь **ровно назначенную сумму аренды**. AIAG зарабатывает на моделях/тулзах/деплое, а не на твоей цене — процента нет." (S35 publish screen repeats: "Получаешь **ровно эту сумму** — AIAG не берёт процент.")

`/CLAUDE.md` decision #7 (verbatim): "the user pays model usage (AIAG markup) + deploy + **the author's exact set sum**; **NO % commission on author rent** — author receives the sum they set; AIAG earns on model markup + tools + deploy."

---

## (2) Free vs priced publish

At publish time the author chooses one of two access modes (monetization doc §"Author-rent model"; wireframe S35 segmented control "Бесплатно / Назначить цену"):

- **Free** ("Бесплатно") — no author charge. Anyone clones/runs without an author fee. (Renter still pays AIAG model/tools/deploy.)
- **Priced** ("Назначить цену") — the author sets an **exact amount**, e.g. a **monthly rent** (subscription) or a **per-deploy / per-use** price.

S35 price entry: an amount field (e.g. `50 кр`) + a period selector (e.g. `в месяц`). S34 shows both modes coexisting in one author's catalog: "Постовик — `50 кр/мес · 62`" (priced) alongside "Сценарист — `бесплатно`".

---

## (3) Published template — SHARED (public) vs PRIVATE

The publish principle (S35 header): "Шарим настройку, НЕ данные." (We share the setup, not the data.)

**SHARED / public (goes into the template):**
- Persona + prompt ("Персона + промпт")
- Model **names** ("Модели (имена)")
- Skills + tools + MCP **definitions** ("Скиллы + тулзы + MCP-дефы")

**PRIVATE / kept (never published):**
- Keys / tokens ("Ключи / токены" 🔒)
- Memory, knowledge, history ("Память, знания, история" 🔒)

I.e. a published template shares the **spec** (model slugs, skill/tool/MCP defs **without keys**), and keeps private the **keys + memory + data + run history**. This matches `/CLAUDE.md`'s general template rule: "public template shares the spec … WITHOUT keys, keeps private the keys/memory/data/history."

---

## (4) Is rent one-time, monthly-subscription, or per-run?

**The author chooses the billing shape; it is NOT fixed to one of these.** The doc and S35 both allow:
- **Monthly rent (subscription)** — the headline / default example ("e.g. a **monthly rent**"; S35 default period = "в месяц"; S34 card shows "50 кр/мес").
- **Per-deploy** price ("per-deploy/per-use price"; S35 helper: "Аренда / мес или за деплой").
- **Per-use** is also listed as an option in the doc ("or a per-deploy/per-use price").

So: **not strictly per-run.** Default/primary model = **monthly subscription**; per-deploy and per-use are author-selectable alternatives. (Note: "per-run" as a separate flat author line is not the framing — model/tool/deploy usage is metered to AIAG; the author's rent is the recurring/per-deploy amount they set.)

Open sub-question (founder, later): "Whether deploy is a flat monthly subscription or metered." — this is about the **AIAG deploy** line (#3), not the author rent.

---

## (5) OPEN founder gates affecting cash-out vs in-app spend

From monetization doc §"Open (founder, later)":

- **FD-2 — Withdrawable vs non-withdrawable credits.** Direct quote: "Withdrawable vs non-withdrawable credits (synthesis FD-2) — affects whether author earnings can cash out (licensing implications)." → This is the gate that decides whether an author's accrued rent (the "доход" / "к выводу" balance in S34, with its "Вывести доход → баланс" button) can be **cashed out** vs only **spent in-app**. UNRESOLVED.
- **Deploy billing shape (related, not FD-2):** "Whether deploy is a flat monthly subscription or metered." UNRESOLVED.

Jurisdiction / compliance context (from `/CLAUDE.md`, bears on FD-2's "licensing implications"): legal is **"NOT factored now"** (founder 2026-06-03). Working structure = a separate **non-RF foreign entity** buys models from the RF AIAG aggregator as a customer; crypto/USDC + $-billed compute sit on the foreign entity. Compliance to be revisited later (synthesis **FD-2 / FD-3**). So the cash-out question is coupled to the unresolved jurisdiction/legal-entity decision, not just a UI toggle.

**Important shipping caveat (D-0 dependency, monetization doc §"What authors lose money on today"):** the worker currently invents its own price (`PRICING × USD_TO_RUB=90`) and discards the gateway's real cost, so **realized margin is not readable by any code** (synthesis D-0 / R-11). Author rent is safe to ship **before** D-0 only because it is a **fixed author-set amount** (deterministic, not margin-derived) — but it still requires: the **USD-credit ledger (D-1)**, an **author-payout sweep** (a separate pass from the renter debit to avoid `tg_user_balances` lock contention), and **BYOK-run exclusion** (no model-markup revenue on own-key runs).

**Anti-abuse rules carried from D-12** (so the open gates don't get gamed): rank templates by realized usage from **distinct funded renters** (wash-trading costs the attacker real credits); **self-deal exclusion** in the accrual hook (author can't rent from themselves); **single-hop attribution** (no recursive royalty farming) + per-author slug namespacing (anti-squatting); concrete **dust floor** on payouts.

---

## Status labels in the wireframes
S34 / S35 / S36 are all tagged **«скоро»** (soon) — publication + author-rent are the **target view**, NOT yet built. S34 numbers (arendators / clones / income) are **демо**. The live profile (S37) already links "Мои шаблоны / доход ›" as the entry point.
