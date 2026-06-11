'use client';

import Link from 'next/link';

// P1-10: таб «Маркет» = единый хаб каталогов. Сегмент-навигатор из ссылок
// поверх трёх существующих страниц (без переписывания данных, v1).
export type CatalogSection = 'agents' | 'models' | 'skills';

const SECTIONS: { key: CatalogSection; href: string; label: string }[] = [
  { key: 'agents', href: '/templates', label: 'Агенты' },
  { key: 'models', href: '/market', label: 'Модели' },
  { key: 'skills', href: '/skills', label: 'Скиллы' },
];

export function CatalogNav({ active }: { active: CatalogSection }) {
  return (
    <nav
      className="tma-segment tma-segment--fit tma-catalog-nav"
      aria-label="Разделы маркета"
    >
      {SECTIONS.map((s) => {
        const isActive = s.key === active;
        return (
          <Link
            key={s.key}
            href={s.href}
            className={`tma-segment-btn${isActive ? ' is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
