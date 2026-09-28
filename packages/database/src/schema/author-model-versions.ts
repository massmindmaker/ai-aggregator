import { pgTable, uuid, integer, jsonb, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { models } from './models-marketplace';
import { users } from './users';

export const authorModelVersions = pgTable('author_model_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  modelId: uuid('model_id').notNull().references(() => models.id, { onDelete: 'restrict' }),
  authorUserId: uuid('author_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  versionNo: integer('version_no').notNull(),
  publicManifest: jsonb('public_manifest').notNull(),
  manifestDigest: text('manifest_digest').notNull(),
  encryptedTokenEnvelope: jsonb('encrypted_token_envelope').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  versionUnique: unique('author_model_versions_model_version_uq').on(table.modelId, table.versionNo),
  modelIdUnique: unique('author_model_versions_model_id_uq').on(table.modelId, table.id),
  modelStatusIdx: index('author_model_versions_model_idx').on(table.modelId, table.status),
  authorIdx: index('author_model_versions_author_idx').on(table.authorUserId, table.createdAt),
}));

export type AuthorModelVersion = typeof authorModelVersions.$inferSelect;
export type NewAuthorModelVersion = typeof authorModelVersions.$inferInsert;
