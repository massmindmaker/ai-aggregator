# AIAG TMA — Tech Remediation Roadmap (from the 50/108 eval)

**Date:** 2026-06-02 · **Companion to:** `2026-06-02-tma-tech-stack-108-eval.md` (scoring) and
`2026-06-02-tma-functional-stack-roadmap.md` (feature phases P0–P5). This doc is the **engineering
remediation lens**: what to fix, in what order, in which files, to move the stack score and — more
importantly — to stop the platform from giving away inference for free and from being auth-spoofable.

**Constraints honored:** no-local-runtime (verify on VPS `ai-aggregator.ru` after deploy); bare-metal
pm2+nginx (no Docker for the app); white-label upstreams; two-entity split; AES-GCM reuse; never expose a
personal Telegram handle.

**How this maps to the feature roadmap:** the feature roadmap's **Phase 0** ("billing-truth foundation")
already names the bypass fix. This doc decomposes it into safe, independently shippable waves and adds the
auth/observability/test gaps that the feature roadmap treats as cross-cutting.

---

> **⚠️ Updated 2026-06-02 (post-context7).** R0-4 was rewritten: the JWT-verify middleware **already
> exists** (`middleware.ts` overwrites `x-tma-user-id` from the verified `sub`), so the fix is to **patch
> Next.js (CVE-2025-29927)**, not add a verify. A **new critical money bug** (jUSDT 6-decimals vs
> `toNano()` → 1000× overpay) is added as R1-8. See `2026-06-02-tma-dev-docs-pack.md` for the full,
> context7-sourced API for every item plus the gaps that were missing (CVE floor, idempotency,
> rate-limit, migration tracking, DLQ, backup/DR, moderation, JWT revocation).

## R0 — Money & identity truth (EMERGENCY — do before any marketing push)

> Every item here is a live integrity hole. Until R0 ships, agent runs earn $0 and any client can act as
> any user. Target: dimensions 4 (2→6) and 5 (3→6).

| # | Fix | Files | Effort | Verify on VPS |
|---|-----|-------|:------:|---------------|
| R0-1 | Route `kind='aiag'` → `http://127.0.0.1:4000/v1/chat/completions` with `AIAG_GATEWAY_KEY`; fall back to OpenRouter only if the gateway lacks the model | `agent-worker/src/agent-runner.ts:33-52`, env `/srv/aiag/shared/.env` | M | `gateway_transactions` records agent runs; `X-AIAG-Upstream` hidden from user |
| R0-2 | Debit `tg_user_balances.balance_rub` on completion **inside one tx** with `markCompleted`; gate run-start on `balance_rub >= MIN_RUN_COST` | `agent-worker/src/db.ts` (+`debitBalance`), `agent-runner.ts:254-256, 171-184` | M | zero-balance user can no longer run; balance drops per run |
| R0-3 | Atomic daily-spend: `UPDATE agents SET spent_today_rub = spent_today_rub + $d WHERE spent_today_rub + $d <= daily_budget_rub RETURNING id` (kills 4× TOCTOU) | `agent-worker/src/db.ts:107-116`, `agent-runner.ts:233-242` | S | 4 concurrent runs cannot exceed daily budget |
| R0-4 | **Patch Next.js → ≥14.2.33 (CVE-2025-29927)** + strip `x-middleware-subrequest` at nginx — the existing JWT middleware is **bypassable** on 14.2.15, re-enabling header spoof; also pin `jwtVerify({ algorithms:['HS256'] })` + iss/aud, and add a JWT denylist | `tg-miniapp/package.json`, nginx vhost, `middleware.ts:32` | S-M | a request with `x-middleware-subrequest` still 401s; forged `x-tma-user-id` ignored |
| R0-5 | **Fail hard** if `TMA_JWT_SECRET` unset (throw at startup); remove the `'dev-only-change-in-prod'` fallback | `auth/verify/route.ts:9-11`, `middleware.ts:4-6` | S | missing secret → boot fails, not silent bypass |
| R0-6 | Wire migration `0026` provider columns into the worker (`AgentRow` + `loadAgent` SELECT + `resolveUpstream` `provider_id IS NOT NULL` branch → decrypt `agent_provider_credentials`) | `agent-worker/src/db.ts:11-65`, `agent-runner.ts:33-52` | M | an agent created via the new picker actually routes to its chosen provider |

**R0 acceptance:** on the VPS, a run by a zero-balance user is rejected; a paid run debits balance, records a
`gateway_transactions` row with markup, and is impossible to trigger as another user via a spoofed header.

---

## R1 — Integrity hardening (the rest of the money/trust surface)

> Target: finish dimensions 5 (→7) and 6 (→8); start 9.

- **R1-1** Implement Ed25519 ton-proof (`@ton/crypto.signVerify`) before `is_verified=true`; reject unverified links from gated flows. `src/lib/ton-proof.ts`, `wallet/link/route.ts`.
- **R1-2** Verify NFT webhook `txHash` against TonCenter before incrementing `minted_count` (defense-in-depth over the nginx IP allowlist). `nft/webhook/route.ts`.
- **R1-3** `crypto.timingSafeEqual` for the HMAC compare; cut initData replay window 24h→1h. `verify-init-data.ts:34,38-39`.
- **R1-4** One **canonical credit unit** (USDT-credit ≈ ₽); demote TON/GNK to display rails; reconcile `balance_rub`/`spent_today_rub`/`amount_nano_ton`. Cross-cuts wallet + worker.
- **R1-5** Live FX: fetch USD/RUB (CBR, reuse the gateway's `cbr.ts` pattern) at worker start with refresh; secondary TON-rate source. `agent-runner.ts:24`, `src/lib/ton-rate.ts`.
- **R1-6** Deposit-watch by tx-hash + a server-side reconciler cron (and plan TonAPI Webhooks); drop the last-20 scan. `topup/check/[id]/route.ts:76-77`.
- **R1-7** Worker-side SSRF re-validation before each `fetch` (IPv6 ULA / `::ffff:` / DNS-rebind); shared egress guard. `agent-runner.ts:117`, `src/lib/external-agent.ts`.
- **R1-8 (NEW — critical money bug, context7)** jUSDT is **6 decimals**; using `toNano()` (9 decimals) on a jetton `amount` **overpays 1000×**. Only the message `value` / `forward_ton_amount` (gas, in TON) use `toNano`; the jetton transfer body (op `0xf8a7ea5`, targeting the **sender's** jetton wallet) must encode the amount in 6-decimal units. Audit every topup/jetton-transfer path. `topup/init/route.ts`, the jetton helper.

---

## R2 — Reliability & observability (make the money path visible)

> Target: dimensions 9 (4→7) and 10 (3→7).

- **R2-1** Enqueue failure → HTTP 503 + `failed_to_enqueue` status (no more silent `pending` forever); bound the BullMQ queue depth + per-user in-flight runs. `agents/[id]/run/route.ts:60-76`.
- **R2-2** Replace 1500ms polling with SSE run-status keyed by `runId` over Redis pub/sub (the gateway already proves SSE). `agents/[id]/page.tsx:142`, new SSE route.
- **R2-3** OpenTelemetry spans across worker→gateway→tool with one `traceId`/`runId`; **self-hosted Langfuse** (MIT) as the sink. **Avoid Helicone** (maintenance mode, Mar 2026); if LiteLLM is ever vendored in the gateway, hash-pin (Mar-2026 PyPI compromise).
- **R2-4** Structured logging (pino) in TMA + worker, replacing `console.*`; the new `tool_calls` table is the durable per-call audit feeding the run-trace screen (feature roadmap Phase 3).
- **R2-5** Shared `sql` singleton module to stop per-request pool churn. `src/lib/db.ts` (new) imported across routes.
- **R2-6** Soft-delete the agent DELETE handler (`UPDATE status='deleted'`) to stop cascade-destroying billing history. `agents/[id]/route.ts:139-145`.

---

## R3 — Supply engine & runtime depth (MCP + framework layering)

> Target: dimensions 2 (6→8) and 7 (5→8). Maps to feature roadmap Phases 1/2/4.

- **R3-1** `apps/mcp-gateway` (Hono) on `@modelcontextprotocol/sdk@^1.29` **`WebStandardStreamableHTTPServerTransport`**, per-request `McpServer` factory keyed by `agentId`, `authInfo` bearer from `agent_provider_credentials`; per-call `aiag_deduct_tool_call`. **Do not** treat `mcp-context-forge` as a minting SDK (it's a federation proxy).
- **R3-2** Key-broker tool rail (Firecrawl first) wired into `executeTool` cost accumulation. `agent-worker/src/tools.ts`, new `broker.ts`.
- **R3-3** Layer **Vercel AI SDK v6** (`createOpenAICompatible` → `:4000`, `useChat` in the TMA) for streaming, and **Mastra as a library** (Memory/Workflows/PgVector/MCP) over the existing loop — Apache-2.0, avoid the CLI on Bun, never import `ee/`.
- **R3-4** pgvector semantic memory in the existing Postgres (HNSW; embeddings through the gateway so spend is billed). Sibling to the KV `agent_memory`.
- **R3-5** Streaming + cancel: SSE token streaming for chat + a Redis cancel-flag the loop checks each iteration. `agent-runner.ts` loop.

---

## R4 — Compliance & legal architecture (deadline-driven)

> Target: dimension 12 (3→7). **Legal gate before scale.**

- **R4-1** 152-ФЗ: PDN consent screen before storing Telegram profile fields; privacy/ToS links; data-residency notice. `tg_users` write path.
- **R4-2** Data-export + account/data-deletion endpoints (152-ФЗ Art. 14 / right-to-erasure).
- **R4-3** OFD/54-ФЗ fiscal receipts for RUB top-ups on the **RF entity**. `topup/*`.
- **R4-4** Formalize the **two-entity split** (RF fiat/web + foreign agentic/crypto) — mandatory from **Jul 1 2026** (RU licensed-intermediary regime; liability from Jul 1 2027). Keep all crypto settlement off the RF entity; **do not self-host an x402 facilitator from the RU side**. Counsel required.

---

## R&D track (explicitly NOT marketed as live)

- **Hermes managed per-user runtime** (`NousResearch/hermes-agent`, MIT) — GO conditional: pod-per-user + memory caps + scheduled restarts + pinned release (`v2026.5.29.2`) + base-URL → `:4000` gateway (closes billing bypass for Hermes too). Integrate against the **real** API surface (`PUT /api/config`, `POST /api/model/set`, `/api/mcp/servers`, `/api/skills/toggle|hub/install`, `/api/cron/jobs`) — the previously assumed endpoints don't exist. Spike: RSS-over-time + concurrent-users-per-VM ceiling; Daytona/Modal hibernate for idle cost.
- **x402** client-side only, foreign entity (agents paying outward); never a RU rail.
- **Gonka GNK** — spike OpenAI-compat endpoint + latency + settlement before any live card; keep off the synchronous run path.
- **agentic.market steal:** machine-readable `GET /v1/services` + `/search` + `llms.txt` discovery surface; Service/Endpoint object model with `1P`/`3P` + `exact`/`upto` pricing; server-side ranking + aggregate hero stats — **not** per-card live metrics (which don't exist).

---

## Sequencing summary

```
R0 (emergency: money + identity)         ── unblocks revenue + closes auth bypass
   └─> R1 (integrity hardening)
   └─> R2 (reliability + observability)   ── R1/R2 parallelizable after R0
          └─> R3 (MCP supply + framework depth)
R4 (legal) runs in parallel; its two-entity gate blocks any crypto-settlement scale (Jul 1 2026)
R&D (Hermes/x402/Gonka) after R0+R2, never marketed as live until real
```

**Projected score lift if R0–R2 land:** dim 4 (2→6), 5 (3→7), 9 (4→7), 10 (3→7), plus 3 (3→6 via R0-1/R0-6)
→ roughly **50 → ~72/108**, with the remaining gap mostly in supply depth (R3), testing (needs its own pass),
and compliance (R4).

> **Testing is the silent debt** (dimension 11, 3/9) — every R0 fix touches money or auth and currently has
> zero tests. Add unit tests for `resolveUpstream`/budget math + an integration test of the
> enqueue→worker→gateway-settle path **as part of** R0, not after.

---

*Remediation roadmap — 2026-06-02. Pairs with the 108 eval; both feed the existing feature roadmap's Phase 0.*
