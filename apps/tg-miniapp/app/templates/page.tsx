'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { CatalogNav } from '@/components/CatalogNav';
import { AgentCard, hueFor } from '@/components/AgentCard';

interface Template {
  id: string;
  name: string | null;
  description: string | null;
  model_slug: string | null;
  tools: unknown;
  price_credits: string | null;
  clone_count: number;
  avg_rating: string | null;
  rating_count: number;
  author_tg_user_id: string;
  created_at: string;
}

// Sort modes map 1:1 to the route's ?sort= contract (see templates/route.ts).
type SortMode = 'new' | 'trending' | 'top';
const SORTS: { key: SortMode; label: string }[] = [
  { key: 'new', label: 'Новые' },
  { key: 'trending', label: 'В тренде' },
  { key: 'top', label: 'Топ' },
];

// P0-1: хранение = центы, дисплей = кр (÷100) — как кошелёк/RunTrace.
function priceLabel(price: string | null): string {
  if (price === null) return 'бесплатно';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'бесплатно';
  return `${(n / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} кр`;
}

// Russian plural for «клон» (1 клон / 2 клона / 5 клонов).
function cloneWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клон';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'клона';
  return 'клонов';
}

export default function TemplatesPage() {
  const { token } = useAuth();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('new');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setTemplates(null);
    setFetchErr(null);
    (async () => {
      try {
        const res = await fetch(`/tg/api/tma/templates?sort=${sort}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setFetchErr(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setTemplates(data.templates ?? []);
      } catch (e) {
        if (cancelled) return;
        setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, sort]);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-eyebrow">Маркет</span>
          <h1 className="tma-title">Готовые агенты</h1>
          <p className="tma-subtitle">
            Клонируйте чужого агента себе. Настройки переносятся, ключи — нет.
          </p>
        </header>

        <CatalogNav active="agents" />

        <div className="tma-segment" role="tablist" aria-label="Сортировка">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={sort === s.key}
              className={`tma-segment-btn${sort === s.key ? ' is-active' : ''}`}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

        {!templates && !fetchErr && (
          <section className="tma-agent-grid" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="tma-agent-card tma-agent-card--skeleton">
                <div className="tma-agent-portrait tma-skeleton" />
                <div className="tma-agent-body">
                  <div className="tma-skeleton tma-skeleton-line" />
                  <div className="tma-skeleton tma-skeleton-line tma-skeleton-line--short" />
                </div>
              </div>
            ))}
          </section>
        )}

        {templates && templates.length === 0 && (
          <section className="tma-card tma-empty">
            <span className="tma-empty-glyph">✦</span>
            <h2 className="tma-card-title">Каталог пуст</h2>
            <p className="tma-card-text">
              Здесь появятся опубликованные агенты. Опубликуйте своего первым —
              откройте агента и нажмите «Опубликовать как шаблон».
            </p>
          </section>
        )}

        {templates && templates.length > 0 && (
          <section className="tma-agent-grid aiag-stagger">
            {templates.map((t, idx) => {
              const hasRating = t.avg_rating !== null;
              return (
                <AgentCard
                  key={t.id}
                  href={`/templates/${t.id}`}
                  hue={hueFor(t.id)}
                  name={t.name}
                  role={t.description}
                  model={t.model_slug}
                  metricLabel={priceLabel(t.price_credits)}
                  metricAccent={t.price_credits !== null}
                  rating={
                    hasRating
                      ? { value: t.avg_rating as string, count: t.rating_count }
                      : null
                  }
                  countLabel={
                    !hasRating
                      ? `${t.clone_count} ${cloneWord(t.clone_count)}`
                      : null
                  }
                  featured={sort === 'top' && idx === 0}
                />
              );
            })}
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}
