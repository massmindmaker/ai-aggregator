import { afterEach, describe, expect, it, vi } from 'vitest';
import { is } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '../lib/db';
import { users, accounts, sessions, verificationTokens } from '@aiag/database/schema';

afterEach(async () => {
  const holder = globalThis as unknown as { db?: typeof db };
  await holder.db?.$client.end();
  holder.db = undefined;
  vi.unstubAllEnvs();
});
describe('lazy database proxy and current Auth.js adapter', () => {
  it('preserves the real PostgreSQL database prototype for adapter detection', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test@127.0.0.1:15432/ai_aggregator_test');
    // Constructing a pool/adapter does not open a connection or query this URL.
    expect(is(db, PgDatabase)).toBe(true);
    expect(() => DrizzleAdapter(db, {
      usersTable: users as never, accountsTable: accounts as never,
      sessionsTable: sessions as never, verificationTokensTable: verificationTokens as never,
    })).not.toThrow();
  });
});
