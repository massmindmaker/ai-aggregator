'use client';

import { TonConnectButton } from '@tonconnect/ui-react';
import { useAuth } from '@/hooks/useAuth';

export default function Home() {
  const { user, loading, error } = useAuth();

  return (
    <main className="tma-shell">
      <header className="tma-header">
        <span className="tma-badge">AIAG</span>
        <h1 className="tma-title">Mini App scaffold OK</h1>
        <p className="tma-subtitle">
          Phase 15 / Wave 02 — HMAC verify + JWT auth.
        </p>
      </header>

      <section className="tma-card">
        <h2 className="tma-card-title">Auth</h2>
        {loading && <p className="tma-card-text">Проверка initData…</p>}
        {!loading && error && (
          <p className="tma-card-text">
            {error === 'Не открыто в Telegram'
              ? 'Откройте через @aiag_bot в Telegram'
              : `Ошибка: ${error}`}
          </p>
        )}
        {!loading && user && (
          <p className="tma-card-text">
            ✓ Авторизован: <strong>{user.first_name ?? user.username ?? user.id}</strong>
          </p>
        )}
      </section>

      <section className="tma-card">
        <h2 className="tma-card-title">TON Connect smoke</h2>
        <p className="tma-card-text">
          Кнопка ниже подтверждает, что <code>TonConnectUIProvider</code> смонтирован
          в client boundary и context инициализирован без ошибок.
        </p>
        <div className="tma-cta">
          <TonConnectButton />
        </div>
      </section>
    </main>
  );
}
