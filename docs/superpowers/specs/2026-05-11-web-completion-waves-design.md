# Web Completion — Waves 1–3 Design

**Date:** 2026-05-11  
**Scope:** Phases 4, 5, 6, 7, 8 — complete the AI-Aggregator web MVP  
**Approach:** Three sequential waves; within each wave phases run in parallel via subagents  
**Upstreams available:** OpenRouter, Kie.ai, Ollama Cloud  

---

## Prerequisites (Hard Gates — must be resolved before Wave 1 start)

| # | Gate | Blocks |
|---|------|--------|
| G1 | `OPENROUTER_API_KEY`, `KIE_API_KEY`, `OLLAMA_CLOUD_URL` set on VPS | Wave 1 deploy |
| G2 | Timeweb Object Storage bucket `aiag-storage` created + S3 credentials available | Wave 2 (Phase 6) |
| G3 | Legal content source decided: auto-generate from templates OR user provides text | Wave 1 (Phase 8) |

---

## Wave 1 — Gateway + Upstreams + Legal (Phase 4 + Phase 5 + Phase 8)

*Phase 8 (Legal) has no dependency on gateway — runs in parallel with Phase 4+5.*

### Subagent A: Phase 4 — Gateway v2
- **Branch:** `exec/plan-04-gateway` (~60% done, merge target: master)
- **Remaining work:**
  - Finalize billing middleware: atomic balance debit + dual-bucket settle-charge
  - SSE streaming pass-through from upstream to client
  - Rate limiting: 429 + Retry-After header
  - Wire real upstream keys from env
  - Split WIP commit into conventional commits, merge to master
- **Keys needed on VPS:** `OPENROUTER_API_KEY`, `KIE_API_KEY`, `OLLAMA_CLOUD_URL` (Gate G1)

### Subagent B: Phase 5 — Upstream Adapters
- **Branch:** `exec/plan-05-upstreams` (~75% done, merge target: master)
- **Remaining work:**
  - OpenRouter adapter: wire + smoke test
  - Kie.ai adapter: port from PinGlass `lib/kie-generation.ts` pattern to gateway `AdapterInterface`
  - Ollama Cloud adapter: implement `supports / estimateCost / invoke / healthCheck`
  - Defer: Yandex IAM token cache, GigaChat (post-MVP)
- **Note on Kie.ai images in Wave 1:** upstream URL returned as-is (expiring Kie CDN link). Permanent storage to Object Storage added in Wave 2 Phase 6.

### Subagent C: Phase 8 — Monitoring (Legal pages deferred)
- **Branch:** `exec/plan-08-launch` (restart fresh — previous agent died)
- **Legal pages:** deferred (no deadline yet, Gate G3 not resolved)
- **Monitoring on VPS:**
  - Prometheus + Node Exporter via apt + systemd
  - Grafana dashboard: request rate, error rate, p95 latency, disk, RAM
  - Telegram alerts: error rate >5%, p95 latency >2s, disk >80%
  - Defer: Loki (post-MVP)
- **РКН-уведомление:** human action, not automated
- **Gate G3:** legal content source must be decided before this subagent starts

### Success Criteria (Wave 1)
1. `POST /v1/chat/completions` with `Bearer sk_aiag_*` streams real tokens from OpenRouter
2. Image generation request routes to Kie.ai, returns Kie CDN URL (permanent storage in Wave 2)
3. Open-source model request routes to Ollama Cloud
4. Insufficient balance → `402` with topup link, balance never goes negative
5. Rate limit → `429 + Retry-After`
6. `X-AIAG-Upstream` header on every response
7. Grafana accessible, Telegram alert fires on synthetic test condition

---

## Wave 2 — Marketplace UI (Phase 6)

*Starts after Wave 1 merged to master. Requires Gate G2 (Object Storage).*

### Subagent D: Phase 6 — Marketplace UI
- **Branch:** `exec/plan-06-marketplace` (~80% done)
- **Remaining work:**
  - Model image upload → Timeweb Object Storage (S3-compatible, Gate G2)
  - Replace Wave 1 expiring Kie URLs with permanent Object Storage URLs for generated images
  - SEO pages `/marketplace/[org]/[model]`: JSON-LD structured data, code samples (Python/JS/curl), pricing table
  - Playground now uses real gateway (Wave 1 prerequisite)
  - Defer: advanced comparison landing pages (post-MVP)

### Success Criteria (Wave 2)
1. `/marketplace` renders models with permanent images from Object Storage
2. `/marketplace/[org]/[model]` has JSON-LD structured data and working playground
3. Playground end-to-end: user sends message → real streamed response via gateway

---

## Wave 3 — Supply / Contests (Phase 7)

*Starts after Wave 2 merged to master.*

### Subagent E: Phase 7 — Supply Side
- **Branch:** `exec/plan-07-supply` (~50% done)
- **Remaining work:**
  - Contest creation → submission upload → eval-runner → leaderboard → close flow
  - **Eval sandbox:** `systemd-run --scope` with:
    - `ulimit -t` (CPU seconds), `ulimit -v` (virtual memory), `ulimit -f` (file size in 512-byte blocks)
    - `ReadWritePaths=` restricted to temp dir (prevents disk escape beyond file-size ulimit)
    - nsjail deferred to post-MVP
  - Tiered revshare: 70/75/80/85% to author per tier, sticky once assigned
  - **Monthly settlement cron:** idempotent — must check `settled_at` timestamp before inserting accruals; use DB transaction with advisory lock to prevent double-accrual on restart
  - Payout request flow ≥ 1000 ₽ with 13% withholding (физлицо)
  - Private score hidden from author until contest close (enforced at DB query level, not just UI)

### Success Criteria (Wave 3)
1. Contest: create → submit → score → leaderboard → close works end-to-end
2. `prize_awards` and `author_earnings` correctly populated after close
3. Settlement cron is idempotent — double-run produces no duplicate accruals
4. Eval sandbox: CPU/memory/file-size limits enforced; submission cannot write outside temp dir
5. Admin payout approve flow works (Phase 14 already built)

---

## Deferred (post-MVP)

| Item | Reason |
|------|--------|
| Yandex IAM / GigaChat adapters | Need Russian entity + agreement |
| nsjail eval sandbox | Complex kernel setup; `systemd-run` sufficient for launch |
| Legal pages (`/privacy`, `/terms`, etc.) | Deliberately deferred — no deadline |
| Author self-service consent UI | Phase 14b |
| Loki log aggregation | Monitoring baseline sufficient |
| Foreign entity / Stripe | Phase 9 trigger: MRR > 500k₽ |
| Storybook / MUI cleanup | Phase 3b |
| Permanent image storage in Wave 1 | Object Storage wired in Wave 2 |

---

## Execution Plan

```
Wave 1 (parallel — 3 subagents)
├── Subagent A: Phase 4 Gateway — finalize + merge
├── Subagent B: Phase 5 Upstreams — OpenRouter + Kie + Ollama
└── Subagent C: Phase 8 Legal pages + monitoring

Wave 2 (1 subagent, after Wave 1)
└── Subagent D: Phase 6 Marketplace — image upload + SEO pages

Wave 3 (1 subagent, after Wave 2)
└── Subagent E: Phase 7 Supply/Contests — eval + revshare + payouts
```
