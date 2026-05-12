'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model_slug: string | null;
  budget_rub_monthly: string;
}

interface Run {
  id: string;
  input: string;
  output: string | null;
  status: string;
  cost_rub: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { token, loading, error } = useAuth();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) {
        setFetchErr('Агент не найден');
        return;
      }
      if (!res.ok) {
        setFetchErr(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setAgent(data.agent);
      setRuns(data.runs ?? []);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
    }
  }, [token, id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'pending' || r.status === 'running');
    if (!hasActive) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [runs, load]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id || !input.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ input: input.trim() }),
      });
      if (res.ok) {
        setInput('');
        await load();
      } else {
        const body = await res.json().catch(() => ({}));
        setFetchErr(body.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!token || !id) return;
    if (!confirm('Удалить агента? Действие необратимо.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        router.push('/agents');
      } else {
        setFetchErr('Не удалось удалить');
        setDeleting(false);
      }
    } catch {
      setDeleting(false);
    }
  }

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/agents" className="tma-back-link">
          ← К списку
        </Link>

        {loading && <p className="tma-card-text">Загрузка…</p>}
        {!loading && error && (
          <div className="tma-card">
            <p className="tma-card-text">
              {error === 'Не открыто в Telegram'
                ? 'Откройте через @aiag_bot в Telegram'
                : `Ошибка: ${error}`}
            </p>
          </div>
        )}

        {fetchErr && <div className="tma-error">{fetchErr}</div>}

        {agent && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">{agent.name}</h1>
              {agent.description && (
                <p className="tma-subtitle">{agent.description}</p>
              )}
              {agent.model_slug && (
                <p className="tma-subtitle">
                  <code>{agent.model_slug}</code> · {Number(agent.budget_rub_monthly).toFixed(0)} ₽/мес
                </p>
              )}
            </header>

            <section className="tma-card">
              <h2 className="tma-card-title">System prompt</h2>
              <p
                className="tma-card-text"
                style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}
              >
                {agent.system_prompt}
              </p>
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 className="tma-card-title">История</h2>
              {runs.length === 0 && (
                <p className="tma-card-text">
                  Пока нет сообщений. Напишите первое ниже.
                </p>
              )}
              {runs
                .slice()
                .reverse()
                .map((r) => (
                  <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ ...bubbleStyle, alignSelf: 'flex-end', background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                      {r.input}
                    </div>
                    {r.output && (
                      <div style={{ ...bubbleStyle, alignSelf: 'flex-start', background: 'var(--bg-elev)' }}>
                        {r.output}
                      </div>
                    )}
                    {!r.output && (r.status === 'pending' || r.status === 'running') && (
                      <div style={{ ...bubbleStyle, alignSelf: 'flex-start', background: 'var(--bg-elev)', opacity: 0.6 }}>
                        …думает
                      </div>
                    )}
                    {r.error && (
                      <div className="tma-error" style={{ alignSelf: 'flex-start' }}>
                        {r.error}
                      </div>
                    )}
                  </div>
                ))}
            </section>

            <form onSubmit={handleSend} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Сообщение агенту…"
                disabled={sending}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  background: 'var(--bg-surface)',
                  color: 'var(--ink)',
                  fontSize: 14,
                  outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="tma-btn tma-btn--primary"
              >
                {sending ? '…' : '→'}
              </button>
            </form>

            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="tma-btn"
              style={{ color: '#fca5a5' }}
            >
              {deleting ? 'Удаление…' : 'Удалить агента'}
            </button>
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}

const bubbleStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 12,
  maxWidth: '85%',
  fontSize: 14,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
