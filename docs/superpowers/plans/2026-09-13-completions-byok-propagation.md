# Legacy completions BYOK credential propagation

**Status:** Source accepted at `e5614e2` after independent TypeScript/security/admission-boundary PASS / APPROVE. Focused24, gateway source/test types, lint and diff checks PASS. Programme-wide final review and route admission remain separate gates.

**Goal:** Correct the existing credential propagation defect in legacy `/v1/completions`: a request classified and charged as header-BYOK must give the selected adapter that same caller key.

**Workflow:** Superpowers subagent-driven-development, one bounded task with independent TypeScript/admission-boundary review. This fixes a known defect in [route coverage](../../product/acceptance/AG-P1-route-coverage.md), not a new admission design.

## Constraints and preflight

- Canonical root `/home/bob/Projects/ai-aggregator`; preserve all concurrent TON/catalog/recovery work. No other product edits.
- Existing `ChatRequest.byokKey` and real adapters already support caller-key precedence. Change only propagation from this route.
- Preserve legacy candidate selection, no-failover BYOK behavior, error handling, preflight and fee semantics. Do not add stored encrypted key lookup, registry bypass, a tariff, DB write, migration or new network call.
- Restricted `stored_chat_only` `/v1/completions` remains501 before provider. This correction does not admit the route, reserve its fee or complete its hold/outcome/recovery lifecycle.
- Existing registry dependence on platform configuration remains a separate open decision. The regression uses distinct synthetic caller/platform credentials and local mocked transport only. Never print actual credentials.
- One heavy command at a time under `flock /tmp/ai-ecosystem-build.lock /tmp/ai-ecosystem-run aggregator`. No runtime/env activation, paid provider, deploy or push.

## Task 1: propagate header and prove real adapter credential precedence

**Exclusive files:**
- `packages/api-gateway/src/routes/v1/completions.ts`
- `packages/api-gateway/src/__tests__/completions-byok.test.ts` (new)

- [x] RED: invoke the actual legacy Hono completions route with a synthetic `x-upstream-key`, two available candidates and a distinct synthetic platform key. Mock resolver/billing/counters/logging seams; run the real OpenRouter adapter against mocked `fetchUpstream`, with zero network/DB. Assert caller key in adapter input and transport authorization, one dispatch, no platform preflight, exactly `calcByokFeeCredits()` settlement and counters `byok:true`/`upstreamCents:0`. Add failing-provider case proving one attempt and zero settlement/counter calls. The missing-field defect must make the success regression fail before source change.
- [x] Implement only the header retention (`byokKey`), BYOK classification from that value, and propagation of that field into the existing adapter request DTO.
- [x] GREEN: run focused `completions-byok.test.ts`, existing `openrouter-admitted-chat.test.ts` and `spend-counters.test.ts` through Node Vitest under the lock. Run gateway production and test tsconfigs, scoped ESLint on the two owned files, and `git diff --check`. Use existing test config; do not change compiler settings to pass.
- [x] Inspect diff to confirm registry/admission/server/failover/pricing/DB and all other routes are unchanged. Report actual command/results, RED counterexample and evidence limits in the ignored task report.
- [x] Commit only the two owned files as `fix(gateway): pass BYOK credentials to legacy completions`; obtain independent TypeScript/security and admission-boundary review. Controller updates the route-coverage defect status only after APPROVE.

**Acceptance:** Caller-supplied key reaches real selected adapter transport instead of the configured platform key in a local regression; failure charges nothing, restricted mode stays unchanged. No live provider/production or admitted-route acceptance is implied.
