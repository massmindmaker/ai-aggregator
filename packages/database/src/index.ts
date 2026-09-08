import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';
import * as schema from './schema';

// Heuristic: Neon serverless HTTP works for *.neon.tech URLs (and Vercel
// Postgres which proxies to it). Anything else (localhost, self-hosted
// Postgres, the SSH-tunnelled VPS Postgres on 127.0.0.1:15432) must go
// through the standard `pg` driver over TCP.
function shouldUseNeon(connectionString: string): boolean {
  return /neon\.tech|vercel-storage\.com/.test(connectionString);
}

// Detect a local Postgres URL — used to disable SSL for self-hosted DBs that
// don't terminate TLS (e.g. local docker-compose or a VPS Postgres bound to
// 127.0.0.1). Without this, `pg-connection-string` v3 escalates `sslmode=prefer`
// to `verify-full` and the connection fails with
// "The server does not support SSL connections".
function isLocalPostgres(connectionString: string): boolean {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:\/]/i.test(connectionString);
}

// Create database client
export function createDb(connectionString: string) {
  if (shouldUseNeon(connectionString)) {
    const sql = neon(connectionString);
    return drizzleNeon(sql, { schema }) as unknown as ReturnType<typeof drizzlePg<typeof schema>>;
  }
  const poolConfig: ConstructorParameters<typeof Pool>[0] = {
    connectionString,
  };
  if (isLocalPostgres(connectionString)) {
    poolConfig.ssl = false;
  }
  const pool = new Pool(poolConfig);
  return drizzlePg(pool, { schema });
}

// Create database client for edge runtime (Neon HTTP only)
export function createEdgeDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzleNeon(sql, { schema });
}

// Export schema
export * from './schema';

// Export drizzle utilities
export { sql, eq, and, or, desc, asc, like, ilike, inArray, notInArray, isNull, isNotNull, between, gt, gte, lt, lte, ne, count, sum, avg, min, max } from 'drizzle-orm';

// Type for database instance
export type Database = ReturnType<typeof createDb>;

export * from './ton-payment-types';
export { createTonInvoice, getTonInvoice, expireTonInvoice, settleTonInvoice } from './ton-payments';
