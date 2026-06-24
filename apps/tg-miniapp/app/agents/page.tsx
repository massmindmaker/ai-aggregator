'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { CharCard } from '@/components/CharCard';
import { hueFor } from '@/components/AgentCard';
import { fmtCredits } from '@/lib/credits';
import { characterFor } from '@/lib/characters';

// ─────────────────────────────────────────────────────────────────────────────
// /agents — экран «Агенты», 3 сегмента (IA-синтез §5.A):
//   [Нанять] [Мои] [Создать]  — через ?tab=…
//   • Мои (дефолт)  = мессенджер-инбокс агентов (строки-чаты, live-дот, превью).
//   • Нанять        = CharCard-грид готовых шаблонов (free-клон / аренда автору) —
//                     переиспользует GET /tg/api/tma/templates + take() как /market.
//   • Создать       = «Из шаблона» (рейл→/templates/[id]) + «С нуля» (→/agents/new)
//                     + «AI-builder» (честная ◷ R&D плашка).
// Для ПУСТОГО инбокса дефолтная вкладка = «Нанять» (нечего показывать в «Мои»).
// Старый хаб переехал в /dashboard. Тап по строке инбокса → /agents/[id].
// ─────────────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  model_slug: string | null;
  budget_rub_monthly: string;
  created_at: string;
  last_output: string | null;
  last_at: string | null;
  last_status: string | null;
}

// Ровно поля GET /tg/api/tma/templates (см. templates/route.ts), как в /market.
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

// ── Сегменты экрана. value = ?tab=… ──────────────────────────────────────────
const TABS = [
  { id: 'hire', label: 'Нанять' },
  { id: 'mine', label: 'Мои' },
  { id: 'create', label: 'Создать' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = new Set(TABS.map((t) => t.id));

// Валидный TabId из ?tab=… или null (если не задан/некорректен — решим по инбоксу).
function tabFromSearch(): TabId | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('tab');
  return raw && TAB_IDS.has(raw as TabId) ? (raw as TabId) : null;
}

const PREVIEW_MAX = 60;

function previewLine(a: Agent): string {
  if (!a.last_output) return 'ещё не запускался';
  const flat = a.last_output.replace(/\s+/g, ' ').trim();
  if (!flat) return 'ещё не запускался';
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

// Цена для строки статов CharCard: центы → «N,NN кр/мес» или «бесплатно».
// Аренда = месячная подписка → цена всегда «кр/мес» (честно: списывается ежемесячно).
function priceStat(price: string | null): string {
  return price !== null ? `${fmtCredits(price)} кр/мес` : 'бесплатно';
}

// Подпись amber-кнопки: платный → ПОДПИСКА с месячной ценой, бесплатный → использовать.
function actionLabel(price: string | null): string {
  return price !== null ? `Подписаться · ${fmtCredits(price)} кр/мес` : 'Использовать';
}

export default function AgentsPage() {
  const router = useRouter();
  const { user, token, loading, error, debug } = useAuth();

  // Активная вкладка. null = ещё не выбрана (ждём инбокс, чтобы решить дефолт).
  const [tab, setTabState] = useState<TabId | null>(null);
  useEffect(() => {
    setTabState(tabFromSearch()); // из URL, если задан явно
  }, []);

  function selectTab(next: TabId) {
    if (next === tab) return;
    setTabState(next);
    const qs = next === 'mine' ? '/agents' : `/agents?tab=${next}`;
    router.replace(qs, { scroll: false });
  }

  // Creator-membership gate: «Создать с нуля» только для держателей членского NFT.
  // null = загрузка; false → честное «стань создателем» вместо опций создания.
  const [isMember, setIsMember] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch('/tg/api/tma/membership', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { is_member: false }))
      .then((j) => setIsMember(!!j.is_member))
      .catch(() => setIsMember(false));
  }, [token]);

  // ── Инбокс «Мои» ───────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<Agent[] | null>(null);
  // Нанятые агенты (active agent_sessions, не владелец) — отдельная секция.
  const [hiredAgents, setHiredAgents] = useState<Agent[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/agents', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setFetchErr(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setAgents(data.agents ?? []);
          setHiredAgents(data.hired ?? []);
        }
      } catch (e) {
        if (!cancelled) setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Дефолт вкладки: если URL не задал tab — пустой инбокс (нет ни своих, ни
  // нанятых) → «Нанять», иначе «Мои». Применяем один раз после загрузки инбокса.
  useEffect(() => {
    if (tab !== null || agents === null) return;
    const empty = agents.length === 0 && hiredAgents.length === 0;
    setTabState(empty ? 'hire' : 'mine');
  }, [tab, agents, hiredAgents]);

  // ── Шаблоны (для «Нанять» и рейла «Создать») ───────────────────────────────
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [tplErr, setTplErr] = useState<string | null>(null);
  const needTemplates = tab === 'hire' || tab === 'create';

  useEffect(() => {
    if (!token || !needTemplates || templates !== null) return;
    let cancelled = false;
    setTplErr(null);
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/templates?sort=trending', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setTplErr(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setTemplates(data.templates ?? []);
      } catch (e) {
        if (!cancelled) setTplErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, needTemplates, templates]);

  // ── «Нанять»: поиск + take() (free clone / paid rent) — mirror /market ──────
  const [search, setSearch] = useState('');
  const [takingId, setTakingId] = useState<string | null>(null);
  const [takeErr, setTakeErr] = useState<string | null>(null);
  const [insufficientId, setInsufficientId] = useState<string | null>(null);

  const visible = useMemo(() => {
    if (!templates) return null;
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const hay = `${t.name ?? ''} ${t.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [templates, search]);

  // take(): бесплатный → clone, платный → rent (как /templates/[id] и /market).
  // На успех — обновляем инбокс и переключаем на «Мои». 402 → инлайн-подсказка.
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
        // Успех: переключаемся на «Мои» и мягко перезагружаем инбокс
        // (токен не меняется, поэтому грузим список вручную, а не через эффект).
        router.replace('/agents', { scroll: false });
        setTabState('mine');
        fetch('/tg/api/tma/agents', {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d) return;
            setAgents(d.agents ?? []);
            setHiredAgents(d.hired ?? []);
          })
          .catch(() => {});
        return;
      }
      setTakeErr(paid ? 'rent_failed' : 'clone_failed');
    } catch (e) {
      setTakeErr(e instanceof Error ? e.message : 'take_failed');
    } finally {
      setTakingId(null);
    }
  }

  const inboxLoading = agents === null && !fetchErr;

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-page-head aiag-fade-up">
          <span className="tma-eyebrow">Агенты</span>
          <h1 className="tma-h1">Агенты</h1>
        </header>

        {/* 3 сегмента (IA-синтез §5.A). На всю ширину. */}
        <div
          className="tma-segment tma-segment--fit"
          role="tablist"
          aria-label="Разделы агентов"
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

        {/* Загрузка авторизации */}
        {loading && (
          <section aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="inbox-row">
                <div className="inbox-avatar aiag-skeleton" />
                <div className="inbox-main">
                  <div className="aiag-skeleton tma-skeleton-line" />
                  <div className="aiag-skeleton tma-skeleton-line tma-skeleton-line--short" />
                </div>
              </div>
            ))}
          </section>
        )}

        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка авторизации: ${error}`}
            </p>
            {debug && (
              <p className="tma-card-text tma-text-small tma-mono">диагностика: {debug}</p>
            )}
          </div>
        )}

        {user && !error && (
          <>
            {/* ════════════ МОИ — инбокс ════════════ */}
            {tab === 'mine' && (
              <>
                {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

                {inboxLoading && (
                  <section aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="inbox-row">
                        <div className="inbox-avatar aiag-skeleton" />
                        <div className="inbox-main">
                          <div className="aiag-skeleton tma-skeleton-line" />
                          <div className="aiag-skeleton tma-skeleton-line tma-skeleton-line--short" />
                        </div>
                      </div>
                    ))}
                  </section>
                )}

                {agents && agents.length === 0 && hiredAgents.length === 0 && (
                  <div className="tma-card">
                    <p className="tma-card-text">У тебя пока нет агентов</p>
                    <button
                      type="button"
                      className="tma-btn tma-btn--primary tma-btn--block"
                      onClick={() => selectTab('hire')}
                    >
                      Нанять агента →
                    </button>
                    <Link href="/agents/new" className="tma-btn tma-btn--ghost tma-btn--block">
                      Создать с нуля
                    </Link>
                  </div>
                )}

                {agents && agents.length > 0 && (
                  <section className="aiag-stagger">
                    {agents.map((a) => {
                      const hue = hueFor(a.id);
                      const char = characterFor(a.template_kind);
                      const live =
                        a.last_status === 'running' || a.last_status === 'pending';
                      return (
                        <Link key={a.id} href={`/agents/${a.id}`} className="inbox-row">
                          <span
                            className="inbox-avatar"
                            style={{
                              background: `linear-gradient(155deg, oklch(0.34 0.09 ${hue}), oklch(0.17 0.045 ${hue}))`,
                              color: `oklch(0.93 0.11 ${hue})`,
                            }}
                          >
                            {char?.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={char.image}
                                alt=""
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              (a.name.trim()[0] ?? '?').toUpperCase()
                            )}
                            {live && (
                              <span className="inbox-live aiag-pulse-dot" aria-hidden />
                            )}
                          </span>
                          <span className="inbox-main">
                            <span className="inbox-name-row">
                              <span className="inbox-name">{a.name}</span>
                              {a.last_at && (
                                <span className="inbox-time">{fmtTime(a.last_at)}</span>
                              )}
                            </span>
                            <span className="inbox-preview">{previewLine(a)}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </section>
                )}

                {/* ── Нанятые — чужие агенты с активной сессией найма ── */}
                {hiredAgents.length > 0 && (
                  <section className="tma-hub-section">
                    <div className="tma-section-head">
                      <h2 className="tma-hub-h2">Нанятые</h2>
                      <span className="tma-pill tma-pill--ok">нанят</span>
                    </div>
                    <div className="aiag-stagger">
                      {hiredAgents.map((a) => {
                        const hue = hueFor(a.id);
                        const char = characterFor(a.template_kind);
                        const live = a.last_status === 'running' || a.last_status === 'pending';
                        return (
                          <Link key={a.id} href={`/agents/${a.id}`} className="inbox-row">
                            <span
                              className="inbox-avatar"
                              style={{
                                background: `linear-gradient(155deg, oklch(0.34 0.09 ${hue}), oklch(0.17 0.045 ${hue}))`,
                                color: `oklch(0.93 0.11 ${hue})`,
                              }}
                            >
                              {char?.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={char.image}
                                  alt=""
                                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                />
                              ) : (
                                (a.name.trim()[0] ?? '?').toUpperCase()
                              )}
                              {live && <span className="inbox-live aiag-pulse-dot" aria-hidden />}
                            </span>
                            <span className="inbox-main">
                              <span className="inbox-name-row">
                                <span className="inbox-name">{a.name}</span>
                                {a.last_at && <span className="inbox-time">{fmtTime(a.last_at)}</span>}
                              </span>
                              <span className="inbox-preview">{previewLine(a)}</span>
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* ── Группы агентов — честная заглушка «скоро» ── */}
                <section className="tma-hub-section">
                  <div className="tma-card">
                    <div className="tma-section-head">
                      <h2 className="tma-hub-h2">Группы агентов</h2>
                      <span className="tma-pill tma-pill--muted">◷ скоро</span>
                    </div>
                    <p className="tma-card-text tma-text-small">
                      Общая память и задания для группы агентов появятся позже.
                    </p>
                  </div>
                </section>
              </>
            )}

            {/* ════════════ НАНЯТЬ — CharCard-грид шаблонов ════════════ */}
            {tab === 'hire' && (
              <>
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

                {tplErr && <div className="tma-error">Ошибка: {tplErr}</div>}

                {/* Скелетоны на время загрузки шаблонов. */}
                {templates === null && !tplErr && (
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
                    <h2 className="tma-card-title">Каталог пока пуст</h2>
                    <p className="tma-card-text">Скоро появятся официальные агенты.</p>
                  </section>
                )}

                {templates && templates.length > 0 && visible && visible.length === 0 && (
                  <section className="tma-card tma-empty">
                    <span className="tma-empty-glyph">✦</span>
                    <h2 className="tma-card-title">Ничего не нашлось</h2>
                    <p className="tma-card-text">Измените запрос.</p>
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
                            author={
                              t.author_username ? `@${t.author_username}` : 'официальный'
                            }
                            stats={{
                              runs: String(t.clone_count),
                              rating: t.avg_rating ?? undefined,
                              price: priceStat(t.price_credits),
                            }}
                            demoStats={!t.clone_count && !t.avg_rating}
                            actionLabel={
                              isTaking ? 'Берём…' : actionLabel(t.price_credits)
                            }
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

            {/* ════════════ СОЗДАТЬ ════════════ */}
            {tab === 'create' && (
              <>
                {/* ── Из шаблона: горизонтальный рейл → /templates/[id] ── */}
                <section className="tma-hub-section">
                  <div className="tma-section-head">
                    <h2 className="tma-hub-h2">Из шаблона</h2>
                    <Link href="/agents?tab=hire" className="tma-hub-link">
                      Все →
                    </Link>
                  </div>
                  <p className="tma-card-text tma-text-small">
                    Готовый чертёж: клонируешь спек, ключи и память — твои с нуля.
                  </p>

                  {tplErr && <div className="tma-error">Ошибка: {tplErr}</div>}

                  {templates === null && !tplErr && (
                    <div className="tma-hub-rail" aria-hidden>
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="tma-hub-rail-item">
                          <div className="tma-agent-card tma-agent-card--skeleton">
                            <div className="tma-agent-portrait tma-skeleton" />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {templates && templates.length === 0 && (
                    <p className="tma-card-text tma-text-small">Шаблонов пока нет.</p>
                  )}

                  {templates && templates.length > 0 && (
                    <div className="tma-hub-rail">
                      {templates.slice(0, 8).map((t) => {
                        const char = characterFor(t.template_kind);
                        return (
                          <div key={t.id} className="tma-hub-rail-item">
                            <CharCard
                              href={`/templates/${t.id}`}
                              hue={hueFor(t.id)}
                              name={t.name}
                              portraitImage={char?.image}
                              portraitVideo={char?.video}
                              modelBadge={t.model_slug}
                              role={t.description}
                              stats={{ price: priceStat(t.price_credits) }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* ── Гейт создателя: «С нуля» и AI-builder — только для держателей
                    членского NFT. Не-членам показываем честное «стань создателем». ── */}
                {isMember === false ? (
                  <section className="tma-hub-section">
                    <div className="tma-card">
                      <div className="tma-section-head">
                        <h2 className="tma-hub-h2">Стань создателем</h2>
                      </div>
                      <p className="tma-card-text tma-text-small">
                        Создание агентов с нуля доступно держателям членского NFT.
                        Без него можно нанимать и клонировать готовых агентов из каталога.
                      </p>
                      <button
                        type="button"
                        className="tma-btn tma-btn--primary tma-btn--block"
                        onClick={() => selectTab('hire')}
                      >
                        Нанять готового →
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    {/* ── С нуля ── */}
                    <section className="tma-hub-section">
                      <div className="tma-card">
                        <div className="tma-section-head">
                          <h2 className="tma-hub-h2">С нуля</h2>
                        </div>
                        <p className="tma-card-text tma-text-small">
                          Собери агента по шагам: личность, модель, инструменты и бюджет.
                        </p>
                        <Link
                          href="/agents/new"
                          className="tma-btn tma-btn--primary tma-btn--block"
                        >
                          Создать с нуля →
                        </Link>
                      </div>
                    </section>

                    {/* ── AI-builder — честная R&D плашка ── */}
                    <section className="tma-hub-section">
                      <div className="tma-card">
                        <div className="tma-section-head">
                          <h2 className="tma-hub-h2">AI-builder</h2>
                          <span className="tma-pill tma-pill--muted">◷ R&D</span>
                        </div>
                        <p className="tma-card-text tma-text-small">
                          Опиши задачу словами — ИИ соберёт спецификацию агента за тебя.
                          В разработке.
                        </p>
                      </div>
                    </section>
                  </>
                )}
              </>
            )}
          </>
        )}
      </main>

      <BottomNav />
    </>
  );
}
