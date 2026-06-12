'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { hueFor } from '@/components/AgentCard';
import { characterFor } from '@/lib/characters';

// ─────────────────────────────────────────────────────────────────────────────
// /agents — мессенджер-инбокс агентов (главная вкладка). Каждая строка = агент
// с превью последнего ответа, как список чатов. Тап → /agents/[id] (детальный
// экран: запуск + история + композер). Живой стриминг-чат — отдельный подпроект.
// Старый хаб переехал в /dashboard. Секция «Группы» — честная заглушка «скоро».
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

export default function AgentsInboxPage() {
  const { user, token, loading, error, debug } = useAuth();

  const [agents, setAgents] = useState<Agent[] | null>(null);
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
        if (!cancelled) setAgents(data.agents ?? []);
      } catch (e) {
        if (!cancelled) setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-page-head aiag-fade-up">
          <span className="tma-eyebrow">Агенты</span>
          <h1 className="tma-h1">Мои агенты</h1>
        </header>

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
            {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

            {agents === null && !fetchErr && (
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

            {agents && agents.length === 0 && (
              <div className="tma-card">
                <p className="tma-card-text">У тебя пока нет агентов</p>
                <Link href="/market" className="tma-btn tma-btn--primary tma-btn--block">
                  Взять в Маркете →
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
      </main>

      <BottomNav />
    </>
  );
}
