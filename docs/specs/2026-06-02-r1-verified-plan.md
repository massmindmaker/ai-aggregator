# R1 — Verified Execution Plan (code-grounded)

**Date:** 2026-06-02 · **Method:** 8 parallel investigators read the live code per R1 item + independent adversarial verification of every money/security finding (ultracode workflow `wf_db4a3a8c-a3e`, 16 agents). Supersedes the R1 section of `2026-06-02-tma-tech-remediation-roadmap.md` where they disagree — the roadmap had stale/phantom claims.

## Verdicts (verified against actual code)

| Item | Verdict | Sev | Effort | One-line |
|------|---------|-----|--------|----------|
| **R1-2** NFT webhook | **confirmed_bug** | high | M | Webhook is public + unauth'd, increments `minted_count` with ZERO on-chain check; the "nginx IP-allowlist" it relies on **does not exist** in either vhost. |
| **R1-6** deposit-watch | **confirmed_bug** | high | M | Topup confirm = client-poll over last-20 TonCenter txs → user can permanently lose funds (app closed / >10min / >20-tx window). No reconciler cron. Also may already be silently broken on v3 field-shape. |
| **R1-7** worker SSRF | **confirmed_bug** | high | M | Worker fetches user-controlled `base_url`/`external_base_url` with zero run-time SSRF check → DNS-rebind + decrypted-key exfil. external_openai branch live; provider_id branch latent (no write-path yet). |
| **R1-5** live FX | **confirmed_bug** | medium | S | `USD_TO_RUB=90` hardcoded (agent-runner.ts:30) = the real user charge; gateway uses live CBR ~92. Margin drift (under-charges, conservative). |
| **R1-3** initData | **confirmed_bug** | medium | S | HMAC compare non-constant-time `!==` (low risk) + **24h** replay window (material; Telegram guidance ~1h). |
| **R1-1** ton-proof | **partial / hardening** | medium | M | `verifyTonProof` is a no-op `return false`, never called. Roadmap's "sets is_verified=true / steal wallet" is **REFUTED** — it's hardcoded FALSE and read nowhere meaningful. Latent gap, no live exploit. |
| **R1-4** canonical unit | **needs_design** | high | L | "No canonical unit" framing **refuted** — RUB already canonical. Real gap = double-ledger (worker `tg_user_balances` vs gateway org credits) + 3 FX feeds. **Founder decision needed.** Code strongly implies the two ledgers are intentional (markup model), not a double-charge. |
| **R1-8** jUSDT 1000× | **REFUTED — DROP** | none | — | **No jetton path exists.** Zero `toNano`/`jetton`/`storeCoins` in any source. Native-TON decimals correct end-to-end. The "1000× overpay (NEW critical)" bug is a phantom. |

## Execution order

**Wave 0 — DECISION GATE (no code):** R1-4 founder call — is the `:4000` gateway the single billing authority (then `tg_user_balances` = projection keyed by `request_id`), or are the two ledgers deliberately separate (gateway org = AIAG cost-of-goods on one house key; `tg_user_balances` = end-user prepaid RUB price)? Code (`agent-runner.ts:84-86`, one shared `AIAG_GATEWAY_KEY`) strongly implies the **latter** → then it is the intended markup model (NOT a double-charge) and R1-4 collapses to FX-unification (= R1-5) + a precision migration + a reconciler (L→S). Inert risk today (0 agents on prod) but architecturally active now that the gateway key is wired.

**Wave 1 — ship now, no decision needed (parallelizable):**
- **R1-2 + R1-6** (high) — share a new `packages/shared/src/toncenter.ts` (TonCenter-by-hash), built ONCE, two consumers. Shared `UNIQUE(tx_hash)` idempotency. Migrations: R1-6 = `0027_tg_topups_tx_hash_unique`, R1-2 = `0028_webhook_events` (sequence to avoid collision).
- **R1-7** (high) — new `apps/agent-worker/src/lib/egress-guard.ts` `safeFetch` (DNS-resolve-before-connect, reject private/loopback/link-local/ULA/`::ffff:`/encoded-IPv4, pin connect to vetted IP to close TOCTOU). Allowlist `127.0.0.1:4000` + OpenRouter. Reuse classifier in `external-agent.ts` create-time guard.
- **R1-5** (S) — parameterize `estimateCostRub(...,rate)`, read gateway's existing Redis `cbr:usd_rub:today` (spread already baked — do NOT re-apply); fallback 92.
- **R1-3** (S) — `crypto.timingSafeEqual` (with length-guard) + `INIT_DATA_MAX_AGE_SEC=3600`.

**Wave 2 — after Wave-0:** R1-4 (only if "single authority"); R1-1 (hardening; reuse installed `@ton/crypto.signVerify`+`@ton/core`, no new deps; widened verifier signature + server nonce + client `setConnectRequestParameters`).

**Drop:** R1-8 (refuted) — re-scope roadmap line; add a CI grep asserting `toNano` never lands on a jetton body amount.

## Cross-cutting
- R1-2⊃R1-6: one TonCenter client; migration 0027(R1-6)/0028(R1-2).
- R1-5⊂R1-4: same FX root; if "single authority", FX application point may move to credit-grant — coordinate.
- R1-3⊃#8/T-15.1-10: 1h initData window only fully helps if JWT TTL (24h) is cut + denylist wired (soft dep).
- Two-entity split: TON rails (R1-1/2/6) = foreign-crypto entity; `balance_rub` = RF entity. Reconcilers must NOT move a crypto-rail amount into the RF fiat ledger without the explicit credit-grant boundary. nano-TON stays transfer/display; RUB stays the only spendable unit.
- Ops: no-local-runtime (verify on VPS); prod ALTER via `sudo -u postgres psql aiag`; tg-miniapp built manually on `/srv/aiag/web-repo`; white-label (R1-2/R1-6 keep provider brand hidden); never expose a personal Telegram handle.

*Full per-item evidence (file:line) in workflow run `wf_db4a3a8c-a3e` output.*
