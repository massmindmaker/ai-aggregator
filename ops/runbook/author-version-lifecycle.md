# Author versions: local verification and operating boundaries

Updated: 29 September 2026. Scope: AI Aggregator, not Arena or Agents Market.

## Data and pricing authority

An author submission creates a disabled model and an immutable candidate version. The API token is AES-GCM encrypted with a user/domain-separated AUTHOR_ENDPOINT_KEK. No token is returned in the author view, public catalog, receipt or audit.

An administrator with a fresh authenticated admin session and step-up performs a single owned probe, proposes an immutable price/share/rights/consent policy, and approves the exact version only after the author accepts its digest. Price is an integer number of microcredits; one credit contains1000microcredits. Author share is an integer basis-point rate, rounded down once. Neither floating-point amounts nor marketing tiers determine settlement.

New calls use the existing POST /v1/chat/completions identity and quota admission. The binding captures version ID, manifest digest, price policy ID/digest and exact price before dispatch. An AFTER-settlement trigger records one author accrual in the same transaction. If accrual fails, settlement rolls back and its already-saved response can be reconciled without inference.

## Interfaces

- Author: /dashboard/models, /dashboard/models/[id], /dashboard/earnings.
- Moderator: /admin/author-models and /admin/author-models/[id].
- Operator: /admin/author-requests.
- Public author catalog: /marketplace/community and /marketplace/community/[slug].
- Common model API: GET /v1/models includes reviewed author prices when author execution is enabled.
- Admin version actions: POST /api/admin/models/[id]/author. Actions: probe, propose, approve, status, review_probe.
- Author actions: POST /api/author/models/[id]. Actions: accept, new_version.
- Financial operator actions: POST /api/admin/author-requests/[id]. Actions: recover, refund, no_charge, dispute.
- Mock payout: POST /api/author/payouts/mock. Requires Idempotency-Key and an explicit mock: recipient. It never transfers funds.

## Configuration and rollout order

Apply the additive migrations0088,0089,0090 to the intended environment only after separate production approval. Old SQL files remain unchanged. Deploy compatible gateway, Web and worker artifacts after migrations. Do not enable selling solely because an admin form renders.

AUTHOR_ENDPOINT_KEK must be a randomly generated256-bit value, encoded as64hex characters or base64; retain it securely for old-version execution and rotate only with a separately verified re-encryption plan. Never commit it or put it in a NEXT_PUBLIC variable.

AUTHOR_CHAT_ENABLED defaults to0. The gateway now rejects AUTHOR_CHAT_ENABLED=1 combined with legacy execution at startup; author sales must not be advertised without the durable executor. Enable it consistently in Web and gateway only on a reviewed environment using a stored gateway execution mode. The author adapter supports bounded non-streaming text only, not tools, BYOK, audio or video. Author hosting is not assumed to be in Russia: key residency and PII restrictions still apply.

AUTHOR_MOCK_PAYOUT_ENABLED only works with AIAG_TEST_DATABASE=1 and the designated loopback test PostgreSQL on15432/ai_aggregator_test. Mock payouts reserve test credits and produce deterministic mock receipts. They are not real payout integration or proof of any mainnet transaction.

## Recovery rules

Never re-run an uncertain provider POST with a fresh request ID as an automatic recovery action. The existing billing/request ID remains the authority.

A confirmed saved response with outcome_recorded can be settled from the operator screen, including when its key was subsequently revoked. This path validates the stored response and pricing and invokes the established settlement function; it does not contact the provider.

A dispatched request without a confirmed result requires the reconciliation deadline and a documented provider evidence reference before an administrator can confirm no charge. That resolution is append-only, releases the existing hold through the canonical settlement path with zero actual cost, creates no author accrual and returns a distinct no-result/zero-charge receipt on replay. An empty evidence field, a different attempt ID or a conflicting later resolution is rejected.

A full refund uses the stored subscription/payg allocation, never a browser-selected amount. Expired subscription credits are not converted to cash; payg refund first repays existing refund debt. Author credit is reversed by a new ledger entry. A refund after an already-completed mock payout leaves a negative author balance that blocks a new payout.

Disputes hold author credit without changing the original receipt. Freeze/depublish stops new admissions; old receipts remain bound to their accepted version. Switching or rolling back the current version does not reprice old requests.

An unknown probe does not become succeeded through operator review. Review records evidence and permits a distinct newly submitted version to be checked; the original operation remains immutable and is never retried. Concurrent new-version submissions use the expected latest version number and a model row lock.

## Reproducible local checks

Use the committed Bun lockfile and the isolated worktree. Never copy a production .env here. Heavy tasks are serialized with /tmp/ai-ecosystem-build.lock.

```bash
bun install --frozen-lockfile
bash scripts/bootstrap-native-test-tools.sh
python3 scripts/__tests__/test_native_port_guard.py
bun run test:database:isolated
scripts/with-native-test-services.sh bash -c 'bun run db:test:bootstrap && bun run db:test:migrate && RUN_NATIVE_DB_INTEGRATION=1 bun run test:unit --no-file-parallelism packages/database/scripts/__tests__/author-lifecycle.native.integration.test.ts packages/database/scripts/__tests__/author-billing.native.integration.test.ts packages/api-gateway/src/__tests__/author-chat-mounted.native.integration.test.ts apps/web/src/__tests__/author-management.native.integration.test.ts'
```

After a fresh Web production build with local-only DATABASE_URL/REDIS_URL, run the dedicated author browser proof:

```bash
scripts/with-native-test-services.sh bash -c 'bun run db:test:bootstrap && bun run db:test:migrate && node scripts/verify-owned-auth.mjs --author'
```

The browser proof uses actual registration/login, actual admin step-up and actual forms. Provider success and a paid request are explicitly synthetic SQL fixtures, not external paid inference. The native mounted gateway proof separately verifies a controlled transport, overlapping requests, key revocation, version replacement/rollback, refund, and uncertain-provider reconciliation.

No production deploy, external paid provider, mainnet transfer or real payout is authorized by these scripts. Disable the author execution flag to stop new author work; do not roll back by dropping financial tables or editing migration history. Preserve receipts and obligations for reconciliation.

## Acceptance runner budget

On a memory-constrained development host, run the complete unit suite with `bun run test:unit --no-file-parallelism --testTimeout=30000 --hookTimeout=60000` under the shared build lock. These are test-process budgets, not production/provider timeout changes. Native integration cases are run separately against owned local databases; unit SKIP is not native PASS.
