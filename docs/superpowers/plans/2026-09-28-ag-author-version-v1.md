# AG-P3 author version v1: implementation plan

**Owner:** AI Aggregator only. **Base:** `310067e`, isolated `feat/ag-author-version-20260928`. **Spec:** [design](../specs/2026-09-28-ag-author-version-v1-design.md). Keep existing `models`/settlement authority; do not rewrite historical migrations or call a real endpoint.

## Batch A — safe candidate version

1. **Contract (shared owner):** define bounded manifest v1 parser and canonical digest in `packages/shared/src/author-manifest.ts`. Input: server-controlled adapter `openai_chat_https_v1`, HTTPS endpoint, text chat capability, rights/consent reference. Reject unknown fields, unsafe URL literals and malformed primitives; canonicalize accepted input server-side before hashing. Client JSON key order and whitespace are not identity. Client price/share is never authority. RED/GREEN focused tests.
2. **Storage (database owner):** additive migration `0087_author_model_versions.sql` and schema mapping. Append-only `author_model_versions` with model/author FK, version number, manifest JSON/digest, encrypted credential envelope, closed moderation state and unique version identity. Add nullable current-version pointer to `models`. Guarded native test: clean87/no-op87, immutable mutation refusal, concurrent duplicate identity, FK and no ledger write.
3. **Submission (Web owner):** rewrite `POST /api/models/request-publish` to validate bounded body, derive author from server auth, encrypt token using a domain-separated `AUTHOR_ENDPOINT_KEK`, insert `models` draft plus candidate version in one transaction, and return only safe fields. No endpoint probe or public activation in Batch A. API tests cover unauthenticated/foreign, invalid URL, absent KEK, duplicate slug, rollback, no plaintext storage/logging. Remove client-controlled tier as accepted price. Align author form with truthful pending terms; no 70/80/85 promise.
4. **Review/gate:** shared/database/Web type-check, focused native+HTTP tests, builds/lint and independent React/TypeScript/security/financial review. Record exact evidence in `docs/product/acceptance/AG-P3.md`, marked **partial** until Batches B/C.

## Batch B — moderation and usable version

Probe only through `safeFetch` without allowlist and with `maxRedirects:0` so Bearer token cannot reach a second origin. Fixed Bearer header, bounded POST/response and DNS/IP checks. Persist exact probe operation before POST; unknown outcome requires operator review, not a fresh key or automatic retry. Moderation CAS approves exact version/digest/rights only after confirmed probe and accepted price policy, then sets current pointer. Gateway admission pins version ID/digest and invokes this version through the same safe adapter. Freeze/depublish blocks new admission but preserves old receipt. Native mounted author endpoint proves one bought text result; no paid provider.

## Batch C — money and recovery

Versioned price/share policy fixed before admission. Settlement and author accrual share one durable authority or a persisted reconciliation task; remove warning-only loss. Refund reversal and mock payout use immutable operation identity and unknown-outcome recovery. One independent author, one buyer, replay/crash/race and accounting equality close AG-P3. Real payout remains separate release gate.

Heavy runs serialize with `flock /tmp/ai-ecosystem-build.lock`. Test DB must use `/tmp/ai-ecosystem-run aggregator` or equivalent guard. Preserve `.serena/project.yml` in the accepted worktree. Do not change Arena/Agents Market.

## Реализация29.09

Batch B/C реализованы в этой ветке: additive0088–0090, shared bounded adapter, pinned stored gateway, Web author/moderator/operator interfaces. [Checkpoint и границы локальной приёмки](../../consolidation/2026-09-29-author-lifecycle-checkpoint.md). Native388 + TON58 + author16, два отдельных browser-сценария прошли; окончательные unit/type/build/lint/commit факты читаются из checkpoint/evidence. Независимый reviewer в этой волне не вернул одобрение. Не переоткрывать Batch B/C как отсутствующий код; следующий общий этап задаётся AG-only roadmap.
