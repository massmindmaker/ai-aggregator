import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  date,
  varchar,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { aiModels } from './ai-models';

/**
 * Plan 07 Task 11 — author monthly earnings snapshot.
 * Sticky tier logic lives in packages/shared/src/revshare.ts.
 */
export const authorEarnings = pgTable(
  'author_earnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id),
    // Phase 14: NULL for per-request accrual rows (sourced from aiag_settle_charge hook)
    periodMonth: date('period_month'),
    grossRevenueRub: numeric('gross_revenue_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    upstreamCostRub: numeric('upstream_cost_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    marginRub: numeric('margin_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    tierPct: integer('tier_pct').notNull(),
    authorShareRub: numeric('author_share_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    authorTaxStatus: text('author_tax_status'),
    status: text('status').notNull().default('accruing'), // accruing | locked | paid
    computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),

    // Phase 14 — per-request accrual columns (spec §5 Step 5)
    gatewayRequestId: varchar('gateway_request_id', { length: 64 }),
    grossRub: numeric('gross_rub', { precision: 14, scale: 4 }),
    tierPctDecimal: numeric('tier_pct_decimal', { precision: 4, scale: 3 }),
    netRub: numeric('net_rub', { precision: 14, scale: 4 }),
    availableAt: timestamp('available_at', { mode: 'date' }),
  },
  (table) => ({
    uniqPeriod: uniqueIndex('author_earnings_uniq_idx').on(
      table.authorId,
      table.modelId,
      table.periodMonth
    ),
    authorMonthIdx: index('author_earnings_author_month_idx').on(
      table.authorId,
      table.periodMonth
    ),
    statusIdx: index('author_earnings_status_idx').on(table.status),
  })
);

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    amountRub: numeric('amount_rub', { precision: 14, scale: 4 }).notNull(),
    taxWithheldRub: numeric('tax_withheld_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    netPaidRub: numeric('net_paid_rub', { precision: 14, scale: 4 })
      .notNull()
      .default('0'),
    method: text('method').notNull(), // card_ru | ip_account | ooo_account | smz_check
    bankDetailsEncrypted: text('bank_details_encrypted'),
    bankDetailsKeyVersion: integer('bank_details_key_version'),
    chekNumber: text('chek_number'),
    receiptPdfS3Key: text('receipt_pdf_s3_key'),
    transactionReference: text('transaction_reference'),
    status: text('status').notNull().default('requested'), // requested | processing | paid | failed | reversed
    adminNote: text('admin_note'),
    requestedAt: timestamp('requested_at', { mode: 'date' }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { mode: 'date' }),
    paidAt: timestamp('paid_at', { mode: 'date' }),

    // Phase 14 — KYC snapshot at payout time + tax act (spec §3.5)
    kycSnapshot: jsonb('kyc_snapshot'),
    taxActStorageKey: text('tax_act_storage_key'),
  },
  (table) => ({
    authorIdx: index('payouts_author_idx').on(table.authorId),
    statusIdx: index('payouts_status_idx').on(table.status),
  })
);

export const authorTierHistory = pgTable(
  'author_tier_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    tier: integer('tier').notNull(), // 70 | 75 | 80 | 85
    effectiveFrom: timestamp('effective_from', { mode: 'date' })
      .defaultNow()
      .notNull(),
    effectiveTo: timestamp('effective_to', { mode: 'date' }),
    reason: text('reason'),
  },
  (table) => ({
    authorIdx: index('author_tier_history_author_idx').on(
      table.authorId,
      table.effectiveFrom
    ),
  })
);

export type AuthorEarning = typeof authorEarnings.$inferSelect;
export type NewAuthorEarning = typeof authorEarnings.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type AuthorTierHistoryRow = typeof authorTierHistory.$inferSelect;
