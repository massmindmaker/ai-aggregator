# AI Hub — checkpoint 19 September 2026

## Scope and resume order

AI Aggregator first, then Arena and Agents Market. Do not restart the broad architecture design.
Base at start: ai-aggregator `34ff916` on `feat/three-projects-completion`.
Other repositories untouched by this batch: agents-market `94b5b45`, aiarena `c2f6559`.
Plan: `docs/superpowers/plans/2026-09-19-ai-hub-resume.md`.

## Delivered in this batch

- AG-owned local HTTP consumer fixture, `packages/api-gateway/src/__tests__/fixtures/catalog-consumer.ts`: injected transport, strict shared parser, bounded pages, revision consistency and duplicate rejection, advisory facts over all pages, fixed HTTP error codes and safe retry headers. Not a production SDK or a price/budget lock.
- Actual mounted `server.ts`/Hono/auth/projector producer-consumer tests with controlled SQL/Redis/provider seams (22 cases), not a mocked projector fixture. Provider execution is disabled by throwing adapters.
- Native pagination suite (3 cases): stable seek pages, real registry mutation invalidates cursor, fresh injected key policy invalidates cursor. Existing native default-reader test retained. Route/auth boundary + real SQL, NOT complete server/Redis or real DB-backed authentication acceptance.
- Fixed root Vitest discovery and coverage accidentally collecting `.superpowers` scratch tests. Production test trees are not excluded.
- Added explicit repeatable `test:catalog-contract` and `test:catalog-native-smoke` scripts. They do not migrate/bootstrap/reset DB and do not replace the full native baseline.

## Fresh checks (19 September 2026)

All commands run in `/home/bob/Projects/ai-aggregator`; heavy commands serialized with `flock /tmp/ai-ecosystem-build.lock`.

| Command after flock | Result |
|---|---|
| `/tmp/ai-ecosystem-run aggregator bun run test:catalog-contract` | 8 suites / 134 PASS |
| `/tmp/ai-ecosystem-run aggregator bun run test:catalog-native-smoke` | 2 suites / 4 PASS, no skip |
| `node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.json` | exit0 |
| `node_modules/.bin/tsc --noEmit -p packages/api-gateway/tsconfig.test.json` | exit0 |
| `/tmp/ai-ecosystem-run aggregator bun run --filter @aiag/api-gateway build` | ESM + DTS, exit0 |
| Scoped eslint and `git diff --check` | exit0 |

Raw logs and original-WIP SHA256 manifest: `.superpowers/sdd/2026-09-19-resume-catalog/` (ignored scratch; this document is the durable summary).
Native runtime is the existing guarded local PG16/Redis instance: 75 migrations,113 tables; no migrations applied in this batch. Restored stopped local services and missing `/tmp/ai-ecosystem-run` symlink. No production connection or provider traffic.

## Full-suite limits and unrelated WIP

Full root `test:unit --no-file-parallelism` baseline hit its180s ceiling (exit124). Before stopping:137 reported suites/2460 listed tests, including skipped; failures in native-ton-core-test(44), native-clean-rehearsal(27), and old `.superpowers/.../ag-candidate-review-repro.test.ts`(1). The scratch-discovery defect was then fixed and regression-tested. The two database orchestration suites remain unmodified and need a separate investigation; do NOT label the whole unit suite green.

All15 pre-existing modified/untracked files retain their original SHA256. In particular TON0076, financial mutations, `.serena`, dirty September13 handoff and unrelated newly appearing `.v2c`/`.video_agent` are not part of this batch. No blanket git add/clean/reset.

## Delegation and one combined review

Implementation job `3e3c0bf1d32f4e479edf412856a6208c`, session`sess_898649f6-37ce-4356-8483-c35bf3435954`: actual persisted model `account:zai-individual-coding-plan/GLM-5.3-Flash`. Job timed out at the bounded deadline; drafts preserved and controller completed integration. No claim the unattended worker completed the task.

Independent read-only review job `79bbc181990b4f32a4d38ccc4a1ecdf9`, session`sess_f7e61457-1703-42ff-afcc-2f50a008637b`: completed, observed same model, no blocking findings in the scoped files.

Controller rulings on reviewer notes:
- Real HTTP409 is preserved as409/CATALOG_REVISION_CHANGED. Silent revision changes across200 responses and replayed duplicate pages remain `schema`, because those violate the producer snapshot contract; they are not valid server409 envelopes. Regression tests demonstrate both branches. A richer client diagnostic enum can be deferred.
- Exclude the proven scratch source `.superpowers`, not unrelated trees blindly. Other agent scratch directories should be assessed separately if real test discovery proves contamination. No broad deletion/exclusion in this change.
- SQL-recording mocks intentionally pin the current prepared-query parameter contract; native default-reader and pagination tests supplement them.

## Next concrete work (still OPEN)

1. Investigate old TON/clean-rehearsal unit failures separately, preserving0076 WIP and immutable applied0074/75.
2. Finish catalog Task5 native mounted matrix: raw fan-out16/17,512/513, runtime/provider readiness and deployment lifecycle, immutable quote/receipt/ledger after GET→POST price change. Do not mark AG-P2 fully accepted yet.
3. Finish recovery composition/native baseline and worker build evidence; do not activate mode or refunds.
4. Continue TON correction review; no new testnet RPC (historical20/20 capture budget), no mainnet/signers/funds.
5. Arena: opt-in binding + concrete DB jobs/evaluator; Market: HTTP/security review + guarded browser auth acceptance + real AG HTTP consumer. Keep their own databases/workers.

No push, merge, deploy, production activation, UI/browser acceptance or full AG→AM acceptance occurred. Existing `legacy` runtime default unchanged. This checkpoint is a scoped local development increment, not a release.
