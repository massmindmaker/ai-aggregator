# R-18 — Credit Economics + Pricing (Billing)

> Research date: 2026-06-04. Author: research subagent.
> Scope: markup strategy of AI aggregators · free-credit activation loop · our unit-cost model · what to show as «цена/прогон».
> Context: AIAG TMA now has a **live USD-credit ledger (1 credit = 1 US cent)** + per-model markup (default **×1.25**) + author-rent (**0% AIAG cut**) + scheduled runs.
> Every claim is grounded to a source URL + access date. Items I could not verify live are flagged **[unverified]**.

---

## 0. TL;DR recommendation (read this first)

- **Free credit on signup:** give **300 credits = $3.00** (≈ tens-to-hundreds of cheap-model runs), activated on first agent run, not on signup. Gate behind a no-cost action so bots don't drain it.
- **Markup:** keep the **×1.25 (25%)** default on AIAG-supplied models — it is *above* what the big aggregators charge (they run 0% inference markup and earn on top-up fees), which is fine because we are a RU-facing reseller through a foreign entity, not a commodity gateway. Keep **BYOK / own-provider = 0% (already in code)**. This is our honest moat: "свой ключ = 0 комиссии".
- **Show per-run price honestly** as a **post-run actual** ("этот прогон: `1.4` кр") plus a **pre-run estimate range** ("≈ `1`–`3` кр/прогон") on the agent card — never a single fake fixed number, because LLM cost is token-variable.

---

## 1. Markup strategy — what aggregators actually charge & how they present it

### OpenRouter (the reference competitor)
- **Inference markup = 0%.** "We pass through the pricing of the underlying model providers without any markup, so you pay the same rate as you would directly with the provider."
  Source: https://openrouter.ai/docs/faq (accessed 2026-06-04).
- They monetize on the **credit top-up fee**, not on tokens. The FAQ confirms a Stripe/card fee and a crypto/Coinbase fee exist but renders the % dynamically (not in static text). Publicly documented figures (consistent with the FAQ structure): **card ≈ 5.5% + ~$0.35 fixed**, **crypto ≈ 5%**. **[unverified — exact % is JS-rendered]**
- **BYOK fee:** "the first [batch] of requests monthly are free, then there is a fee of [N]% of what the same model and provider would normally cost." The % is JS-rendered; the widely cited figure is **5%**. **[unverified — exact % is JS-rendered]**
  Source: https://openrouter.ai/docs/faq (accessed 2026-06-04).
- **Presentation:** per-million-token input/output prices shown per model; balance in USD credits; fee disclosed only at the top-up step.

### Vercel AI Gateway
- **Zero markup, including BYOK.** "AI Gateway provides tokens with zero markup, including when you bring your own key." Pay-as-you-go USD credits, $5/mo free tier that stops once you buy credits.
- They monetize via **add-on surcharges** (not core tokens): Custom Reporting **$0.075 / 1k writes**, **$5 / 1k report queries**; provider allowlist **$0.10 / 1k requests**; ZDR **$0.10 / 1k requests**. "You're responsible for any payment processing fees."
  Source: https://vercel.com/docs/ai-gateway/pricing (last_updated 2026-05-22, accessed 2026-06-04).

### Poe (consumer-credit comparable — closest to TMA's model)
- Subscription + **compute-points** model: a monthly subscription (historically **$19.99/mo ≈ 1,000,000 points/mo**, plus annual tier) where each bot/message consumes a point amount set per model; creators earn a share. Points are an **abstract credit unit deliberately decoupled from raw token math** so the user never sees tokens. **[unverified — Poe pricing pages returned 403/empty on 2026-06-04; figures from prior public knowledge]**
- **Takeaway for us:** Poe proves the consumer pattern of "one opaque credit unit, per-action cost, hide tokens" — exactly DESIGN.md's "one canonical credit unit, never show contracts/gas."

### Pattern across the market
| Player | Inference markup | How they actually earn | BYOK |
|---|---|---|---|
| OpenRouter | **0%** | top-up fees (~5–5.5%) + BYOK ~5% | small fee |
| Vercel AI Gateway | **0%** | feature surcharges + payment fees | **0%** |
| Poe | n/a (opaque points) | subscription + per-message point spread | n/a |
| **AIAG (us)** | **×1.25 (25%)** | **markup on AIAG models** + deploy + author-rent passthrough | **0% (BYOK free)** |

**Strategic read:** the commodity gateways converged on **0% inference markup + fee-on-money-in**. AIAG is *not* a commodity gateway — it is a RU-market reseller with a curated agent marketplace and a foreign-entity compute layer, so a **visible token markup is defensible** as long as the **BYOK=0% escape hatch is loud**. The risk is only if a power user benchmarks our marked-up token price against OpenRouter's pass-through. Mitigation: position the 25% as "хостинг + рантайм агента", and keep BYOK obviously free.

---

## 2. Free-credit activation loop — how much to give

### Benchmarks (grounded)
- **Freemium → paid:** average **1–10%** (OpenView via Userpilot). Source: https://userpilot.com/blog/freemium-conversion-rate/ (accessed 2026-06-04).
- **Free-trial → paid:** a *good* rate is **~17%** (OpenView via Userpilot). Same source.
- Implication: a free-credit grant behaves like a **reverse free trial** — it must be **large enough to reach the "aha" (a working agent run that returns something useful)** but **small enough that bot/abuse can't farm it**.

### Sizing logic for AIAG
- Our cheap-model run cost (section 3) is **well under 1 credit** for short runs. So even **$1–$3** of free credit buys the user **dozens of real runs** — enough to feel the product without us bleeding.
- Abuse vector: TMA is inside Telegram (sybil-cheap). So **do not grant on signup**; grant on **first successful agent run** or first connect, and **cap concurrent/daily** free spend.
- Recommendation: **300 credits ($3.00)**, single grant, non-refillable, shown as "`300` кр · приветственный баланс". This is generous in *runs* but trivial in $ exposure (worst case if a sybil farms one full grant = $3 of upstream tokens, capped further by the per-agent daily budget that already exists in code).

### Top-up presentation
- Smallest paid pack should be a **low-friction round number** (e.g. **500 / 1500 / 5000 кр**) so the first purchase after the free grant is a small step, not a cliff. Keep multi-crypto (TON/USDT) only; no Stars, no ₽ (per CLAUDE.md).

---

## 3. Unit-cost model — what a typical agent run costs us vs what we charge

Real per-1M-token prices pulled live from OpenRouter's pricing API on 2026-06-04
(`https://openrouter.ai/api/v1/models`, input/output USD per 1M tokens):

| Model (representative) | input $/1M | output $/1M |
|---|---|---|
| gpt-5-nano | 0.05 | 0.40 |
| gemini-2.5-flash-lite | 0.10 | 0.40 |
| llama-3.3-70b-instruct | 0.10 | 0.32 |
| gpt-4o-mini | 0.15 | 0.60 |
| deepseek-chat | 0.20 | 0.80 |
| gpt-5-mini | 0.25 | 2.00 |
| gemini-2.5-flash | 0.30 | 2.50 |
| claude-3.5-haiku | 0.80 | 4.00 |
| gpt-4o | 2.50 | 10.00 |
| o4-mini | 1.10 | 4.40 |

**Typical agent run assumption** (single chat turn with system prompt + short context):
**~1,500 input tokens + ~500 output tokens.**

Per-run **upstream cost** = `1500/1e6 * in + 500/1e6 * out`:

| Model | upstream cost / run | × our credits (1 cr = 1¢) | **our charge @ ×1.25** | **our gross margin / run** |
|---|---|---|---|---|
| gpt-5-nano | $0.000275 | 0.0275 кр | **0.034 кр** | $0.00007 |
| gemini-2.5-flash-lite | $0.00035 | 0.035 кр | **0.044 кр** | $0.00009 |
| gpt-4o-mini | $0.000525 | 0.0525 кр | **0.066 кр** | $0.00013 |
| deepseek-chat | $0.0007 | 0.07 кр | **0.088 кр** | $0.00018 |
| gemini-2.5-flash | $0.00170 | 0.17 кр | **0.21 кр** | $0.00043 |
| claude-3.5-haiku | $0.00320 | 0.32 кр | **0.40 кр** | $0.0008 |
| gpt-4o | $0.00875 | 0.875 кр | **1.09 кр** | $0.0022 |

**Heavier run** (agent w/ tools + memory, ~8k input + ~2k output):

| Model | upstream / run | **our charge @ ×1.25** | margin / run |
|---|---|---|---|
| gpt-4o-mini | $0.0024 | **0.30 кр** | $0.0006 |
| gemini-2.5-flash | $0.0074 | **0.92 кр** | $0.0018 |
| gpt-4o | $0.040 | **5.0 кр** | $0.010 |

**Reading this:**
- A typical cheap-model run costs us **fractions of a cent**; at ×1.25 we charge **<0.1 credit** and net **hundredths of a cent**. Margin-per-run is tiny in absolute terms — **volume + premium-model mix is where money is**, not cheap chat.
- The **$3 free grant** therefore = **thousands of gpt-5-nano/flash-lite runs** or **~hundreds of gpt-4o-mini runs** — far more "aha" surface than needed. We could safely drop the grant to **$1–$2** if abuse appears.
- **Rounding risk:** at 1 credit = 1¢, a cheap run rounds to ~**0.03–0.07 кр**. Do **not** round per-run charges to whole credits (that would 15–30× overcharge and break trust). Keep the ledger in **sub-credit precision** (it already stores cents-as-credits; ensure fractional debits, e.g. 4-decimal credits, are preserved — verify in `settleRun`).

---

## 4. What to SHOW as «цена/прогон» (honest per-run price)

LLM cost is **token-variable**, so a single fixed "цена за прогон" is a lie. Honest pattern (matches PRODUCT.md "UI = reality" + DESIGN.md run-trace + all-numerics-mono):

1. **On the agent card (pre-run):** a **range estimate**, mono, e.g. `≈ 0.1–0.5 кр/прогон` derived from the agent's main model + its typical context size. Label it "оценка". Never a hard single number.
2. **Before confirming a paid run:** show the **daily budget remaining** and the **estimate** ("осталось `42` кр сегодня · этот прогон ≈ `0.3` кр").
3. **After the run (the truth):** show the **actual** in the run-trace cost badge — "этот прогон: `0.34` кр · `1 842` токенов". This is the load-bearing honesty surface (DESIGN.md run-trace already specifies a per-tool cost badge + metrics strip).
4. **BYOK agents:** show "**0 кр · свой ключ**" with a status pill — never a fake number. This is the conversion hook ("свой = 0 комиссии", PRODUCT.md §4 / commission rule).
5. **Author-rent agents:** show rent **separately** from usage — "аренда: `200` кр/мес · использование: ≈ `0.3` кр/прогон" — so the user sees AIAG takes 0% of the rent and only the model markup. (Monetization spec: `docs/specs/2026-06-03-monetization.md`.)
6. **Currency discipline:** one unit "**кр / Credits**", mono numerics, no tokens-as-primary, no ₽, no Stars, no gas/contract (DESIGN.md §Wallet).

**Anti-pattern to avoid:** showing raw token counts as the *primary* price (intimidating, Poe deliberately hides this) — tokens belong in the run-trace detail, credits belong on the surface.

---

## 5. Concrete starter pricing recommendation

- **Free credit:** **300 кр ($3.00)**, granted on **first successful run** (not signup), non-refillable, single grant, protected by the existing per-agent daily budget cap. Drop to $1–$2 if Telegram-sybil farming appears.
- **Markup:** keep **×1.25 (25%)** on AIAG-supplied models; **BYOK / own provider = 0%** (already in code — keep it loud in UI). Revisit downward toward ×1.15 only if a power-user segment churns on token-price comparison vs OpenRouter.
- **Top-up packs:** **500 / 1 500 / 5 000 кр** via TON/USDT; bake any crypto on-ramp fee into the pack price (mirror OpenRouter's "fee at money-in" model) rather than into per-token markup, so the headline markup stays a clean 25%.
- **Per-run display:** estimate-range pre-run (`≈ X–Y кр`) + **actual post-run** in the run-trace cost badge + **0 кр** for BYOK. Never a single fixed per-run number; never whole-credit rounding on cheap runs.
- **Engineering check:** confirm `settleRun` debits **fractional** credits (cheap runs = 0.03–0.4 кр); whole-number rounding would massively overcharge and is the single biggest correctness risk in this pricing.

---

## Sources
- OpenRouter FAQ (0% inference markup; top-up + BYOK fees JS-rendered): https://openrouter.ai/docs/faq — accessed 2026-06-04.
- OpenRouter live pricing API (per-model token prices): https://openrouter.ai/api/v1/models — accessed 2026-06-04.
- Vercel AI Gateway pricing (zero markup incl. BYOK; feature surcharges): https://vercel.com/docs/ai-gateway/pricing — last_updated 2026-05-22, accessed 2026-06-04.
- Freemium / free-trial conversion benchmarks (1–10% freemium, ~17% good trial; OpenView via Userpilot): https://userpilot.com/blog/freemium-conversion-rate/ — accessed 2026-06-04.
- Poe compute-points model — **[unverified 2026-06-04; pages 403/empty]**, from prior public knowledge; used only as a qualitative pattern.

### Verification flags
- OpenRouter exact top-up % (card ~5.5%, crypto ~5%) and BYOK % (~5%) are **JS-rendered**, not confirmable from static fetch on 2026-06-04 — figures are from prior public knowledge and should be re-checked in-browser before quoting externally.
- Poe subscription price / points figures **not re-verified** (pricing pages blocked).
- Exa/Firecrawl search endpoints were down (400/404) on 2026-06-04; research used WebFetch + the OpenRouter JSON API instead.
