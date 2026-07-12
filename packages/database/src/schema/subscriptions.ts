import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  varchar,
  jsonb,
  integer,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { aiModels, pricingPlans } from './ai-models';
import { subscriptionStatusEnum, apiKeyStatusEnum } from './enums';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Key details
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(), // Hashed API key
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(), // First 8 chars for identification
    lastChars: varchar('last_chars', { length: 4 }).notNull(), // Last 4 chars for display

    // Permissions
    permissions: jsonb('permissions').$type<{
      models?: string[]; // Model IDs this key can access, empty = all subscribed
      endpoints?: string[]; // Specific endpoints, empty = all
      ipWhitelist?: string[];
    }>(),

    // Rate limits override
    rateLimits: jsonb('rate_limits').$type<{
      requestsPerMinute?: number;
      requestsPerDay?: number;
    }>(),

    // Status
    status: apiKeyStatusEnum('status').default('active').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
    revokeReason: text('revoke_reason'),

    // Usage stats
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    totalRequests: integer('total_requests').default(0).notNull(),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('api_keys_user_idx').on(table.userId),
    keyHashIdx: uniqueIndex('api_keys_hash_idx').on(table.keyHash),
    prefixIdx: index('api_keys_prefix_idx').on(table.keyPrefix),
    statusIdx: index('api_keys_status_idx').on(table.status),
  })
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Nullable since migration 0054: a paid TIER (Basic/Starter/Pro) is not
    // scoped to a single model, unlike the legacy per-model subscription.
    modelId: uuid('model_id')
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .references(() => pricingPlans.id, { onDelete: 'set null' }),

    // Subscription status
    status: subscriptionStatusEnum('status').default('active').notNull(),

    // Tier state (migration 0054) — read by dashboard/overview.ts. plan_name =
    // TIERS[tier].name; creditsLimit = TIERS[tier].credits (a COUNT of monthly
    // credits, NOT rubles); creditsUsed = consumption this period.
    planName: text('plan_name'),
    creditsLimit: integer('credits_limit'),
    creditsUsed: integer('credits_used').default(0).notNull(),

    // Billing
    currentPeriodStart: timestamp('current_period_start', { mode: 'date' }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { mode: 'date' }).notNull(),

    // Usage in current period
    usedRequests: integer('used_requests').default(0).notNull(),
    usedTokens: integer('used_tokens').default(0).notNull(),

    // Cancellation
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
    cancelledAt: timestamp('cancelled_at', { mode: 'date' }),
    cancellationReason: text('cancellation_reason'),

    // Tinkoff recurring payment
    tinkoffRebillId: text('tinkoff_rebill_id'),

    // Metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('subscriptions_user_idx').on(table.userId),
    modelIdx: index('subscriptions_model_idx').on(table.modelId),
    userModelIdx: uniqueIndex('subscriptions_user_model_idx').on(
      table.userId,
      table.modelId
    ),
    statusIdx: index('subscriptions_status_idx').on(table.status),
    periodEndIdx: index('subscriptions_period_end_idx').on(table.currentPeriodEnd),
  })
);

export const apiUsageLogs = pgTable(
  'api_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiKeyId: uuid('api_key_id')
      .references(() => apiKeys.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id'),
    subscriptionId: uuid('subscription_id')
      .references(() => subscriptions.id, { onDelete: 'set null' }),

    // Request details
    method: varchar('method', { length: 10 }).notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),

    // Performance
    responseTimeMs: integer('response_time_ms'),
    tokensUsed: integer('tokens_used'),

    // Cost
    cost: numeric('cost', { precision: 12, scale: 6 }),

    // Request metadata
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),

    // Error tracking
    errorCode: varchar('error_code', { length: 50 }),
    errorMessage: text('error_message'),

    // Timestamp
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('api_usage_user_idx').on(table.userId),
    modelIdx: index('api_usage_model_idx').on(table.modelId),
    keyIdx: index('api_usage_key_idx').on(table.apiKeyId),
    createdAtIdx: index('api_usage_created_at_idx').on(table.createdAt),
    // Composite index for analytics queries
    analyticsIdx: index('api_usage_analytics_idx').on(
      table.modelId,
      table.createdAt
    ),
  })
);

// Daily aggregated usage stats (for faster analytics)
export const usageStatsDaily = pgTable(
  'usage_stats_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: timestamp('date', { mode: 'date' }).notNull(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' }),

    // Aggregated stats
    totalRequests: integer('total_requests').default(0).notNull(),
    successfulRequests: integer('successful_requests').default(0).notNull(),
    failedRequests: integer('failed_requests').default(0).notNull(),
    totalTokens: integer('total_tokens').default(0).notNull(),
    totalCost: numeric('total_cost', { precision: 12, scale: 2 }).default('0'),
    avgResponseTimeMs: integer('avg_response_time_ms'),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    dateModelIdx: uniqueIndex('usage_stats_date_model_idx').on(
      table.date,
      table.modelId,
      table.userId
    ),
    modelIdx: index('usage_stats_model_idx').on(table.modelId),
    userIdx: index('usage_stats_user_idx').on(table.userId),
  })
);

// Relations
export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  usageLogs: many(apiUsageLogs),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
  model: one(aiModels, {
    fields: [subscriptions.modelId],
    references: [aiModels.id],
  }),
  plan: one(pricingPlans, {
    fields: [subscriptions.planId],
    references: [pricingPlans.id],
  }),
}));

export const apiUsageLogsRelations = relations(apiUsageLogs, ({ one }) => ({
  apiKey: one(apiKeys, {
    fields: [apiUsageLogs.apiKeyId],
    references: [apiKeys.id],
  }),
  user: one(users, {
    fields: [apiUsageLogs.userId],
    references: [users.id],
  }),
  model: one(aiModels, {
    fields: [apiUsageLogs.modelId],
    references: [aiModels.id],
  }),
  subscription: one(subscriptions, {
    fields: [apiUsageLogs.subscriptionId],
    references: [subscriptions.id],
  }),
}));

// Types
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type ApiUsageLog = typeof apiUsageLogs.$inferSelect;
export type NewApiUsageLog = typeof apiUsageLogs.$inferInsert;
export type UsageStatsDaily = typeof usageStatsDaily.$inferSelect;
export type NewUsageStatsDaily = typeof usageStatsDaily.$inferInsert;
