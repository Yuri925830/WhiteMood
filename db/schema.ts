import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Counts only. Never store conversations, recordings, diagnoses or IP addresses here.
export const requestLimits = sqliteTable('wm_request_limits', {
  id: text('id').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('wm_request_limits_expiry').on(table.expiresAt)]);

export const accounts = sqliteTable('wm_accounts', {
  userId: text('user_id').primaryKey(),
  loginId: text('login_id').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  salt: text('salt').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const accountSessions = sqliteTable('wm_account_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('wm_account_sessions_expiry').on(table.expiresAt)]);
