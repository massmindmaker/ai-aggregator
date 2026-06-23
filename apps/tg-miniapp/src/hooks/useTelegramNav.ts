'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// Routes that are "roots" (reachable from the bottom tab-bar). On these the
// native Telegram BackButton is hidden; everywhere else it shows and pops the
// in-app history. Matched by exact path OR as a prefix (e.g. /market/[slug]
// is NOT a root, but /market is).
const ROOTS = new Set(['/agents', '/market', '/dashboard', '/wallet', '/account', '/']);

function tgWebApp(): any {
  return typeof window !== 'undefined'
    ? (window as any).Telegram?.WebApp
    : undefined;
}

/**
 * Wires the native Telegram BackButton to Next's router on nested screens and
 * hides it on the bottom-tab roots. Mounted once (in a layout-level client
 * component). All Telegram calls are optional-chained — silent no-op outside
 * Telegram or on older clients that lack BackButton.
 *
 * Not a motion concern, so it stays on regardless of prefers-reduced-motion.
 */
export function useTelegramNav() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const tg = tgWebApp();
    const back = tg?.BackButton;
    if (!back) return;

    const isRoot = pathname ? ROOTS.has(pathname) : true;
    const onBack = () => router.back();

    try {
      if (isRoot) {
        back.hide?.();
      } else {
        back.show?.();
        back.onClick?.(onBack);
      }
    } catch {
      /* ignore */
    }

    return () => {
      try {
        back.offClick?.(onBack);
      } catch {
        /* ignore */
      }
    };
  }, [pathname, router]);
}
