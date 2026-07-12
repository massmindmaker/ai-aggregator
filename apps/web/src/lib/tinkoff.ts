import { TinkoffAcquiring } from '@aiag/tinkoff';
import { getTinkoffClient } from '@/lib/payments/providers';

// Create a global instance to reuse
const globalForTinkoff = globalThis as unknown as {
  tinkoff: TinkoffAcquiring | undefined;
};

// Verify (webhook) and Init (providers.ts) share ONE client factory so the
// terminal secret is resolved identically (TINKOFF_PASSWORD || TINKOFF_SECRET_KEY
// via resolveTinkoffSecret). Previously this read TINKOFF_SECRET_KEY only, so a
// prod terminal configured under TINKOFF_PASSWORD would fail CONFIRMED
// verification and lose the payment.
export const tinkoff = globalForTinkoff.tinkoff ?? getTinkoffClient();

if (process.env.NODE_ENV !== 'production') {
  globalForTinkoff.tinkoff = tinkoff;
}

export { generateOrderId, formatAmount } from '@aiag/tinkoff';
