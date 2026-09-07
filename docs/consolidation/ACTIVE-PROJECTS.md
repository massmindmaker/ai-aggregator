# Active project topology — 2026-09-07

Latest authority: founder requests three folders, projects and repositories; Agents Market has independent Web and TMA applications. Autonomous local development authorized. Historical monorepo/mirror rules are superseded for these products only.

| Product | Canonical working root | Current integration workspace | Scope |
|---|---|---|---|
| AI Aggregator | /home/bob/Projects/ai-aggregator | same, feat/three-projects-completion | models/algorithm marketplace, gateway, consumer/author money |
| AI Arena | /home/bob/Projects/aiarena | same, feat/arena-foundation-reviewed | contests, evaluation, blind comparison, prizes |
| Agents Market | /home/bob/Projects/agents-market | same, feat/standalone-agents-market | apps/web, apps/tma, apps/worker, shared product contracts |

## Source preservation

- AI Aggregator starts from archived core `2252c95`, not the September web fork. Preserve core middleware CSP and sync-models test; manually port compatible donor features.
- Arena integration starts from `wave5-release` `61b05fb` and first integrated at reviewed commit `d742077` on `feat/arena-foundation-reviewed`. This is historical provenance; the current accepted source and test evidence live in each product development entrypoint. The original `wave2` state is recoverable through `refs/archive/pre-three-root-cutover-20260907` and the verified pre-cutover bundle. External Hermes working changes remain references, not approved code.
- Former `/home/bob/Projects/aggregator` is preserved intact at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aggregator-sourcecontainer`.
- Former `/home/bob/Projects/aiag-web` is preserved intact at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aiag-web-sourcecontainer`. This is distinct from the pre-existing `/home/bob/Projects/archive/aiag-web` task archive.
- Snapshots and the exact cutover manifest live at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906`. Historical references under either former source prefix resolve by the two mappings above.

Repository split and source cutover are local. No GitHub repository creation, remote history rewrite or production deployment has occurred. Product baseline work remains in progress and is not a production-readiness claim.

## Validation infrastructure

One heavy job uses flock /tmp/ai-ecosystem-build.lock. Redis test instance binds loopback 16379, persistence disabled. PostgreSQL 16.14 binds loopback 15432 with separate ai_aggregator_test, ai_arena_test and agents_market_test databases. Each product has its own guarded migration/test boundary. The current accepted schema and scenario results are recorded in product entrypoints, not inferred from the existence of a database. Never copy source .env into these checkouts; never use production DB for test writes.

## Development authority and memory recall

This three-product topology, authorized on 6–7 September 2026, supersedes historical LightRAG or Serena descriptions of Aggregator and Agents Market as two products sharing a monorepo and application database. Those earlier records remain provenance. Do not restore shared runtime SQL or move work back into archived folders.

- AI Aggregator owns its model/provider catalog, inference gateway and financial records. RUB remains in scope alongside a separate TON Web payment lane.
- Agents Market owns its accounts, agents, run state, templates and financial records. Its Web and Telegram Mini App are separate application/release units in the same Agents Market repository. Their common backend does not make them Aggregator modules. Removal of remaining legacy foreign catalog reads still depends on the validated Aggregator HTTP catalog contract; the target boundary is not a claim that cutover is finished.
- AI Arena owns contest participation, submissions/evaluation evidence, comparison and prize obligations. Versioned publication/evidence and provider integration cross HTTP contracts, not shared product tables.
- Working memory: LightRAG holds accepted shared knowledge; Brain is human navigation; Serena is local code/LSP context; Graphify is a derived code graph. Historical notes and an index timestamp do not override current source, accepted review and explicit founder decisions. Private task journals stay private.
- Independent repo workers are authorized; module ownership is exclusive and heavy jobs run sequentially under the shared lock. Serious architectural and financial work uses Astra with higher reasoning; routine implementation uses lighter models. Superpowers task review remains mandatory.

Use [Aggregator entrypoint](../DEVELOPMENT-ENTRYPOINT.md), [Agents Market entrypoint](/home/bob/Projects/agents-market/docs/DEVELOPMENT-ENTRYPOINT.md) and [Arena entrypoint](/home/bob/Projects/aiarena/docs/DEVELOPMENT-ENTRYPOINT.md) for current task/commit/test status. This document defines ownership, not release readiness.
