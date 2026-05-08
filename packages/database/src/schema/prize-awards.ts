/**
 * Phase 14 — prize_awards table (spec §3.6).
 *
 * Post-contest forfeit-aware ledger of cash prizes. Status `pending` means
 * the winner has not completed KYC; `available` means payout-eligible;
 * `forfeited` is set when the winner declines or fails KYC by deadline.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { contests, contestSubmissions } from './contests';

export const prizeAwards = pgTable(
  'prize_awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => contestSubmissions.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    rank: integer('rank').notNull(),
    amountRub: numeric('amount_rub', { precision: 12, scale: 2 }).notNull(),
    status: text('status').notNull().default('pending'), // pending | available | forfeited
    forfeitedReason: text('forfeited_reason'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('idx_prize_awards_uniq').on(
      t.contestId,
      t.submissionId,
      t.rank
    ),
    userStatus: index('idx_prize_awards_user_status').on(t.userId, t.status),
  })
);

export type PrizeAward = typeof prizeAwards.$inferSelect;
export type NewPrizeAward = typeof prizeAwards.$inferInsert;
