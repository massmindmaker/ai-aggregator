'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  href: string;
  label: string;
  iconPath: string;
}

// Outline SVG paths (24×24 viewbox)
const ITEMS: Item[] = [
  {
    href: '/agents',
    label: 'Агенты',
    iconPath: 'M12 2a3 3 0 013 3v1h2a2 2 0 012 2v3h1v4h-1v3a2 2 0 01-2 2H7a2 2 0 01-2-2v-3H4v-4h1V8a2 2 0 012-2h2V5a3 3 0 013-3z M9 13h.01 M15 13h.01', // robot
  },
  {
    href: '/nft',
    label: 'NFT',
    iconPath: 'M6 3h12l3 6-9 12L3 9z M6 3l6 18 M18 3l-6 18 M3 9h18', // gem
  },
  {
    href: '/market',
    label: 'Маркет',
    iconPath: 'M3 7l9 4 9-4-9-4-9 4z M3 7v10l9 4 9-4V7 M12 11v10', // box
  },
  {
    href: '/skills',
    label: 'Скиллы',
    iconPath: 'M13 2L3 14h7l-1 8 10-12h-7l1-8z', // bolt
  },
  {
    href: '/profile',
    label: 'Профиль',
    iconPath: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c0-4 4-7 8-7s8 3 8 7', // user
  },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="tma-bottom-nav" aria-label="Главное меню">
      {ITEMS.map((it) => {
        const p = path ?? '';
        const active = p === it.href || p.startsWith(it.href + '/');
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`tma-nav-item ${active ? 'tma-nav-item--active' : ''}`}
            aria-current={active ? 'page' : undefined}
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
