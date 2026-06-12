'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /market — «Маркет»: витрина агентов-персонажей (CharCard). Это ре-скин каталога
// шаблонов: AIAG сеет официальных агентов КАК шаблоны, массы берут их (использовать
// = бесплатный клон / арендовать = author-rent). Глубокие каталоги (Модели · Скиллы
// · MCP · Тузы · Базы) — для операторов (фаза 2), показаны как LOCKED-сегменты.
//
// Данные: GET /tg/api/tma/templates?sort=trending (Bearer, как в /templates).
// Карточка: src/components/CharCard.tsx (готовая, не трогаем). hueFor — AgentCard.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { CharCard } from '@/components/CharCard';
import { hueFor } from '@/components/AgentCard';
import { fmtCredits } from '@/lib/credits';
import { characterFor } from '@/lib/characters';

// Ровно поля, которые отдаёт GET /tg/api/tma/templates (см. templates/route.ts).
// template_kind список НЕ возвращает → портрет берём по нему только если он есть.
interface Template {
  id: string;
  name: string | null;
  description: string | null;
  trait: string | null;
  model_slug: string | null;
  tools: unknown;
  price_credits: string | null;
  clone_count: number;
  avg_rating: string | null;
  rating_count: number;
  author_tg_user_id: string;
  author_username: string | null;
  created_at: string;
  template_kind?: string | null;
}

// Сегменты витрины. «Агенты» активен; остальные — для операторов (фаза 2),
// рендерятся как не-кликабельные чипы с пилюлей «для операторов».
const LOCKED_SEGMENTS = ['Модели', 'Скиллы', 'MCP', 'Тузы', 'Базы'];

// Визуальные категории (клиентский фильтр по подстроке имени/роли — без перебора).
const CATEGORIES = ['Все', 'Текст', 'Образ', 'Голос', 'Код', 'Данные'] as const;
type Category = (typeof CATEGORIES)[number];

// Подсказки фильтра: к какой категории какие слова-маркеры. «Все» = без фильтра.
const CATEGORY_HINTS: Record<Exclude<Category, 'Все'>, string[]> = {
  Текст: ['текст', 'писат', 'копи', 'статья', 'перевод', 'редакт'],
  Образ: ['образ', 'картин', 'фото', 'дизайн', 'изображ', 'арт'],
  Голос: ['голос', 'озвуч', 'аудио', 'речь', 'звук'],
  Код: ['код', 'разработ', 'программ', 'девопс', 'sql', 'api'],
  Данные: ['данны', 'аналит', 'таблиц', 'отчёт', 'отчет', 'базы'],
};

function matchesCategory(t: Template, cat: Category): boolean {
  if (cat === 'Все') return true;
  const hay = `${t.name ?? ''} ${t.description ?? ''}`.toLowerCase();
  return CATEGORY_HINTS[cat].some((w) => hay.includes(w));
}

// Цена для строки статов CharCard: центы → «N,NN кр» или «бесплатно».
function priceStat(price: string | null): string {
  return price !== null ? `${fmtCredits(price)} кр` : 'бесплатно';
}

// Подпись amber-кнопки: платный → аренда с ценой, бесплатный → использовать.
function actionLabel(price: string | null): string {
  return price !== null ? `Арендовать · ${fmtCredits(price)} кр` : 'Использовать';
}

export default function MarketPage() {
  const router = useRouter();
  const { token, loading, error } = useAuth();

  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>('Все');

  // take() в полёте: какой шаблон сейчас берём + куда показать ошибку/недостаток.
  const [takingId, setTakingId] = useState<string | null>(null);
  const [takeErr, setTakeErr] = useState<string | null>(null);
  const [insufficientId, setInsufficientId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setTemplates(null);
    setFetchErr(null);
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/templates?sort=trending', {
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
  }, [token]);

  // Клиентский фильтр (имя/роль) — поиск + категория. Над списком, не над сетью.
  const visible = useMemo(() => {
    if (!templates) return null;
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (!matchesCategory(t, category)) return false;
      if (!q) return true;
      const hay = `${t.name ?? ''} ${t.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [templates, search, category]);

  // take(): бесплатный → clone, платный → rent (как в templates/[id]). На успех —
  // в инбокс (/agents). 402 → инлайн-подсказка с пополнением. Mirror error-handling.
  async function take(t: Template) {
    if (!token || takingId) return;
    const paid = t.price_credits !== null;
    setTakingId(t.id);
    setTakeErr(null);
    setInsufficientId(null);
    try {
      const res = await fetch(
        `/tg/api/tma/templates/${t.id}/${paid ? 'rent' : 'clone'}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 402) {
        // insufficient_balance — предложить пополнение, а не сырую ошибку.
        setInsufficientId(t.id);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setTakeErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.agent_id) {
        router.push('/agents');
        return;
      }
      setTakeErr(paid ? 'rent_failed' : 'clone_failed');
    } catch (e) {
      setTakeErr(e instanceof Error ? e.message : 'take_failed');
    } finally {
      setTakingId(null);
    }
  }

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header aiag-fade-up">
          <span className="tma-eyebrow">Маркет</span>
          <h1 className="tma-title">Агенты</h1>
          <p className="tma-subtitle">
            Готовые агенты-персонажи. Используйте бесплатно или арендуйте у автора.
          </p>
        </header>

        {/* Сегменты: «Агенты» активен; глубже — для операторов (фаза 2), LOCKED. */}
        <div className="tma-segment" role="tablist" aria-label="Разделы маркета">
          <button
            type="button"
            role="tab"
            aria-selected
            className="tma-segment-btn is-active"
          >
            Агенты
          </button>
          {/* Локед-разделы (модели/скиллы/MCP/тузы/базы) свёрнуты в ОДИН тихий
              чип — фаза-A это маркет агентов, не витрина заблокированного. */}
          <span
            role="tab"
            aria-disabled
            className="tma-segment-btn is-locked"
            title={`Для операторов (фаза 2): ${LOCKED_SEGMENTS.join(' · ')}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden style={{ flexShrink: 0 }}>
              <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2" />
            </svg>
            Для операторов
          </span>
        </div>

        {/* Поиск + категории (визуальный клиентский фильтр). */}
        <div>
          <input
            type="search"
            className="tma-input"
            placeholder="Поиск агента"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Поиск агента"
          />
        </div>
        <div className="tma-segment" role="tablist" aria-label="Категории">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              className={`tma-segment-btn${category === c ? ' is-active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

        {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

        {/* Вне Telegram authed-fetch не запустится — честно скажем, а не пусто. */}
        {!templates && !fetchErr && !loading && error && (
          <section className="tma-card">
            <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
            <p className="tma-card-text">Маркет доступен только в Telegram Mini App.</p>
          </section>
        )}

        {/* Скелетоны на время загрузки. */}
        {!templates && !fetchErr && (loading || (!error && !!token)) && (
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

        {/* Честный пустой стейт. */}
        {templates && templates.length === 0 && (
          <section className="tma-card tma-empty">
            <span className="tma-empty-glyph">✦</span>
            <h2 className="tma-card-title">Каталог пока пуст</h2>
            <p className="tma-card-text">Скоро появятся официальные агенты.</p>
          </section>
        )}

        {/* Ничего не нашлось по фильтру (но каталог не пуст). */}
        {templates && templates.length > 0 && visible && visible.length === 0 && (
          <section className="tma-card tma-empty">
            <span className="tma-empty-glyph">✦</span>
            <h2 className="tma-card-title">Ничего не нашлось</h2>
            <p className="tma-card-text">Измените запрос или категорию.</p>
          </section>
        )}

        {visible && visible.length > 0 && (
          <section className="tma-agent-grid aiag-stagger">
            {visible.map((t) => {
              const char = characterFor(t.template_kind);
              const isTaking = takingId === t.id;
              return (
                <div key={t.id} className="cc-cell">
                  <CharCard
                    href={`/templates/${t.id}`}
                    hue={hueFor(t.id)}
                    name={t.name}
                    portraitImage={char?.image}
                    portraitVideo={char?.video}
                    modelBadge={t.model_slug}
                    role={t.description}
                    trait={t.trait ?? undefined}
                    author={t.author_username ? `@${t.author_username}` : 'официальный'}
                    stats={{
                      runs: String(t.clone_count),
                      rating: t.avg_rating ?? undefined,
                      price: priceStat(t.price_credits),
                    }}
                    demoStats={!t.clone_count && !t.avg_rating}
                    actionLabel={isTaking ? 'Берём…' : actionLabel(t.price_credits)}
                    onAction={() => take(t)}
                  />
                  {insufficientId === t.id && (
                    <div className="tma-card" style={{ padding: 12, marginTop: 8 }}>
                      <p className="tma-card-text">
                        Недостаточно кредитов для аренды. Пополните баланс и
                        попробуйте снова.
                      </p>
                      <Link href="/profile/topup" className="tma-btn tma-btn--ghost">
                        Пополнить баланс
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {takeErr && <div className="tma-error">Ошибка: {takeErr}</div>}
      </main>
      <BottomNav />
    </>
  );
}
