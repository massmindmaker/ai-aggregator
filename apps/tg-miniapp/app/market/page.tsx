'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /market — «Маркет»: 5 настоящих категоризированных разделов (IA-синтез §5.B).
// Горизонтальный сегмент через searchParams.tab:
//   [Агенты] [Скиллы] [MCP] [Тузы] [Базы знаний]
//   • Агенты (дефолт) = CharCard-грид шаблонов (использовать=free-клон / арендовать).
//   • Скиллы / Тузы    = листинг встроенных тулов воркера (AVAILABLE_TOOLS).
//   • MCP              = листинг проверенных MCP-пресетов (MCP_PRESETS).
//   • Базы знаний      = честная плашка «◷ фаза 3» + описание концепции.
// Данные скиллов/MCP/тузов УЖЕ есть в коде (app/agents/new + app/agents/[id]);
// здесь — только листинг + честный статус (live/скоро). Не выдумываем функции.
//
// Данные агентов: GET /tg/api/tma/templates?sort=trending (Bearer, как в /templates).
// Карточка: src/components/CharCard.tsx (готовая, не трогаем). hueFor — AgentCard.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { CharCard } from '@/components/CharCard';
import { hueFor } from '@/components/AgentCard';
import { fmtCredits } from '@/lib/credits';
import { characterFor } from '@/lib/characters';

// ── Разделы маркета (вкладки). value = ?tab=… ──────────────────────────────────
const TABS = [
  { id: 'agents', label: 'Агенты' },
  { id: 'skills', label: 'Скиллы' },
  { id: 'mcp', label: 'MCP' },
  { id: 'tools', label: 'Тузы' },
  { id: 'knowledge', label: 'Базы знаний' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = new Set(TABS.map((t) => t.id));

// Встроенные инструменты воркера (apps/agent-worker/src/tools.ts).
// Тот же набор, что зашит в app/agents/new + app/agents/[id]: это display-данные,
// не money-path. status: 'live' = работает в воркере сегодня; 'soon' = заявлено.
const WORKER_TOOLS: {
  id: string;
  label: string;
  hint: string;
  example: string;
  status: 'live' | 'soon';
}[] = [
  {
    id: 'web_search',
    label: 'Веб-поиск',
    hint: 'Поиск актуальной информации в интернете',
    example: '«какой курс TON сегодня?»',
    status: 'live',
  },
  {
    id: 'calc',
    label: 'Калькулятор',
    hint: 'Точные арифметические вычисления',
    example: '«посчитай 17% от 248 900»',
    status: 'live',
  },
  {
    id: 'image_gen',
    label: 'Генерация картинок',
    hint: 'Картинка по текстовому описанию',
    example: '«нарисуй логотип-чайку в минимализме»',
    status: 'live',
  },
  {
    id: 'memory',
    label: 'Память',
    hint: 'Запоминает факты между запусками',
    example: '«запомни: мой проект называется AIAG»',
    status: 'live',
  },
];

// Проверенные MCP-пресеты (зеркало MCP_PRESETS из app/agents/[id]).
const MCP_PRESETS: { label: string; hint: string }[] = [
  { label: 'Notion', hint: 'Страницы и базы данных Notion как контекст агента' },
  { label: 'GitHub', hint: 'Репозитории, issues и PR через GitHub MCP' },
  { label: 'Linear', hint: 'Задачи и проекты Linear' },
  { label: 'Sentry', hint: 'Ошибки и трейсы из Sentry' },
];

// Хелпер: вернуть валидный TabId из строки запроса (или дефолт 'agents').
function tabFromSearch(): TabId {
  if (typeof window === 'undefined') return 'agents';
  const raw = new URLSearchParams(window.location.search).get('tab');
  return raw && TAB_IDS.has(raw as TabId) ? (raw as TabId) : 'agents';
}

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

  // Активная вкладка. Инициализируем из ?tab=…; синхроним URL без перезагрузки.
  // (useState + window вместо useSearchParams — без Suspense-обёртки в Next 14.)
  const [tab, setTab] = useState<TabId>('agents');
  useEffect(() => {
    setTab(tabFromSearch());
  }, []);
  function selectTab(next: TabId) {
    if (next === tab) return;
    setTab(next);
    const qs = next === 'agents' ? '/market' : `/market?tab=${next}`;
    router.replace(qs, { scroll: false });
  }

  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>('Все');

  // take() в полёте: какой шаблон сейчас берём + куда показать ошибку/недостаток.
  const [takingId, setTakingId] = useState<string | null>(null);
  const [takeErr, setTakeErr] = useState<string | null>(null);
  const [insufficientId, setInsufficientId] = useState<string | null>(null);

  useEffect(() => {
    if (!token || tab !== 'agents') return;
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
  }, [token, tab]);

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
          <h1 className="tma-title">Каталог</h1>
          <p className="tma-subtitle">
            Агенты, скиллы, MCP-серверы, инструменты и базы знаний — всё, из чего
            собирается агент.
          </p>
        </header>

        {/* 5 настоящих разделов (IA-синтез §5.B). На всю ширину, прокрутка края. */}
        <div
          className="tma-segment tma-segment--fit"
          role="tablist"
          aria-label="Разделы маркета"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tma-segment-btn${tab === t.id ? ' is-active' : ''}`}
              onClick={() => selectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Раздел: АГЕНТЫ — CharCard-грид шаблонов (как было) ───────────────── */}
        {tab === 'agents' && (
          <>
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
                <p className="tma-card-text">
                  Маркет доступен только в Telegram Mini App.
                </p>
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
          </>
        )}

        {/* ── Раздел: СКИЛЛЫ — листинг встроенных тулов как «скиллов» ──────────── */}
        {tab === 'skills' && (
          <section className="tma-mkt-rows aiag-stagger" aria-label="Скиллы">
            {WORKER_TOOLS.map((t) => (
              <div key={t.id} className="tma-mkt-row">
                <span className="tma-mkt-row-icon" aria-hidden>
                  {ICONS[t.id]}
                </span>
                <div className="tma-mkt-row-body">
                  <div className="tma-mkt-row-head">
                    <span className="tma-mkt-row-name">{t.label}</span>
                    {t.status === 'live' ? (
                      <span className="tma-pill tma-pill--ok">
                        <Dot /> live
                      </span>
                    ) : (
                      <span className="tma-pill tma-pill--muted">◷ скоро</span>
                    )}
                  </div>
                  <p className="tma-mkt-row-hint">{t.hint}</p>
                </div>
              </div>
            ))}
            <p className="tma-mkt-note">◷ свои скиллы — фаза 2</p>
          </section>
        )}

        {/* ── Раздел: MCP — листинг проверенных MCP-пресетов ──────────────────── */}
        {tab === 'mcp' && (
          <section className="tma-mkt-rows aiag-stagger" aria-label="MCP-серверы">
            {MCP_PRESETS.map((p) => (
              <div key={p.label} className="tma-mkt-row">
                <span className="tma-mkt-row-icon" aria-hidden>
                  {/* плаг-иконка — единый глиф для всех MCP-серверов */}
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <div className="tma-mkt-row-body">
                  <div className="tma-mkt-row-head">
                    <span className="tma-mkt-row-name">{p.label}</span>
                  </div>
                  <p className="tma-mkt-row-hint">{p.hint}</p>
                </div>
                <Link
                  href="/agents/new"
                  className="tma-btn tma-btn--ghost tma-mkt-row-cta"
                >
                  Подключить
                </Link>
              </div>
            ))}
            <Link href="/agents/new" className="tma-mkt-note tma-mkt-note--link">
              + Свой MCP-сервер
            </Link>
          </section>
        )}

        {/* ── Раздел: ТУЗЫ — сетка инструментов карточками ────────────────────── */}
        {tab === 'tools' && (
          <>
            <section className="tma-agent-grid aiag-stagger" aria-label="Инструменты">
              {WORKER_TOOLS.map((t) => (
                <div key={t.id} className="tma-card tma-mkt-tool">
                  <div className="tma-mkt-row-head">
                    <span className="tma-mkt-row-icon" aria-hidden>
                      {ICONS[t.id]}
                    </span>
                    {t.status === 'live' ? (
                      <span className="tma-pill tma-pill--ok">
                        <Dot /> live
                      </span>
                    ) : (
                      <span className="tma-pill tma-pill--muted">◷ скоро</span>
                    )}
                  </div>
                  <h3 className="tma-card-title">{t.label}</h3>
                  <p className="tma-card-text">{t.hint}</p>
                  <p className="tma-mono tma-mt-1">{t.example}</p>
                </div>
              ))}
            </section>
            <p className="tma-mkt-note">
              ◷ платные инструменты (Firecrawl, x402-брокер) — позже
            </p>
          </>
        )}

        {/* ── Раздел: БАЗЫ ЗНАНИЙ — честная плашка (фаза 3) ───────────────────── */}
        {tab === 'knowledge' && (
          <section className="tma-card tma-empty" aria-label="Базы знаний">
            <span className="tma-empty-glyph">◷</span>
            <h2 className="tma-card-title">Базы знаний — фаза 3</h2>
            <p className="tma-card-text">
              Подключайте свои документы и ссылки как долговременный контекст агента:
              агент будет отвечать, опираясь на ваши материалы (RAG). Раздел появится
              в третьей фазе — пока агент использует встроенную «Память».
            </p>
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}

// Минималистичные иконки тулов (currentColor, наследуют цвет ряда/карточки).
const ICONS: Record<string, ReactNode> = {
  web_search: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  calc: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 7h8M8 12h.01M12 12h.01M16 12v5M8 16h.01M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  image_gen: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="2" />
      <path d="m4 18 5-5 4 4 3-3 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  memory: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

// Live-точка для status-pill (иконка + слово, не цвет в одиночку).
function Dot() {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: 'currentColor',
        display: 'inline-block',
      }}
    />
  );
}
