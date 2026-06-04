'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { AgentCard, hueFor } from '@/components/AgentCard';

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  model_slug: string | null;
  budget_rub_monthly: string;
  created_at: string;
}

export default function AgentsPage() {
  const { user, token, loading, error, debug } = useAuth();
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
          <span className="tma-eyebrow">Мои агенты</span>
          <h1 className="tma-title">Агенты</h1>
          <p className="tma-subtitle">
            Создавайте AI-агентов под свои задачи. Из шаблона или с нуля.
          </p>
        </header>

        {loading && (
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

        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка авторизации: ${error}`}
            </p>
            {debug && (
              <p className="tma-card-text tma-text-small" style={{ opacity: 0.55, fontFamily: 'var(--font-mono, monospace)', marginTop: 6 }}>
                диагностика: {debug}
              </p>
            )}
          </div>
        )}

        {user && !error && (
          <>
            <div className="tma-cta" style={{ gap: 8 }}>
              <Link href="/agents/new" className="tma-btn tma-btn--primary">
                Создать агента
              </Link>
              <Link href="/schedules" className="tma-btn">
                Расписания
              </Link>
            </div>

            {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

            {agents && agents.length === 0 && (
              <section className="tma-card tma-empty">
                <span className="tma-empty-glyph">✦</span>
                <h2 className="tma-card-title">Пока пусто</h2>
                <p className="tma-card-text">
                  Выберите готовый шаблон в маркете или соберите своего агента
                  с нуля — персона, модель, инструменты и расписание.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <Link href="/agents/new" className="tma-btn tma-btn--primary">
                    Собрать с нуля
                  </Link>
                  <Link href="/templates" className="tma-btn">
                    Открыть шаблоны
                  </Link>
                </div>
              </section>
            )}

            {agents && agents.length > 0 && (
              <section className="tma-agent-grid">
                {agents.map((a, idx) => (
                  <AgentCard
                    key={a.id}
                    href={`/agents/${a.id}`}
                    hue={hueFor(a.id)}
                    name={a.name}
                    role={a.description}
                    model={a.model_slug}
                    metricLabel={`${Number(a.budget_rub_monthly).toFixed(0)} кр/мес`}
                    featured={idx === 0 && agents.length > 1}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
