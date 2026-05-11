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
    href: '/',
    label: 'Главная',
    iconPath: 'M3 12 12 4l9 8M5 10v10h14V10', // home
  },
  {
    href: '/nft',
    label: 'NFT',
    iconPath: 'M6 3h12l3 6-9 12L3 9z M6 3l6 18 M18 3l-6 18 M3 9h18', // gem
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
        const active =
          path === it.href || (it.href !== '/' && (path ?? '').startsWith(it.href));
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
