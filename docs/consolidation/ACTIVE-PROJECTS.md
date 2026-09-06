# Active project topology — 2026-09-07

Latest authority: founder requests three folders, projects and repositories; Agents Market has independent Web and TMA applications. Autonomous local development authorized. Historical monorepo/mirror rules are superseded for these products only.

| Product | Canonical working root | Current integration workspace | Scope |
|---|---|---|---|
| AI Aggregator | /home/bob/Projects/ai-aggregator | same, feat/three-projects-completion | models/algorithm marketplace, gateway, consumer/author money |
| AI Arena | /home/bob/Projects/aiarena | same, feat/arena-foundation-reviewed | contests, evaluation, blind comparison, prizes |
| Agents Market | /home/bob/Projects/agents-market | same, feat/standalone-agents-market | apps/web, apps/tma, apps/worker, shared product contracts |

## Source preservation

- AI Aggregator starts from archived core `2252c95`, not the September web fork. Preserve core middleware CSP and sync-models test; manually port compatible donor features.
- Arena integration starts from `wave5-release` `61b05fb` and is active at reviewed commit `d742077` on `feat/arena-foundation-reviewed`. The original `wave2` state is recoverable through `refs/archive/pre-three-root-cutover-20260907` and the verified pre-cutover bundle. External Hermes working changes remain references, not approved code.
- Former `/home/bob/Projects/aggregator` is preserved intact at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aggregator-sourcecontainer`.
- Former `/home/bob/Projects/aiag-web` is preserved intact at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906/aiag-web-sourcecontainer`. This is distinct from the pre-existing `/home/bob/Projects/archive/aiag-web` task archive.
- Snapshots and the exact cutover manifest live at `/home/bob/Projects/archive/ai-ecosystem-sources-20260906`. Historical references under either former source prefix resolve by the two mappings above.

Repository split and source cutover are local. No GitHub repository creation, remote history rewrite or production deployment has occurred. Product baseline work remains in progress and is not a production-readiness claim.

## Validation infrastructure

One heavy job uses flock /tmp/ai-ecosystem-build.lock. Redis test instance binds loopback 16379, persistence disabled. PostgreSQL 16.14 binds loopback 15432 with separate ai_aggregator_test, ai_arena_test and agents_market_test databases. Schemas and product-level integration tests are still pending. Never copy source .env into these checkouts; never use production DB for test writes.
