'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';
import { fmtCredits } from '@/lib/credits';

interface IncomeResp {
  total_income_credits: string;
  month_income_credits?: string;
  templates: { id: string }[];
}

// Best-effort token wipe. The JWT lives in Telegram CloudStorage under
// `aiag_jwt` (see useAuth). We clear it there and, as a fallback, any
// localStorage key holding the same name, then bounce to the root.
function clearAuthToken() {
  try {
    const tg = (window as { Telegram?: { WebApp?: { CloudStorage?: { removeItem?: (k: string, cb?: () => void) => void } } } }).Telegram?.WebApp;
    tg?.CloudStorage?.removeItem?.('aiag_jwt', () => {});
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem('aiag_jwt');
  } catch {
    /* ignore */
  }
}

export default function AccountPage() {
  const router = useRouter();
  const { user, token, loading: authLoading, error: authError } = useAuth();
  const [income, setIncome] = useState<IncomeResp | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/me/author-income', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const j = (await res.json()) as IncomeResp;
        setIncome(j);
      } catch {
        /* доход автора прячем, если запрос не удался */
      }
    })();
  }, [token]);

  function onLogout() {
    clearAuthToken();
    router.replace('/');
  }

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card" aria-hidden>
          <div className="aiag-skeleton" style={{ height: 14, width: '40%' }} />
          <div className="aiag-skeleton" style={{ height: 24, width: '60%' }} />
        </section>
        <BottomNav />
      </main>
    );
  }

  if (authError) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card">
          <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
          <p className="tma-card-text">Аккаунт доступен только в Telegram Mini App.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  const displayName =
    [user?.first_name, user?.username ? `@${user.username}` : null]
      .filter(Boolean)
      .join(' ') || 'Telegram-аккаунт';
  const hasIncome =
    !!income && ((income.templates?.length ?? 0) > 0 || Number(income.total_income_credits) > 0);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header aiag-fade-up">
          <span className="tma-eyebrow">Аккаунт</span>
          <h1 className="tma-title">Профиль</h1>
          <p className="tma-subtitle">Личность, тариф и согласия. Деньги — в кошельке.</p>
        </header>

        {/* Профиль — личность из Telegram. */}
        <section className="tma-card aiag-fade-up">
          <h2 className="tma-card-title">Telegram</h2>
          <div className="tma-row">
            <span className="tma-card-text">{displayName}</span>
            {user?.id ? (
              <span className="tma-mono" style={{ color: 'var(--ink-faint)' }}>
                id {user.id}
              </span>
            ) : null}
          </div>
        </section>

        {/* Тариф — Шара (live) + Оператор (скоро, статичный). */}
        <section className="tma-card">
          <h2 className="tma-card-title">Тариф</h2>
          <div className="tma-row">
            <span className="tma-card-text">Тариф: Шара</span>
            <span className="tma-pill tma-pill--ok">✓ активен</span>
          </div>
          <div className="tma-row" style={{ marginTop: 10 }}>
            <span className="tma-card-text">Оператор</span>
            <span className="tma-pill tma-pill--muted">◷ скоро</span>
          </div>
          <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
            Разворачивай своих агентов и сдавай их — в платном тарифе (фаза 2).
          </p>
        </section>

        {/* Доход автора — показываем только если у автора есть шаблоны/доход. */}
        {hasIncome && income && (
          <section className="tma-card">
            <h2 className="tma-card-title">Доход автора</h2>
            <div className="tma-row">
              <span className="tma-card-text">Всего заработано</span>
              <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtCredits(income.total_income_credits ?? '0')} кр
              </span>
            </div>
            <div className="tma-row" style={{ marginTop: 8 }}>
              <span className="tma-card-text">За этот месяц</span>
              <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtCredits(income.month_income_credits ?? '0')} кр
              </span>
            </div>
            <div className="tma-cta" style={{ marginTop: 12 }}>
              <Link href="/profile/income" className="tma-btn">
                Подробнее о доходе
              </Link>
            </div>
          </section>
        )}

        {/* Согласия — read-only, информационные. */}
        <section className="tma-card">
          <h2 className="tma-card-title">Согласия</h2>
          <div className="tma-row">
            <span className="tma-card-text">Согласие на обработку данных (152-ФЗ)</span>
            <span className="tma-pill tma-pill--ok">✓ принято</span>
          </div>
          <div className="tma-row" style={{ marginTop: 10 }}>
            <span className="tma-card-text">Пользовательское соглашение</span>
            <span className="tma-pill tma-pill--ok">✓ принято</span>
          </div>
        </section>

        {/* Выход — вторичная кнопка, не amber. Чистит токен и уходит на старт. */}
        <section className="tma-card">
          <button type="button" className="tma-btn" onClick={onLogout} style={{ width: '100%' }}>
            Выход
          </button>
          <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
            Выход очистит сохранённую сессию на этом устройстве.
          </p>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
