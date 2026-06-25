'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { hueFor } from '@/components/AgentCard';

interface Template {
  id: string;
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
  suggested_skills: unknown;
  price_credits: string | null;
  visibility: string;
  fork_parent_id: string | null;
  parent_name: string | null;
  avg_rating: string | null;
  rating_count: number;
  clone_count: number;
  author_tg_user_id: string;
  created_at: string;
}

// P0-1: хранение = центы, дисплей = кр (÷100) — как кошелёк/RunTrace.
function priceLabel(price: string | null): string {
  if (price === null) return 'бесплатно';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'бесплатно';
  return `${(n / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} кр`;
}

// Russian plural for «оценка» (1 оценка / 2 оценки / 5 оценок).
function ratingWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'оценка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'оценки';
  return 'оценок';
}

export default function TemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { token, loading, error } = useAuth();

  const [template, setTemplate] = useState<Template | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  // Slice 2: paid author-rent. `renting` = request in flight; `insufficient` =
  // the rent route answered 402 (top up first).
  const [renting, setRenting] = useState(false);
  const [rentErr, setRentErr] = useState<string | null>(null);
  const [insufficient, setInsufficient] = useState(false);

  // Rating widget. `ratingStars` = the 1..5 the user picked; `ratingComment`
  // optional. `rateState` drives the honest UI: 'idle' | 'sending' | 'done'
  // (thanks) | 'ineligible' (403 not_eligible → «оцените после клонирования»).
  const [ratingStars, setRatingStars] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [rateState, setRateState] = useState<'idle' | 'sending' | 'done' | 'ineligible'>('idle');
  const [rateErr, setRateErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id || !token) return;
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) {
        setFetchErr('not_found');
        return;
      }
      if (!res.ok) {
        setFetchErr(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setTemplate(data.template);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
    }
  }, [id, token]);

  useEffect(() => {
    load();
  }, [load]);

  // Нативная BackButton Telegram → возврат к фактическому источнику (router.back()).
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    tg?.BackButton?.show?.();
    const h = () => router.back();
    tg?.BackButton?.onClick?.(h);
    return () => {
      tg?.BackButton?.offClick?.(h);
      tg?.BackButton?.hide?.();
    };
  }, [router]);

  const isPaid = template ? template.price_credits !== null : false;
  const priceNum = template && template.price_credits !== null ? Number(template.price_credits) : 0;
  const cloneDisabled = cloning;

  async function handleClone() {
    if (!token || !id) return;
    setCloning(true);
    setCloneErr(null);
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCloneErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.agent_id) {
        router.push(`/agents/${data.agent_id}`);
        return;
      }
      setCloneErr('clone_failed');
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : 'clone_failed');
    } finally {
      setCloning(false);
    }
  }

  // Slice 2: pay the author's exact rent → server settles atomically (debit
  // renter / credit author, 0% AIAG) → clones the agent to us → we route to it.
  async function handleRent() {
    if (!token || !id) return;
    setRenting(true);
    setRentErr(null);
    setInsufficient(false);
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}/rent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 402) {
        // insufficient_balance — offer a top-up instead of a raw error.
        setInsufficient(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRentErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.agent_id) {
        router.push(`/agents/${data.agent_id}`);
        return;
      }
      setRentErr('rent_failed');
    } catch (e) {
      setRentErr(e instanceof Error ? e.message : 'rent_failed');
    } finally {
      setRenting(false);
    }
  }

  // Submit a 1..5 rating + optional comment. The server enforces eligibility
  // (must have cloned/rented this template) and returns 403 not_eligible for
  // drive-by raters — we surface that as an honest disabled state, not an error.
  async function handleRate() {
    if (!token || !id || ratingStars < 1) return;
    setRateState('sending');
    setRateErr(null);
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}/rate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          stars: ratingStars,
          comment: ratingComment.trim() ? ratingComment.trim() : null,
        }),
      });
      if (res.status === 403) {
        setRateState('ineligible');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRateErr(body.error ?? `HTTP ${res.status}`);
        setRateState('idle');
        return;
      }
      // Refresh avg_rating / rating_count so the new value shows immediately.
      await load();
      setRateState('done');
    } catch (e) {
      setRateErr(e instanceof Error ? e.message : 'rate_failed');
      setRateState('idle');
    }
  }

  const tools = Array.isArray(template?.tools) ? (template!.tools as unknown[]) : [];
  const skills = Array.isArray(template?.suggested_skills)
    ? (template!.suggested_skills as unknown[])
    : [];

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link
          href="/market"
          className="tma-back-link"
          onClick={(e) => {
            e.preventDefault();
            router.back();
          }}
        >
          ← К маркету
        </Link>

        {/* 404: a dead link must not look like a crash — honest card + way out. */}
        {fetchErr === 'not_found' ? (
          <section className="tma-card">
            <h2 className="tma-card-title">Шаблон не найден</h2>
            <p className="tma-card-text">
              Возможно, автор снял его с публикации или ссылка устарела.
            </p>
            <Link href="/market" className="tma-btn tma-btn--ghost" style={{ marginTop: 8 }}>
              К маркету
            </Link>
          </section>
        ) : (
          fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>
        )}

        {/* Outside Telegram the authed fetch never runs — say so instead of a
            blank screen. */}
        {!template && !fetchErr && !loading && error && (
          <section className="tma-card">
            <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
            <p className="tma-card-text">
              Карточка шаблона доступна только в Telegram Mini App.
            </p>
          </section>
        )}

        {/* Loading: auth handshake or template fetch in flight. */}
        {!template && !fetchErr && (loading || (!error && !!token)) && (
          <p className="tma-card-text">Загрузка…</p>
        )}

        {template && (
          <>
            <section className="tma-detail-hero">
              <div
                className="tma-detail-portrait"
                style={{
                  background: `linear-gradient(155deg, oklch(0.34 0.09 ${hueFor(template.id)}), oklch(0.17 0.045 ${hueFor(template.id)}))`,
                  color: `oklch(0.93 0.11 ${hueFor(template.id)})`,
                }}
              >
                {((template.name ?? '?').trim()[0] ?? '?').toUpperCase()}
              </div>
              <div className="tma-detail-hero-body">
            <header className="tma-header" style={{ gap: 6 }}>
              <h1 className="tma-title">{template.name ?? 'Без имени'}</h1>
              {template.avg_rating !== null ? (
                <span className="tma-rating">
                  <span className="tma-rating-star">★</span>
                  <span className="tma-rating-value">{template.avg_rating}</span>
                  <span className="tma-rating-count">
                    ({template.rating_count}{' '}
                    {ratingWord(template.rating_count)})
                  </span>
                </span>
              ) : (
                <span className="tma-rating-empty">★ ещё нет оценок</span>
              )}
              {template.fork_parent_id && (
                <Link href={`/templates/${template.fork_parent_id}`} className="tma-fork-link">
                  <span className="tma-fork-glyph">⑂</span>
                  Форк от: {template.parent_name ?? 'оригинал'}
                </Link>
              )}
              {template.description && (
                <p className="tma-subtitle">{template.description}</p>
              )}
              <div className="tma-row" style={{ marginTop: 4 }}>
                <span
                  className={isPaid ? 'tma-price-strong' : 'tma-nft-supply'}
                  style={isPaid ? { fontVariantNumeric: 'tabular-nums' } : undefined}
                >
                  {priceLabel(template.price_credits)}
                </span>
                <span className="tma-mono">⧉ {template.clone_count} клонов</span>
              </div>
            </header>
              </div>
            </section>

            {/* CTA — the one primary action on this screen. Paid templates rent
                (pays the author the exact sum, 0% AIAG); free templates clone. */}
            {isPaid ? (
              <button
                type="button"
                onClick={handleRent}
                disabled={renting || loading || !!error}
                className="tma-btn tma-btn--primary"
              >
                {renting ? 'Аренда…' : `Арендовать за ${priceLabel(String(priceNum))}`}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleClone}
                disabled={cloneDisabled || loading || !!error}
                className="tma-btn tma-btn--primary"
              >
                {cloning ? 'Клонирование…' : 'Клонировать'}
              </button>
            )}

            {insufficient && (
              <div className="tma-card" style={{ padding: 14 }}>
                <p className="tma-card-text">
                  Недостаточно кредитов для аренды ({priceLabel(String(priceNum))}). Пополните
                  баланс и попробуйте снова.
                </p>
                <Link href="/profile/topup" className="tma-btn tma-btn--ghost">
                  Пополните баланс
                </Link>
              </div>
            )}

            {rentErr && <div className="tma-error">Ошибка: {rentErr}</div>}

            {!loading && error && (
              <p className="tma-card-text">
                {error === 'Не открыто в Telegram'
                  ? 'Откройте через @aiag_bot, чтобы клонировать'
                  : `Ошибка: ${error}`}
              </p>
            )}

            {cloneErr && <div className="tma-error">Ошибка: {cloneErr}</div>}

            {template.model_slug && (
              <section className="tma-card">
                <h2 className="tma-card-title">Модель</h2>
                <p className="tma-card-text">
                  <code>{template.model_slug}</code>
                </p>
              </section>
            )}

            {template.system_prompt && (
              <section className="tma-card">
                <h2 className="tma-card-title">System prompt</h2>
                <p
                  className="tma-card-text"
                  style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}
                >
                  {template.system_prompt}
                </p>
              </section>
            )}

            {(tools.length > 0 || skills.length > 0 || template.mcp_endpoint_url) && (
              <section className="tma-card">
                <h2 className="tma-card-title">Что внутри</h2>
                {tools.length > 0 && (
                  <div className="tma-chips">
                    {tools.map((t, i) => (
                      <span key={i} className="tma-chip">
                        {String(t)}
                      </span>
                    ))}
                  </div>
                )}
                {skills.length > 0 && (
                  <>
                    <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
                      Навыки
                    </p>
                    <div className="tma-chips">
                      {skills.map((s, i) => (
                        <span key={i} className="tma-chip">
                          {typeof s === 'string'
                            ? s
                            : String((s as { name?: unknown })?.name ?? '')}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                {template.mcp_endpoint_url && (
                  <p className="tma-card-text tma-text-small">
                    MCP-сервер: <code>{template.mcp_endpoint_url}</code>
                  </p>
                )}
              </section>
            )}

            {/* Rating widget. Shown to everyone; the server returns 403
                not_eligible to drive-by raters → honest disabled state. */}
            <section className="tma-card">
              <h2 className="tma-card-title">Оценить шаблон</h2>
              {rateState === 'done' ? (
                <p className="tma-success">Спасибо за оценку</p>
              ) : rateState === 'ineligible' ? (
                <p className="tma-card-text tma-text-small">
                  Оцените после клонирования — оценки доступны тем, кто запускал
                  этого агента.
                </p>
              ) : (
                <>
                  <div className="tma-rate-stars" role="radiogroup" aria-label="Оценка">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={ratingStars === n}
                        aria-label={`${n} из 5`}
                        disabled={rateState === 'sending'}
                        className={`tma-rate-star${n <= ratingStars ? ' is-on' : ''}`}
                        onClick={() => setRatingStars(n)}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="tma-rate-comment"
                    placeholder="Комментарий (необязательно)"
                    maxLength={2000}
                    value={ratingComment}
                    disabled={rateState === 'sending'}
                    onChange={(e) => setRatingComment(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={handleRate}
                    disabled={ratingStars < 1 || rateState === 'sending'}
                    className="tma-btn tma-btn--primary"
                  >
                    {rateState === 'sending' ? 'Отправка…' : 'Оценить'}
                  </button>
                  {rateErr && <div className="tma-error">Ошибка: {rateErr}</div>}
                </>
              )}
            </section>

            <p className="tma-card-text tma-text-small">
              При клонировании настройки переносятся к вам. Ключи и приватные
              данные автора не передаются — подключение настраиваете сами.
            </p>
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
