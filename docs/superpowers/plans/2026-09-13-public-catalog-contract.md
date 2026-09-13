# AG-P2: public catalog contract Implementation Plan

> **Status:** APPROVED_FOR_IMPLEMENTATION13.09 — independent scoped design review accepted `229a83f`; all two Critical, five Important and two minor findings addressed. Shared Task1 source `5466c34` + `a502f4c` is independently accepted. Task2 durable revision `78f7e38` + `665a43b` is independently accepted, including guarded pristine73 migration proof and native22 checks. Task3 may proceed; runtime and full AG-P2 acceptance remain open.

> **For agentic workers:** REQUIRED SUB-SKILL: use Superpowers `executing-plans` or the controller-approved `subagent-driven-development` workflow. Execute one task at a time, keep exclusive file ownership, and obtain an independent review before each scoped commit.

**Goal:** Add an authenticated `GET /v1/catalog` contract that tells a consumer exactly which AI Aggregator model offering it may invoke, through which admitted public request contract, and under which retail pricing revision, without giving the consumer AI Aggregator database access or exposing supplier prices, markup, routing, egress, provider credentials, or unreviewed capabilities.

**Architecture:** The existing gateway server remains the only HTTP server. The route projects a fresh, key-relative catalog snapshot from the live model registry, the accepted reviewed capability manifest, the registered adapter mechanics, the current gateway execution mode, exact billing configuration, and the freshly authenticated key policy. A model is advertised as callable only when those sources agree on one unambiguous admitted deployment. The response carries an opaque catalog revision and seek cursor; a durable database revision invalidates pages after any relevant registry change. Existing `/v1/models` behavior and the default `legacy` runtime mode remain unchanged.

**Tech Stack:** TypeScript, Hono, Zod, PostgreSQL, existing exact token billing functions, Bun 1.4.2 and Vitest/native guards for later implementation.

**Spec inputs:** [production continuation](2026-09-07-production-continuation.md), [integration ownership](../../ecosystem/integration.md), [payment and evidence design](../../ecosystem/payment-and-evidence-design.md), [research decisions](../../research/2026-09-07-research-impact-and-decisions.md), and the current accepted gateway/auth/routing/billing source named below. Private SDD intake is non-normative provenance and is not required in a clean clone.

## Global constraints

- Work only in `/home/bob/Projects/ai-aggregator`. AI Arena and Agents Market source remain paused. The consumer fixture in this repository is test code owned by Aggregator; it is not an Agents Market implementation or release claim.
- Do not create another server, public origin, database credential path, tariff source, provider probe, paid call, deployment, production migration, or feature activation.
- `/v1/models` remains byte/behavior compatible. Adding `/v1/catalog` must not narrow, reinterpret, redirect, or enrich `/v1/models`.
- Register `/v1/catalog` through the existing `/v1` authentication and guard chain in both `legacy` and `stored_chat_only` assemblies. The default `GATEWAY_HTTP_EXECUTION_MODE=legacy` is unchanged.
- The only currently accepted advertised execution contract is stored, non-streaming, plaintext chat backed by an exact reviewed profile and admitted adapter mechanics. Legacy chat, completions, embeddings, media, batches, tools, streaming, BYOK, and other model rows are not upgraded to admitted capabilities by this read route.
- AG-P2 advertises only the contract proven today; it does not narrow the agreed full product v1. All previously agreed streaming, BYOK, tools, other modalities and async/batch gates remain mandatory for AG-P5/full-product acceptance and are merely outside this focused implementation.
- Catalog availability is an advertised-contract decision from configuration and policy. It is not a live upstream health/SLA claim and never performs a provider request.
- Prices are retail terms derived with exact decimal arithmetic from the billing authority already used by admission. Never serialize or copy supplier cents, markup, upstream/provider identity, upstream model ID, priority, latency, uptime, base URL, egress proxy, metadata, credentials, environment values, or raw policy contents.
- A catalog price is not a quote. Admission continues to create and persist its immutable quote/pricing snapshots. A later catalog or price revision never rewrites an existing quote, receipt, usage snapshot, or ledger row.
- SQL uses tagged prepared statements. Any native database work uses only a disposable local test database under `/tmp/ai-ecosystem-build.lock`; implementation must re-read the migration manifest before reserving the next number.
- Every error body is a fixed allowlisted projection. No caught exception text, SQL diagnostics, policy values, provider names, config names, secrets, or row payloads reach the response.
- No task below may claim the real AG→AM gate. Until Agents Market is resumed and its own source consumer is reviewed, full cross-product acceptance remains **UNVERIFIED**.
- Tasks are strictly sequential. The controller assigns one named owner to each task, records its exact accepted commit, then hands that commit to the next owner. Task 5 integration owner is the sole owner of root `package.json` changes for this plan.

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
3. Collapsing several eligible deployments to an average, cheapest, or guessed tariff would not reproduce admission. If more than one distinct admitted deployment survives, the public item uses the neutral `runtime_contract_unavailable`; the internal bounded telemetry may record `ambiguous_admitted_deployment` without row/provider/price payload. A separately reviewed multi-deployment contract is required before exposing one.
4. Offset pagination can skip or duplicate items after a price/status change. A seek cursor bound to a catalog revision makes mutation explicit.
5. Recomputing a revision by loading an unbounded registry on every request is not a bounded backend. A singleton database revision, one frozen runtime capture, and key-policy hash provide deterministic invalidation without a second service. Candidate reads are independently bounded before profile binding, mode selection, pricing or revision projection.

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
  | 'retail_pricing_unavailable';

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
    requestBody: {
      unknownFields: 'reject';
      unknownMessageFields: 'reject';
      unsupportedExecutionFields: readonly [
        'tools', 'functions', 'tool_choice', 'modalities', 'audio', 'input_audio'
      ];
      multimodalMessageContent: 'reject';
    };
    headers: {
      idempotencyKey: {
        name: 'Idempotency-Key'; required: true;
        pattern: '^[A-Za-z0-9._:-]{1,128}$';
      };
      sessionId: {
        name: 'X-AIAG-Session-Id'; required: false;
        pattern: '^[A-Za-z0-9._:-]{1,128}$';
      };
      upstreamKey: {
        name: 'X-Upstream-Key'; allowed: false;
        rejection: 'UNSUPPORTED_EXECUTION_CONTRACT';
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
        acceptedMaximum: 9007199254740991;
        effectiveMaximum: number;
        configuredDefault: number;
        defaultApplied: number;
        normalization: 'clamp_to_effective_max';
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

The invocation descriptor is a normative projection of the already accepted stored-chat request boundary, not a second parser. `effectiveMaximum = min(profile.contextWindowTokens, profile.maxOutputTokens)` and `defaultApplied = min(configuredDefault, effectiveMaximum)`, where `configuredDefault` is the positive safe integer captured from `GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS`. An explicit `max_tokens` from `1` through `acceptedMaximum` is accepted by the HTTP parser and normalized to `min(requested,effectiveMaximum)` by the same quote seam; omission uses `defaultApplied`. Unknown body or message fields fail with `400 INVALID_STORED_CHAT_HTTP_IDENTITY`. `stream:true`, any listed tools/functions/media field, multimodal message content, and `X-Upstream-Key` fail with `501 UNSUPPORTED_EXECUTION_CONTRACT`; `stream:false` or omission is accepted. The catalog must derive these values and rejection labels from the same frozen profile/config/request-contract constants used by mounted admission, never from duplicated literals with independent behavior.

### Identity and attestation rules

- `model.id` is the existing `models.id` UUID. `model.slug` remains the request alias and retains `/v1/models` compatibility; it is not promoted to immutable artifact identity.
- `deployment.id` is the sole admitted `model_upstreams.id` UUID. The response never exposes the associated upstream/provider/model labels.
- `deployment.configurationRevision` is SHA-256 over a canonical ordered tuple containing schema version, model ID/slug/type, deployment ID, reviewed profile identity/revision, admitted adapter contract, public invocation limits/capabilities, and the effective runtime contract. It is configuration identity, not a digest of remote model weights or code.
- Current source contains no immutable remote artifact version/digest. Therefore v1 emits only `artifact.attestation='unattested'`, `version=null`, and `digest=null`. Adding an attested variant requires evidence and an explicit contract amendment; no implementation may fill these fields from provider labels, metadata, URLs, response `model`, git HEAD, or configuration revision.
- A price-only change changes `pricing.revision` and `catalogRevision`, but does not change `model.id` or `deployment.id`. It changes `configurationRevision` only if a non-price public execution fact also changed.
- An in-place update of a deployment's execution binding or public configuration preserves its row UUID and therefore `deployment.id`, while changing `configurationRevision` and `catalogRevision`. Deleting and recreating the deployment creates a new row UUID and public `deployment.id`; admin/application paths must not reuse the deleted identity. Neither UUID is an artifact, provider identity, version, or derived immutable label.

### Capability and availability rules

The projector starts with `models.enabled=true` and `status IN ('live','frozen')`, ordered by `(slug,id)`. Draft, pending-consent, depublished, and disabled rows are absent from `/v1/catalog`; this is a new contract and does not alter `/v1/models`.

For a `live` model, the available union is emitted only when all checks pass:

1. Runtime mode is `stored_chat_only`; `legacy` keeps its existing routes but has no durably admitted advertised contract in this v1.
2. The fresh key policy parses under the same strict policy decoder used by stored chat, and the model whitelist permits the slug.
3. A candidate is enabled, its upstream is enabled, the model type is `chat`, and the accepted `status='live'` resolver projection is valid.
4. `findReviewedChatProfile` matches the full model/upstream/model/adapter identity; metadata never substitutes for it.
5. `getUpstream` resolves configured mechanics and `admittedChat.contract` matches the reviewed profile. This is a local configuration check only and sends no request.
6. For each advertised `aiag_mode`, `prepareStoredChatQuote` accepts the effective key policy and selects the same sole deployment. Modes with no eligible candidate are removed from `availableValues`. If distinct admitted deployments survive across available modes or quote candidates, the whole item emits the neutral public reason `runtime_contract_unavailable` rather than publishing a misleading blended price. Bounded internal telemetry may record `ambiguous_admitted_deployment` but contains no provider, price, row, binding, routing, or credential payload.
7. Exact billing facts parse, both retail rates are canonical nonnegative decimals, the computed maximum authorization is positive, and all published integer/decimal bounds validate. A zero rate already permitted by the billing authority is not reclassified by a new catalog tariff rule.

`defaultRequested` is the fresh key policy `default_mode` or `auto`. `effectiveDefault` is `ru-only` when fresh policy forces non-RU exclusion, otherwise `defaultRequested`. `requiresExplicitAvailableValue` is true only when `effectiveDefault` is not in `availableValues`; the consumer must then choose an advertised available mode. PII availability cannot be known before request content exists, so the capability carries `requestDependentRestrictions:['pii_transborder']`; it never claims all plaintext will pass.

Reason precedence for unavailable items is fixed: `model_frozen` → `runtime_contract_unavailable` → `key_policy_excludes_model` → `service_configuration_unavailable` → `no_admitted_deployment` → `retail_pricing_unavailable`. Internal ambiguity maps to `runtime_contract_unavailable`; it is never a public enum value. A malformed/unavailable key-policy read invalidates the whole response with 503 rather than classifying individual models from uncertain policy.

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

The internal fan-out constants are frozen public implementation constants: `CATALOG_MAX_CANDIDATES_PER_MODEL = 16` and `CATALOG_MAX_CANDIDATES_PER_PAGE = 512`. They are not client-selectable and are included in `runtimeProjectionRevision`. After selecting at most `limit+1` models, one prepared candidate query uses the selected IDs, deterministic `(model_id,model_upstream_id)` order, a lateral `LIMIT CATALOG_MAX_CANDIDATES_PER_MODEL+1` for each model, and an outer `LIMIT CATALOG_MAX_CANDIDATES_PER_PAGE+1`. The bound applies to raw `model_upstreams` rows before enabled/upstream/policy/profile filtering. The query therefore returns at most 513 rows to the projector and inspects at most 17 rows for any model. Seeing row 17 for a model or row 513 for the page fails the whole snapshot with fixed `503 CATALOG_UNAVAILABLE`. This overflow check runs before profile binding, mode evaluation, price/configuration projection, or any response revision hash; no truncation may make an over-limit model appear callable.

The cursor is base64url without padding of strict canonical JSON:

```ts
interface CatalogCursorV1 {
  schemaVersion: 1;
  catalogRevision: Sha256Revision;
  after: { slug: string; modelId: Uuid };
}
```

The encoded cursor is limited to 1024 bytes. It is not a credential and need not be signed: a well-formed forged seek position cannot bypass authentication, availability checks, or row predicates. Malformed cursors return 400. A cursor whose `catalogRevision` differs from the fresh current revision returns 409 and no data; the consumer restarts without a cursor. Each page selects at most `limit+1` model rows by `(slug,id)` and performs the bounded candidate read only for those IDs inside the same read-only repeatable-read transaction.

The next migration adds one singleton `gateway_catalog_revisions` row with positive `BIGINT revision` and statement-level bump triggers for relevant changes to `models`, `model_upstreams`, and `upstreams`. Relevant columns include identities, slug/type/status/enabled flags, candidate binding/enabled/priority, exact price/markup, residency and execution configuration. Deletion also bumps. Over-invalidation is acceptable; failure to invalidate a public fact is not. The implementation owner re-reads the migration manifest and substitutes the actual next free migration number before editing.

At request entry, before any await or transaction work, capture one immutable runtime object. It contains the execution mode, reviewed profile/contract revisions, exact cache multiplier, positive safe configured default, request-contract constants, candidate bounds, and a sorted neutral mechanics-readiness projection for relevant admitted adapter contracts. The readiness projection records only whether admitted mechanics are configured and whether force-mock excludes them; it contains no credential value, credential/config variable name, provider label, base URL, or executable secret-bearing adapter object. Projection and revision hashing consume this same capture and may not call `getUpstream`, re-read environment/config, or reconstruct readiness a second time.

`catalogRevision` is SHA-256 over `[schemaVersion,dbRevision,runtimeProjectionRevision,keyPolicyRevision]`:

- `runtimeProjectionRevision` hashes the reviewed manifest revisions, admitted-contract identities, execution mode, exact cache multiplier, configured default, public request/candidate constants, and the neutral configured/unconfigured plus force-mock readiness facts from the one runtime capture. It contains no secret value or secret/config name. Rotating a credential while readiness stays configured does not change the revision; configured↔unconfigured or force-mock inclusion↔exclusion does.
- `keyPolicyRevision` hashes the normalized policy values already held by fresh authentication. It is never returned separately and never includes bearer/hash/credential data.
- A relevant registry/price change, process restart with changed public config/profile, or key-policy change invalidates later pages.

The transaction order is fixed: read and validate the singleton DB revision, read the seek page, run the candidate bound+1 query, reject overflow, then compute all projections/revisions from the frozen DB rows, runtime capture, and normalized key policy before comparing any supplied cursor and returning data. DB revision, cursor comparison, model/candidate reads, and page construction stay in the same read-only repeatable-read transaction. No second live configuration or mechanics read may split the advertised item from its revision.

The catalog is advisory preflight for POST. `catalogRevision` and `pricing.revision` are not accepted by `POST /v1/chat/completions`, do not bind admission, and do not guarantee a consumer budget between GET and POST. Admission always reads fresh registry/policy terms and creates the authoritative immutable quote. If price changes after GET, POST uses the new price and stores a new quote; the server does not compare the stale catalog revision. Existing quotes, pricing snapshots, receipts and ledger rows remain unchanged.

Every success and error sets `Cache-Control: private, no-store`; success also sets `Vary: Authorization`. `catalogRevision` is for explicit consumer cache validation and cursor continuity, not permission to use a shared HTTP cache. No Redis/catalog body cache is added in this task.

## HTTP registration and error semantics

Create one Hono route module and register it in the existing `packages/api-gateway/src/server.ts`. Before either mode's common guards, mount an exact path-specific boundary for `/v1/catalog` and `/v1/catalog/`. It sets `Cache-Control: private, no-store` before `await next()`, sanitizes thrown failures and returned guard responses only for these two paths, and never changes another `/v1` route. It preserves the guard's status semantics while replacing the body with the fixed allowlisted catalog envelope; a raw Redis/rate-limit storage exception becomes `503 SERVICE_UNAVAILABLE`, never the general `500 INTERNAL` body.

- legacy assembly: after that early boundary, register `catalogRoute` through the existing `/v1/*` auth/rate/key/PII/model guard chain;
- restricted assembly: after the same early boundary, add `['/catalog', catalogRoute]` to the current allowlisted GET-copy loop, preserving both aliases and the same guard order.

Fixed response semantics:

| HTTP | Code | Owner | Meaning |
|---:|---|---|---|
| 200 | — | catalog route | Valid key and valid bounded snapshot, even when every item is unavailable or the organization balance is zero. |
| 400 | `INVALID_CATALOG_QUERY` | catalog route | Unknown/repeated parameter or invalid `limit`. |
| 400 | `INVALID_CATALOG_CURSOR` | catalog route | Malformed, oversized or non-canonical cursor. |
| 401 | `UNAUTHORIZED` | inherited auth guard, sanitized by early boundary | Existing missing/invalid/revoked/disabled API-key boundary. |
| 402 | `PAYMENT_REQUIRED` | inherited key-limit guard, sanitized by early boundary | Only the already-mounted monthly cost-cap policy. Catalog performs no balance/admission check and invents no other 402. |
| 409 | `CATALOG_REVISION_CHANGED` | catalog route | Cursor belongs to a superseded catalog/key-policy revision; restart pagination. |
| 429 | `RATE_LIMITED` | inherited rate/daily-cap guard, sanitized by early boundary | Existing mounted limit semantics and a validated positive `Retry-After`. |
| 404 | `NOT_FOUND` | early boundary | Unsupported method on either exact catalog alias. |
| 503 | `SERVICE_UNAVAILABLE` | early boundary | Auth/rate/key-limit storage or other guard dependency is unavailable, including raw Redis failure. |
| 503 | `KEY_POLICY_UNAVAILABLE` | catalog route | Authenticated policy cannot be strictly normalized. |
| 503 | `CATALOG_UNAVAILABLE` | catalog route | Registry/revision/projection transaction, candidate overflow, or required safe configuration failed. |

Every body in this matrix contains exactly `{error:{code,message}}` when it is an error. Catalog-owned fixed messages are respectively `Invalid catalog query`, `Invalid catalog cursor`, `Catalog changed; restart pagination`, `Key policy unavailable`, and `Catalog unavailable`; boundary-owned fixed messages are `Unauthorized`, `Payment required`, `Rate limited`, `Route not found`, and `Service unavailable`. Every 503 sets `Retry-After: 2`; 429 preserves only a validated positive guard retry value and otherwise uses the fixed safe fallback. No inherited guard body, caught exception text, Redis/SQL diagnostic, or per-row data is forwarded. A single malformed supposedly sellable row fails the response closed with 503 rather than disappearing or becoming available with partial facts.

## Schema-first implementation tasks

### Task 0: independent design gate

**Files:** this plan and private review report only.

- [x] Root independent reviewer checks schema consistency, identity/attestation language, pricing parity, revision/pagination races, auth/402 semantics, leakage boundary, task ownership and the acceptance matrix.
- [x] Any contract change is made here before source work. Record `APPROVED_FOR_IMPLEMENTATION` or blocking findings in the private controller workspace.

**Gate:** no implementation task starts while this plan remains DRAFT or the review is unresolved.

### Task 1: shared strict schema and pinned fixture

**Exclusive files:**

- `packages/shared/src/catalog-contract.ts` (new)
- `packages/shared/src/__tests__/catalog-contract.test.ts` (new)
- `packages/shared/src/__tests__/fixtures/catalog-v1.json` (new)
- `packages/shared/package.json`
- `packages/shared/tsup.config.ts`

Steps:

- [x] RED: strict parser rejects unknown keys, invalid digest/UUID/decimal, overlong fields, more than 100 data items, unavailable items carrying price/capability data, available items missing unit/revision, unsupported capability marked available, malformed cursor, and invocation descriptors missing strict-field/BYOK rejection or any of the four distinct max-token values.
- [x] Implement the exact DTO/cursor schemas, types, bounded parser and canonical cursor codec as browser-safe code with no Node import.
- [x] Pin descriptor fixtures for absent `max_tokens`, `1`, exact effective cap, cap+1 and `Number.MAX_SAFE_INTEGER`, plus unknown-field, streaming, tools/functions/media, multimodal and BYOK rejection metadata. Task 3 proves parser/normalization parity and Task 4 proves mounted HTTP codes.
- [x] Add `@aiag/shared/catalog-contract` as an explicit build/export entry; do not expand the legacy root/client/server barrels.
- [x] Pin one available stored-chat item, one unavailable item and a next cursor in the fixture. Fixture values are synthetic and visibly named; they are not production/provider evidence.

**Focused acceptance:** shared contract tests, shared source/test typecheck, build export/import smoke, applicable lint, secret/provider-field negative scan, `git diff --check`.

### Task 2: durable registry revision

**Exclusive files:**

- `packages/database/migrations/0073_gateway_catalog_revision.sql` (new; resolve exact number immediately before work)
- `packages/database/scripts/__tests__/gateway-catalog-revision.native.integration.test.ts` (new)
- `packages/database/scripts/__tests__/native-migrate.test.ts` (only manifest length and final filename expectations for the newly allocated migration)

Steps:

- [x] RED on a disposable database: missing singleton/revision; insert/update/delete of relevant model/upstream/candidate facts fail to advance exactly once per statement; rollback incorrectly advances; zero-row update advances; unrelated table change advances; or overflow/corrupt singleton incorrectly permits a catalog read.
- [x] Add idempotent singleton table, positive revision constraint, guarded bump function and statement triggers. Mutation rollback must roll back the bump. Missing/duplicate/corrupt singleton makes the catalog query fail closed.
- [x] Prove price, status, enabled/binding/residency/config and deletion invalidation. Execute the real admin catalog apply transaction and prove the statement trigger is the sole bump owner on commit, rollback, conflict/no-op and zero-row behavior; admin code must not manually bump. Prove an unrelated ledger/key telemetry update does not bump the DB revision; key policy remains covered by its request hash.

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

- [ ] RED pricing parity vectors: fractional DB values, markup products, half-up ties, cache multiplier 0/1/fraction, zero prompt, output below input, maximum ceil and values beyond `2^53`. Compare catalog formula results with existing `calculateTokenCharge` and `quoteChatMaximum`. RED invocation parity covers omitted/`1`/cap/cap+1/`Number.MAX_SAFE_INTEGER` using the same profile and configured-default capture as admission.
- [ ] Export a pure strict key-policy normalization seam from `stored-chat-fresh-policy.ts` and keep the existing request preparation using that same seam. No policy meaning changes.
- [ ] Implement exact decimal multiplication/normalization, public pricing projection and pricing revision. The returned object never contains source prices or markup.
- [ ] Implement prepared seek-page reads in one read-only repeatable-read transaction. Enforce the exact per-model 16 and per-page 512 candidate bounds with bound+1 reads before profiles, modes, prices or revisions. Test 16/17, 512/513, and one model with very large fan-out; every overflow is one fixed 503 and never a truncated item.
- [ ] Evaluate all five request modes under the normalized current key policy. Publish the available union only when every available mode maps to the same single admitted deployment and price; otherwise use the fixed unavailable reason.
- [ ] Capture runtime inputs once and use that immutable capture for mechanics eligibility, invocation limits and configuration/runtime/key/catalog revisions. Tests prove configured↔unconfigured and force-mock readiness changes alter `catalogRevision` and stale a cursor, while rotating a secret value with readiness unchanged does not. Hashes may consume internal non-secret identities but only the final digest is returned.
- [ ] Prove identity lifecycle: price-only in-place update preserves both IDs and configuration revision; in-place execution binding/config update preserves deployment ID but changes configuration revision; delete/recreate produces a new deployment ID. Each relevant mutation changes catalog revision and never creates an artifact/version claim.
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

- [ ] RED: `/v1/catalog` and trailing slash are absent or misguarded in one mode; the early boundary runs after a guard; query/cursor/status matrix is incomplete; low/zero balance is incorrectly 402; returned guard bodies or exception data leak.
- [ ] Add the bounded query/cursor capture and fixed success/error descriptors. Never pass caught error/message/details into a descriptor.
- [ ] Mount the exact-path early catalog boundary before common guards in both assemblies, then register the same route object through the existing common legacy chain and restricted GET-copy loop. Preserve guard order and `private, no-store` on both aliases for success, auth failure, 402, 409, 429, every 503 and 404/unsupported method response.
- [ ] Exercise thrown and returned failures separately: auth storage failure, invalid/revoked key, monthly cap, daily/RPM cap, raw Redis rate-limit failure, malformed fresh policy, registry transaction failure and candidate overflow. Assert guard-owned versus catalog-owned codes, fixed messages, retry headers and absence of the original body/diagnostic.
- [ ] Snapshot `/v1/models` before/after for both runtime modes and prove no import, SQL, field or response change in its module.

**Focused acceptance:** route/server composition tests in both env modes; 200/400/401/402/409/429/503 matrix; no balance query/admission/provider call on catalog read; source/test typecheck, applicable lint and diff check. TypeScript review is required.

### Task 5: AG-owned HTTP consumer fixture and native contract gate

**Exclusive files:**

- `packages/api-gateway/src/__tests__/fixtures/catalog-consumer.ts` (new)
- `packages/api-gateway/src/__tests__/catalog-producer-consumer.http.test.ts` (new)
- `packages/api-gateway/src/__tests__/catalog-mounted.native.integration.test.ts` (new)
- `docs/product/acceptance/AG-P2.md` (new; evidence only after commands actually pass)
- root `package.json` guarded baseline script (sole owner for this plan; edit only after focused approval)

Steps:

- [ ] The fixture consumer accepts only a `fetch`-compatible function/base URL, calls mounted `GET /v1/catalog`, parses JSON through `@aiag/shared/catalog-contract`, and treats capability/mode/unit/revision validation as advisory preflight over that one response. It never claims price/budget locking and sends no catalog or pricing revision with POST.
- [ ] Static boundary test proves the fixture imports no database package, SQL client, internal catalog projector, provider module or Agents Market path.
- [ ] Local HTTP test exercises the real Hono route and auth chain with controlled adapters/SQL; it must not call a network provider.
- [ ] Native disposable-DB test proves stable two-page seek order, no duplicates, raw candidate counts 16/17 and 512/513 including one huge-fan-out model, relevant mutation → stale cursor 409, key-policy/readiness change → stale cursor 409, exact price revision and deployment lifecycle changes, frozen/unavailable behavior, provider configuration failure, and immutable existing admission/receipt snapshots after price change.
- [ ] Mutation-between-GET-and-POST test changes the price after advisory catalog preflight, proves POST ignores the stale catalog revision, uses the fresh price, and creates a new immutable admission quote. A separate assertion proves earlier quote/pricing/receipt/ledger snapshots remain unchanged.
- [ ] Negative serialization scan rejects keys and representative nested paths for `upstream`, `provider`, `upstreamModelId`, `pricePer1k`, `markup`, `priority`, `latency`, `uptime`, `baseUrl`, `egress`, `metadata`, `policies`, `credential`, `secret`, and environment variable names.
- [ ] Record exact commits, commands, environment, checked time, counts, reviewer verdict and unresolved limits in `AG-P2.md`. Label the fixture `AG-owned local consumer`; label real AM and cross-product acceptance **UNVERIFIED**.

**Focused acceptance:** shared schema + gateway unit/composition + local HTTP fixture + guarded native catalog test, then package source/test types and applicable lint. Run one heavy command at a time under the shared lock. Task 5's root integration owner records the exact accepted commits from Tasks 1–4 before changing `package.json`; tasks never share an uncommitted root script edit. Independent contract/financial/security/TypeScript review must approve the combined diff before the scoped implementation commit.

## Acceptance matrix

| ID | Contract claim | Required proof | Reject condition |
|---|---|---|---|
| CAT-01 | Exact schema v1 | Shared strict parser + pinned JSON producer fixture | Unknown/missing fields, unbounded input or incompatible union accepted |
| CAT-02 | Stable identities without invented artifact | Price-only, in-place binding/config, and delete/recreate lifecycle tests | Reused deleted deployment ID or provider/config label presented as immutable artifact/version |
| CAT-03 | Truthful capability and invocation | Reviewed profile + frozen admitted mechanics + max-token/strict rejection parity table | Descriptor differs from mounted parser/clamp or tools/stream/media/BYOK/legacy is advertised |
| CAT-04 | Key-relative availability | Whitelist/provider/residency/default/explicit-mode matrix | Policy-excluded or ambiguous deployment is sellable |
| CAT-05 | Runtime/config availability | Both modes, one runtime capture, readiness/secret-rotation/force-mock tests, no network | Projection changes without revision or legacy/missing configuration is callable |
| CAT-06 | Exact retail price | Parity with current quote/charge functions including >`2^53` vectors | Float arithmetic, absent unit/revision, supplier/markup exposure |
| CAT-07 | Cache policy truth | Whole-cost multiplier and one half-up rounding assertion | Independent discounted-input rate or second rounding introduced |
| CAT-08 | Advisory preflight and snapshot immutability | Mutation between GET/POST plus old/new admission snapshot assertions | POST treats catalog revision as lock or mutation rewrites old quote/receipt/ledger |
| CAT-09 | Bounded stable pagination | Seek pages, 16/17 and 512/513 fan-out, huge-model case, DB/runtime/key invalidation | Unbounded/truncated candidates, duplicate/skip, or stale page returns 200 |
| CAT-10 | Auth and errors | Early-boundary 200/400/401/402/409/429/503 matrix for both modes/aliases and Redis failure | General 500, inherited body leak, catalog-specific balance 402, or missing no-store |
| CAT-11 | `/v1/models` compatibility | Before/after snapshots and unchanged source contract | Existing route shape/filter/registration changes |
| CAT-12 | No internal leakage | Positive allowlist serializer + forbidden-key scan | Provider/routing/cost/markup/egress/policy/secret field escapes |
| CAT-13 | DB isolation | AG-owned consumer import boundary + mounted HTTP test | Consumer imports AG DB/projector or bypasses HTTP |
| CAT-14 | Full cross-product | Real AM source consumer plus catalog→admission→run→receipt after AM resume | Remains **UNVERIFIED** in this plan; fixture cannot satisfy it |

## Deferred from AG-P2, still required by the full product

- Real Agents Market or Arena code, credentials, activation, deployment, Web/TMA behavior, and full AG→AM cross-product run/receipt.
- Anonymous/public-without-key catalog, shared/proxy caching, provider health/SLA probes, live paid provider execution and production migration/deploy.
- More than one admitted deployment per public offering, consumer-selected deployment, provider disclosure, fallback price envelopes, or price comparison modes.
- Streaming, tools/functions, structured output, multimodal messages, embeddings, images, audio, video, batches, async jobs, BYOK and legacy route admission.
- Immutable model/code/weights digest, provider model revision, author rights/license/evidence refs, Arena score, or author marketplace lifecycle.
- New tariff, discount, FX, RUB conversion, subscription/free-tier terms, supplier price, markup, author split, egress cost or quote endpoint.
- Runtime route activation: the default stays `legacy`; switching mode or claiming production availability requires its existing separate release gate.

## Completion boundary

This plan is complete only as a reviewed design candidate. AG-P2 implementation becomes locally accepted only after Tasks 1–5 pass their focused checks and independent reviews, the scoped source commit is identified, and `docs/product/acceptance/AG-P2.md` records the actual evidence. Production, real provider, real AM consumer and full cross-product readiness remain separate gates regardless of local PASS. AG-P2's narrow advertised contract does not reduce the agreed product v1: streaming, BYOK, tools, other modalities and async/batch gates remain mandatory for AG-P5/full-product acceptance.
