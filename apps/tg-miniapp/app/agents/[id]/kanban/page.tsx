'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';

/**
 * SCREEN 26 — Канбан / swarm (READ-ONLY).
 *
 * Honest visualization of a CONNECT-YOUR-OWN Hermes. We do NOT run Hermes; the
 * user runs `NousResearch/hermes-agent` on their VPS and connects it as an
 * external provider. This page POLLs our server-side route, which in turn polls
 * the Hermes dashboard kanban endpoints (SSRF-guarded). It never writes.
 *
 * States:
 *   - not a connected Hermes        → «подключите свой Hermes» empty state
 *   - Hermes unreachable / timeout  → «недоступен» state (no crash)
 *   - reachable                     → queue/in-progress/done columns + workers
 */

interface KTask {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  priority: number | null;
  summary: string | null;
  comment_count: number | null;
  progress: { done: number; total: number } | null;
  worker_pid: number | null;
}

interface KColumn {
  name: string;
  tasks: KTask[];
}

interface KWorker {
  run_id: number | string;
  task_id: string;
  task_title: string | null;
  profile: string | null;
  worker_pid: number | null;
  started_at: number | null;
}

interface KanbanResponse {
  columns?: KColumn[];
  workers?: KWorker[];
  checked_at?: number;
  error?: string;
}

// Hermes BOARD_COLUMNS (from plugin_api.py). Russian labels for the UI; unknown
// columns fall through with their raw name so a Hermes schema change still shows.
const COLUMN_LABELS: Record<string, string> = {
  triage: 'Триаж',
  todo: 'Очередь',
  scheduled: 'Запланировано',
  ready: 'Готово к работе',
  running: 'В работе',
  blocked: 'Заблокировано',
  review: 'Ревью',
  done: 'Завершено',
  archived: 'Архив',
};

const COLUMN_ORDER = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
];

function labelFor(name: string): string {
  return COLUMN_LABELS[name] ?? name;
}

function sortColumns(cols: KColumn[]): KColumn[] {
  return cols.slice().sort((a, b) => {
    const ia = COLUMN_ORDER.indexOf(a.name);
    const ib = COLUMN_ORDER.indexOf(b.name);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

export default function AgentKanbanPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { token, loading, error } = useAuth();

  const [data, setData] = useState<KanbanResponse | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !id) return;
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/kanban`, {
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
      const j = (await res.json()) as KanbanResponse;
      setData(j);
      setFetchErr(null);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
    }
  }, [token, id]);

  useEffect(() => {
    load();
  }, [load]);

  // Live-poll only while the board is reachable (avoid hammering an offline box).
  const reachable = !!data && !data.error;
  useEffect(() => {
    if (!reachable) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [reachable, load]);

  const columns = data?.columns ? sortColumns(data.columns) : [];
  const workers = data?.workers ?? [];
  const totalTasks = columns.reduce((n, c) => n + c.tasks.length, 0);

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href={`/agents/${id}`} className="tma-back-link">
          ← К агенту
        </Link>

        <header className="tma-header">
          <p
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 11,
              color: 'var(--ink-faint)',
              margin: 0,
            }}
          >
            SWARM · READ-ONLY
          </p>
          <h1 className="tma-title">
            Канбан{' '}
            {/* Honest status pill — icon + word, never colour alone (DESIGN.md). */}
            <span
              className="tma-pill tma-pill--muted"
              style={{ verticalAlign: 'middle' }}
            >
              ⚗ R&amp;D · только просмотр
            </span>
          </h1>
          <p className="tma-subtitle">
            Доска задач вашего подключённого Hermes. Только просмотр — задачами
            управляет сам Hermes.
          </p>
        </header>

        {loading && (
          <section
            aria-hidden
            style={{ display: 'flex', gap: 12, overflowX: 'hidden', paddingBottom: 8 }}
          >
            {[0, 1, 2].map((c) => (
              <div
                key={c}
                style={{
                  flex: '0 0 78vw',
                  maxWidth: 320,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div className="aiag-skeleton tma-skel-block tma-skel-block--mid" />
                {[0, 1].map((t) => (
                  <div key={t} className="tma-skel-card" style={{ padding: 12 }}>
                    <div className="aiag-skeleton tma-skel-block tma-skel-block--wide" />
                    <div className="aiag-skeleton tma-skel-block tma-skel-block--mid" />
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
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

        {/* Empty state — agent is not a connected external Hermes. */}
        {data?.error === 'not_connected_hermes' && (
          <section className="tma-card" style={{ padding: 20 }}>
            <h2 className="tma-card-title">Подключите свой Hermes</h2>
            <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
              Канбан-доска доступна только для агентов, подключённых к вашему
              собственному Hermes-рантайму (внешний OpenAI-совместимый провайдер).
              Запустите Hermes на своём VPS и подключите его в настройках агента —
              его доску задач можно будет смотреть здесь.
            </p>
            <Link
              href={`/agents/${id}`}
              className="tma-btn tma-btn--primary"
              style={{ marginTop: 16, display: 'inline-block' }}
            >
              Настроить подключение
            </Link>
          </section>
        )}

        {/* Unreachable — connected, but the dashboard endpoint did not answer. */}
        {data?.error === 'hermes_unreachable' && (
          <section className="tma-card" style={{ padding: 20 }}>
            <h2 className="tma-card-title">Hermes недоступен</h2>
            <p className="tma-card-text tma-text-small" style={{ marginTop: 8 }}>
              Не удалось получить доску от вашего Hermes. Проверьте, что запущен{' '}
              <code>hermes dashboard</code> и его порт (по умолчанию{' '}
              <code>:9119</code>) доступен по тому же хосту, что и подключение
              агента.
            </p>
            <button
              type="button"
              onClick={load}
              className="tma-btn"
              style={{ marginTop: 16 }}
            >
              Повторить
            </button>
          </section>
        )}

        {/* Reachable board. */}
        {reachable && (
          <>
            {/* Metrics strip. */}
            <section
              style={{
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                padding: '12px 14px',
                border: '1px solid var(--line)',
                borderRadius: 8,
                background: 'var(--bg-surface)',
              }}
            >
              <Metric label="задач" value={totalTasks} />
              <Metric label="воркеров" value={workers.length} />
              <Metric label="колонок" value={columns.length} />
            </section>

            {/* Active workers. */}
            {workers.length > 0 && (
              <section className="tma-card" style={{ padding: 14 }}>
                <h2 className="tma-card-title">Активные воркеры</h2>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
                >
                  {workers.map((w) => (
                    <div
                      key={String(w.run_id) + w.task_id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--line)',
                        background: 'var(--bg-elev)',
                      }}
                    >
                      <span
                        aria-hidden
                        className="aiag-pulse-dot"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: 'var(--success)',
                          flex: '0 0 auto',
                          position: 'relative',
                          display: 'inline-block',
                        }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p
                          className="tma-card-text"
                          style={{
                            fontSize: 13,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {w.task_title ?? w.task_id}
                        </p>
                        <p
                          className="tma-card-text tma-text-small"
                          style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}
                        >
                          {w.profile ?? 'profile?'}
                          {w.worker_pid != null ? ` · pid ${w.worker_pid}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Columns. */}
            {totalTasks === 0 ? (
              <p className="tma-card-text" style={{ marginTop: 8 }}>
                На доске пока нет задач.
              </p>
            ) : (
              <section
                style={{
                  display: 'flex',
                  gap: 12,
                  overflowX: 'auto',
                  paddingBottom: 8,
                  marginTop: 4,
                }}
              >
                {columns.map((col) => (
                  <div
                    key={col.name}
                    style={{
                      flex: '0 0 78vw',
                      maxWidth: 320,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span
                        className="tma-card-text"
                        style={{ fontWeight: 600, fontSize: 13 }}
                      >
                        {labelFor(col.name)}
                      </span>
                      <span
                        className="tma-card-text tma-text-small"
                        style={{
                          fontFamily: 'var(--font-mono, monospace)',
                          opacity: 0.7,
                        }}
                      >
                        {col.tasks.length}
                      </span>
                    </div>

                    {col.tasks.length === 0 && (
                      <div
                        style={{
                          border: '1px dashed var(--line)',
                          borderRadius: 8,
                          padding: 12,
                          opacity: 0.5,
                        }}
                      >
                        <span className="tma-card-text tma-text-small">пусто</span>
                      </div>
                    )}

                    {col.tasks.map((t) => (
                      <TaskCard key={t.id} task={t} running={col.name === 'running'} />
                    ))}
                  </div>
                ))}
              </section>
            )}

            {data?.checked_at && (
              <p
                className="tma-card-text tma-text-small"
                style={{ opacity: 0.6, marginTop: 4 }}
              >
                Обновлено ~
                <code>{formatHHMMSS(data.checked_at)}</code> · автообновление 5с
              </p>
            )}
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 22,
          fontWeight: 600,
          color: 'var(--ink)',
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span className="tma-card-text tma-text-small" style={{ opacity: 0.7 }}>
        {label}
      </span>
    </div>
  );
}

function TaskCard({ task, running }: { task: KTask; running: boolean }) {
  return (
    <div
      style={{
        border: running ? '1px solid var(--accent)' : '1px solid var(--line)',
        borderRadius: 8,
        padding: 12,
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <p className="tma-card-text" style={{ fontSize: 13, lineHeight: 1.35 }}>
        {task.title}
      </p>
      {task.summary && (
        <p
          className="tma-card-text tma-text-small"
          style={{
            opacity: 0.7,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {task.summary}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
          opacity: 0.7,
        }}
      >
        {task.assignee && <span>@{task.assignee}</span>}
        {task.progress && (
          <span>
            {task.progress.done}/{task.progress.total}
          </span>
        )}
        {task.comment_count != null && task.comment_count > 0 && (
          <span>💬 {task.comment_count}</span>
        )}
        {task.worker_pid != null && <span>pid {task.worker_pid}</span>}
      </div>
    </div>
  );
}

/** Epoch seconds → local HH:MM:SS for the "обновлено ~" footer. */
function formatHHMMSS(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
