'use client';

import { useRouter } from 'next/navigation';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

interface ScenarioCardLinkProps {
  href: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Same visual/markup contract as `next/link` (renders a real `<a href>` so
 * middle-click / cmd-click / no-JS / crawlers keep working), but forces the
 * navigation through `router.push` + `router.refresh()` on a plain click.
 *
 * Why not a plain `<Link>`: this card always navigates to `/marketplace`
 * with a *different* query string per scenario. Next 14.2's client Router
 * Cache can serve a previously-rendered RSC payload for that pathname
 * (e.g. the bare `/marketplace` visited from the hero CTA or nav) instead
 * of re-fetching with the new `?types=...`/`?tags=...` filter — the same
 * staleness class already worked around in `SearchAndSort.tsx` for
 * same-page sort/search changes. `router.refresh()` forces a fresh
 * server render so the clicked scenario's filter is guaranteed to apply
 * on first click, not just after a manual reload.
 */
export function ScenarioCardLink({
  href,
  className,
  style,
  children,
}: ScenarioCardLinkProps) {
  const router = useRouter();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let modified clicks (new tab/window, middle click) behave natively.
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(href);
    router.refresh();
  };

  return (
    <a href={href} className={className} style={style} onClick={handleClick}>
      {children}
    </a>
  );
}
