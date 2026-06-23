'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Page-transition shell (R2 motion uplift).
 *
 * Next App Router re-mounts template.tsx on every navigation, so a single
 * keyframed enter animation here gives a soft fade + lift on each screen change
 * — no router patching, no extra lib. View Transitions API is used as a
 * progressive enhancement for the cross-fade where the browser supports it; the
 * CSS keyframe below is the universal fallback (older Telegram WebViews / Safari).
 *
 * Rules (DESIGN.md): transform/opacity only, ease cubic-bezier(.23,1,.32,1),
 * full prefers-reduced-motion off-switch (see .tma-page-enter in globals.css).
 * No layout shift: the wrapper is display:contents, animation lives on a child
 * div that fills naturally.
 */
export default function Template({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const prevPath = useRef<string | null>(null);

  // View Transitions cross-fade: when the path actually changes and the browser
  // supports startViewTransition, wrap the (already-committed) DOM swap so the
  // browser snapshots old→new and cross-fades. React has rendered by the time
  // this effect runs; calling it here is a best-effort enhancement and a no-op
  // where unsupported. The CSS keyframe still runs regardless.
  useEffect(() => {
    if (prevPath.current === null) {
      prevPath.current = pathname;
      return;
    }
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => void;
    };
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof doc.startViewTransition !== 'function') return;
    // Empty callback: the DOM is already updated; this just triggers the
    // browser's default root cross-fade for the committed change.
    try {
      doc.startViewTransition(() => {});
    } catch {
      /* ignore — keyframe fallback covers it */
    }
  }, [pathname]);

  // key=pathname forces a fresh mount → the enter keyframe replays each route.
  return (
    <div key={pathname} className="tma-page-enter">
      {children}
    </div>
  );
}
