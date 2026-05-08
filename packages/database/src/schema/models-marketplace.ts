/**
 * Phase 14 — Drizzle mapping for the canonical gateway `models` table.
 *
 * NOTE: This is the live `models` table from migration 0004_gateway_core.sql,
 * NOT the separate `ai_models` table in `./ai-models.ts`. The gateway routes
 * requests against `models.slug`, and Phase 14 promotes it from a pure
 * routing registry into the marketplace catalog (with author_user_id,
 * status lifecycle, and tags as a real text[] column).
 *
 * Table shape mirrors `0014_contest_marketplace.sql` after Phase 14 apply.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
// `contests` would be the natural FK target for derivedFromContestId, but to
// avoid a circular import we use a plain uuid column and rely on the SQL FK.

export const models = pgTable(
  'models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 128 }).notNull().unique(),
    type: varchar('type', { length: 20 }).notNull(), // chat | completion | embedding | image | audio
    enabled: boolean('enabled').notNull().default(true),
    displayName: text('display_name'),
    description: text('description'),
    metadata: jsonb('metadata').notNull().default({}),

    // Phase 14 additions (spec §3.2)
    derivedFromContestId: uuid('derived_from_contest_id'),
    authorUserId: uuid('author_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    hostingStrategy: text('hosting_strategy')
      .notNull()
      .default('cloud_api_wrap'), // cloud_api_wrap | hosted_on_aiag | self_hosted_by_author
    status: text('status').notNull().default('live'), // draft | pending_author_consent | live | frozen | depublished
    frozenReason: text('frozen_reason'),
    depublishedReason: text('depublished_reason'),
    tags: text('tags').array().notNull().default([]),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    enabledTypeIdx: index('models_enabled_type_idx').on(
      table.enabled,
      table.type
    ),
    statusLiveIdx: index('idx_models_status_live').on(table.status),
    authorUserIdx: index('idx_models_author_user').on(table.authorUserId),
  })
);

export type MarketplaceModel = typeof models.$inferSelect;
export type NewMarketplaceModel = typeof models.$inferInsert;
