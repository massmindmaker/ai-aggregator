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
import { organizations } from './organizations';
import { contestStatusEnum } from './enums';

export const contests = pgTable(
  'contests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 100 }).notNull(),
    name: text('name').notNull(),
    shortDescription: text('short_description'),
    description: text('description'),

    // Branding
    logo: text('logo'),
    banner: text('banner'),
    tags: text('tags').array(),

    // Status and timeline
    status: contestStatusEnum('status').default('draft').notNull(),
    startsAt: timestamp('starts_at', { mode: 'date' }),
    endsAt: timestamp('ends_at', { mode: 'date' }),
    evaluationEndsAt: timestamp('evaluation_ends_at', { mode: 'date' }),

    // Configuration
    config: jsonb('config').$type<{
      maxSubmissionsPerUser?: number;
      maxSubmissionsPerDay?: number;
      allowTeams?: boolean;
      maxTeamSize?: number;
      isPublic?: boolean;
      requireApproval?: boolean;
    }>(),

    // Prizes
    totalPrizePool: numeric('total_prize_pool', { precision: 12, scale: 2 }),
    currency: varchar('currency', { length: 3 }).default('RUB'),
    prizes: jsonb('prizes').$type<
      Array<{
        place: number;
        amount: number;
        description?: string;
      }>
    >(),

    // Evaluation
    evaluationMetrics: jsonb('evaluation_metrics').$type<
      Array<{
        name: string;
        weight: number;
        description?: string;
      }>
    >(),

    // Rules
    rules: text('rules'),
    dataDescription: text('data_description'),
    submissionFormat: text('submission_format'),

    // Files
    datasetUrl: text('dataset_url'),
    sampleSubmissionUrl: text('sample_submission_url'),

    // Statistics
    totalParticipants: integer('total_participants').default(0).notNull(),
    totalSubmissions: integer('total_submissions').default(0).notNull(),

    // Ownership
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'set null' }),

    // Visibility
    isPublic: boolean('is_public').default(false).notNull(),
    isFeatured: boolean('is_featured').default(false).notNull(),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { mode: 'date' }),
  },
  (table) => ({
    slugOwnerIdx: uniqueIndex('contests_slug_owner_idx').on(table.slug, table.ownerId),
    statusIdx: index('contests_status_idx').on(table.status),
    ownerIdx: index('contests_owner_idx').on(table.ownerId),
    orgIdx: index('contests_org_idx').on(table.organizationId),
    datesIdx: index('contests_dates_idx').on(table.startsAt, table.endsAt),
    publicIdx: index('contests_public_idx').on(table.isPublic, table.status),
  })
);

export const contestParticipants = pgTable(
  'contest_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Team (if applicable)
    teamId: uuid('team_id'),
    teamName: text('team_name'),

    // Stats
    totalSubmissions: integer('total_submissions').default(0).notNull(),
    bestScore: numeric('best_score', { precision: 20, scale: 10 }),
    currentRank: integer('current_rank'),

    // Status
    isApproved: boolean('is_approved').default(true).notNull(),
    isDisqualified: boolean('is_disqualified').default(false).notNull(),
    disqualificationReason: text('disqualification_reason'),

    // Timestamps
    joinedAt: timestamp('joined_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    contestUserIdx: uniqueIndex('contest_participants_contest_user_idx').on(
      table.contestId,
      table.userId
    ),
    contestIdx: index('contest_participants_contest_idx').on(table.contestId),
    userIdx: index('contest_participants_user_idx').on(table.userId),
    rankIdx: index('contest_participants_rank_idx').on(table.contestId, table.currentRank),
  })
);

export const contestSubmissions = pgTable(
  'contest_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => contestParticipants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Submission
    fileUrl: text('file_url').notNull(),
    fileName: text('file_name'),
    fileSize: integer('file_size'),
    description: text('description'),

    // Scoring
    status: varchar('status', { length: 20 }).default('pending').notNull(), // 'pending' | 'processing' | 'scored' | 'failed' | 'invalid'
    score: numeric('score', { precision: 20, scale: 10 }),
    publicScore: numeric('public_score', { precision: 20, scale: 10 }), // Leaderboard score
    privateScore: numeric('private_score', { precision: 20, scale: 10 }), // Final evaluation score

    // Detailed metrics
    metrics: jsonb('metrics').$type<Record<string, number>>(),

    // Processing
    errorMessage: text('error_message'),
    processingTimeMs: integer('processing_time_ms'),

    // Selection
    isSelected: boolean('is_selected').default(false).notNull(), // Selected for final evaluation
    isFinal: boolean('is_final').default(false).notNull(), // Chosen as final submission

    // Phase 14 — publish-to-marketplace linkage (spec §3.1)
    publishedModelId: uuid('published_model_id'),
    publishedAt: timestamp('published_at', { mode: 'date' }),
    finalRank: integer('final_rank'),
    authorConsentId: uuid('author_consent_id'),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    scoredAt: timestamp('scored_at', { mode: 'date' }),
  },
  (table) => ({
    contestIdx: index('contest_submissions_contest_idx').on(table.contestId),
    participantIdx: index('contest_submissions_participant_idx').on(table.participantId),
    userIdx: index('contest_submissions_user_idx').on(table.userId),
    statusIdx: index('contest_submissions_status_idx').on(table.status),
    scoreIdx: index('contest_submissions_score_idx').on(table.contestId, table.publicScore),
    createdAtIdx: index('contest_submissions_created_at_idx').on(table.createdAt),
  })
);

// Relations
export const contestsRelations = relations(contests, ({ one, many }) => ({
  owner: one(users, {
    fields: [contests.ownerId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [contests.organizationId],
    references: [organizations.id],
  }),
  participants: many(contestParticipants),
  submissions: many(contestSubmissions),
}));

export const contestParticipantsRelations = relations(
  contestParticipants,
  ({ one, many }) => ({
    contest: one(contests, {
      fields: [contestParticipants.contestId],
      references: [contests.id],
    }),
    user: one(users, {
      fields: [contestParticipants.userId],
      references: [users.id],
    }),
    submissions: many(contestSubmissions),
  })
);

export const contestSubmissionsRelations = relations(contestSubmissions, ({ one }) => ({
  contest: one(contests, {
    fields: [contestSubmissions.contestId],
    references: [contests.id],
  }),
  participant: one(contestParticipants, {
    fields: [contestSubmissions.participantId],
    references: [contestParticipants.id],
  }),
  user: one(users, {
    fields: [contestSubmissions.userId],
    references: [users.id],
  }),
}));

// Types
export type Contest = typeof contests.$inferSelect;
export type NewContest = typeof contests.$inferInsert;
export type ContestParticipant = typeof contestParticipants.$inferSelect;
export type NewContestParticipant = typeof contestParticipants.$inferInsert;
export type ContestSubmission = typeof contestSubmissions.$inferSelect;
export type NewContestSubmission = typeof contestSubmissions.$inferInsert;
