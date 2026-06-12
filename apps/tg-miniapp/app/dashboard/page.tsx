'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { AgentCard, hueFor } from '@/components/AgentCard';
import { characterFor } from '@/lib/characters';
import { fmtCredits } from '@/lib/credits';

// ─────────────────────────────────────────────────────────────────────────────
// Главный экран-хаб (/dashboard) — спека docs/specs/2026-06-11-design-audit-bench.md.
// Блоки: 1 баланс-хедер · 2 сетка 2×4 · 3 закреплённый агент · 4 «Мои агенты»
// · 5 лента «Шаблоны недели» · 6 баннер. Один амбер-primary: «Пополнить».
// ─────────────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  model_slug: string | null;
  budget_rub_monthly: string;
  created_at: string;
}

interface HubTemplate {
  id: string;
  name: string | null;
  description: string | null;
  model_slug: string | null;
  price_credits: string | null;
  clone_count: number;
  avg_rating: string | null;
  rating_count: number;
}

const LS_HIDE_BALANCE = 'aiag_hide_balance';
const LS_PINNED_AGENT = 'aiag_pinned_agent_id';
const LS_BANNER = 'aiag_hub_banner_publish';

// Outline-иконки 24×24 (тот же stroke-набор, что BottomNav — НЕ emoji).
const ICONS = {
  plus: 'M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z M12 8v8 M8 12h8',
  templates:
    'M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z M12 8l1.2 2.5 2.8.4-2 2 .5 2.8-2.5-1.4-2.5 1.4.5-2.8-2-2 2.8-.4L12 8z',
  layers: 'M12 2l9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 17l9 5 9-5',
  bolt: 'M13 2L3 14h7l-1 8 10-12h-7l1-8z',
  history: 'M12 21a9 9 0 110-18 9 9 0 010 18z M12 8v4l3 2',
  income: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  transfer: 'M12 15V3 M7 8l5-5 5 5 M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z M12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff:
    'M17.94 17.94A10.5 10.5 0 0112 19c-7 0-11-7-11-7a20 20 0 015.06-5.94 M9.9 4.5A10.9 10.9 0 0112 4c7 0 11 7 11 7a20 20 0 01-3.06 4.06 M1 1l22 22 M9.88 9.88a3 3 0 104.24 4.24',
} as const;

function HubIcon({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function priceMetric(price: string | null): string {
  if (price === null) return 'бесплатно';
  return `${fmtCredits(price)} кр`;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, token, loading, error, debug } = useAuth();

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const [balance, setBalance] = useState<string | null>(null);
  const [balanceErr, setBalanceErr] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);

  const [authorIncome, setAuthorIncome] = useState<string | null>(null);
  const [isAuthor, setIsAuthor] = useState(false);

  const [weekly, setWeekly] = useState<HubTemplate[] | null>(null);
  const [weeklyErr, setWeeklyErr] = useState(false);

  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [bannerHidden, setBannerHidden] = useState(true);
  const [sheet, setSheet] = useState<'more' | 'transfer' | null>(null);

  // localStorage только на клиенте.
  useEffect(() => {
    try {
      setHideBalance(localStorage.getItem(LS_HIDE_BALANCE) === '1');
      setPinnedId(localStorage.getItem(LS_PINNED_AGENT));
      setBannerHidden(localStorage.getItem(LS_BANNER) === '1');
    } catch {
      setBannerHidden(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/agents', { headers });
        if (cancelled) return;
        if (!res.ok) {
          setFetchErr(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setAgents(data.agents ?? []);
      } catch (e) {
        if (!cancelled) setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/wallet', { headers });
        if (cancelled) return;
        if (!res.ok) {
          setBalanceErr(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setBalance(data.balance_credits ?? '0');
      } catch {
        if (!cancelled) setBalanceErr(true);
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/me/author-income', { headers });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.templates) && data.templates.length > 0) {
          setIsAuthor(true);
          setAuthorIncome(data.month_income_credits ?? '0');
        }
      } catch {
        // тизер дохода: при ошибке строку просто не показываем
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/templates?sort=trending', { headers });
        if (cancelled) return;
        if (!res.ok) {
          setWeeklyErr(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setWeekly((data.templates ?? []).slice(0, 6));
      } catch {
        if (!cancelled) setWeeklyErr(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const pinned = useMemo(() => {
    if (!agents || agents.length === 0) return null;
    return agents.find((a) => a.id === pinnedId) ?? agents[0];
  }, [agents, pinnedId]);

  const toggleBalance = () => {
    const next = !hideBalance;
    setHideBalance(next);
    try {
      localStorage.setItem(LS_HIDE_BALANCE, next ? '1' : '0');
    } catch {}
  };

  const dismissBanner = () => {
    setBannerHidden(true);
    try {
      localStorage.setItem(LS_BANNER, '1');
    } catch {}
  };

  const onTransfer = () => {
    const list = agents ?? [];
    if (list.length === 0) {
      router.push('/agents/new');
    } else if (list.length === 1) {
      router.push(`/agents/${list[0].id}/offer`);
    } else {
      setSheet('transfer');
    }
  };

  const kanbanHref =
    agents && agents.length > 0 ? `/agents/${agents[0].id}/kanban` : '/agents/new';

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        {loading && (
          <>
            <section className="tma-card tma-hub-balance" aria-hidden>
              <div className="tma-skeleton tma-skeleton-line tma-skeleton-line--short" />
              <div className="tma-skeleton tma-hub-sum-skeleton" />
              <div className="tma-skeleton tma-skeleton-line" />
            </section>
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
          </>
        )}

        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка авторизации: ${error}`}
            </p>
            {debug && (
              <p className="tma-card-text tma-text-small tma-mono">
                диагностика: {debug}
              </p>
            )}
          </div>
        )}

        {user && !error && (
          <>
            {/* ── Блок 1: баланс-хедер ── */}
            <section className="tma-card tma-hub-balance aiag-fade-up">
              <span className="tma-eyebrow">Баланс</span>
              {balance === null && !balanceErr ? (
                <div className="tma-skeleton tma-hub-sum-skeleton" aria-hidden />
              ) : (
                <div className="tma-hub-balance-row">
                  <Link href="/profile" className="tma-hub-sum">
                    {balanceErr ? (
                      <span className="tma-hub-sum-unit">недоступен</span>
                    ) : hideBalance ? (
                      <>
                        ••••<span className="tma-hub-sum-unit">кр</span>
                      </>
                    ) : (
                      <>
                        {fmtCredits(balance)}
                        <span className="tma-hub-sum-unit">кр</span>
                      </>
                    )}
                  </Link>
                  <button
                    type="button"
                    className="tma-hub-eye"
                    onClick={toggleBalance}
                    aria-label={hideBalance ? 'Показать баланс' : 'Скрыть баланс'}
                  >
                    <HubIcon d={hideBalance ? ICONS.eyeOff : ICONS.eye} />
                  </button>
                </div>
              )}
              <Link href="/profile/topup" className="tma-btn tma-btn--primary tma-btn--block">
                Пополнить
              </Link>
              {isAuthor && authorIncome !== null && (
                <Link href="/profile/income" className="tma-hub-income">
                  Доход за месяц: +{fmtCredits(authorIncome)} кр →
                </Link>
              )}
            </section>

            {/* ── Блок 2: сетка функций 2×4 ── */}
            <nav className="tma-hub-grid" aria-label="Функции">
              <Link href="/agents/new" className="tma-hub-cell">
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.plus} /></span>
                <span className="tma-hub-cell-label">Создать</span>
              </Link>
              <Link href="/market" className="tma-hub-cell">
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.templates} /></span>
                <span className="tma-hub-cell-label">Шаблоны</span>
              </Link>
              <Link href="/market" className="tma-hub-cell">
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.layers} /></span>
                <span className="tma-hub-cell-label">Модели</span>
              </Link>
              <Link href="/wallet" className="tma-hub-cell">
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.history} /></span>
                <span className="tma-hub-cell-label">История</span>
              </Link>
              <Link href="/account" className="tma-hub-cell">
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.income} /></span>
                <span className="tma-hub-cell-label">Доход</span>
              </Link>
              <button type="button" className="tma-hub-cell" onClick={onTransfer}>
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.transfer} /></span>
                <span className="tma-hub-cell-label">Передать</span>
              </button>
              <button type="button" className="tma-hub-cell" onClick={() => setSheet('more')}>
                <span className="tma-hub-cell-icon"><HubIcon d={ICONS.more} /></span>
                <span className="tma-hub-cell-label">Ещё</span>
              </button>
            </nav>

            {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

            {/* ── Блок 3: закреплённый агент ── */}
            {pinned && (
              <Link href={`/agents/${pinned.id}`} className="tma-hub-pinned">
                <span
                  className="tma-hub-pinned-avatar"
                  style={{
                    background: `linear-gradient(155deg, oklch(0.34 0.09 ${hueFor(pinned.id)}), oklch(0.17 0.045 ${hueFor(pinned.id)}))`,
                    color: `oklch(0.93 0.11 ${hueFor(pinned.id)})`,
                    overflow: 'hidden',
                  }}
                >
                  {characterFor(pinned.template_kind)?.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={characterFor(pinned.template_kind)!.image}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    (pinned.name.trim()[0] ?? '?').toUpperCase()
                  )}
                </span>
                <span className="tma-hub-pinned-body">
                  <span className="tma-hub-pinned-name">{pinned.name}</span>
                  {pinned.model_slug && (
                    <span className="tma-hub-pinned-model">{pinned.model_slug}</span>
                  )}
                </span>
                <span className="tma-hub-pinned-chat">Чат →</span>
              </Link>
            )}

            {/* ── Блок 4: мои агенты ── */}
            <section className="tma-hub-section">
              <div className="tma-section-head">
                <h2 className="tma-hub-h2">Мои агенты</h2>
                {agents && agents.length > 0 && (
                  <span className="tma-hub-count">{agents.length}</span>
                )}
              </div>

              {agents === null && !fetchErr && (
                <div className="tma-agent-grid" aria-hidden>
                  {[0, 1].map((i) => (
                    <div key={i} className="tma-agent-card tma-agent-card--skeleton">
                      <div className="tma-agent-portrait tma-skeleton" />
                      <div className="tma-agent-body">
                        <div className="tma-skeleton tma-skeleton-line" />
                        <div className="tma-skeleton tma-skeleton-line tma-skeleton-line--short" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {agents && agents.length === 0 && (
                <div className="tma-hub-paths">
                  <Link href="/templates" className="tma-hub-path">
                    <span className="tma-hub-path-body">
                      <span className="tma-hub-path-label">Из шаблона</span>
                      <span className="tma-hub-path-sub">
                        Готовый агент в пару тапов
                      </span>
                    </span>
                  </Link>
                  <Link href="/agents/new" className="tma-hub-path">
                    <span className="tma-hub-path-body">
                      <span className="tma-hub-path-label">Подключить свой Hermes</span>
                      <span className="tma-hub-path-sub">
                        Свой провайдер, комиссия 0%
                      </span>
                    </span>
                  </Link>
                  <Link href="/agents/new" className="tma-hub-path">
                    <span className="tma-hub-path-body">
                      <span className="tma-hub-path-label">С нуля</span>
                      <span className="tma-hub-path-sub">
                        Персона, модель, инструменты
                      </span>
                    </span>
                  </Link>
                </div>
              )}

              {agents && agents.length > 0 && (
                <div className="tma-agent-grid aiag-stagger">
                  {agents.filter((a) => a.id !== pinned?.id).map((a) => (
                    <AgentCard
                      key={a.id}
                      href={`/agents/${a.id}`}
                      hue={hueFor(a.id)}
                      name={a.name}
                      portraitImage={characterFor(a.template_kind)?.image}
                      portraitVideo={characterFor(a.template_kind)?.video}
                      role={a.description}
                      model={a.model_slug}
                      metricLabel={`${Number(a.budget_rub_monthly).toFixed(0)} кр/мес`}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ── Блок 5: шаблоны недели ── скрыт целиком при 0 шаблонов (#4) ── */}
            {!(weekly && weekly.length === 0) && (
              <section className="tma-hub-section">
                <div className="tma-section-head">
                  <h2 className="tma-hub-h2">Шаблоны недели</h2>
                  <Link href="/templates" className="tma-hub-link">
                    Все →
                  </Link>
                </div>

                {weekly === null && !weeklyErr && (
                  <div className="tma-hub-rail" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="tma-hub-rail-item">
                        <div className="tma-agent-card tma-agent-card--skeleton">
                          <div className="tma-agent-portrait tma-skeleton" />
                          <div className="tma-agent-body">
                            <div className="tma-skeleton tma-skeleton-line" />
                            <div className="tma-skeleton tma-skeleton-line tma-skeleton-line--short" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {weeklyErr && (
                  <p className="tma-card-text">Не удалось загрузить витрину.</p>
                )}

                {weekly && weekly.length > 0 && (
                  <div className="tma-hub-rail">
                    {weekly.map((t, idx) => (
                      <div key={t.id} className="tma-hub-rail-item">
                        <AgentCard
                          href={`/templates/${t.id}`}
                          hue={hueFor(t.id)}
                          name={t.name}
                          role={t.description}
                          model={t.model_slug}
                          metricLabel={priceMetric(t.price_credits)}
                          metricAccent={t.price_credits !== null}
                          rating={
                            t.avg_rating !== null
                              ? { value: t.avg_rating, count: t.rating_count }
                              : null
                          }
                          countLabel={
                            t.avg_rating === null ? `${t.clone_count} клонов` : null
                          }
                          featured={idx === 0}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── Блок 6: баннер «опубликуй» — только авторам (#23) ── */}
            {isAuthor && !bannerHidden && (
              <div className="tma-hub-banner">
                <span className="tma-hub-banner-icon">
                  <HubIcon d={ICONS.income} />
                </span>
                <Link href="/profile/income" className="tma-hub-banner-text">
                  Опубликуйте шаблон и назначьте ренту. Вся сумма достаётся вам.
                </Link>
                <button
                  type="button"
                  className="tma-hub-banner-close"
                  onClick={dismissBanner}
                  aria-label="Скрыть баннер"
                >
                  ✕
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Bottom-sheet «Ещё» ── */}
      {sheet === 'more' && (
        <div className="tma-sheet-scrim" onClick={() => setSheet(null)}>
          <div
            className="tma-sheet"
            role="dialog"
            aria-label="Ещё"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tma-sheet-handle" />
            <span className="tma-sheet-section">Агенты</span>
            <Link href="/schedules" className="tma-sheet-row" onClick={() => setSheet(null)}>
              <span>Расписания</span>
              <span className="tma-pill tma-pill--ok">● live</span>
            </Link>
            <Link href={kanbanHref} className="tma-sheet-row" onClick={() => setSheet(null)}>
              <span>Канбан</span>
              <span className="tma-pill tma-pill--ok">● live</span>
            </Link>
            <span className="tma-sheet-section">Подключения</span>
            <Link href="/agents/new" className="tma-sheet-row" onClick={() => setSheet(null)}>
              <span>Создать агента</span>
              <span className="tma-hub-link">→</span>
            </Link>
            <span className="tma-sheet-section">R&D</span>
            <div className="tma-sheet-row tma-sheet-row--static">
              <span>Managed Hermes</span>
              <span className="tma-pill tma-pill--muted">◷ R&D</span>
            </div>
            <div className="tma-sheet-row tma-sheet-row--static">
              <span>Маркет тулов</span>
              <span className="tma-pill tma-pill--muted">◷ скоро</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom-sheet выбора агента для передачи ── */}
      {sheet === 'transfer' && agents && (
        <div className="tma-sheet-scrim" onClick={() => setSheet(null)}>
          <div
            className="tma-sheet"
            role="dialog"
            aria-label="Передать агента"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tma-sheet-handle" />
            <h3 className="tma-sheet-title">Какого агента передать?</h3>
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.id}/offer`}
                className="tma-sheet-row"
                onClick={() => setSheet(null)}
              >
                <span className="tma-sheet-row-main">
                  <span
                    className="tma-hub-pinned-avatar tma-hub-pinned-avatar--sm"
                    style={{
                      background: `linear-gradient(155deg, oklch(0.34 0.09 ${hueFor(a.id)}), oklch(0.17 0.045 ${hueFor(a.id)}))`,
                      color: `oklch(0.93 0.11 ${hueFor(a.id)})`,
                    }}
                  >
                    {(a.name.trim()[0] ?? '?').toUpperCase()}
                  </span>
                  <span>{a.name}</span>
                </span>
                <span className="tma-hub-link">→</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <BottomNav />
    </>
  );
}
