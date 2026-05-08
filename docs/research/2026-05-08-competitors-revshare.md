# AI Marketplace Author Payout / Revshare — Competitor Research

**Date:** 2026-05-08
**Phase:** Phase 14 — Marketplace publish flow (AIAG)
**Goal:** Bench AIAG's 70/75/80/85% sticky-tier author flow vs. global incumbents.

---

## Comparison Matrix

| Platform | Creator vs Platform Split | Payout Cadence | Min Payout | KYC / Tax | Hosting Model | Tier System | Author Dashboard |
|---|---|---|---|---|---|---|---|
| **Replicate** | No formal % split. Authors set their own per-second price on **public models**; Replicate takes a markup over GPU cost. Authors earn delta when others run their model. Effectively ~50–70% net to author depending on price set. | Monthly, on Stripe Connect | Stripe Connect default ($1+, but practical ~$25 accrual) | W-9 / W-8BEN via Stripe Connect; 1099-NEC for US | **Platform-hosted** (Cog containers, autoscale on Replicate GPUs) | None — pricing is open-set per author | Runs, revenue, P50/P99 latency, cold-start, error rate |
| **Hugging Face** | **No direct revshare** for model authors. Authors monetize via: (1) Inference Endpoints (author pays HF for hosting, sells API themselves), (2) Pro/Enterprise gated models, (3) being chosen as Inference Provider. HF stated future revshare "under consideration". | N/A for authors; partner contracts only | N/A | Stripe / partner contracts | **Hybrid** — author-deployed Endpoints OR third-party Inference Providers (Together, Fal, Replicate, etc.) | None | Endpoint metrics, downloads, likes — no monetary dashboard |
| **OpenRouter** | Provider sets price; OR adds **5.5% credit-purchase fee** ($0.80 min). No markup on inference itself. Provider gets 100% of inference, OR earns on credit float + BYOK fee (5%). | Per provider contract | Provider-defined | Provider handles own KYC/tax (B2B contract) | **Author-hosted** (provider runs own infra) | None — model price set by provider | Per-model usage stats, latency, ranking |
| **Civitai** | **Compensation pool** model (revenue share of Buzz purchases), not flat %. Creators "Bank" Buzz monthly → share of pool proportional to Banked Buzz. Ratio ~1000 Buzz = $1. | **Monthly** (15-day pending → 15th of month) | **$50** | Tipalti onboarding — W-9/W-8, 1099-K treatment, KYC/AML, TIN match, international supported | **Platform-hosted** generator (LoRAs run on Civitai infra) | None — pool-share, not tier % | Buzz earned, banking history, payout queue, tax docs |
| **fal.ai** | Marketplace in early stage. Featured labs (BFL, Kling, Minimax, ByteDance) on **bespoke commercial contracts**. Public split not disclosed; reportedly ~60–70% to model lab on featured tier. | Per contract (monthly typical) | Contract-defined | Enterprise contract — direct invoicing | **Platform-hosted** (fal serverless GPU) | Implicit: "Featured Partner" vs community publish | Limited public; partners get per-call telemetry |
| **Together.ai** | **Not a marketplace** for monetization. Authors deploy fine-tuned/custom models on Dedicated Endpoints — they pay Together per-GPU-minute and resell themselves. No revshare on serverless catalog. | N/A (cost center, not revenue) | N/A | N/A | **Platform-hosted** dedicated GPU | None | GPU utilization, tokens/min, p99 latency |

---

## Key Insights for AIAG Phase 14

1. **Sticky tier 70/75/80/85% is unusually generous and competitor-leading.** Replicate and fal effectively land at 50–70% net to author after compute markup; Civitai's pool model is opaque and often <50% effective. AIAG's tier ladder is a real differentiator — keep it, market it explicitly.

2. **Monthly cadence + ~$50 min payout is the industry default.** Civitai $50/15th-of-month is the closest analog. Don't go weekly (cashflow burden) and don't go below ~3000₽ min payout — under that, payment fees eat margin.

3. **Hold/clawback period is universal.** Civitai uses 15-day "Pending Settlement". Replicate via Stripe has rolling reserve. AIAG must implement a `pending_until` field on payout rows for chargebacks/abuse claims (suggest 14 days).

4. **KYC/tax must be collected BEFORE first payout, not at signup.** All competitors gate the *withdraw* button on tax-form submission — never the publish button. For RU: ИП/самозанятый ИНН + reg, физлицо НДФЛ-агентом (AIAG удерживает 13%). Mirror Tipalti's "complete tax form to unlock withdrawal" UX.

5. **Platform-hosted wins for marketplace UX.** Replicate, Civitai, fal.ai all platform-host. Author-hosted (HF Endpoints, OpenRouter) shifts ops burden to authors and hurts conversion. AIAG's Cog-on-our-GPU model is correct — confirms Phase 14 hosting decision.

6. **Author dashboard MVP must show: runs, revenue (gross/net/tier%), payout queue, latency P50/P99, error rate.** Replicate's dashboard is the gold standard — copy it. Civitai's "Banking phase" complexity is a *negative* example — keep our tier display dead-simple.

7. **Pricing autonomy = Replicate's killer feature.** Authors set per-run price; platform takes fixed margin on top of compute. AIAG should let authors set price within bounds (compute cost × 1.2 floor, × 10 ceiling) and lock tier % as separate dial.

8. **No competitor publishes "tier ladder by lifetime revenue".** Sticky 70→85% by GMV is genuinely novel. Rule: tier should ratchet UP only (never down) — once 85%, always 85%. Reduces author anxiety, mirrors Twitch Partner stickiness.

9. **Tipalti or Stripe Connect for international.** RU-first means Tinkoff/ЮKassa for ИП/самозанятые is primary, but build payout adapter abstraction now — global Tipalti integration is Phase 16+ unlock for CIS authors.

10. **Featured slot economics matter.** fal's "Featured Partner" tier (curated, manual deal) generates outsized GMV. AIAG should reserve admin-curated "Featured" placement as a separate concept from sticky tier — editorial pick, not algorithmic.

---

## Sources

- [Replicate Billing](https://replicate.com/docs/topics/billing)
- [Replicate Pricing](https://replicate.com/pricing)
- [Replicate Publish Model](https://replicate.com/docs/topics/models/publish-a-model)
- [Hugging Face Pricing](https://huggingface.co/pricing)
- [Hugging Face Inference Providers Pricing](https://huggingface.co/docs/inference-providers/pricing)
- [OpenRouter Pricing](https://openrouter.ai/pricing)
- [OpenRouter FAQ](https://openrouter.ai/docs/faq)
- [Civitai Creator Program](https://civitai.com/creator-program)
- [Civitai Buzz Terms](https://civitai.com/content/buzz/terms)
- [Civitai Creator Program — First Cycle Update](https://civitai.com/articles/13199/civitai-creator-program-update-a-successful-first-cycle)
- [Civitai Education — Earning Guide](https://education.civitai.com/civitais-guide-to-earning-with-the-creator-program/)
- [fal.ai About](https://fal.ai/about)
- [Sacra — fal.ai analysis](https://sacra.com/c/fal-ai/)
- [Together AI Dedicated Endpoints](https://docs.together.ai/docs/dedicated-endpoints)
- [Together AI Pricing](https://www.together.ai/pricing)
- [Tipalti — 1099 / W-9 / KYC](https://tipalti.com/blog/w9-vs-1099/)
