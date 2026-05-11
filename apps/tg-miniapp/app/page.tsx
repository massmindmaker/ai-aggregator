'use client';

import { TonConnectButton } from '@tonconnect/ui-react';

export default function Home() {
  return (
    <main className="tma-shell">
      <header className="tma-header">
        <span className="tma-badge">AIAG</span>
        <h1 className="tma-title">Mini App scaffold OK</h1>
        <p className="tma-subtitle">
          Phase 15 / Wave 01 — Next 14 App Router + TON Connect client-boundary provider.
        </p>
      </header>

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
