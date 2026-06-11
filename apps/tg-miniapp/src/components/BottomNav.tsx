'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item {
  href: string;
  label: string;
  iconPath: string;
  /** P1-10: таб подсвечивается на любом из этих путей (по умолчанию — href). */
  match?: string[];
}

// Outline SVG paths (24×24 viewbox)
const ITEMS: Item[] = [
  {
    href: '/agents',
    label: 'Агенты',
    iconPath: 'M12 2a3 3 0 013 3v1h2a2 2 0 012 2v3h1v4h-1v3a2 2 0 01-2 2H7a2 2 0 01-2-2v-3H4v-4h1V8a2 2 0 012-2h2V5a3 3 0 013-3z M9 13h.01 M15 13h.01', // robot
  },
  {
    // P1-10: «Маркет» = хаб каталогов, дефолт-сегмент — агенты (/templates).
    // Скиллы переехали в сегменты внутри хаба.
    href: '/templates',
    label: 'Маркет',
    iconPath: 'M3 7l9 4 9-4-9-4-9 4z M3 7v10l9 4 9-4V7 M12 11v10', // box
    match: ['/templates', '/market', '/skills'],
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
        const active = (it.match ?? [it.href]).some(
          (m) => p === m || p.startsWith(m + '/'),
        );
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
