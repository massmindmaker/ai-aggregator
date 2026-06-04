'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';

interface TemplateRow {
  id: string;
  name: string | null;
  price_credits: string | null;
  clone_count: number;
  visibility: string;
  rental_count: number;
  earned_credits: string;
}

interface IncomeResp {
  total_income_credits: string;
  spendable_credits: string;
  templates: TemplateRow[];
}

// D-1: all balances/amounts are integer US cents (1 credit = $0.01). Display as
// "N.NN кр" — never expose the raw integer. JetBrains/mono via .tma-mono.
function fmtCredits(s: string): string {
  const cents = Number(s);
  if (!Number.isFinite(cents)) return s;
  return (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function AuthorIncomePage() {
  const { token, loading: authLoading, error: authError } = useAuth();
  const [data, setData] = useState<IncomeResp | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    // Gated on token (the catalog had a 401 bug from a tokenless fetch) — the
    // authed fetch sends `Authorization: Bearer ${token}`, middleware resolves it
    // to x-tma-user-id, and the route scopes everything to that author.
    if (!token) return;
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/me/author-income', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setFetchErr(`HTTP ${res.status}`);
          return;
        }
        const j = (await res.json()) as IncomeResp;
        setData(j);
      } catch (e) {
        setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
  }, [token]);

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <p className="tma-card-text">Загрузка…</p>
        <BottomNav />
      </main>
    );
  }

  if (authError) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card">
          <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
          <p className="tma-card-text">Доход автора доступен только в Telegram Mini App.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  const templates = data?.templates ?? [];

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <Link href="/profile" className="tma-back-link">
            ← Профиль
          </Link>
          <span className="tma-badge">Доход автора</span>
          <h1 className="tma-title">Заработок на шаблонах</h1>
          <p className="tma-subtitle">
            Аренда ваших шаблонов идёт вам целиком — AIAG берёт 0%.
          </p>
        </header>

        {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

        {/* Totals — all numerics in mono (DESIGN.md). */}
        <section className="tma-card">
          <div className="tma-row">
            <span className="tma-card-text">Всего заработано</span>
            <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtCredits(data?.total_income_credits ?? '0')} кр
            </span>
          </div>
          <div className="tma-row" style={{ marginTop: 8 }}>
            <span className="tma-card-text">Доступно на балансе</span>
            <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtCredits(data?.spendable_credits ?? '0')} кр
            </span>
          </div>
        </section>

        {/* Per-template breakdown table: name + clone_count + rental_count + earned. */}
        <section className="tma-card">
          <h2 className="tma-card-title">По шаблонам</h2>
          {!data && !fetchErr && <p className="tma-card-text">Загрузка…</p>}
          {data && templates.length === 0 && (
            <p className="tma-card-text">
              У вас пока нет опубликованных шаблонов. Опубликуйте агента — и доход
              появится здесь.
            </p>
          )}
          {templates.length > 0 && (
            <>
              <div className="tma-row" style={{ marginTop: 4, marginBottom: 4 }}>
                <span className="tma-mono" style={{ flex: 1 }}>
                  шаблон
                </span>
                <span className="tma-mono" style={{ width: 56, textAlign: 'right' }}>
                  клоны
                </span>
                <span className="tma-mono" style={{ width: 56, textAlign: 'right' }}>
                  аренды
                </span>
                <span className="tma-mono" style={{ width: 80, textAlign: 'right' }}>
                  доход
                </span>
              </div>
              {templates.map((t) => (
                <div
                  className="tma-row"
                  key={t.id}
                  style={{ marginTop: 6, alignItems: 'baseline' }}
                >
                  <span
                    className="tma-card-text"
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.name ?? 'Без имени'}
                  </span>
                  <span
                    className="tma-mono"
                    style={{ width: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {t.clone_count}
                  </span>
                  <span
                    className="tma-mono"
                    style={{ width: 56, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {t.rental_count}
                  </span>
                  <span
                    className="tma-mono"
                    style={{ width: 80, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {fmtCredits(t.earned_credits)} кр
                  </span>
                </div>
              ))}
            </>
          )}
        </section>

        {/* HONEST «скоро» — FD-2 (cash-out) is deferred. Withdraw is a disabled
            label, NOT a working button. Income is spendable in-app now. */}
        <section className="tma-card">
          <h2 className="tma-card-title">Вывод средств</h2>
          <button type="button" className="tma-btn" disabled style={{ width: '100%' }}>
            Вывод средств — скоро
          </button>
          <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
            Доход уже можно тратить внутри приложения — на запуски и аренду своих
            агентов. Вывод на внешний кошелёк появится позже.
          </p>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
