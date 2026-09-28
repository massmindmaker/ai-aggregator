# Aggregator release remediation implementation plan

Goal: remove known dependency blockers, restore native local verification, then resume the existing author-version plan.
Authority: user approved all recommendations in docs/consolidation/2026-09-28-aggregator-security-review.md and step-by-step implementation. Existing author design remains unchanged.
Execution: superpowers:executing-plans, TDD for behavior changes, one heavy process under /tmp/ai-ecosystem-build.lock. Existing isolated worktree retained at base0caa580.
Constraints: Aggregator only; no production deploy/migrations, no real paid inference/payout/mainnet, no secret export, no discarded prior work. Do not replace native DB evidence with mocks.

## Task1: patched compatible dependencies
- [x] Add runtime library regression tests for escaped SQL identifiers, malformed auth headers and supported package floors; observe RED against installed dependencies.
- [x] Pin Next15 maintained release, NextAuth5 fixed beta and adapter, Drizzle0.45 stable, Vitest4 fixed release (amended after current advisory against3), compatible Vite/plugin. Preserve React18 UI in this bounded migration; update only required compatibility code.
- [x] Install using Bun1.4.2; record exact lock and audit. No blind forced overrides across major versions.
- [x] Resolve residual vulnerable transitive packages with compatible overrides only, documented individually.
- [x] Run runtime regressions, full unit, source/test type checks and production build. Explicitly record all skips/failures.

## Task2: reproducible disposable native services
- [x] Obtain PostgreSQL/Redis using distro packages without changing global production services; loopback ports15432/16379 only.
- [x] Add an owned runner with identity guards, unique data dir, cleanup and forced local DB URLs; never source a production .env.
- [x] Run clean87/no-op87, author version native gate and cumulative DB baseline; owned server cleanup must be observed.

## Task3: restore full transaction semantics
- [x] Verify createDb driver boundary against transaction needs; write failing test for incompatible Neon HTTP authority before implementation.
- [x] Keep explicit createEdgeDb HTTP API separate; transaction-bearing service clients must use a transaction-capable driver.
- [ ] Native prove commit/rollback and audit mutation atomicity; no broad financial redesign.

## Task4: continue author BatchB using its existing spec/plan
- [ ] Persist exact probe operation before POST; single claimed dispatch, durable outcome and unknown state without retry.
- [ ] Freeze verified rights/price/version at moderation and admission; do not activate until native mounted receipt evidence.
- [ ] Only after B acceptance implement C accrual/reversal using existing sole settlement authority.

## Review / finish
- [ ] Request a separate genuine GLM/ZCode review when a supported invocation exists. Do not fake reviewers or buy credits.
- [x] Record skill successes/failures locally; observer queue only if confirmed configured.
- [x] Commit verified packages with exact evidence and remaining gates. Production release requires its own authorization.

Evidence28.09: [release remediation checkpoint](../../consolidation/2026-09-28-release-remediation-checkpoint.md). Native topup money rollback and driver selection are proven; dedicated new moderation-audit failure injection and remote Neon connectivity are not separately accepted. Author BatchB/C remains OPEN.
