import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  varchar,
  jsonb,
  date,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { userRoleEnum } from './enums';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    emailVerified: timestamp('email_verified', { mode: 'date' }),
    passwordHash: text('password_hash'),
    name: text('name'),
    username: varchar('username', { length: 50 }).unique(),
    image: text('image'),
    bio: text('bio'),
    website: text('website'),
    role: userRoleEnum('role').default('user').notNull(),

    // Profile data
    location: text('location'),
    company: text('company'),
    socialLinks: jsonb('social_links').$type<{
      github?: string;
      twitter?: string;
      linkedin?: string;
      telegram?: string;
    }>(),

    // Preferences
    preferences: jsonb('preferences').$type<{
      notifications: boolean;
      newsletter: boolean;
      theme: 'light' | 'dark' | 'system';
      language: string;
    }>().default({
      notifications: true,
      newsletter: false,
      theme: 'system',
      language: 'ru',
    }),

    // Balance for pay-per-use
    balance: text('balance').default('0'), // Stored as string to avoid floating point issues

    // Status
    isActive: boolean('is_active').default(true).notNull(),
    isBanned: boolean('is_banned').default(false).notNull(),
    banReason: text('ban_reason'),

    // Phase 14 — KYC + tax + bank fields (spec §3.3)
    kycStatus: text('kyc_status').notNull().default('none'), // none | pending | verified | rejected
    kycType: text('kyc_type'), // self_employed | ip | individual
    kycVerifiedAt: timestamp('kyc_verified_at', { mode: 'date' }),
    taxCountry: text('tax_country').default('RU'),
    taxId: text('tax_id'),
    bankDetails: jsonb('bank_details'), // encrypted application-side (libsodium) — admin sees last-4 only
    dob: date('dob'),

    // 152-FZ consent fields
    consentProcessing: boolean('consent_processing').notNull().default(false),
    consentTransborder: boolean('consent_transborder').notNull().default(false),
    consentMarketing: boolean('consent_marketing').notNull().default(false),
    consentTimestamp: timestamp('consent_timestamp', { mode: 'date' }),
    consentIpAddress: varchar('consent_ip_address', { length: 45 }),
    consentUserAgent: text('consent_user_agent'),

    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at', { mode: 'date' }),
  },
  (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
    usernameIdx: index('users_username_idx').on(table.username),
    roleIdx: index('users_role_idx').on(table.role),
  })
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'oauth' | 'credentials'
    provider: text('provider').notNull(), // 'google' | 'github' | 'yandex' | 'credentials'
    providerAccountId: text('provider_account_id').notNull(),
    refreshToken: text('refresh_token'),
    accessToken: text('access_token'),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    tokenType: text('token_type'),
    scope: text('scope'),
    idToken: text('id_token'),
    sessionState: text('session_state'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index('accounts_user_id_idx').on(table.userId),
    providerIdx: index('accounts_provider_idx').on(table.provider, table.providerAccountId),
  })
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionToken: text('session_token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index('sessions_user_id_idx').on(table.userId),
    sessionTokenIdx: index('sessions_token_idx').on(table.sessionToken),
  })
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull().unique(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (table) => ({
    identifierIdx: index('verification_tokens_identifier_idx').on(table.identifier),
  })
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
