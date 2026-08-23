/**
 * Plan 04 Gateway — canonical schema (separate from Plan-01 marketplace tables).
 *
 * These map the raw SQL migration `0004_gateway_core.sql`.
 */
import {
  pgTable,
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
} from 'drizzle-orm/pg-core';
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
  },
  (t) => ({
    orgStatusIdx: index('prediction_jobs_org_status_idx').on(t.orgId, t.status),
  })
);

// -----------------------------------------------------------------------------
// batches
// -----------------------------------------------------------------------------
export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: varchar('batch_id', { length: 64 }).notNull().unique(),
    orgId: uuid('org_id').notNull(),
    apiKeyId: uuid('api_key_id'),
    type: varchar('type', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('validating'),
    inputFileUrl: text('input_file_url').notNull(),
    outputFileUrl: text('output_file_url'),
    errorFileUrl: text('error_file_url'),
    totalCount: integer('total_count').notNull().default(0),
    completedCount: integer('completed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    costRub: numeric('cost_rub', { precision: 18, scale: 6 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgStatusIdx: index('batches_org_status_idx').on(t.orgId, t.status),
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
export type PiiDetection = typeof piiDetections.$inferSelect;
export type PredictionJob = typeof predictionJobs.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type ModelSubmission = typeof modelSubmissions.$inferSelect;
export type NewModelSubmission = typeof modelSubmissions.$inferInsert;
