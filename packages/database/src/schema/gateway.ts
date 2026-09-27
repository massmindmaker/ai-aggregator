/**
 * Plan 04 Gateway — canonical schema (separate from Plan-01 marketplace tables).
 *
 * These map the raw SQL migration `0004_gateway_core.sql`.
 */
import {
  pgTable,
  primaryKey,
  smallint,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  bigserial,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations';

// -----------------------------------------------------------------------------
// upstreams
// -----------------------------------------------------------------------------
export const upstreams = pgTable('upstreams', {
  id: varchar('id', { length: 64 }).primaryKey(),
  provider: varchar('provider', { length: 64 }).notNull(),
  ruResidency: boolean('ru_residency').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  latencyP50Ms: integer('latency_p50_ms').notNull().default(500),
  uptime: numeric('uptime', { precision: 5, scale: 4 }).notNull().default('0.99'),
  baseUrl: text('base_url'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -----------------------------------------------------------------------------
// models (canonical model registry)
// -----------------------------------------------------------------------------
export const gatewayModels = pgTable(
  'models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 128 }).notNull().unique(),
    type: varchar('type', { length: 20 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayName: text('display_name'),
    description: text('description'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    enabledTypeIdx: index('models_enabled_type_idx').on(t.enabled, t.type),
  })
);

// -----------------------------------------------------------------------------
// model_upstreams
// -----------------------------------------------------------------------------
export const modelUpstreams = pgTable(
  'model_upstreams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => gatewayModels.id, { onDelete: 'cascade' }),
    upstreamId: varchar('upstream_id', { length: 64 })
      .notNull()
      .references(() => upstreams.id, { onDelete: 'cascade' }),
    upstreamModelId: varchar('upstream_model_id', { length: 256 }).notNull(),
    pricePer1kInput: numeric('price_per_1k_input', { precision: 18, scale: 10 })
      .notNull()
      .default('0'),
    pricePer1kOutput: numeric('price_per_1k_output', { precision: 18, scale: 10 })
      .notNull()
      .default('0'),
    pricePerImage: numeric('price_per_image', { precision: 18, scale: 10 }),
    pricePerAudioSec: numeric('price_per_audio_sec', { precision: 18, scale: 10 }),
    markup: numeric('markup', { precision: 5, scale: 4 }).notNull().default('1.25'),
    // Native egress integration T2 — mirrors migrations/0062_upstream_egress_proxy.sql.
    // Optional per-row egress proxy; NULL = inherit env/direct.
    egressProxy: text('egress_proxy'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modelUpstreamUniq: uniqueIndex('model_upstreams_model_upstream_uniq').on(
      t.modelId,
      t.upstreamId
    ),
    modelIdx: index('model_upstreams_model_idx').on(t.modelId),
    upstreamIdx: index('model_upstreams_upstream_idx').on(t.upstreamId),
  })
);

// -----------------------------------------------------------------------------
// gateway_api_keys (org-scoped, distinct from Plan-01 user-scoped api_keys)
// -----------------------------------------------------------------------------
export type ApiKeyPolicies = {
  default_mode?: 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';
  allowed_providers?: string[];
  blocked_providers?: string[];
  forbid_non_ru?: boolean;
  allow_pii_transborder?: boolean;
  per_session_budget_cap_rub?: number;
  forbid_streaming_prompts?: boolean;
};

export const gatewayApiKeys = pgTable(
  'gateway_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 24 }).notNull(),
    policies: jsonb('policies').$type<ApiKeyPolicies>().notNull().default({}),
    rpmLimit: integer('rpm_limit').notNull().default(60),
    dailyUsdCap: numeric('daily_usd_cap', { precision: 12, scale: 2 }),
    batchRpmLimit: integer('batch_rpm_limit').notNull().default(10),
    costLimitMonthlyRub: numeric('cost_limit_monthly_rub', { precision: 10, scale: 2 }),
    modelWhitelist: jsonb('model_whitelist').$type<string[]>().notNull().default([]),
    ruResidencyOnly: boolean('ru_residency_only').notNull().default(false),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('gateway_api_keys_org_idx').on(t.orgId),
    ownerIdUniq: uniqueIndex('gateway_api_keys_org_id_id_uniq').on(t.orgId, t.id),
    prefixIdx: index('gateway_api_keys_prefix_idx').on(t.keyPrefix),
  })
);

// -----------------------------------------------------------------------------
// credit_buckets
// -----------------------------------------------------------------------------
export const creditBuckets = pgTable(
  'credit_buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(),
    amountRub: numeric('amount_rub', { precision: 20, scale: 6 }).notNull().default('0'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    source: varchar('source', { length: 40 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('credit_buckets_org_idx').on(t.orgId, t.kind),
  })
);

// -----------------------------------------------------------------------------
// usage_events
// -----------------------------------------------------------------------------
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    requestId: varchar('request_id', { length: 64 }),
    kind: varchar('kind', { length: 30 }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('usage_events_org_created_idx').on(t.orgId, t.createdAt),
  })
);

// -----------------------------------------------------------------------------
// requests (partitioned — declared as plain table for types; real CREATE is raw SQL)
// -----------------------------------------------------------------------------
export const gatewayRequests = pgTable(
  'requests',
  {
    id: uuid('id').notNull().defaultRandom(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    orgId: uuid('org_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    type: varchar('type', { length: 20 }).notNull(),
    modelSlug: varchar('model_slug', { length: 128 }).notNull(),
    upstreamId: varchar('upstream_id', { length: 64 }).notNull(),
    modeRequested: varchar('mode_requested', { length: 16 }),
    modeApplied: varchar('mode_applied', { length: 16 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    imageCount: integer('image_count').notNull().default(0),
    audioSeconds: numeric('audio_seconds', { precision: 10, scale: 2 }).notNull().default('0'),
    upstreamCostUsd: numeric('upstream_cost_usd', { precision: 18, scale: 8 })
      .notNull()
      .default('0'),
    usdToRub: numeric('usd_to_rub', { precision: 10, scale: 4 }),
    markup: numeric('markup', { precision: 6, scale: 4 }),
    batchDiscount: numeric('batch_discount', { precision: 6, scale: 4 }).notNull().default('1'),
    cachingFactor: numeric('caching_factor', { precision: 6, scale: 4 }).notNull().default('1'),
    totalCostRub: numeric('total_cost_rub', { precision: 18, scale: 6 }).notNull().default('0'),
    subPortionRub: numeric('sub_portion_rub', { precision: 18, scale: 6 }).notNull().default('0'),
    paygPortionRub: numeric('payg_portion_rub', { precision: 18, scale: 6 }).notNull().default('0'),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    byok: boolean('byok').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('requests_org_created_idx').on(t.orgId, t.createdAt),
    apiKeyCreatedIdx: index('requests_api_key_created_idx').on(t.apiKeyId, t.createdAt),
  })
);

// -----------------------------------------------------------------------------
// responses
// -----------------------------------------------------------------------------
export const responses = pgTable(
  'responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: varchar('request_id', { length: 64 }).notNull(),
    orgId: uuid('org_id').notNull(),
    body: jsonb('body'),
    headers: jsonb('headers'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('responses_request_idx').on(t.requestId),
  })
);

// -----------------------------------------------------------------------------
// gateway_transactions (canonical per spec §4.3)
// -----------------------------------------------------------------------------
export const gatewayTransactions = pgTable(
  'gateway_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestId: varchar('request_id', { length: 64 }),
    type: varchar('type', { length: 20 }).notNull(),
    source: varchar('source', { length: 20 }).notNull(),
    // T1 (2026-07-16, migration 0056): whole US-cent credits, not ₽ NUMERIC —
    // matches organizations.subscription_credits / payg_credits.
    delta: bigint('delta', { mode: 'number' }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('gateway_transactions_org_created_idx').on(t.orgId, t.createdAt),
    // Partial UNIQUE index is created in raw migration SQL (drizzle partial-index
    // support is limited).
  })
);

// -----------------------------------------------------------------------------
// gateway_charge_admissions — durable financial authority for provider dispatch
// -----------------------------------------------------------------------------
export type GatewayChargeAdmissionSnapshot = Record<string, unknown>;

export const gatewayChargeAdmissions = pgTable(
  'gateway_charge_admissions',
  {
    billingRequestId: uuid('billing_request_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // Retained without an API-key FK so the financial audit survives key deletion.
    apiKeyId: uuid('api_key_id').notNull(),
    clientRequestId: varchar('client_request_id', { length: 255 }),
    routeKind: varchar('route_kind', { length: 32 }).notNull(),
    billingMode: varchar('billing_mode', { length: 16 }).notNull(),
    modelSlug: varchar('model_slug', { length: 128 }).notNull(),
    authorizedMaxCredits: bigint('authorized_max_credits', { mode: 'bigint' }).notNull(),
    heldSubscriptionCredits: bigint('held_subscription_credits', { mode: 'bigint' }).notNull(),
    heldPaygCredits: bigint('held_payg_credits', { mode: 'bigint' }).notNull(),
    capturedSubscriptionExpiresAt: timestamp('captured_subscription_expires_at', {
      withTimezone: true,
    }),
    quoteSnapshot: jsonb('quote_snapshot')
      .$type<GatewayChargeAdmissionSnapshot>()
      .notNull(),
    attemptId: uuid('attempt_id'),
    upstreamId: varchar('upstream_id', { length: 64 }),
    pricingSnapshot: jsonb('pricing_snapshot').$type<GatewayChargeAdmissionSnapshot>(),
    actualCostCredits: bigint('actual_cost_credits', { mode: 'bigint' }),
    usageSnapshot: jsonb('usage_snapshot').$type<GatewayChargeAdmissionSnapshot>(),
    outcomeKind: varchar('outcome_kind', { length: 32 }),
    state: varchar('state', { length: 24 }).notNull().default('held'),
    preDispatchDeadlineAt: timestamp('pre_dispatch_deadline_at', {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    outcomeRecordedAt: timestamp('outcome_recorded_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    reconcileAfter: timestamp('reconcile_after', { withTimezone: true }),
    releasedSubscriptionCredits: bigint('released_subscription_credits', {
      mode: 'bigint',
    }).notNull().default(0n),
    releasedPaygCredits: bigint('released_payg_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    debtRepaidCredits: bigint('debt_repaid_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    expiredSubscriptionCredits: bigint('expired_subscription_credits', {
      mode: 'bigint',
    }).notNull().default(0n),
  },
  (t) => ({
    orgStateIdx: index('gateway_charge_admissions_org_state_idx').on(
      t.orgId,
      t.state,
      t.createdAt
    ),
    // Partial retry index is defined in the raw migration SQL.
    ownerIdUniq: uniqueIndex('gateway_charge_admissions_owner_id_uniq').on(t.orgId, t.apiKeyId, t.billingRequestId),
  })
);

export const gatewayChargeAdmissionEvents = pgTable(
  'gateway_charge_admission_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => gatewayChargeAdmissions.billingRequestId, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    eventKey: varchar('event_key', { length: 32 }).notNull(),
    eventKind: varchar('event_kind', { length: 32 }).notNull(),
    heldSubscriptionCredits: bigint('held_subscription_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    heldPaygCredits: bigint('held_payg_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    usedSubscriptionCredits: bigint('used_subscription_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    usedPaygCredits: bigint('used_payg_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    releasedSubscriptionCredits: bigint('released_subscription_credits', {
      mode: 'bigint',
    }).notNull().default(0n),
    releasedPaygCredits: bigint('released_payg_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    debtRepaidCredits: bigint('debt_repaid_credits', { mode: 'bigint' })
      .notNull()
      .default(0n),
    expiredSubscriptionCredits: bigint('expired_subscription_credits', {
      mode: 'bigint',
    }).notNull().default(0n),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identityUniq: uniqueIndex('gateway_charge_admission_events_identity_uniq').on(
      t.admissionId,
      t.eventKey
    ),
    orgCreatedIdx: index('gateway_charge_admission_events_org_created_idx').on(
      t.orgId,
      t.createdAt
    ),
  })
);

// -----------------------------------------------------------------------------
// pii_detections
// -----------------------------------------------------------------------------
export const piiDetections = pgTable(
  'pii_detections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    requestId: varchar('request_id', { length: 64 }),
    kind: varchar('kind', { length: 20 }).notNull(),
    sampleHash: varchar('sample_hash', { length: 64 }),
    action: varchar('action', { length: 20 }).notNull(),
    modelSlug: varchar('model_slug', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('pii_detections_org_idx').on(t.orgId, t.createdAt),
  })
);

// -----------------------------------------------------------------------------
// prediction_jobs
// -----------------------------------------------------------------------------
export const predictionJobs = pgTable(
  'prediction_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: varchar('task_id', { length: 64 }).notNull().unique(),
    orgId: uuid('org_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    modelSlug: varchar('model_slug', { length: 128 }).notNull(),
    upstreamId: varchar('upstream_id', { length: 64 }).notNull(),
    upstreamTaskId: varchar('upstream_task_id', { length: 128 }),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    errorMessage: text('error_message'),
    costRub: numeric('cost_rub', { precision: 18, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    billingRequestId: uuid('billing_request_id'),
    routeKind: varchar('route_kind', { length: 32 }),
    billingMode: varchar('billing_mode', { length: 16 }),
    contractVersion: smallint('contract_version'),
    idempotencyKeyDigest: text('idempotency_key_digest'),
    requestFingerprint: text('request_fingerprint'),
    modelUpstreamId: uuid('model_upstream_id'),
    providerFamily: varchar('provider_family', { length: 32 }),
    providerTaskId: varchar('provider_task_id', { length: 256 }),
    quotedRetailMicrocredits: bigint('quoted_retail_microcredits', { mode: 'bigint' }),
    quotedSupplierMicrocredits: bigint('quoted_supplier_microcredits', { mode: 'bigint' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    resultDigest: text('result_digest'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    orgStatusIdx: index('prediction_jobs_org_status_idx').on(t.orgId, t.status),
  })
);

// -----------------------------------------------------------------------------
// batches + durable batch_items
// -----------------------------------------------------------------------------
export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: varchar('batch_id', { length: 64 }).notNull().unique(),
    orgId: uuid('org_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    type: varchar('type', { length: 20 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('validating'),
    inputFileUrl: text('input_file_url').notNull(),
    outputFileUrl: text('output_file_url'),
    errorFileUrl: text('error_file_url'),
    totalCount: integer('total_count').notNull().default(0),
    completedCount: integer('completed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    costRub: numeric('cost_rub', { precision: 18, scale: 6 }).notNull().default('0'),
    contractVersion: smallint('contract_version').notNull().default(1),
    billingMode: varchar('billing_mode', { length: 16 }),
    idempotencyKeyDigest: varchar('idempotency_key_digest', { length: 64 }),
    requestFingerprint: varchar('request_fingerprint', { length: 64 }),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    reconcileAfter: timestamp('reconcile_after', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgStatusIdx: index('batches_org_status_idx').on(t.orgId, t.status),
    durableIdentityUniq: uniqueIndex('batches_durable_identity_unique').on(
      t.orgId,
      t.contractVersion,
      t.billingMode,
      t.idempotencyKeyDigest
    ),
    reconcileIdx: index('batches_reconcile_idx').on(t.reconcileAfter, t.createdAt),
  })
);

export const batchItems = pgTable(
  'batch_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    itemIndex: integer('item_index').notNull(),
    customId: varchar('custom_id', { length: 128 }).notNull(),
    routeKind: varchar('route_kind', { length: 32 }).notNull(),
    requestFingerprint: varchar('request_fingerprint', { length: 64 }).notNull(),
    requestBody: jsonb('request_body').$type<Record<string, unknown>>().notNull(),
    billingRequestId: uuid('billing_request_id')
      .notNull()
      .references(() => gatewayChargeAdmissions.billingRequestId, { onDelete: 'restrict' }),
    attemptId: uuid('attempt_id').notNull(),
    modelSlug: varchar('model_slug', { length: 128 }).notNull(),
    modelUpstreamId: uuid('model_upstream_id').notNull(),
    upstreamId: varchar('upstream_id', { length: 64 }).notNull(),
    upstreamModelId: varchar('upstream_model_id', { length: 256 }).notNull(),
    adapterKey: varchar('adapter_key', { length: 64 }).notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').$type<Record<string, unknown>>().notNull(),
    providerRequest: jsonb('provider_request').$type<Record<string, unknown>>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    output: jsonb('output').$type<Record<string, unknown>>(),
    errorCode: varchar('error_code', { length: 64 }),
    resultDigest: varchar('result_digest', { length: 64 }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentIndexUniq: uniqueIndex('batch_items_parent_index_unique').on(t.batchId, t.itemIndex),
    parentCustomUniq: uniqueIndex('batch_items_parent_custom_unique').on(t.batchId, t.customId),
    billingUniq: uniqueIndex('batch_items_billing_unique').on(t.billingRequestId),
    claimIdx: index('batch_items_claim_idx').on(t.batchId, t.status, t.itemIndex),
  })
);

// -----------------------------------------------------------------------------
// upstream_health (Plan 03 worker probes)
// -----------------------------------------------------------------------------
export const upstreamHealth = pgTable(
  'upstream_health',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    upstreamId: varchar('upstream_id', { length: 64 })
      .notNull()
      .references(() => upstreams.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    latencyMs: integer('latency_ms'),
    error: text('error'),
  },
  (t) => ({
    recentIdx: index('idx_upstream_health_recent').on(t.upstreamId, t.checkedAt),
  })
);

// -----------------------------------------------------------------------------
// model_submissions (Plan 10 — supply-side direct model submissions)
// -----------------------------------------------------------------------------
export const modelSubmissions = pgTable(
  'model_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 128 }).notNull(),
    modality: varchar('modality', { length: 20 }).notNull(),
    description: text('description').notNull(),
    outboundKind: varchar('outbound_kind', { length: 32 }).notNull(),
    upstreamUrl: text('upstream_url'),
    pricing: jsonb('pricing').notNull().default({}),
    ruResidency: boolean('ru_residency').notNull().default(false),
    piiRisk: varchar('pii_risk', { length: 16 }).notNull().default('low'),
    gdprApplicable: boolean('gdpr_applicable').notNull().default(false),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    adminNote: text('admin_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('model_submissions_user_idx').on(t.userId, t.createdAt),
    statusIdx: index('model_submissions_status_idx').on(t.status, t.createdAt),
  })
);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export type Upstream = typeof upstreams.$inferSelect;
export type UpstreamHealth = typeof upstreamHealth.$inferSelect;
export type GatewayModel = typeof gatewayModels.$inferSelect;
export type ModelUpstream = typeof modelUpstreams.$inferSelect;
export type GatewayApiKey = typeof gatewayApiKeys.$inferSelect;
export type CreditBucket = typeof creditBuckets.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type GatewayRequest = typeof gatewayRequests.$inferSelect;
export type Response_ = typeof responses.$inferSelect;
export type GatewayTransaction = typeof gatewayTransactions.$inferSelect;
export type GatewayChargeAdmission = typeof gatewayChargeAdmissions.$inferSelect;
export type GatewayChargeAdmissionEvent = typeof gatewayChargeAdmissionEvents.$inferSelect;
export type PiiDetection = typeof piiDetections.$inferSelect;
export type PredictionJob = typeof predictionJobs.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type ModelSubmission = typeof modelSubmissions.$inferSelect;
export type NewModelSubmission = typeof modelSubmissions.$inferInsert;

// Durable v2 quotas. CHECK constraints and SID COLLATE "C" are authoritative in 0068.
export const gatewayQuotaOrgPolicies = pgTable('gateway_quota_org_policies', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id, { onDelete: 'restrict' }),
  enforcementVersion: smallint('enforcement_version').notNull().default(1),
  dailySupplierUsdMicroLimitV2: bigint('daily_supplier_usd_micro_limit_v2', { mode: 'bigint' }),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(1n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});
export const gatewayQuotaKeyPolicies = pgTable('gateway_quota_key_policies', {
  apiKeyId: uuid('api_key_id').primaryKey().references(() => gatewayApiKeys.id, { onDelete: 'restrict' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  sessionMicrocreditsLimitV2: bigint('session_microcredits_limit_v2', { mode: 'bigint' }),
  revision: bigint('revision', { mode: 'bigint' }).notNull().default(1n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});
export const gatewayQuotaBuckets = pgTable('gateway_quota_buckets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  apiKeyId: uuid('api_key_id').references(() => gatewayApiKeys.id, { onDelete: 'restrict' }),
  declaredSessionId: varchar('declared_session_id', { length: 128 }),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  reservedAmount: bigint('reserved_amount', { mode: 'bigint' }).notNull().default(0n),
  settledAmount: bigint('settled_amount', { mode: 'bigint' }).notNull().default(0n),
}, t => ({
  month: uniqueIndex('gateway_quota_month_uniq').on(t.orgId,t.apiKeyId,t.periodStart).where(sql`${t.kind} = 'key_month_charged_v2'`),
  day: uniqueIndex('gateway_quota_day_uniq').on(t.orgId,t.periodStart).where(sql`${t.kind} = 'org_day_supplier_v2'`),
  session: uniqueIndex('gateway_quota_session_uniq').on(t.orgId,t.apiKeyId,t.declaredSessionId).where(sql`${t.kind} = 'key_session_charged_v2'`),
}));
export const gatewayChargeQuotaContexts = pgTable('gateway_charge_quota_contexts', {
  billingRequestId: uuid('billing_request_id').primaryKey().references(() => gatewayChargeAdmissions.billingRequestId, { onDelete: 'restrict' }),
  quotaVersion: smallint('quota_version').notNull().default(2),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  apiKeyId: uuid('api_key_id').notNull().references(() => gatewayApiKeys.id, { onDelete: 'restrict' }),
  declaredSessionId: varchar('declared_session_id', { length: 128 }),
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
  supplierFormulaVersion: varchar('supplier_formula_version', { length: 80 }).notNull(),
  supplierQuoteSnapshot: jsonb('supplier_quote_snapshot').notNull(),
  supplierAuthorizedMaxUsdMicro: bigint('supplier_authorized_max_usd_micro', { mode: 'bigint' }).notNull(),
  supplierActualUsdMicro: bigint('supplier_actual_usd_micro', { mode: 'bigint' }),
  supplierUsageSnapshot: jsonb('supplier_usage_snapshot'),
});
export const gatewayChargeQuotaReservations = pgTable('gateway_charge_quota_reservations', {
  billingRequestId: uuid('billing_request_id').notNull().references(() => gatewayChargeQuotaContexts.billingRequestId, { onDelete: 'restrict' }),
  bucketId: uuid('bucket_id').notNull().references(() => gatewayQuotaBuckets.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  limitSnapshot: bigint('limit_snapshot', { mode: 'bigint' }),
  policySnapshot: jsonb('policy_snapshot').notNull(),
  reservedMax: bigint('reserved_max', { mode: 'bigint' }).notNull(),
  actualAmount: bigint('actual_amount', { mode: 'bigint' }),
  state: varchar('state', { length: 12 }).notNull().default('reserved'),
  terminalAt: timestamp('terminal_at', { withTimezone: true }),
}, t => ({
  pk: primaryKey({ columns: [t.billingRequestId,t.bucketId] }),
  dimension: uniqueIndex('gateway_charge_quota_reservations_billing_request_id_kind_key').on(t.billingRequestId,t.kind),
}));
export const gatewayChargeQuotaEvents = pgTable('gateway_charge_quota_events', {
  billingRequestId: uuid('billing_request_id').notNull().references(() => gatewayChargeQuotaContexts.billingRequestId, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  eventKind: varchar('event_kind', { length: 12 }).notNull(),
  bucketId: uuid('bucket_id').notNull().references(() => gatewayQuotaBuckets.id, { onDelete: 'restrict' }),
  reservedDelta: bigint('reserved_delta', { mode: 'bigint' }).notNull(),
  settledDelta: bigint('settled_delta', { mode: 'bigint' }).notNull(),
  releasedAmount: bigint('released_amount', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => ({ pk: primaryKey({ columns: [t.billingRequestId,t.kind,t.eventKind] }) }));

// HTTP identity persists before admission; strict CHECK/COLLATE/immutability rules live in 0069.
export const gatewayHttpRequests = pgTable('gateway_http_requests', {
  billingRequestId: uuid('billing_request_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  apiKeyId: uuid('api_key_id').notNull(),
  routeKind: varchar('route_kind', { length: 32 }).$type<'chat' | 'embeddings' | 'completions'>().notNull(),
  billingMode: varchar('billing_mode', { length: 16 }).$type<'stored' | 'byok_fee'>().notNull(),
  contractVersion: smallint('contract_version').$type<1 | 2 | 3>().notNull(),
  idempotencyKeyDigest: text('idempotency_key_digest').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => ({
  keyOwner: foreignKey({ name: 'gateway_http_requests_key_owner_fk', columns: [t.orgId, t.apiKeyId], foreignColumns: [gatewayApiKeys.orgId, gatewayApiKeys.id] }).onDelete('restrict'),
  scope: uniqueIndex('gateway_http_requests_scope_uniq').on(t.orgId, t.apiKeyId, t.routeKind, t.idempotencyKeyDigest),
  ownerId: uniqueIndex('gateway_http_requests_owner_id_uniq').on(t.orgId, t.apiKeyId, t.billingRequestId),
}));

/** Sanitized plaintext DTO only. Request bodies and financial snapshots never belong here. */
export type GatewayHttpCompletionBody = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [{ index: 0; message: { role: 'assistant'; content: string | null }; finish_reason: 'stop' | 'length' | 'content_filter' }];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_input_tokens?: number };
};
export const gatewayHttpResults = pgTable('gateway_http_results', {
  billingRequestId: uuid('billing_request_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  apiKeyId: uuid('api_key_id').notNull(),
  contractVersion: smallint('contract_version').$type<1 | 2 | 3>().notNull(),
  httpStatus: smallint('http_status').$type<200>().notNull(),
  contentType: text('content_type').$type<'application/json' | 'text/event-stream'>().notNull(),
  responseBody: jsonb('response_body').$type<GatewayHttpCompletionBody>(),
  responseDigest: text('response_digest').notNull(),
  storedAt: timestamp('stored_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  payloadExpiredAt: timestamp('payload_expired_at', { withTimezone: true }),
}, t => ({
  keyOwner: foreignKey({ name: 'gateway_http_results_key_owner_fk', columns: [t.orgId, t.apiKeyId], foreignColumns: [gatewayApiKeys.orgId, gatewayApiKeys.id] }).onDelete('restrict'),
  requestOwner: foreignKey({ name: 'gateway_http_results_request_owner_fk', columns: [t.orgId, t.apiKeyId, t.billingRequestId], foreignColumns: [gatewayHttpRequests.orgId, gatewayHttpRequests.apiKeyId, gatewayHttpRequests.billingRequestId] }).onDelete('restrict'),
  admissionOwner: foreignKey({ name: 'gateway_http_results_admission_owner_fk', columns: [t.orgId, t.apiKeyId, t.billingRequestId], foreignColumns: [gatewayChargeAdmissions.orgId, gatewayChargeAdmissions.apiKeyId, gatewayChargeAdmissions.billingRequestId] }).onDelete('restrict'),
}));
export type GatewayHttpRequest = typeof gatewayHttpRequests.$inferSelect;
export type GatewayHttpResult = typeof gatewayHttpResults.$inferSelect;

export type GatewayHttpRejectionCode = 'PAYMENT_REQUIRED' | 'QUOTA_EXCEEDED' | 'ADMISSION_DEADLINE_EXPIRED' | 'SESSION_REQUIRED' | 'REFUND_BLOCKED' | 'REQUEST_NOT_STARTED';
/** Fixed SQL-generated no-admission DTO. It is neither usage evidence nor a zero-price receipt. */
export const gatewayHttpRejections = pgTable('gateway_http_rejections', {
  billingRequestId: uuid('billing_request_id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  apiKeyId: uuid('api_key_id').notNull(),
  resultVersion: smallint('result_version').$type<1>().notNull(),
  rejectionCode: text('rejection_code').$type<GatewayHttpRejectionCode>().notNull(),
  httpStatus: smallint('http_status').$type<400 | 402 | 409 | 429>().notNull(),
  contentType: text('content_type').$type<'application/json'>().notNull(),
  responseBody: jsonb('response_body').$type<{ error: { code: GatewayHttpRejectionCode; message: string; type: 'billing_error' | 'request_error' } }>().notNull(),
  terminalAt: timestamp('terminal_at', { withTimezone: true }).notNull(),
}, t => ({
  keyOwner: foreignKey({ name: 'gateway_http_rejections_key_owner_fk', columns: [t.orgId, t.apiKeyId], foreignColumns: [gatewayApiKeys.orgId, gatewayApiKeys.id] }).onDelete('restrict'),
  requestOwner: foreignKey({ name: 'gateway_http_rejections_request_owner_fk', columns: [t.orgId, t.apiKeyId, t.billingRequestId], foreignColumns: [gatewayHttpRequests.orgId, gatewayHttpRequests.apiKeyId, gatewayHttpRequests.billingRequestId] }).onDelete('restrict'),
}));
export type GatewayHttpRejection = typeof gatewayHttpRejections.$inferSelect;
