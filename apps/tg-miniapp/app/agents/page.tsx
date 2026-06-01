'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  model_slug: string | null;
  budget_rub_monthly: string;
  created_at: string;
}

const EMOJI: Record<string, string> = {
  writer: '✍️',
  coder: '💻',
  analyst: '📊',
  researcher: '🔬',
  marketer: '📣',
  personal: '🤖',
};

export default function AgentsPage() {
  const { user, token, loading, error } = useAuth();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch('/tg/api/tma/agents', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setFetchErr(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setAgents(data.agents ?? []);
      } catch (e) {
        setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
  }, [token]);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-badge">AIAG</span>
          <h1 className="tma-title">Агенты</h1>
          <p className="tma-subtitle">
            Создавайте AI-агентов под свои задачи. Шаблоны или с нуля.
          </p>
        </header>

        {loading && <p className="tma-card-text">Загрузка…</p>}
        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка авторизации: ${error}`}
            </p>
          </div>
        )}

        {user && !error && (
          <>
            <div className="tma-cta">
              <Link href="/agents/new" className="tma-btn tma-btn--primary">
                + Создать агента
              </Link>
            </div>

            {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

            {agents && agents.length === 0 && (
              <section className="tma-card">
                <h2 className="tma-card-title">Пока пусто</h2>
                <p className="tma-card-text">
                  Выберите шаблон или соберите своего агента с нуля.
                </p>
              </section>
            )}

            {agents && agents.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {agents.map((a) => (
                  <Link
                    key={a.id}
                    href={`/agents/${a.id}`}
                    className="tma-card"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <div className="tma-row">
                      <h2 className="tma-card-title">
                        <span style={{ marginRight: 8 }}>{EMOJI[a.template_kind] ?? '🤖'}</span>
                        {a.name}
                      </h2>
                      <span className="tma-nft-supply">
                        {Number(a.budget_rub_monthly).toFixed(0)} ₽/мес
                      </span>
                    </div>
                    {a.description && <p className="tma-card-text">{a.description}</p>}
                    {a.model_slug && (
                      <p className="tma-card-text tma-text-small">
                        <code>{a.model_slug}</code>
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
