# TON worker-only boundary implementation plan

**Goal:** Actual separate PostgreSQL worker can settle/replay once while Web/API cannot reach core, protected writes or owner privileges.
**Architecture:** Strict guarded local installer, attested immutable core, non-login SECURITY DEFINER owner, worker-only wrapper and dedicated bounded internal client.
**Tech stack:** TypeScript, node-postgres, PostgreSQL18, Vitest.
**Spec:** ../specs/2026-09-29-ton-worker-boundary-design.md

## Global constraints

No historical SQL change, production grants/deploy or keys; existing isolated worktree and single heavy flock. Default runtime still disabled/observe. Actual worker sessions, never superuser SET ROLE as successful money proof.

## Tasks

1. [x] Native+unit RED for installer safety and worker money boundary. Files packages/database/scripts/ton-worker-boundary.ts, scripts/__tests__/ton-worker-boundary*.ts. Use existing owned child DB guard; fresh4roles, cleanup exact known OIDs.
2. [x] Implement attested local installer. Bound input, correct role flags/memberships/ACLs, source/trigger identity; transaction creates private schema/wrapper and exact grants. Test same ledger authority, no constraints disabled.
3. [x] Native actual login/concurrency/replay/rollback/temp-shadow/regrant tests. All money uses unchanged core through wrapper, deny direct access.
4. [x] Dedicated internal settlement client and boundary validator; no public settlement export or source-level bypass. Unit RED/GREEN, native actual client login/commit/replay and wrong identity rejection.
5. [x] Independent financial/security and TypeScript source reviews; reproduce substantive findings, correct; full existing unit baseline once at frozen final source plus native, types/lint/build/audit. Commit source then evidence.
6. [x] Update AG roadmap and deployment handoff honestly. Do not start Arena before remaining Aggregator gates are accepted.

References: PostgreSQL18 CREATE FUNCTION security-definer guidance, role-membership effective SET/USAGE and CREATE ROLE attributes; checked29.09.2026. Automatic execution selected by user; design reviews delegated to distinct actual Space Bunny contexts, not fabricated source approval.

Accepted29.09 source3135690; exact evidence in ../../consolidation/2026-09-29-ton-roles-and-restore-checkpoint.md. Added guarded samecluster dump/restore rehearsal with four native scenarios; separate documented external gates remain.
