'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';

interface TocItem {
  id: string;
  label: string;
}

interface Props {
  title: string;
  /** Дата последнего обновления */
  updated?: string;
  /** Items для ToC. Если не задано — auto-extract из h2 children */
  toc?: TocItem[];
  /** Показать ссылку "← На главную" */
  showBack?: boolean;
  children: ReactNode;
}

/**
 * Layout для legal/policy страниц:
 * - Sticky ToC sidebar на desktop (≥ lg)
 * - Anchor highlight активного раздела через IntersectionObserver
 * - Smooth scroll
 */
export function LegalLayout({
  title,
  updated,
  toc: tocProp,
  showBack = true,
  children,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [autoToc, setAutoToc] = useState<TocItem[]>([]);

  // Auto-extract h2 IDs if toc not provided
  useEffect(() => {
    if (tocProp) return;
    const headings = document.querySelectorAll('main h2[id]');
    setAutoToc(
      Array.from(headings).map((h) => ({
        id: h.id,
        label: h.textContent ?? '',
      }))
    );
  }, [tocProp]);

  const items = tocProp ?? autoToc;

  // IntersectionObserver — track active section
  useEffect(() => {
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter(Boolean) as HTMLElement[];
    if (!headings.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              a.target.getBoundingClientRect().top -
              b.target.getBoundingClientRect().top
          );
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-100px 0px -60% 0px' }
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-12 grid lg:grid-cols-[1fr_220px] gap-12">
      <main className="prose prose-invert max-w-none text-[15px] leading-relaxed">
        {showBack && (
          <nav className="not-prose mb-6 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground transition-colors">
              ← На главную
            </Link>
          </nav>
        )}
        <header
          className="not-prose mb-10 pb-6 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <h1 className="text-3xl font-bold tracking-tight mb-2">{title}</h1>
          {updated && (
            <p className="text-xs opacity-50 uppercase tracking-widest">
              Обновлено: {updated}
            </p>
          )}
        </header>
        {children}
      </main>

      {items.length > 0 && (
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-1 text-sm">
            <p className="text-[10px] uppercase tracking-[0.12em] opacity-40 font-semibold mb-3 px-3">
              На странице
            </p>
            {items.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={`block px-3 py-1.5 rounded-sm transition-all border-l-2 ${
                  activeId === item.id
                    ? 'border-[var(--accent)] text-[var(--ink)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]'
                    : 'border-transparent opacity-50 hover:opacity-100 hover:bg-white/[0.03]'
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </aside>
      )}
    </div>
  );
}
