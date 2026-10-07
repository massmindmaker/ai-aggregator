import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { parseCheckoutPolicy } from './checkout-policy';

/**
 * Runtime checkout policy source (plan AG-TON-L task 3.4): the worker
 * refresher persists the policy JSON to admin_settings under this key; the
 * env variable stays as the local-development fallback.
 */
export const TON_CHECKOUT_POLICY_KEY = 'ton_checkout_policy';

/** Raw string form of the active policy: admin_settings row first, env fallback. */
export async function readCheckoutPolicyRaw(): Promise<string> {
  try {
    const result = (await db.execute(
      sql`SELECT value FROM admin_settings WHERE key = ${TON_CHECKOUT_POLICY_KEY} LIMIT 1`,
    )) as { rows?: Array<{ value: unknown }> };
    const value = result.rows?.[0]?.value;
    if (value !== undefined && value !== null) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
  } catch {
    /* database outage must not brick checkout when env is configured */
  }
  const fromEnv = process.env.TON_CHECKOUT_POLICY;
  return typeof fromEnv === 'string' ? fromEnv : '';
}

export async function createCheckoutPolicySource(): Promise<string> {
  return readCheckoutPolicyRaw();
}

export async function activeCheckoutPolicy() {
  return parseCheckoutPolicy(await readCheckoutPolicyRaw());
}
