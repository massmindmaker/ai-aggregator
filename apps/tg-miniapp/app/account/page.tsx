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

// /tg/api/tma/agents → { agents: [...] }; на этом экране нужен только счётчик.
interface AgentsResp {
  agents: unknown[];
}

// /tg/api/tma/providers → каталог доступных провайдеров (БЕЗ ключей).
interface ProviderItem {
  id: string;
  name: string;
  apiBase: string | null;
  requiresBaseUrl: boolean;
}
interface ProvidersResp {
  providers: ProviderItem[];
}

// /tg/api/tma/ledger → лента движения средств (центы США, D-1).
// Расход за месяц = Σ |delta| по kind='run_debit' за текущий календарный месяц.
interface LedgerEntry {
  kind: string;
  delta_credits: string;
  created_at: string;
}
interface LedgerResp {
  entries: LedgerEntry[];
}

// Σ списаний за прогоны (run_debit) с начала текущего месяца, в центах (строка
// для fmtCredits). delta_credits у списаний отрицательная → берём модуль.
function monthRunSpendCents(entries: LedgerEntry[]): string {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let cents = 0;
  for (const e of entries) {
    if (e.kind !== 'run_debit') continue;
    if (new Date(e.created_at).getTime() < monthStart) continue;
    cents += Math.abs(Number(e.delta_credits) || 0);
  }
  return String(cents);
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

  // Мои агенты / провайдеры / расход — каждый блок грузится сам, с собственным
  // флагом загрузки (скелетон) и тихой обработкой ошибки (null = «нет данных»).
  const [agentsCount, setAgentsCount] = useState<number | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderItem[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [monthSpend, setMonthSpend] = useState<string | null>(null);
  const [spendLoading, setSpendLoading] = useState(true);
  // Подтверждение выхода через bottom-sheet (window.confirm не работает в
  // Telegram iOS WebView — тот же приём, что K1 при удалении агента).
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  useEffect(() => {
    if (!token) return;
    const auth = { Authorization: `Bearer ${token}` };

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/me/author-income', { headers: auth });
        if (!res.ok) return;
        const j = (await res.json()) as IncomeResp;
        setIncome(j);
      } catch {
        /* доход автора прячем, если запрос не удался */
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/agents', { headers: auth });
        if (res.ok) {
          const j = (await res.json()) as AgentsResp;
          setAgentsCount(Array.isArray(j.agents) ? j.agents.length : 0);
        }
      } catch {
        /* счётчик агентов оставляем неизвестным */
      } finally {
        setAgentsLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/providers', { headers: auth });
        if (res.ok) {
          const j = (await res.json()) as ProvidersResp;
          setProviders(Array.isArray(j.providers) ? j.providers : []);
        }
      } catch {
        /* каталог провайдеров прячем при ошибке */
      } finally {
        setProvidersLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch('/tg/api/tma/ledger', { headers: auth });
        if (res.ok) {
          const j = (await res.json()) as LedgerResp;
          setMonthSpend(monthRunSpendCents(Array.isArray(j.entries) ? j.entries : []));
        }
      } catch {
        /* расход прячем при ошибке */
      } finally {
        setSpendLoading(false);
      }
    })();
  }, [token]);

  async function onLogout() {
    // Server-side revoke: put this token's jti on the denylist so a copy that
    // leaked off this device stops working immediately. Best-effort — if the
    // call fails (offline / store not configured), we still clear locally and
    // leave; the token simply expires on its own.
    if (token) {
      try {
        await fetch('/tg/api/tma/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* выход не блокируем при сетевой ошибке */
      }
    }
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

        {/* Мои агенты — счётчик из /agents + ссылка на список. */}
        <section className="tma-card">
          <h2 className="tma-card-title">Мои агенты</h2>
          {agentsLoading ? (
            <div className="aiag-skeleton" style={{ height: 20, width: '30%' }} />
          ) : (
            <div className="tma-row">
              <span className="tma-card-text">Всего агентов</span>
              <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {agentsCount ?? 0}
              </span>
            </div>
          )}
          <div className="tma-cta" style={{ marginTop: 12 }}>
            <Link href="/agents" className="tma-btn">
              К моим агентам
            </Link>
          </div>
        </section>

        {/* Расход за месяц — Σ run_debit за текущий месяц из /ledger. */}
        <section className="tma-card">
          <h2 className="tma-card-title">Расход за месяц</h2>
          {spendLoading ? (
            <div className="aiag-skeleton" style={{ height: 20, width: '40%' }} />
          ) : (
            <div className="tma-row">
              <span className="tma-card-text">Списано за прогоны</span>
              <span className="tma-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtCredits(monthSpend ?? '0')} кр
              </span>
            </div>
          )}
          <div className="tma-cta" style={{ marginTop: 12 }}>
            <Link href="/wallet" className="tma-btn">
              К кошельку →
            </Link>
          </div>
        </section>

        {/* Провайдеры — каталог доступных провайдеров из /providers (БЕЗ ключей). */}
        <section className="tma-card">
          <h2 className="tma-card-title">Провайдеры</h2>
          {providersLoading ? (
            <>
              <div className="aiag-skeleton" style={{ height: 14, width: '50%' }} />
              <div className="aiag-skeleton" style={{ height: 14, width: '40%', marginTop: 8 }} />
            </>
          ) : !providers || providers.length === 0 ? (
            <p className="tma-card-text">Список провайдеров недоступен.</p>
          ) : (
            providers.map((p, i) => (
              <div className="tma-row tma-provider-row" key={p.id} style={i > 0 ? { marginTop: 10 } : undefined}>
                <span className="tma-card-text tma-provider-name">{p.name}</span>
                {p.apiBase ? (
                  <span
                    className="tma-mono tma-provider-url"
                    style={{ color: 'var(--ink-faint)' }}
                    title={p.apiBase.replace(/^https?:\/\//, '')}
                  >
                    {p.apiBase.replace(/^https?:\/\//, '')}
                  </span>
                ) : (
                  <span className="tma-pill tma-pill--muted">свой URL</span>
                )}
              </div>
            ))
          )}
          <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
            Свой ключ к любому из них — 0 комиссии. Подключаются при создании агента.
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

        {/* Условия использования — информационные строки, без ложного «принято». */}
        <section className="tma-card">
          <h2 className="tma-card-title">Условия использования</h2>
          <div className="tma-row">
            <span className="tma-card-text">Обработка данных (152-ФЗ)</span>
          </div>
          <div className="tma-row" style={{ marginTop: 10 }}>
            <span className="tma-card-text">Пользовательское соглашение</span>
          </div>
        </section>

        {/* Выход — вторичная кнопка, не amber. Тап открывает подтверждение. */}
        <section className="tma-card">
          <button
            type="button"
            className="tma-btn"
            onClick={() => setLogoutConfirm(true)}
            style={{ width: '100%' }}
          >
            Выход
          </button>
          <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
            Выход очистит сохранённую сессию на этом устройстве.
          </p>
        </section>
      </main>

      {logoutConfirm && (
        <div className="tma-sheet-scrim" onClick={() => setLogoutConfirm(false)}>
          <div
            className="tma-sheet"
            role="dialog"
            aria-label="Выйти из аккаунта?"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tma-sheet-handle" />
            <h3 className="tma-sheet-title">Выйти из аккаунта?</h3>
            <p className="tma-card-text">Сессия на этом устройстве будет очищена.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setLogoutConfirm(false)}
                className="tma-btn"
                style={{ flex: 1 }}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="tma-btn tma-btn--danger"
                style={{ flex: 1 }}
              >
                Выйти
              </button>
            </div>
          </div>
        </div>
      )}
      <BottomNav />
    </>
  );
}
