'use client';

import { TonConnectUIProvider } from '@tonconnect/ui-react';
import type { ReactNode } from 'react';

/**
 * MANDATORY pattern (spike result 2026-05-11):
 *   TonConnectUIProvider must live inside a 'use client' boundary.
 *   Importing it from a server component (RSC) breaks Next 14 with
 *   `TypeError: createContext is not a function`.
 */
const MANIFEST_URL =
  process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL ??
  'https://app.ai-aggregator.ru/tg/tonconnect-manifest.json';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TonConnectUIProvider manifestUrl={MANIFEST_URL}>
      {children}
    </TonConnectUIProvider>
  );
}
