# AG-P2: public catalog contract Implementation Plan

> **Status:** DRAFT — contract candidate for independent design review. No implementation or AG-P2 acceptance is implied by this document. Implementation may start only after the root independent review records an explicit approval.

> **For agentic workers:** REQUIRED SUB-SKILL: use Superpowers `executing-plans` or the controller-approved `subagent-driven-development` workflow. Execute one task at a time, keep exclusive file ownership, and obtain an independent review before each scoped commit.

**Goal:** Add an authenticated `GET /v1/catalog` contract that tells a consumer exactly which AI Aggregator model offering it may invoke, through which admitted public request contract, and under which retail pricing revision, without giving the consumer AI Aggregator database access or exposing supplier prices, markup, routing, egress, provider credentials, or unreviewed capabilities.

**Architecture:** The existing gateway server remains the only HTTP server. The route projects a fresh, key-relative catalog snapshot from the live model registry, the accepted reviewed capability manifest, the registered adapter mechanics, the current gateway execution mode, exact billing configuration, and the freshly authenticated key policy. A model is advertised as callable only when those sources agree on one unambiguous admitted deployment. The response carries an opaque catalog revision and seek cursor; a durable database revision invalidates pages after any relevant registry change. Existing `/v1/models` behavior and the default `legacy` runtime mode remain unchanged.

**Tech Stack:** TypeScript, Hono, Zod, PostgreSQL, existing exact token billing functions, Bun 1.4.2 and Vitest/native guards for later implementation.

**Spec inputs:** [production continuation](2026-09-07-production-continuation.md), [integration ownership](../../ecosystem/integration.md), [payment and evidence design](../../ecosystem/payment-and-evidence-design.md), [research decisions](../../research/2026-09-07-research-impact-and-decisions.md), and the private [design intake](../../../.superpowers/sdd/2026-09-07-production-continuation/catalog-design-intake.md).

## Global constraints

- Work only in `/home/bob/Projects/ai-aggregator`. AI Arena and Agents Market source remain paused. The consumer fixture in this repository is test code owned by Aggregator; it is not an Agents Market implementation or release claim.
- Do not create another server, public origin, database credential path, tariff source, provider probe, paid call, deployment, production migration, or feature activation.
- `/v1/models` remains byte/behavior compatible. Adding `/v1/catalog` must not narrow, reinterpret, redirect, or enrich `/v1/models`.
- Register `/v1/catalog` through the existing `/v1` authentication and guard chain in both `legacy` and `stored_chat_only` assemblies. The default `GATEWAY_HTTP_EXECUTION_MODE=legacy` is unchanged.
- The only currently accepted advertised execution contract is stored, non-streaming, plaintext chat backed by an exact reviewed profile and admitted adapter mechanics. Legacy chat, completions, embeddings, media, batches, tools, streaming, BYOK, and other model rows are not upgraded to admitted capabilities by this read route.
- Catalog availability is an advertised-contract decision from configuration and policy. It is not a live upstream health/SLA claim and never performs a provider request.
- Prices are retail terms derived with exact decimal arithmetic from the billing authority already used by admission. Never serialize or copy supplier cents, markup, upstream/provider identity, upstream model ID, priority, latency, uptime, base URL, egress proxy, metadata, credentials, environment values, or raw policy contents.
- A catalog price is not a quote. Admission continues to create and persist its immutable quote/pricing snapshots. A later catalog or price revision never rewrites an existing quote, receipt, usage snapshot, or ledger row.
- SQL uses tagged prepared statements. Any native database work uses only a disposable local test database under `/tmp/ai-ecosystem-build.lock`; implementation must re-read the migration manifest before reserving the next number.
- Every error body is a fixed allowlisted projection. No caught exception text, SQL diagnostics, policy values, provider names, config names, secrets, or row payloads reach the response.
- No task below may claim the real AG→AM gate. Until Agents Market is resumed and its own source consumer is reviewed, full cross-product acceptance remains **UNVERIFIED**.

## Research inputs → Decision / ADR → Acceptance → Deferred

| Input | Grounded finding | Decision / ADR | Acceptance consequence | Deferred |
|---|---|---|---|---|
| R03 marketplace lifecycle | A catalog entry refers to a sellable version/configuration; an endpoint label alone is not immutable source identity. Exact author rights and immutable artifacts remain open. | Separate stable model identity, stable deployment identity, mutable configuration revision, and immutable artifact attestation. Current remote artifact is explicitly `unattested`. | Tests reject invented digest/version fields and preserve identity across price-only changes. | Author artifact/version/rights lifecycle remains AG-P3. |
| R06 providers/capabilities | A configured key or registry row does not prove capability or availability. Curated, tested combinations are the v1 boundary. | Capabilities come only from reviewed profile + registered admitted mechanics + runtime mode + current key policy; model metadata is never a capability source. | Unsupported/missing mechanics and policy-excluded candidates are unavailable, never paid fallback. | New profiles, tools, streaming, media, BYOK and provider probes need separate briefs. |
| R09 contract ownership | Products must integrate through versioned HTTP contracts without foreign SQL, with explicit owner/revision/recovery semantics. | Aggregator owns schema, route, pricing projection and revision. Use seek pagination with revision invalidation and an AG-owned consumer fixture. | Producer JSON is parsed by the shared contract over the mounted local HTTP route; fixture imports no DB module. | Real AM source integration and full AG→AM run/receipt are separate resumed gates. |
| Existing billing authority | DB cents-per-1k plus exact markup produces microcredits; actual charge applies the legacy cache multiplier to the whole input+output cost and rounds once half-up. Maximum authorization rounds once upward. | Publish only exact retail microcredits-per-token and the existing formula/cache/rounding IDs. Price revision hashes the public retail projection. | Catalog arithmetic must reproduce `calculateTokenCharge` and `quoteChatMaximum` over boundary vectors. | No new FX, tariffs, discounts, commission, free tier, or unit-economic policy. |

### ADR: selected projection boundary

`/v1/catalog` is a key-relative **advertised contract**, not a mirror of registry metadata and not a provider discovery API. It returns the publicly listed model set, but an item contains an invocation and price only when the current sources establish one admitted deployment. In the accepted current state that means the exact reviewed stored-chat tuple; the route does not infer capabilities for the rest of the catalog.

Alternatives rejected for v1:

1. Returning `models.metadata` or adapter method names would turn historical/unreviewed data into product claims.
2. Returning every `model_upstreams` candidate would disclose routing structure and make a price appear selectable when the request API accepts only a model slug.
3. Collapsing several eligible deployments to an average, cheapest, or guessed tariff would not reproduce admission. If more than one distinct admitted deployment survives, the item is unavailable with `ambiguous_admitted_deployment` until a separately reviewed multi-deployment contract exists.
4. Offset pagination can skip or duplicate items after a price/status change. A seek cursor bound to a catalog revision makes mutation explicit.
5. Recomputing a revision by loading an unbounded registry on every request is not a bounded backend. A singleton database revision, runtime projection hash, and key-policy hash provide deterministic invalidation without a second service.

## Frozen wire contract candidate

The shared Zod parser is strict: unknown keys fail, strings and arrays are bounded, monetary decimals are canonical nonnegative plain strings, and all revision digests match `sha256:<64 lowercase hex>`. The following is the full response shape; unavailable items cannot carry deployment, invocation, capability, or pricing objects.

```ts
type Sha256Revision = `sha256:${string}`;
type Uuid = string;
type CatalogMode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';

type CatalogUnavailableReason =
  | 'model_frozen'
  | 'runtime_contract_unavailable'
  | 'key_policy_excludes_model'
  | 'no_admitted_deployment'
  | 'service_configuration_unavailable'
  | 'retail_pricing_unavailable'
  | 'ambiguous_admitted_deployment';

interface CatalogModelIdentityV1 {
  id: Uuid;                    // existing models.id; stable identity
  slug: string;                // request alias; /v1/models continues to expose it as id
  type: string;                // bounded registry type, not a capability assertion
  artifact: {
    attestation: 'unattested';
    version: null;
    digest: null;
  };
}

interface CatalogUnavailableItemV1 {
  object: 'catalog.model';
  model: CatalogModelIdentityV1;
  availability: {
    state: 'unavailable';
    scope: 'advertised_contract';
    reason: CatalogUnavailableReason;
    liveUpstreamHealthChecked: false;
  };
  deployment: null;
  invocation: null;
  capabilities: readonly [];
  pricing: null;
}

interface CatalogAvailableItemV1 {
  object: 'catalog.model';
  model: CatalogModelIdentityV1;
  availability: {
    state: 'available';
    scope: 'advertised_contract';
    reason: null;
    liveUpstreamHealthChecked: false;
  };
  deployment: {
    id: Uuid;                  // sole admitted model_upstreams.id, opaque to consumer
    configurationRevision: Sha256Revision;
    contract: 'stored-plaintext-chat-v1';
  };
  invocation: {
    method: 'POST';
    path: '/v1/chat/completions';
    authorization: 'bearer_api_key';
    contentType: 'application/json';
    maxBodyBytes: 262144;
    headers: {
      idempotencyKey: {
        name: 'Idempotency-Key'; required: true;
        pattern: '^[A-Za-z0-9._:-]{1,128}$';
      };
      sessionId: {
        name: 'X-AIAG-Session-Id'; required: false;
        pattern: '^[A-Za-z0-9._:-]{1,128}$';
      };
    };
    parameters: {
      model: { required: true; const: string };
      messages: {
        required: true; minItems: 1;
        roles: readonly ['system', 'user', 'assistant'];
        content: 'nonempty_string';
      };
      stream: { required: false; const: false; normalizedDefault: false };
      max_tokens: {
        required: false; type: 'integer'; minimum: 1;
        maximum: number; defaultApplied: number;
      };
      aiag_mode: {
        required: false;
        values: readonly ['auto', 'fastest', 'cheapest', 'balanced', 'ru-only'];
        availableValues: readonly CatalogMode[];
        defaultRequested: CatalogMode;
        effectiveDefault: CatalogMode;
        requiresExplicitAvailableValue: boolean;
      };
    };
  };
  capabilities: readonly [{
    id: 'chat.completions.stored.plaintext.v1';
    inputModalities: readonly ['text'];
    outputModalities: readonly ['text'];
    streaming: false;
    toolCalling: false;
    structuredOutput: false;
    asynchronous: false;
    storedResult: true;
    usageReceipt: true;
    requestDependentRestrictions: readonly ['pii_transborder'];
    contextWindowTokens: number;
    maxOutputTokens: number;
  }];
  pricing: CatalogRetailTokenPricingV1;
}

interface CatalogRetailTokenPricingV1 {
  revision: Sha256Revision;
  currency: 'USD';
  settlementUnit: 'microcredit';
  microcreditsPerUsdCent: '1000';
  rates: {
    input: { amount: string; unit: 'microcredit_per_token' };
    output: { amount: string; unit: 'microcredit_per_token' };
  };
  actualCharge: {
    formulaVersion: 'db-input-output-cents-per-1k-legacy-whole-cache-v1';
    cachePolicy: {
      scope: 'whole_input_plus_output_cost';
      multiplier: string;
      factorFormula:
        'prompt=0?1:((prompt-cached)+cached*multiplier)/prompt';
    };
    rounding: 'nearest_nonnegative_half_up_once_to_microcredit';
  };
  maximumAuthorization: {
    formula:
      'input_rate*context+max(output_rate-input_rate,0)*max_output';
    rounding: 'ceil_once_to_microcredit';
  };
  quoteSemantics: 'terms_only_quote_created_at_admission';
}

type CatalogItemV1 = CatalogUnavailableItemV1 | CatalogAvailableItemV1;

interface CatalogResponseV1 {
  schemaVersion: 1;
  object: 'catalog.list';
  catalogRevision: Sha256Revision;
  data: readonly CatalogItemV1[];
  page: {
    limit: number;
    nextCursor: string | null;
  };
}
```

### Identity and attestation rules

- `model.id` is the existing `models.id` UUID. `model.slug` remains the request alias and retains `/v1/models` compatibility; it is not promoted to immutable artifact identity.
- `deployment.id` is the sole admitted `model_upstreams.id` UUID. The response never exposes the associated upstream/provider/model labels.
- `deployment.configurationRevision` is SHA-256 over a canonical ordered tuple containing schema version, model ID/slug/type, deployment ID, reviewed profile identity/revision, admitted adapter contract, public invocation limits/capabilities, and the effective runtime contract. It is configuration identity, not a digest of remote model weights or code.
- Current source contains no immutable remote artifact version/digest. Therefore v1 emits only `artifact.attestation='unattested'`, `version=null`, and `digest=null`. Adding an attested variant requires evidence and an explicit contract amendment; no implementation may fill these fields from provider labels, metadata, URLs, response `model`, git HEAD, or configuration revision.
- A price-only change changes `pricing.revision` and `catalogRevision`, but does not change `model.id` or `deployment.id`. It changes `configurationRevision` only if a non-price public execution fact also changed.

### Capability and availability rules

The projector starts with `models.enabled=true` and `status IN ('live','frozen')`, ordered by `(slug,id)`. Draft, pending-consent, depublished, and disabled rows are absent from `/v1/catalog`; this is a new contract and does not alter `/v1/models`.

For a `live` model, the available union is emitted only when all checks pass:

1. Runtime mode is `stored_chat_only`; `legacy` keeps its existing routes but has no durably admitted advertised contract in this v1.
2. The fresh key policy parses under the same strict policy decoder used by stored chat, and the model whitelist permits the slug.
3. A candidate is enabled, its upstream is enabled, the model type is `chat`, and the accepted `status='live'` resolver projection is valid.
4. `findReviewedChatProfile` matches the full model/upstream/model/adapter identity; metadata never substitutes for it.
5. `getUpstream` resolves configured mechanics and `admittedChat.contract` matches the reviewed profile. This is a local configuration check only and sends no request.
6. For each advertised `aiag_mode`, `prepareStoredChatQuote` accepts the effective key policy and selects the same sole deployment. Modes with no eligible candidate are removed from `availableValues`. If distinct admitted deployments survive across available modes or quote candidates, the whole item is `ambiguous_admitted_deployment` rather than publishing a misleading blended price.
7. Exact billing facts parse, both retail rates are canonical nonnegative decimals, the computed maximum authorization is positive, and all published integer/decimal bounds validate. A zero rate already permitted by the billing authority is not reclassified by a new catalog tariff rule.

`defaultRequested` is the fresh key policy `default_mode` or `auto`. `effectiveDefault` is `ru-only` when fresh policy forces non-RU exclusion, otherwise `defaultRequested`. `requiresExplicitAvailableValue` is true only when `effectiveDefault` is not in `availableValues`; the consumer must then choose an advertised available mode. PII availability cannot be known before request content exists, so the capability carries `requestDependentRestrictions:['pii_transborder']`; it never claims all plaintext will pass.

Reason precedence for unavailable items is fixed: `model_frozen` → `runtime_contract_unavailable` → `key_policy_excludes_model` → `service_configuration_unavailable` → `no_admitted_deployment` → `retail_pricing_unavailable` → `ambiguous_admitted_deployment`. A malformed/unavailable key-policy read invalidates the whole response with 503 rather than classifying individual models from uncertain policy.

### Exact retail price rules

- Read `price_per_1k_input`, `price_per_1k_output`, and `markup` as exact canonical decimal text from the same fresh candidate projection used by admission. They remain internal.
- Derive each public rate with exact rational multiplication: `retail microcredits/token = supplier cents/1000 tokens × 1000 microcredits/cent × markup`. The factors of 1000 cancel; serialize the normalized exact product only. Never multiply through JavaScript `number` and never publish per-token values rounded to an integer.
- Actual charge remains exactly `calculateTokenCharge`: form `input_rate*prompt_tokens + output_rate*completion_tokens`; apply the configured cache factor to that whole sum; round the final nonnegative value once with half-up to integer microcredits.
- The cache factor is `1` when `prompt_tokens=0`; otherwise `((prompt_tokens-cached_input_tokens)+cached_input_tokens*multiplier)/prompt_tokens`. `multiplier` is the exact `STORED_CHAT_CACHING_DISCOUNT_EXACT` string. It is not a separate cached-input retail rate.
- Maximum authorization remains exactly `quoteChatMaximum`: `ceil(input_rate*context_window + max(output_rate-input_rate,0)*max_output_tokens)` in microcredits. The catalog does not promise that this maximum will be the final charge.
- `pricing.revision` is SHA-256 of canonical JSON containing only the public currency/unit/rates, formula version, exact cache policy, rounding, and maximum formula. Supplier price and markup are excluded from both JSON and diagnostics.
- Catalog reads do not create quotes or inspect balances. Existing immutable admission `quoteSnapshot`/`pricingSnapshot`, receipts, and ledger records remain authoritative for a request after catalog terms change.

## Pagination, revision and cache contract

Query parameters are only `limit` and `cursor`. `limit` defaults to 20 and must be a canonical decimal integer from 1 through 100. Offset/page parameters and repeated/unknown query keys are rejected with 400.

The cursor is base64url without padding of strict canonical JSON:

```ts
interface CatalogCursorV1 {
  schemaVersion: 1;
  catalogRevision: Sha256Revision;
  after: { slug: string; modelId: Uuid };
}
```

The encoded cursor is limited to 1024 bytes. It is not a credential and need not be signed: a well-formed forged seek position cannot bypass authentication, availability checks, or row predicates. Malformed cursors return 400. A cursor whose `catalogRevision` differs from the fresh current revision returns 409 and no data; the consumer restarts without a cursor. Each page selects at most `limit+1` model rows by `(slug,id)` and then only candidates for those IDs inside the same read-only repeatable-read transaction.

The next migration adds one singleton `gateway_catalog_revisions` row with positive `BIGINT revision` and statement-level bump triggers for relevant changes to `models`, `model_upstreams`, and `upstreams`. Relevant columns include identities, slug/type/status/enabled flags, candidate binding/enabled/priority, exact price/markup, residency and execution configuration. Deletion also bumps. Over-invalidation is acceptable; failure to invalidate a public fact is not. The implementation owner re-reads the migration manifest and substitutes the actual next free migration number before editing.

`catalogRevision` is SHA-256 over `[schemaVersion,dbRevision,runtimeProjectionRevision,keyPolicyRevision]`:

- `runtimeProjectionRevision` hashes the reviewed manifest revisions, admitted-contract identities, execution mode, exact cache multiplier, default max output and public contract constants. It contains no secret value.
- `keyPolicyRevision` hashes the normalized policy values already held by fresh authentication. It is never returned separately and never includes bearer/hash/credential data.
- A relevant registry/price change, process restart with changed public config/profile, or key-policy change invalidates later pages.

Every success and error sets `Cache-Control: private, no-store`; success also sets `Vary: Authorization`. `catalogRevision` is for explicit consumer cache validation and cursor continuity, not permission to use a shared HTTP cache. No Redis/catalog body cache is added in this task.

## HTTP registration and error semantics

Create one Hono route module and register it in the existing `packages/api-gateway/src/server.ts`:

- legacy assembly: `app.route('/v1/catalog', catalogRoute)` after the common `/v1/*` auth/rate/key/PII/model guard chain;
- restricted assembly: add `['/catalog', catalogRoute]` to the current allowlisted GET-copy loop, preserving both `/v1/catalog` and `/v1/catalog/` aliases and the same guard order.

Fixed response semantics:

| HTTP | Code | Meaning |
|---:|---|---|
| 200 | — | Valid key and valid bounded snapshot, even when every item is unavailable or the organization balance is zero. |
| 400 | `INVALID_CATALOG_QUERY` | Unknown/repeated parameter or invalid `limit`. |
| 400 | `INVALID_CATALOG_CURSOR` | Malformed, oversized or non-canonical cursor. |
| 401 | `UNAUTHORIZED` | Existing missing/invalid/revoked/disabled API-key boundary. |
| 402 | `PAYMENT_REQUIRED` | Only the already-mounted key-limit policy when its monthly cost cap is reached. Catalog performs no balance/admission check and invents no other 402. |
| 409 | `CATALOG_REVISION_CHANGED` | Cursor belongs to a superseded catalog/key-policy revision; restart pagination. |
| 429 | `RATE_LIMITED` | Existing mounted rate/daily-cap boundary. |
| 503 | `SERVICE_UNAVAILABLE` | Existing fresh-auth storage failure. |
| 503 | `KEY_POLICY_UNAVAILABLE` | Authenticated policy cannot be strictly normalized. |
| 503 | `CATALOG_UNAVAILABLE` | Registry/revision/projection transaction or required safe configuration failed. |

Catalog-owned bodies contain exactly `{error:{code,message}}`; the fixed messages are respectively `Invalid catalog query`, `Invalid catalog cursor`, `Catalog changed; restart pagination`, `Key policy unavailable`, and `Catalog unavailable`. A 503 sets `Retry-After: 2`. No per-row exception text is returned. A single malformed supposedly sellable row fails the response closed with 503 rather than disappearing or becoming available with partial facts.

## Schema-first implementation tasks

### Task 0: independent design gate

**Files:** this plan and private review report only.

- [ ] Root independent reviewer checks schema consistency, identity/attestation language, pricing parity, revision/pagination races, auth/402 semantics, leakage boundary, task ownership and the acceptance matrix.
- [ ] Any contract change is made here before source work. Record `APPROVED_FOR_IMPLEMENTATION` or blocking findings in the private controller workspace.

**Gate:** no implementation task starts while this plan remains DRAFT or the review is unresolved.

### Task 1: shared strict schema and pinned fixture

**Exclusive files:**

- `packages/shared/src/catalog-contract.ts` (new)
- `packages/shared/src/__tests__/catalog-contract.test.ts` (new)
- `packages/shared/src/__tests__/fixtures/catalog-v1.json` (new)
- `packages/shared/package.json`
- `packages/shared/tsup.config.ts`

Steps:

- [ ] RED: strict parser rejects unknown keys, invalid digest/UUID/decimal, overlong fields, more than 100 data items, unavailable items carrying price/capability data, available items missing unit/revision, unsupported capability marked available, and malformed cursor.
- [ ] Implement the exact DTO/cursor schemas, types, bounded parser and canonical cursor codec as browser-safe code with no Node import.
- [ ] Add `@aiag/shared/catalog-contract` as an explicit build/export entry; do not expand the legacy root/client/server barrels.
- [ ] Pin one available stored-chat item, one unavailable item and a next cursor in the fixture. Fixture values are synthetic and visibly named; they are not production/provider evidence.

**Focused acceptance:** shared contract tests, shared source/test typecheck, build export/import smoke, applicable lint, secret/provider-field negative scan, `git diff --check`.

### Task 2: durable registry revision

**Exclusive files:**

- `packages/database/migrations/<actual-next>_gateway_catalog_revision.sql` (new; resolve exact number immediately before work)
- `packages/database/scripts/__tests__/gateway-catalog-revision.native.integration.test.ts` (new)
- `package.json` only if the controller assigns this focused native file to the guarded baseline

Steps:

- [ ] RED on a disposable database: missing singleton/revision; insert/update/delete of relevant model/upstream/candidate facts fail to advance exactly once per statement; rollback incorrectly advances; unrelated table change advances; or overflow/corrupt singleton incorrectly permits a catalog read.
- [ ] Add idempotent singleton table, positive revision constraint, guarded bump function and statement triggers. Mutation rollback must roll back the bump. Missing/duplicate/corrupt singleton makes the catalog query fail closed.
- [ ] Prove price, status, enabled/binding/residency/config and deletion invalidation. Prove an unrelated ledger/key telemetry update does not bump the DB revision; key policy remains covered by its request hash.

**Focused acceptance:** fresh migration plus no-op rerun on the task database, focused native revision test under `flock`, migration manifest check, applicable type/lint and diff check. This does not authorize a production migration.

### Task 3: exact retail and availability projector

**Exclusive files:**

- `packages/api-gateway/src/catalog/retail-token-pricing.ts` (new)
- `packages/api-gateway/src/catalog/public-catalog.ts` (new)
- `packages/api-gateway/src/billing/stored-chat-fresh-policy.ts`
- `packages/api-gateway/src/__tests__/catalog-retail-token-pricing.test.ts` (new)
- `packages/api-gateway/src/__tests__/public-catalog.test.ts` (new)
- `packages/api-gateway/src/__tests__/stored-chat-fresh-policy.test.ts`

Steps:

- [ ] RED pricing parity vectors: fractional DB values, markup products, half-up ties, cache multiplier 0/1/fraction, zero prompt, output below input, maximum ceil and values beyond `2^53`. Compare catalog formula results with existing `calculateTokenCharge` and `quoteChatMaximum`.
- [ ] Export a pure strict key-policy normalization seam from `stored-chat-fresh-policy.ts` and keep the existing request preparation using that same seam. No policy meaning changes.
- [ ] Implement exact decimal multiplication/normalization, public pricing projection and pricing revision. The returned object never contains source prices or markup.
- [ ] Implement prepared seek-page reads in one read-only repeatable-read transaction and project model/candidate rows through existing reviewed-profile and admitted-mechanics boundaries.
- [ ] Evaluate all five request modes under the normalized current key policy. Publish the available union only when every available mode maps to the same single admitted deployment and price; otherwise use the fixed unavailable reason.
- [ ] Compute configuration/runtime/key/catalog revisions from canonical tuples. Hashes may consume internal identities but only the final digest is returned.
- [ ] Fail closed on invalid status/type/price/profile/config/policy shapes. Ignore descriptive metadata as a capability source.

**Focused acceptance:** projector/pricing/policy unit tests, mutation-after-capture immutability checks, source/test typecheck, applicable lint and diff check. Independent financial/spec review must confirm exact pricing and old snapshot semantics before route wiring.

### Task 4: route, both server modes and sanitized errors

**Exclusive files:**

- `packages/api-gateway/src/routes/v1/catalog.ts` (new)
- `packages/api-gateway/src/catalog/http-contract.ts` (new)
- `packages/api-gateway/src/server.ts`
- `packages/api-gateway/src/__tests__/catalog-route.test.ts` (new)
- `packages/api-gateway/src/__tests__/server.test.ts`
- `packages/api-gateway/src/__tests__/stored-chat-composition.test.ts`

Steps:

- [ ] RED: `/v1/catalog` and trailing slash are absent or misguarded in one mode; query/cursor/status matrix is incomplete; low/zero balance is incorrectly 402; exception data leaks.
- [ ] Add the bounded query/cursor capture and fixed success/error descriptors. Never pass caught error/message/details into a descriptor.
- [ ] Register the same route object through the existing common legacy chain and restricted GET-copy loop. Preserve middleware order and `private, no-store` on success, auth failure, 402, 409, 429, 503 and 404.
- [ ] Snapshot `/v1/models` before/after for both runtime modes and prove no import, SQL, field or response change in its module.

**Focused acceptance:** route/server composition tests in both env modes; 200/400/401/402/409/429/503 matrix; no balance query/admission/provider call on catalog read; source/test typecheck, applicable lint and diff check. TypeScript review is required.

### Task 5: AG-owned HTTP consumer fixture and native contract gate

**Exclusive files:**

- `packages/api-gateway/src/__tests__/fixtures/catalog-consumer.ts` (new)
- `packages/api-gateway/src/__tests__/catalog-producer-consumer.http.test.ts` (new)
- `packages/api-gateway/src/__tests__/catalog-mounted.native.integration.test.ts` (new)
- `docs/product/acceptance/AG-P2.md` (new; evidence only after commands actually pass)
- root guarded baseline script only if controller assigns this exact test after focused approval

Steps:

- [ ] The fixture consumer accepts only a `fetch`-compatible function/base URL, calls mounted `GET /v1/catalog`, parses JSON through `@aiag/shared/catalog-contract`, rejects unavailable capability/price and refuses dispatch unless requested capability, mode, unit and revision match.
- [ ] Static boundary test proves the fixture imports no database package, SQL client, internal catalog projector, provider module or Agents Market path.
- [ ] Local HTTP test exercises the real Hono route and auth chain with controlled adapters/SQL; it must not call a network provider.
- [ ] Native disposable-DB test proves stable two-page seek order, no duplicates, relevant mutation → stale cursor 409, key-policy change → stale cursor 409, exact price revision change, frozen/unavailable behavior, provider configuration failure, and immutable existing admission/receipt snapshots after price change.
- [ ] Negative serialization scan rejects keys and representative nested paths for `upstream`, `provider`, `upstreamModelId`, `pricePer1k`, `markup`, `priority`, `latency`, `uptime`, `baseUrl`, `egress`, `metadata`, `policies`, `credential`, `secret`, and environment variable names.
- [ ] Record exact commits, commands, environment, checked time, counts, reviewer verdict and unresolved limits in `AG-P2.md`. Label the fixture `AG-owned local consumer`; label real AM and cross-product acceptance **UNVERIFIED**.

**Focused acceptance:** shared schema + gateway unit/composition + local HTTP fixture + guarded native catalog test, then package source/test types and applicable lint. Run one heavy command at a time under the shared lock. Independent contract/financial/security/TypeScript review must approve the combined diff before the scoped implementation commit.

## Acceptance matrix

| ID | Contract claim | Required proof | Reject condition |
|---|---|---|---|
| CAT-01 | Exact schema v1 | Shared strict parser + pinned JSON producer fixture | Unknown/missing fields, unbounded input or incompatible union accepted |
| CAT-02 | Stable identities without invented artifact | Identity/config-revision tests across price/config/binding changes | Provider label or config hash presented as immutable artifact/version |
| CAT-03 | Truthful capability | Reviewed profile + admitted mechanics + strict request descriptors | Metadata, adapter method presence alone, tools/stream/media/legacy advertised |
| CAT-04 | Key-relative availability | Whitelist/provider/residency/default/explicit-mode matrix | Policy-excluded or ambiguous deployment is sellable |
| CAT-05 | Runtime/config availability | Both modes, configured/missing adapter, no network | Legacy mode or missing system configuration advertised callable |
| CAT-06 | Exact retail price | Parity with current quote/charge functions including >`2^53` vectors | Float arithmetic, absent unit/revision, supplier/markup exposure |
| CAT-07 | Cache policy truth | Whole-cost multiplier and one half-up rounding assertion | Independent discounted-input rate or second rounding introduced |
| CAT-08 | Quote/receipt immutability | Native price-change test against stored admission snapshots | Catalog mutation rewrites/revalues old quote, receipt or ledger |
| CAT-09 | Stable pagination | Seek pages + DB/runtime/key revision invalidation | Offset, duplicate/skip, stale page returns 200 |
| CAT-10 | Auth and errors | 200/400/401/402/409/429/503 matrix in both modes | Catalog-specific balance 402 or diagnostic leakage |
| CAT-11 | `/v1/models` compatibility | Before/after snapshots and unchanged source contract | Existing route shape/filter/registration changes |
| CAT-12 | No internal leakage | Positive allowlist serializer + forbidden-key scan | Provider/routing/cost/markup/egress/policy/secret field escapes |
| CAT-13 | DB isolation | AG-owned consumer import boundary + mounted HTTP test | Consumer imports AG DB/projector or bypasses HTTP |
| CAT-14 | Full cross-product | Real AM source consumer plus catalog→admission→run→receipt after AM resume | Remains **UNVERIFIED** in this plan; fixture cannot satisfy it |

## Deferred and explicitly unclaimed

- Real Agents Market or Arena code, credentials, activation, deployment, Web/TMA behavior, and full AG→AM cross-product run/receipt.
- Anonymous/public-without-key catalog, shared/proxy caching, provider health/SLA probes, live paid provider execution and production migration/deploy.
- More than one admitted deployment per public offering, consumer-selected deployment, provider disclosure, fallback price envelopes, or price comparison modes.
- Streaming, tools/functions, structured output, multimodal messages, embeddings, images, audio, video, batches, async jobs, BYOK and legacy route admission.
- Immutable model/code/weights digest, provider model revision, author rights/license/evidence refs, Arena score, or author marketplace lifecycle.
- New tariff, discount, FX, RUB conversion, subscription/free-tier terms, supplier price, markup, author split, egress cost or quote endpoint.
- Runtime route activation: the default stays `legacy`; switching mode or claiming production availability requires its existing separate release gate.

## Completion boundary

This plan is complete only as a reviewed design candidate. AG-P2 implementation becomes locally accepted only after Tasks 1–5 pass their focused checks and independent reviews, the scoped source commit is identified, and `docs/product/acceptance/AG-P2.md` records the actual evidence. Production, real provider, real AM consumer and full cross-product readiness remain separate gates regardless of local PASS.
