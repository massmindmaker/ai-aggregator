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

// Per-character accent hue (OKLCH) — the collectible-card signature (DESIGN.md /
// PRODUCT.md): the agents catalog now speaks the SAME card language as /templates,
// not faceless emoji rows ("два языка сшиты"). Deterministic per agent id.
const HUES = [28, 235, 340, 165, 60, 290, 200, 130];
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}
function monogram(name: string | null): string {
  const t = (name ?? '?').trim();
  return (t[0] ?? '?').toUpperCase();
}

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
            <div className="tma-cta" style={{ gap: 8 }}>
              <Link href="/agents/new" className="tma-btn tma-btn--primary">
                + Создать агента
              </Link>
              <Link href="/schedules" className="tma-btn">
                ⏰ Расписания
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
              <section className="tma-nft-grid">
                {agents.map((a) => {
                  const hue = hueFor(a.id);
                  return (
                    <Link key={a.id} href={`/agents/${a.id}`} className="tma-nft-card">
                      <div
                        className="tma-nft-image tma-nft-image--placeholder"
                        style={{
                          background: `linear-gradient(155deg, oklch(0.32 0.08 ${hue}), oklch(0.18 0.04 ${hue}))`,
                          color: `oklch(0.92 0.10 ${hue})`,
                          fontSize: 40,
                          fontWeight: 700,
                        }}
                      >
                        <span>{monogram(a.name)}</span>
                      </div>
                      <div className="tma-nft-body">
                        <h3 className="tma-nft-name">{a.name}</h3>
                        {a.description && (
                          <p
                            className="tma-card-text tma-text-small"
                            style={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {a.description}
                          </p>
                        )}
                        {a.model_slug && (
                          <span className="tma-mono" style={{ wordBreak: 'break-all' }}>
                            {a.model_slug}
                          </span>
                        )}
                        <div className="tma-nft-meta">
                          <span className="tma-nft-supply" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {Number(a.budget_rub_monthly).toFixed(0)} кр/мес
                          </span>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </section>
            )}
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
