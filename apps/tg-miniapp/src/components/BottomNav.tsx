'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { haptic } from '@/lib/haptics';

interface Item {
  href: string;
  label: string;
  iconPath: string;
  /** P1-10: таб подсвечивается на любом из этих путей (по умолчанию — href). */
  match?: string[];
}

// Outline SVG paths (24×24 viewbox). Redesign-A: 5 табов.
const ITEMS: Item[] = [
  {
    href: '/agents',
    label: 'Агенты',
    iconPath: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z', // chat-bubble
    match: ['/agents'],
  },
  {
    href: '/market',
    label: 'Маркет',
    iconPath: 'M3 5h7v7H3V5z M14 5h7v7h-7V5z M3 16h7v3H3v-3z M14 16h7v3h-7v-3z', // cards/grid
    match: ['/market'],
  },
  {
    href: '/dashboard',
    label: 'Дэшборд',
    iconPath: 'M3 21h18 M6 21V11 M11 21V5 M16 21v-7 M21 21V9', // chart
    match: ['/dashboard'],
  },
  {
    href: '/wallet',
    label: 'Кошелёк',
    iconPath: 'M3 7a2 2 0 012-2h12a2 2 0 012 2v2h2v6h-2v2a2 2 0 01-2 2H5a2 2 0 01-2-2V7z M19 9h-4a3 3 0 000 6h4', // wallet
    match: ['/wallet'],
  },
  {
    href: '/account',
    label: 'Аккаунт',
    iconPath: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c0-4 4-7 8-7s8 3 8 7', // user
    match: ['/account'],
  },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="tma-bottom-nav" aria-label="Главное меню">
      {ITEMS.map((it) => {
        const p = path ?? '';
        const active = (it.match ?? [it.href]).some(
          (m) => p === m || p.startsWith(m + '/'),
        );
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`tma-nav-item ${active ? 'tma-nav-item--active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (!active) haptic.select();
            }}
          >
            <svg
              className="tma-nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={it.iconPath} />
            </svg>
            <span className="tma-nav-label">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
