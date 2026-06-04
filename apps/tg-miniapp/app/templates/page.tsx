'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';

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

// Per-character accent hues (OKLCH) — the collectible-card signature (DESIGN.md).
// Deterministic per template id so a card always wears the same colour.
const HUES = [28, 235, 340, 165, 60, 290, 200, 130];
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

function priceLabel(price: string | null): string {
  if (price === null) return 'бесплатно';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'бесплатно';
  return `${n} кр`;
}

function monogram(name: string | null): string {
  const t = (name ?? '?').trim();
  return (t[0] ?? '?').toUpperCase();
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
          <span className="tma-badge">ШАБЛОНЫ</span>
          <h1 className="tma-title">Готовые агенты</h1>
          <p className="tma-subtitle">
            Клонируйте чужого агента себе. Настройки переносятся, ключи — нет.
          </p>
        </header>

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

        {!templates && !fetchErr && <p className="tma-card-text">Загрузка…</p>}

        {templates && templates.length === 0 && (
          <section className="tma-card">
            <h2 className="tma-card-title">Каталог пуст</h2>
            <p className="tma-card-text">
              Скоро здесь появятся опубликованные агенты.
            </p>
          </section>
        )}

        {templates && templates.length > 0 && (
          <section className="tma-nft-grid">
            {templates.map((t) => {
              const hue = hueFor(t.id);
              return (
                <Link key={t.id} href={`/templates/${t.id}`} className="tma-nft-card">
                  <div
                    className="tma-nft-image tma-nft-image--placeholder"
                    style={{
                      background: `linear-gradient(155deg, oklch(0.32 0.08 ${hue}), oklch(0.18 0.04 ${hue}))`,
                      color: `oklch(0.92 0.10 ${hue})`,
                      fontSize: 40,
                      fontWeight: 700,
                    }}
                  >
                    <span>{monogram(t.name)}</span>
                  </div>
                  <div className="tma-nft-body">
                    <h3 className="tma-nft-name">{t.name ?? 'Без имени'}</h3>
                    {t.description && (
                      <p
                        className="tma-card-text tma-text-small"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {t.description}
                      </p>
                    )}
                    {t.model_slug && (
                      <span className="tma-mono" style={{ wordBreak: 'break-all' }}>
                        {t.model_slug}
                      </span>
                    )}
                    <div className="tma-nft-meta">
                      <span
                        className={t.price_credits === null ? 'tma-nft-supply' : 'tma-nft-price'}
                        style={
                          t.price_credits !== null
                            ? { fontVariantNumeric: 'tabular-nums' }
                            : undefined
                        }
                      >
                        {priceLabel(t.price_credits)}
                      </span>
                      {t.avg_rating !== null ? (
                        <span className="tma-rating">
                          <span className="tma-rating-star">★</span>
                          <span className="tma-rating-value">{t.avg_rating}</span>
                          {t.rating_count > 0 && (
                            <span className="tma-rating-count">({t.rating_count})</span>
                          )}
                        </span>
                      ) : (
                        <span className="tma-nft-supply">⧉ {t.clone_count}</span>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}
