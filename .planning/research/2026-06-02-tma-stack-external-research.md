# AIAG TMA — External Stack Research Synthesis (2026-06-02)

External research pass over 6 parallel agents: Hermes runtime, agentic.market storefront, runtime frameworks (Mastra / Vercel AI), MCP stack, Telegram+crypto stack, and competitive+legal landscape. This feeds the 108-point tech-stack evaluation. Sources are cited inline.

---

## 1. Executive summary — 10 headline takeaways

1. **Hermes is adoptable as the R&D per-user runtime, but only with hard isolation.** `NousResearch/hermes-agent` is MIT, extremely active (weekly date-stamped releases, latest `v2026.5.29.2`), and a pure remote-API client — no GPU/weights. Ports `:8642` (OpenAI-compatible `/v1`) and `:9119` (dashboard) and `~/.hermes/config.yaml`+`.env` are all confirmed in source. BUT it is single-tenant-local by design (localhost binds, per-process token) and self-documents RSS growth over hours, so a managed per-user tier needs container/pod isolation, port namespacing, memory caps + scheduled restarts, and a pinned release. (https://api.github.com/repos/NousResearch/hermes-agent)
2. **Point Hermes at AIAG's own gateway and the billing-bypass bug closes itself.** Hermes supports an arbitrary OpenAI-compatible "custom endpoint" provider; set each managed instance's base URL to AIAG's `:4000` gateway and all markup/billing flows through AIAG while the white-label upstream stays hidden. (gateway/platforms/api_server.py)
3. **agentic.market validates "zero-key, one-wallet, pay-per-call discovery" — but the per-card live-metrics feature AIAG wanted to copy does not exist.** Live API returns 1011 services with price-on-card only; calls/payers/last-active live one layer down in Coinbase's CDP "x402 Bazaar" ranking layer (recomputed every 6h), never shown per-card. Don't build a non-existent feature. (https://api.agentic.market/v1/services)
4. **The highest-leverage, lowest-cost steal is a machine-readable discovery surface + `llms.txt`.** Ship `GET /v1/services` + `/v1/services/search?q=` style JSON `{items,total,limit,offset}` over models/skills/MCP-tools, plus a root `llms.txt` documenting both — so any agent (and AIAG's own worker) finds the catalog at runtime. (https://agentic.market/llms.txt)
5. **Build the MCP gateway on `@modelcontextprotocol/sdk@^1.29` + `WebStandardStreamableHTTPServerTransport` under Hono/Bun.** The official `honoWebStandardStreamableHttp` example is a near-exact template; a per-request `McpServer` factory keyed by `agentId` gives free per-tenant isolation and stateless mode fits the stateless OpenRouter loop. SSE transport is hard-`@deprecated`. (https://registry.npmjs.org/@modelcontextprotocol/sdk)
6. **The "Elastic v2 license" fear on Mastra is unfounded — both Mastra and Vercel AI are Apache-2.0.** Only Mastra's `ee/` (FGA-auth) dir is non-Apache; never import it. Adopt Vercel AI v6 (stable; v7 in beta) for streaming to the gateway + `useChat` in the TMA (lowest-risk), layer Mastra as a *library* (avoid CLI/bundler/deployer in Bun monorepos). (https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)
7. **grammY delivers "agent acts in your DMs" for free over plain HTTP Bot API — no MTProto/userbot needed.** Business Connection is first-class since Bot API 7.2; `business_connection_id` is a standard `sendMessage` param. The misleading `core.telegram.org/api/bots/connected-business-bots` page describes the MTProto *client* view of the same feature and does not apply to grammY. (https://grammy.dev/advanced/business)
8. **x402 is a UX/discovery pattern to steal, NOT a payment rail for the RU entity.** It is now a Linux Foundation standard (canonical repo `x402-foundation/x402`; `coinbase/x402` is now a fork), is Base/Solana USDC (separate rail from TON), and self-hosting a settling facilitator (`x402-rs`) from an RU ИП carries serious sanctions/MSB/freeze risk. Use x402 client-side only (agents paying outward) or in the foreign entity. (https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation)
9. **Observability plan ("OTel + tool_calls table") is validated and well-timed — adopt self-hosted Langfuse, avoid Helicone, harden LiteLLM.** Helicone went into maintenance mode after the Mar 3 2026 Mintlify acquisition; LiteLLM had a PyPI supply-chain compromise (1.82.7/1.82.8, Mar 24 2026). Langfuse (MIT core, OTel-native, v3.177.x) is the safe choice. (https://github.com/langfuse/langfuse)
10. **The two-entity split (RF fiat + foreign crypto/x402) is now a hard legal requirement, not just structuring.** From Jul 1 2026 RU licensed-intermediary regime kicks in; RF entities are explicitly barred from accepting crypto for services; criminal/admin liability for out-of-framework operation starts Jul 1 2027. The Jan 20 2026 Constitutional Court ruling (No. 2-P) strengthens crypto-as-property but does NOT permit domestic crypto payments. (https://iidx.ru/blog/zakon-o-cifrovoy-valyute-2026-kriptobirzhi-rossiya/)

---

## 2. Hermes runtime — verified facts, maturity, per-user operational risk, go/no-go

### Verified facts (all confirmed in source)
- **License:** MIT (GitHub API `license.spdx_id=MIT` + LICENSE in repo root). Favorable for AIAG reuse.
- **Activity/recency:** created 2025-07-22; last push 2026-06-01; date-stamped weekly releases (`v2026.5.29.2`, `v2026.5.29`, `v2026.5.28`, …); daily commit cadence; default branch `main`.
- **Popularity:** ~175,950 stars / ~30,008 forks (treat exact star count with mild caution; unambiguously top-tier).
- **It is a thin orchestrator/client, NOT an inference server.** All LLM calls go to remote providers (Nous Portal 300+, OpenRouter 200+, NovitaAI, Gemini, z.ai, Kimi, MiniMax, OpenAI, custom endpoints). A per-user instance is a normal Python+Node process — **no GPU, no local weights.** Markets running on a "$5 VPS"; only hard model requirement is a ≥64K context window. (README)
- **PORT 8642 CONFIRMED:** `gateway/platforms/api_server.py` `DEFAULT_PORT = 8642`; OpenAI-compatible adapter, `POST /v1/chat/completions`, stateless with opt-in session continuity via `X-Hermes-Session-Id` / `X-Hermes-Session-Key` headers.
- **PORT 9119 CONFIRMED:** `web/README.md` + `hermes_cli/web_server.py` — FastAPI backend on `127.0.0.1:9119` serving a Vite/React 19/Tailwind v4 SPA.
- **Config CONFIRMED:** `~/.hermes/config.yaml` is "the single source of truth"; secrets in `~/.hermes/.env`; `HERMES_HOME` overrides home.
- **Config-injection control plane CONFIRMED (real shapes, from `web/src/lib/api.ts`):** `PUT /api/config {config}`, `PUT /api/config/raw {yaml_text}`, `PUT /api/env {key,value}`, `DELETE /api/env {key}`, `POST /api/env/reveal` (token-gated), `POST /api/model/set`, `GET /api/config/schema|/defaults`, `GET /api/model/options`. MCP via `GET/POST/DELETE /api/mcp/servers` (+`/test`); profiles `/api/profiles` (+`/soul`, `/setup-command`); skills `PUT /api/skills/toggle` + `POST /api/skills/hub/install`; cron `/api/cron/jobs` (+`pause/resume/trigger`).
- **Dashboard auth CONFIRMED and non-trivial:** `hermes_cli/dashboard_auth/` — ephemeral per-process session token, CORS locked to localhost, OAuth gate auto-engages when bound non-loopback, DNS-rebinding Host allowlist.
- **Features CONFIRMED:** Skills (`SKILL.md`+frontmatter, agentskills.io standard, Skills Hub install/update, self-improvement loop); sub-agents (`tools/delegate_tool.py` spawns child `AIAgent`s in a `ThreadPoolExecutor` with isolated context/toolsets/terminal — **NOT tmux**); swarm (`mixture_of_agents_tool.py` MoA arXiv:2406.04692 + `hermes_cli/kanban_swarm.py`); cron; FTS5 cross-session search; Honcho dialectic user-modeling; 40+ tools; isolation backends local/Docker/SSH/Singularity/Modal/Daytona.
- **Front-ends are bundled in-repo, NOT separate repos:** `web/` (dashboard) + `apps/desktop/` (Electron). Telegram is one of ~15 gateway PLATFORM adapters (`gateway/platforms/telegram.py`), not a standalone mini-app.

### Maturity
High in features, but a **massive churning backlog: ~5,636 open issues + ~10,638 open PRs**, daily commits, weekly releases. The API surface and config schema are moving targets. ~61 declared deps with `[all]`/`[termux]`/`[rl]` extras (`[rl]` pulls torch/wandb).

### Per-user managed-tier operational risk
- **Memory is the marquee risk and it is self-documented:** `gateway/memory_monitor.py` states the long-lived gateway "accumulates memory as it caches agent instances, session transcripts, tool schemas, memory providers, MCP" — RSS climbs over hours and emits `[MEMORY] RSS` log lines. The repo ships `gateway/restart.py` — restarts are expected. **One such process per user** means a $5/1GB VPS will OOM beyond a handful of concurrent users.
- **No multi-tenancy:** localhost binds, per-process token. "Managed cloud Hermes" = one isolated process+home+port pair per user, which AIAG must orchestrate (k3s pod-per-user is the clean model), reverse-proxy, and namespace (defaults 8642/9119 collide; override `API_SERVER_PORT`/`API_SERVER_HOST`/`HERMES_HOME`).
- **Agent autonomy = sandbox-escape risk:** spawns subagents, runs shell, executes code, drives a browser, self-modifies skills. Container isolation is **mandatory** for untrusted users in RU jurisdiction (Docker/Singularity/Modal/Daytona backends exist).
- **Egress dependency:** all inference is remote → every instance needs outbound HTTPS to providers (RKN egress consideration), unless pointed at AIAG's gateway.
- **Dep/cold-start weight:** image pulls Python 3.13 + Node 22 + ffmpeg + ripgrep + docker-cli; use curated extras, not `[all]`/`[rl]`.

### GO / NO-GO for the R&D tier
**GO, conditional (R&D only).** Adopt Hermes as the per-user managed runtime IF and ONLY IF: (a) one container/pod per user with hard memory caps + scheduled restarts; (b) ports namespaced per instance; (c) provider base-URL pointed at AIAG's `:4000` gateway (closes billing bypass); (d) pinned to a specific release tag (e.g. `v2026.5.29.2`) with re-verification on upgrade; (e) integration targets the **real** API surface, not the assumed endpoints. Daytona/Modal hibernate-when-idle backends are a near-drop-in answer to "costs ~nothing when idle." Treat as R&D — not near-term production — given churn and isolation cost.

---

## 3. agentic.market — what to steal, what to avoid (Маркет supply surface)

### What to steal (concrete)
- **Machine-readable discovery surface NOW (highest leverage):** clean `GET /v1/services` returning `{services:[...], total, limit, offset}` (paginates 50/page) + `GET /v1/services/search?q=` over models/skills/MCP-tools, plus a root **`llms.txt`** that documents both endpoints with a copy-pasteable example response. Tagline to mirror: "Browse and call services — no API keys, no accounts, pay per request."
- **Two-tier object model verbatim:** a **Service** wrapper (`id,name,description,domain,provider,providerUrl,category,networks[],enriched,integrationType '1P'|'3P',isNew,priceSummary{minAmount,maxAmount,avgCostPerTransaction,avgCostBasis,currency},serviceName,tags[],iconUrl,endpoints[]`) containing **Endpoints** (`url,method,description,pricing{amount,currency,network,scheme,maxAmount,minAmount},parameters[{group,name,type,description,example,enumValues,default,required}]`). Maps cleanly: model = endpoint, skill/MCP-tool = service-with-endpoints. The **`1P`/`3P` flag** is perfect for AIAG-native vs BYO/partner providers.
- **Pricing-scheme concept:** `scheme:'exact'` for fixed-price skills, `scheme:'upto'` (min/max band) for token-metered inference — solves the variable-cost display problem honestly while still showing a price.
- **Publisher pitch as positioning copy:** "expose your endpoint metadata; agents find and pay without accounts, sales calls, or API-key setup" — exact value-prop for P1A "connect your own OpenAI-compatible agent."
- **Self-indexing AIAG-style:** make the AIAG gateway the "facilitator" — first successful billed call through the gateway auto-lists the tool, with a recency window. Same "used ⇒ listed" loop, no crypto.
- **Aggregate trust metrics as hero stats:** the site shows only network-wide 1D volume / all-time TPV / a transactions chart — cheaper and less gameable than per-card live counters.
- **Server-side quality-signal ranking** (call volume, distinct payers, recency, metadata completeness) recomputed on a schedule (CDP Bazaar uses a 6-hour cadence) to order search — instead of UI effort on per-card live counters.
- **Free listing / take via runtime markup** — listing fees kill long-tail supply.

### What to avoid
- **Do NOT build "live metrics on every card"** — it does not exist on agentic.market (REFUTED, see §5). Only PRICE is on cards.
- **Do NOT adopt x402/USDC settlement as the rail** — chain-native (Base/Solana), conflicts with RU jurisdiction + TON-Connect reality; the "self-index magic" is coupled to Coinbase's CDP Facilitator. (Header migration note: current spec uses `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`, not the older `X-PAYMENT*`.)
- **Do NOT promise exact prices you can't compute** — `priceSummary.avgCostPerTransaction` is frequently empty and `'upto'` bands are wide (e.g. $0.001–$10).
- **Beware 30-day recency culling** — a Bazaar-style index drops low-traffic tools; cold-start/long-tail problem for a new marketplace.

Endpoint corrections: actual paths are `/v1/services` + `/v1/services/search?q=` on `api.agentic.market` (not `/v1/tools`); deeper CDP layer is `/v2/x402/discovery/resources` + `/search`; no `/.well-known/*` exists.

---

## 4. Stack verdict table

| Library | Version | License | Verdict | One-line why |
|---|---|---|---|---|
| **mastra** (`@mastra/core`) | 1.37.1 | Apache-2.0 (only `ee/` FGA-auth dir non-Apache) | **ADOPT (caution)** | Hono- & AI-SDK-native Memory/PgVector/Workflows/MCP — embed as a *library* only; avoid CLI/bundler/deployer in Bun monorepo; never import `ee/`. |
| **vercel-ai** (`ai`) | 6.0.194 (v7 beta) | Apache-2.0 | **ADOPT** | Framework-agnostic v6 streaming to AIAG `:4000` via `createOpenAICompatible`; `useChat` in TMA; lowest-risk streaming. Pin majors (three churning). |
| **mcp typescript-sdk** (`@modelcontextprotocol/sdk`) | 1.29.0 | MIT | **ADOPT** | Official Hono-native `WebStandardStreamableHTTPServerTransport` + per-request `McpServer` factory mints isolated `/t/{agentId}/mcp`; spec 2025-11-25; SSE deprecated. Pin `^1.29` (avoid v2/main). |
| **mcp-context-forge** (`mcp-contextforge-gateway`) | 1.0.2 | Apache-2.0 | **CAUTION** | Credible federation proxy (FastAPI+Postgres+Redis, JWT+teams+RBAC) that sits IN FRONT OF MCP servers — not a per-agent endpoint-minting SDK; reference/optional layer, heavy Python footprint + 2nd auth system. |
| **grammY** (`grammy`) | 1.43.0 | MIT | **KEEP** | Bot API 10.0; first-class HTTP-native Business Connection = "agent in your DMs" with no MTProto; works on Bun. |
| **ton-connect** (`@tonconnect/ui-react`) | 2.4.4 (sdk 3.4.1) | Apache-2.0 | **KEEP** | Current, native fit for RU-friendly TON-USDT billing; centralize the jetton-transfer helper + use TonAPI Webhooks (not deprecated SSE) for deposit-watch. |
| **x402** (`x402-foundation/x402` V2) | V2 (npm `x402` 1.2.0 = legacy V1) | Apache-2.0 | **ADOPT client-side / CAUTION server-side** | Great for letting AIAG agents autonomously pay for x402-gated APIs (low risk); Base/Solana rail separate from TON; pin to V2 + foundation repo (`coinbase/x402` now a fork). |
| **x402-rs** (`x402-rs/x402-rs`) | crates v1.3.0 (facilitator binary) | Apache-2.0 | **CAUTION (legally AVOID from RU entity)** | Genuinely production-ready self-hostable Rust facilitator, but self-custodies a settlement private key → serious sanctions/MSB/freeze risk for an RU ИП; run only on a non-RU entity/host or use client-side. |

Adjacent observability verdicts (validating the "OTel + tool_calls" plan): **Langfuse** v3.177.1 MIT-core OTel-native — **ADOPT**; **Helicone** — **AVOID** (maintenance mode post-Mintlify, Mar 3 2026); **LiteLLM** v1.86.2 MIT — **CAUTION** (Mar 24 2026 PyPI supply-chain compromise of 1.82.7/1.82.8 → hash-pin + CI-token hygiene mandatory if used as the `:4000` gateway).

---

## 5. Deltas vs the 2026-06-02 internal synthesis (corrections)

### Hermes
- **CORRECT:** `:8642` OpenAI-compatible `/v1/chat/completions`; `:9119` dashboard; `~/.hermes/config.yaml` + `.env` single source of truth. Verified in source.
- **WRONG — `models.json`:** NOT a standard config artifact. Model lists come from a **remote `model_catalog` manifest URL** (cached ~1h, `hermes_cli/model_catalog.py`), not a local file the integrator edits. Offline provisioning needs catalog-URL override or `config.yaml model.default` seeding.
- **WRONG — assumed dashboard endpoints:** `/api/local-providers`, `/api/models`, `/api/agents`, `POST /api/skills/install`, `PUT /api/mcp/configure`, and `PUT /api/config` with an `auth.profiles` path **do not exist**. Real surface: `PUT /api/config {config}` + `/api/config/raw {yaml_text}`; `POST /api/model/set`; `/api/profiles` (+`/soul`,`/setup-command`); `GET/POST/DELETE /api/mcp/servers` (+`/test`); `PUT /api/skills/toggle` + `POST /api/skills/hub/install`; `/api/cron/jobs` (+pause/resume/trigger). `PUT /api/env {key,value}`, `DELETE /api/env`, `POST /api/env/reveal` ARE correct.
- **WRONG — sub-agents are NOT tmux:** `tools/delegate_tool.py` spawns child `AIAgent`s via a `ThreadPoolExecutor` (0 tmux references). Terminal backends = local/Docker/SSH/Singularity/Modal/Daytona.
- **WRONG — front-ends are NOT separate repos** (`hermes-workspace` / `hermes-telegram-miniapp` do not exist in the org). Bundled in-repo: `web/` dashboard (`:9119`) + `apps/desktop/` Electron. Telegram is one of ~15 gateway adapters.
- **WRONG/nuanced — default model:** NOT a hardcoded `hermes-4-405b`. Selected at setup time; a Portal install defers to Nous's runtime default; zero local weights.
- **NEW:** MIT license; weekly releases / daily commits but ~5.6k open issues + ~10.6k open PRs; `gateway/memory_monitor.py` self-documents RSS growth (concrete evidence for per-user memory risk); dashboard ships real auth (ephemeral token + OAuth gate when non-loopback).

### agentic.market
- **REFUTED (mostly) — "live metrics on EVERY tool card":** only PRICE is on cards. Calls/payers/last-active are NOT in `/v1/services` and NOT shown per-card; the UI shows only aggregate network-wide volume/TPV/transactions. Usage signals exist solely inside CDP Bazaar's 6-hourly search-ranking layer.
- **CONFIRMED but RELOCATED — self-indexing:** true, but it happens in the CDP Facilitator/Bazaar layer (catalog on first settled payment, requires `paymentPayload.resource`), not in agentic.market itself (a read-only front-end). Plus an undocumented-in-synthesis **30-day no-activity culling rule.**
- **CORRECTED endpoint paths:** `/v1/services` + `/v1/services/search?q=` (not `/v1/tools`); CDP layer `/v2/x402/discovery/resources` + `/search`; no `/.well-known/*`.
- **NEW:** header migration to `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`; total exactly 1011 services (2026-06-02); built by Coinbase CDP (launched ~Apr 2026, free, network fees <$0.0001); `integrationType '1P'|'3P'` and `pricing.scheme 'exact'|'upto'` field nuances.

### Runtime frameworks
- **CORRECTED — no Elastic v2:** both Mastra and Vercel AI are Apache-2.0; only Mastra's `ee/` dir is non-Apache (NOASSERTION). Any prior "Elastic v2" claim is wrong.
- **CORRECTED — Vercel AI:** v6 stable / v7 beta, three churning majors; the v6 agent primitive is `ToolLoopAgent` (with `stopWhen`/`prepareStep`), not `Agent`.
- **CORRECTED — Mastra:** runs on Hono and is AI-SDK-native; the Bun risk is **only the CLI**, not the library.

### MCP stack
- **CORRECTED — `StreamableHTTPServerTransport`:** as of 1.29.0 it is a THIN WRAPPER over the new `WebStandardStreamableHTTPServerTransport` (Web Request/Response). For Bun/Hono instantiate the Web-standard class directly (the Node wrapper pulls `@hono/node-server`).
- **CORRECTED — spec revision:** SDK `LATEST` is **2025-11-25** (not 2025-06-18); `2025-03-26` is only the default negotiated fallback. Any doc pinning "2025-06-18 latest" is stale.
- **CORRECTED — SSE:** `SSEServerTransport` is hard-`@deprecated` in code; build only on Streamable HTTP.
- **CORRECTED — auth:** the SDK's `requireBearerAuth` is Express-shaped; the clean Hono integration point is the `authInfo` option on `handleRequest`, NOT the SDK middleware.
- **CORRECTED (category error) — ContextForge:** it is a federation PROXY in front of MCP servers, NOT a per-agent endpoint-minting SDK. If the synthesis listed it as a "drop-in for building the gateway," that is the wrong category. It is past RC at stable v1.0.2 (2026-05-26), but GA-young, and still ships a dev default secret literally named `2026-not-for-prod`.

### Telegram + crypto
- **RESOLVED — grammY Business Connection:** it IS first-class and HTTP Bot API native (since Bot API 7.2), NOT MTProto. Any prior assumption that "agent acts in your DMs" needs a userbot/MTProto session is wrong for the grammY path.
- **CORRECTED — x402 governance:** now a Linux Foundation "x402 Foundation" project (announced 2026-04-02); canonical repo `x402-foundation/x402` (6128 stars); `coinbase/x402` is now literally a fork. x402 is at V2 (launched 2025-12-11) with renamed headers and scoped `@x402/*` packages.
- **CORRECTED — x402-rs is real, not vaporware:** maintained Rust facilitator (267 stars, pushed 2026-06-01, prebuilt Docker, V1+V2, EVM+Solana, `/verify`+`/settle`, port 8080). Crucial: it **self-custodies a signer private key** — the crux of the RU legal risk.
- **NEW — chains:** x402 supports Base + Solana + EVM L2s; **no TON support**. x402 and TON Connect are separate rails; x402 does not replace TON billing.

### Competitive + legal
- **NEW (decision-critical) — Helicone in maintenance mode** post-Mintlify acquisition (Mar 3 2026) → drop as a forward dependency; adopt self-hosted Langfuse.
- **NEW (security) — LiteLLM PyPI compromise** (1.82.7/1.82.8, TeamPCP, Mar 24 2026) → harden (hash-pin, CI token hygiene) or reconsider if vendored in the gateway.
- **NEW (RU legal) — Constitutional Court No. 2-P (Jan 20 2026)** strengthens crypto-as-property protection (does NOT permit domestic crypto payments).
- **NEW (RU regulatory) — Jul 1 2026 licensed-intermediary regime** (CBR registry, 35M RUB exchanger capital, 300k RUB/yr unqualified-investor cap, KYC/AML + FNS/Rosfinmonitoring reporting); criminal/admin liability for out-of-framework ops starts Jul 1 2027 → the two-entity split is now a hard legal requirement.
- **CONFIRMED — two-entity split** (RF web/fiat + foreign agentic/crypto) is legally necessary; RF entities barred from accepting crypto for services; transferring crypto abroad is not itself a violation.
- **CONFIRMED — Telegram Stars** ~32% fee + 21-day hold is real/current → TON-Connect-only was the right Phase-15 call; keep Stars deferred.
- **REFINED — competitive model:** leading agent marketplaces (Virtuals ~10% ACP take + token flywheel; Olas fee-burn) are crypto-token-based and volatile (VIRTUAL −87% from ATH). The safer RU-compatible analog to copy is **Poe's transparent per-call usage pricing**, not a creator-token bonding curve. OpenAI GPT Store's opaque, engagement-gated payouts are the failure pattern to avoid.

---

## 6. Risks (ranked)

1. **RU crypto-settlement illegality (CRITICAL, legal).** An RF ИП cannot lawfully accept USDC/crypto for agent services (259-FZ, fines tightened Mar 2026). Self-hosting an x402 settling facilitator (`x402-rs` holds a hot wallet, pays gas, moves stablecoins) likely qualifies as crypto-asset transmission/MSB activity and exposes a RU-linked address to OFAC/Circle freeze + RPC/Circle geofencing. **Any per-call crypto billing MUST sit in the foreign entity; do not self-host a settling facilitator from the RU side.** Consult counsel.
2. **Hermes per-user memory OOM (HIGH, operational).** Self-documented RSS growth × one process per user → small VPS OOM. Requires memory caps + scheduled restarts + pod-per-user isolation.
3. **Hermes agent autonomy / sandbox escape (HIGH, security).** Shell/code/browser/self-modifying skills run per untrusted user → container isolation mandatory in RU jurisdiction.
4. **LiteLLM supply-chain (HIGH if vendored).** The `:4000` gateway is a credential-bearing crown jewel; the Mar 2026 PyPI backdoor shows this class of dependency is a high-value target.
5. **API/spec churn on fast-moving deps (MEDIUM).** Hermes (~10.6k open PRs, weekly releases), three Vercel AI majors, MCP SDK pre-alpha v2 on main, x402 V1→V2 header/package/org migration. Pin everything; re-verify on upgrade.
6. **Hermes integration against non-existent endpoints (MEDIUM).** Building against assumed `/api/local-providers` etc. will fail; target the real surface.
7. **Building agentic.market's non-existent "live per-card metrics" (MEDIUM, wasted effort).** Use server-side ranking + aggregate hero stats instead.
8. **Token-speculation marketplace volatility + RU securities/ЦФА scrutiny (MEDIUM).** Avoid tokenizing agents for the RU audience.
9. **Opaque/engagement-gated payouts destroy creator trust (MEDIUM).** The GPT Store failure mode — publish a deterministic author split.
10. **TON jetton-transfer footgun + TonAPI third-party dependency (MEDIUM, operational).** Must target the sender's jetton-wallet (not USDT master) + ~0.05 TON gas (issue #217); migrate off deprecated SSE Streaming to Webhooks API; TonAPI is an external hosted dependency for billing-critical deposit detection.
11. **Agent-marketplace category base-rate failure (MEDIUM, strategic).** Gartner: >40% agentic projects canceled by 2027; reliability compounds (85%/step ⇒ ~20% over 10 steps). Engineer for reliability/observability, not listing volume.
12. **Telegram Business rights are user-controlled/revocable + require Premium owner (LOW-MEDIUM, UX).** Gate features on `can_reply`; handle revoked/non-Premium states.
13. **30-day recency culling cold-start (LOW-MEDIUM).** A Bazaar-style index hides long-tail tools.

---

## 7. Opportunities (ranked)

1. **Close the billing-bypass bug by pointing Hermes (and all agent runs) at AIAG's `:4000` gateway** — the gateway becomes the white-label upstream AND the "facilitator" that auto-lists tools on first billed call.
2. **Ship the machine-readable discovery surface + `llms.txt` now** — single highest-leverage, lowest-cost steal; runtime-discoverable catalog for any agent + AIAG's own worker.
3. **Be the first Telegram-native agent marketplace with a transparent, deterministic take-rate** — copy Poe's per-call usage pricing but publish the exact author split. The gap is real (no TON/Telegram agent store publishes clear economics).
4. **Build apps/mcp-gateway on `@modelcontextprotocol/sdk@^1.29` Web-standard transport** — official Hono template, per-request factory keyed by `agentId`, stateless mode fits the OpenRouter loop; `authInfo` seam lets OAuth 2.1+PKCE be deferred.
5. **"Agent in your DMs" via grammY Business Connection (free)** — persist `business_connection_id` per user, gate on `businessBotRights.can_reply`, agent-worker calls `ctx.reply()`/`sendMessage`. No userbot/MTProto risk. This is the TMA's marquee capability.
6. **Adopt the two-tier Service/Endpoint object model + `1P`/`3P` flag + `exact`/`upto` pricing scheme** — clean mapping for AIAG supply types and BYO/partner providers.
7. **Validate the "OTel + tool_calls" plan with self-hosted Langfuse** — transparent per-call cost traces underwrite a trustworthy take-rate and differentiate from black-box stores.
8. **Layer Vercel AI v6 (streaming/`useChat`) + Mastra (Workflows/Memory/PgVector/MCP) as libraries** — lowest-risk streaming + fuller agent primitives without CLI/bundler risk.
9. **Reuse Hermes's MIT feature set as reference implementations** — cron, kanban swarm, MoA, FTS5 search, agentskills.io `SKILL.md` interop, config-injection control plane, dashboard auth design (ephemeral token + OAuth gate) for AIAG's own BYOK/settings flow.
10. **Adopt x402 client-side in the foreign entity** — let AIAG agents autonomously pay for x402-gated upstream APIs (low risk, real differentiator); track `x402-rs` "BYO-facilitator hooks" + `upto` scheme for future metered-billing alignment.
11. **Steal Virtuals' demand-side subsidy in a fiat/non-token form** — launch fund / fee holiday for early authors to solve cold-start without token volatility.
12. **Support agent-to-agent (A2A) billable calls from day one** — >50% of Olas volume is agents hiring agents; that is where durable volume lives.
13. **Use Hermes Daytona/Modal hibernate-when-idle backends** — "per-user instance that costs ~nothing when idle" for the R&D tier.

---

## 8. Open questions needing a spike or legal review

1. **[LEGAL] Foreign-entity structure for x402/USDC settlement.** What jurisdiction/entity can lawfully operate (or contract a facilitator for) x402 settlement, and how do repatriated funds pass RF currency-control (contract registration, bank-as-agent, 161-FZ multi-bank block risk)? Watch draft bill N 1194918-8 (VED crypto settlement). Counsel required before any settlement role.
2. **[LEGAL] x402 facilitator KYC/sanctions posture.** Does relying on Coinbase's hosted facilitator (1,000 free tx/mo) or any US-infra RPC create sanctions/geofencing exposure for an RU-linked founder even through a foreign entity? Verify facilitator + Circle KYC posture before committing.
3. **[SPIKE] Hermes per-user memory envelope.** Measure RSS-over-time for a single Hermes gateway under a realistic agent loop; determine concurrent-users-per-VM ceiling, restart cadence, and whether Daytona/Modal hibernate meaningfully bounds idle cost.
4. **[SPIKE] Hermes pod-per-user isolation cost.** Prototype k3s pod-per-user (or container) with port namespacing (`API_SERVER_PORT`/`HERMES_HOME`), provider base-URL pinned to `:4000`, and pinned release; measure cold-start time + disk per user with curated extras (not `[all]`/`[rl]`).
5. **[SPIKE] MCP gateway per-tenant Hono template.** Stand up `app.all('/t/:agentId/mcp')` with `WebStandardStreamableHTTPServerTransport` + per-request `getServer(agentId)` + `authInfo` bearer from `agent_provider_credentials`; validate stateless mode under PM2/multi-replica and decide whether EventStore (Postgres/Redis) is needed for any streamed tools.
6. **[SPIKE] grammY Business Connection on Bun.** Validate the `webhookCallback` + `Bun.serve()` entrypoint in CI (Bun support is community-validated, not headline-certified); confirm `business_connection`/`business_message` round-trip and `business_connection_id` auto-injection.
7. **[SPIKE] TON jetton-transfer helper + deposit-watch.** Build/centralize one tested `op 0xf8a7ea5` helper (sender jetton-wallet, 6-decimal USDT, ~0.05 TON gas) and migrate deposit detection to TonAPI Webhooks `/account-tx/subscribe` (off deprecated SSE).
8. **[LEGAL/PRODUCT] Self-indexing + author payout determinism.** Confirm the "first billed call auto-lists" loop + a published deterministic author split is compliant for the RU fiat entity (vs ЦФА/securities classification) and survives a 30-day-recency-style culling rule for long-tail supply.
9. **[VERIFY] Unconfirmed secondary-source claims.** Some MCP/ContextForge version+date strings (`1.0.0-RC-3`, a future-dated "July 28 2026 new spec") could not be verified against primary sources — re-verify against npm/PyPI/GitHub before relying on them.
10. **[SPIKE] LiteLLM avoidance vs hardening.** Decide whether the `:4000` gateway vendors LiteLLM at all; if yes, define hash-pinning + CI-token-hygiene controls (avoid leaky Trivy steps) and treat it as a credential crown jewel.

---

*Compiled 2026-06-02 from 6 parallel research agents. All URLs preserved inline; full source lists are in the per-agent findings JSON.*
