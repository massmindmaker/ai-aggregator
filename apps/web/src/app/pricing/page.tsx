import { auth } from '@/auth';
import PricingClient from './PricingClient';
import { readGramPricing } from '@/lib/ton-wallet/pricing-packages';

export const dynamic = 'force-dynamic';

/**
 * Gram-storefront (task 4): the public pricing page no longer reads
 * subscription plans (rub tiers) from SQL — it renders credit packages
 * projected from the active TON checkout policy. `readGramPricing` never
 * throws: a missing/invalid policy yields null and the client falls back to
 * a "packages coming soon" block with a 200 response.
 */
export default async function PricingPage() {
  const session = await auth();
  const view = await readGramPricing();
  return <PricingClient isLoggedIn={Boolean(session?.user)} view={view} />;
}
