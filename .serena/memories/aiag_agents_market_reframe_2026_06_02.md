# AIAG TMA — agents-marketplace reframe + roadmap (2026-06-02)

Strategic design checkpoint. The Telegram Mini App was reframed and deeply reviewed.

## Reframe (locked)
- **TMA = AGENTS MARKETPLACE first** (discover/run/create agents that work in your Telegram). The 73-model aggregator is **just one provider**, not the hero. "N models" hero copy removed everywhere.
- **Providers (multi):** AIAG-gateway (default, managed) · OpenAI/Anthropic BYOK · **Gonka** (gonka.ai, Cosmos/GNK, OpenAI-compat via GonkaGate — provider + wallet, **beta, spike pending**) · **own Hermes** (R&D).
- **Runtime:** managed cloud Hermes per user (+ BYO for power) — BUT **Hermes runtime is R&D/unbuilt**; the REAL runtime is a stateless BullMQ OpenRouter loop in `apps/agent-worker/src/agent-runner.ts`.
- **Supply:** AIAG feeds Hermes models + skills (SKILL.md) + MCP-tools via config-injection; billing TON/USDT credits per-call, x402-shaped (USDC/Base) for external. Telegram deploy = OFFICIAL only (Bot API + Telegram Business; NO MTProto).

## REAL bug (P0)
`kind='aiag'` agent runs hit OpenRouter directly (`agent-runner.ts:48-51`), NOT the Hono gateway (127.0.0.1:4000) → **markup + billing skipped for agent runs**. Fix: rewire `resolveUpstream` → 127.0.0.1:4000/v1; add `aiag_deduct_tool_call` + `tool_calls` table; verify on VPS.

## Scores
- UX-108 (reframed): 59/108. Functional-108 (4 tabs ×27): **43/108** — Агенты 14 · Маркет 11 · Кошелёк 11 · Профиль 7.
- Top gaps: no author/creator profiles; no publish/monetization (supply read-only); no run-trace/observability; clone-not-remix; provider choice hidden; missing error/pending/empty states; currency soup (need one canonical credit unit); auto-top-up dead; 152-ФЗ/receipts unbuilt.

## Tech stack (extend, not replace)
Keep BullMQ loop + layer **mastra-ai/mastra** (multi-step+memory); managed **hermes-agent** opt-in; NO code-sandbox v1. New Hono **apps/mcp-gateway** (Streamable-HTTP, per-agent bearer) via **modelcontextprotocol/typescript-sdk** + **IBM/mcp-context-forge** (Postgres+Redis). EXTEND Postgres ledger (`aiag_deduct_tool_call`), not OpenMeter/Lago. **grammyjs/grammY** in apps/agent-bot + **@telegram-apps/sdk-react**. **vercel/ai** (streaming), **pgvector** (memory), Helicone/OTel→SigNoz. **ton-connect/sdk** + USDT-jetton; Gonka GNK off live path via **cosmjs**; **coinbase/x402** wire format.

## Roadmap
P0 truth+billing (fix bypass bug, deduct ledger, kill N-models hero, models under Провайдеры) → P1 provider picker + supply attribution → P2 two-sided market (author profiles/remix/publish/ratings) → P3 wallet truth + observability (canonical credit unit, auto-top-up, error states, run-trace) → P4 MCP gateway + per-call metering → P5 Telegram delivery (grammY) + WebApp + 152-ФЗ. R&D: managed Hermes, Gonka spike, x402 inbound (161/259-ФЗ), pgvector memory, agent groups.

## Artifacts
- Wireframes: `docs/wireframes/tma/index.html` (+styles.css) — dark/amber, 41 artboards, crypto-only, agents-first.
- Specs: `docs/superpowers/specs/2026-06-01-aiag-hermes-supply-design.md`, `docs/specs/2026-06-01-tma-108-reframe.md`, `docs/specs/2026-06-02-tma-functional-stack-roadmap.md` (build roadmap+stack+repos), `docs/specs/2026-06-01-tma-wireframes-design.md`, `docs/specs/2026-06-01-tma-review-108.md`, `docs/superpowers/specs/2026-06-01-provider-connection-research.md`.

Hard rule: never expose a personal Telegram handle in any artifact. P0 provider-connection (migration 0026 + GET /api/providers) already live on prod.
