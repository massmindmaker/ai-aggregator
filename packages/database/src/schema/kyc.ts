/**
 * Phase 14 — kyc_documents table (spec §3.4).
 *
 * Per-user identity uploads supporting KYC review flow. doc_type covers
 * passport pages, INN, IP/EGRIP, and self-employed certificates. Status
 * transitions: pending → approved | rejected.
 */

import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const kycDocuments = pgTable(
  'kyc_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    docType: text('doc_type').notNull(), // passport_main | passport_registration | inn_certificate | ip_egrip | self_employed_certificate | other
    storageKey: text('storage_key').notNull(),
    uploadedAt: timestamp('uploaded_at', { mode: 'date' }).defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at', { mode: 'date' }),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    status: text('status').notNull().default('pending'), // pending | approved | rejected
    rejectionReason: text('rejection_reason'),
  },
  (t) => ({
    userIdx: index('idx_kyc_docs_user').on(t.userId),
    pendingIdx: index('idx_kyc_docs_pending').on(t.status, t.uploadedAt),
  })
);

export type KycDocument = typeof kycDocuments.$inferSelect;
export type NewKycDocument = typeof kycDocuments.$inferInsert;
