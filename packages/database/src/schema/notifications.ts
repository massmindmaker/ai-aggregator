import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  varchar,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { notificationTypeEnum } from './enums';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Notification content
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    message: text('message'),

    // Link to action
    actionUrl: text('action_url'),
    actionLabel: text('action_label'),

    // Reference to related entity
    referenceType: varchar('reference_type', { length: 50 }), // 'model' | 'subscription' | 'payment' | etc.
    referenceId: uuid('reference_id'),

    // Metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    // Status
    isRead: boolean('is_read').default(false).notNull(),
    readAt: timestamp('read_at', { mode: 'date' }),
    isArchived: boolean('is_archived').default(false).notNull(),

    // Email notification
    emailSent: boolean('email_sent').default(false).notNull(),
    emailSentAt: timestamp('email_sent_at', { mode: 'date' }),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
  },
  (table) => ({
    userIdx: index('notifications_user_idx').on(table.userId),
    userUnreadIdx: index('notifications_user_unread_idx').on(
      table.userId,
      table.isRead
    ),
    typeIdx: index('notifications_type_idx').on(table.type),
    createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
  })
);

// Model announcements (API updates, new versions, etc.)
export const modelAnnouncements = pgTable(
  'model_announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id').notNull(),

    // Content
    title: text('title').notNull(),
    content: text('content').notNull(),
    type: varchar('type', { length: 20 }).default('update').notNull(), // 'update' | 'maintenance' | 'deprecation' | 'feature'

    // Author
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Visibility
    isPublished: boolean('is_published').default(false).notNull(),
    publishedAt: timestamp('published_at', { mode: 'date' }),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    modelIdx: index('announcements_model_idx').on(table.modelId),
    authorIdx: index('announcements_author_idx').on(table.authorId),
    publishedIdx: index('announcements_published_idx').on(
      table.isPublished,
      table.publishedAt
    ),
  })
);

// Relations
export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
}));

export const modelAnnouncementsRelations = relations(modelAnnouncements, ({ one }) => ({
  author: one(users, {
    fields: [modelAnnouncements.authorId],
    references: [users.id],
  }),
}));

// Types
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type ModelAnnouncement = typeof modelAnnouncements.$inferSelect;
export type NewModelAnnouncement = typeof modelAnnouncements.$inferInsert;
