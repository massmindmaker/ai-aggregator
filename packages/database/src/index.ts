import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';
import * as schema from './schema';

// Service clients always use a driver with interactive transactions.
// HTTP edge access is explicit below, never inferred from text in a URL.
function isLocalPostgres(connectionString: string): boolean {
  const host = new URL(connectionString).hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// Create database client
export function createDb(connectionString: string) {
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
export { createTonInvoice, getTonInvoice, expireTonInvoice, listTonReviewRequired, resolveTonReviewDecision } from './ton-payments';
export type { TonReviewRequiredEntry, TonReviewAction } from './ton-payments';

export { issueTonWalletChallenge, completeTonWalletProof, consumeTonWalletTicket, listTonWallets, checkTonWalletSession, reserveTonWalletPasswordAttempt, revokeTonWallet, TonWalletAuthError } from "./ton-wallet-auth";
export type { TonWalletContext, LinkedTonWallet, TonWalletLoginUser } from "./ton-wallet-auth";

export { createTonCheckout,readTonCheckout,claimTonCheckoutSend,recordTonCheckoutClientReport } from "./ton-wallet-checkout";
export type { TonCheckoutPolicy,TonCheckout,TonCheckoutInput } from "./ton-wallet-checkout";
