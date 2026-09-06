# Active project topology — 2026-09-06

Latest authority: founder requests three folders, projects and repositories; Agents Market has independent Web and TMA applications. Autonomous local development authorized. Historical monorepo/mirror rules are superseded for these products only.

| Product | Canonical working root | Current integration workspace | Scope |
|---|---|---|---|
| AI Aggregator | /home/bob/Projects/ai-aggregator | same, feat/three-projects-completion | models/algorithm marketplace, gateway, consumer/author money |
| AI Arena | /home/bob/Projects/aiarena | /tmp/aiarena-integration-20260906, feat/ecosystem-completion | contests, evaluation, blind comparison, prizes |
| Agents Market | /home/bob/Projects/agents-market | same, feat/standalone-agents-market | apps/web, apps/tma, apps/worker, shared product contracts |

## Source preservation

- AI Aggregator starts from core 2252c95, not September web fork. Preserve core middleware CSP and sync-models test; manually port compatible donor features.
- Arena integration starts from wave5-release 61b05fb; old wave2 substantive tracked diff is empty after CRLF normalization. Original worktrees remain unchanged until verified integration. External Hermes working changes are references, not approved code.
- /home/bob/Projects/aggregator and /home/bob/Projects/aiag-web are source/asset containers pending final archive cutover. They are not newly endorsed duplicate development roots.
- Snapshots at /home/bob/Projects/archive/ai-ecosystem-sources-20260906 contain all-ref Arena bundle, raw patches, status and ref inventories. Original untracked data remains in source folders.

Repository split is local. No GitHub repository creation, remote history rewrite or production deployment has occurred. Active code extraction and baseline repairs are in progress, not production-ready.

## Validation infrastructure

One heavy job uses flock /tmp/ai-ecosystem-build.lock. Redis test instance binds loopback 16379, persistence disabled. PostgreSQL 16.14 binds loopback 15432 with separate ai_aggregator_test, ai_arena_test and agents_market_test databases. Schemas and product-level integration tests are still pending. Never copy source .env into these checkouts; never use production DB for test writes.
