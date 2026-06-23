'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';
import { haptic } from '@/lib/haptics';

// ---- types (mirror GET /api/tma/me/schedules) ----
interface ScheduleRow {
  id: string;
  agent_id: string;
  agent_name: string;
  name: string | null;
  schedule_kind: 'interval' | 'daily' | 'weekly' | string;
  interval_minutes: number | null;
  at_time: string | null; // "HH:MM:SS"
  weekday: number | null; // 0=Sun..6=Sat
  enabled: boolean;
  next_run_at: string;
  prompt: string;
}

interface AgentLite {
  id: string;
  name: string;
}

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const INTERVAL_PRESETS: { value: number; label: string }[] = [
  { value: 15, label: 'каждые 15 минут' },
  { value: 60, label: 'каждый час' },
  { value: 360, label: 'каждые 6 часов' },
  { value: 1440, label: 'каждые 24 часа' },
];

/** Humanize the «когда» column from a schedule's kind + params. */
function humanizeWhen(s: ScheduleRow): string {
  if (s.schedule_kind === 'interval' && s.interval_minutes != null) {
    const m = s.interval_minutes;
    if (m % 1440 === 0) return `каждые ${m / 1440} сут`;
    if (m % 60 === 0) return `каждые ${m / 60} ч`;
    return `каждые ${m} мин`;
  }
  if (s.schedule_kind === 'daily' && s.at_time) {
    return `${hhmm(s.at_time)} ежедневно`;
  }
  if (s.schedule_kind === 'weekly' && s.at_time && s.weekday != null) {
    return `${WEEKDAYS[s.weekday] ?? '?'} ${hhmm(s.at_time)}`;
  }
  return '—';
}

/** "HH:MM:SS" or "HH:MM" → "HH:MM". */
function hhmm(t: string): string {
  return t.slice(0, 5);
}

/** ISO → local HH:MM for the "следующий ~" hint. */
function nextHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SchedulesPage() {
  const { token, loading: authLoading, error: authError } = useAuth();

  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ---- new-schedule form ----
  const [formOpen, setFormOpen] = useState(false);
  const [fAgent, setFAgent] = useState('');
  const [fName, setFName] = useState('');
  const [fKind, setFKind] = useState<'interval' | 'daily' | 'weekly'>('daily');
  const [fInterval, setFInterval] = useState(1440);
  const [fTime, setFTime] = useState('09:00');
  const [fWeekday, setFWeekday] = useState(1); // Пн
  const [fPrompt, setFPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [sRes, aRes] = await Promise.all([
        fetch('/tg/api/tma/me/schedules', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/tg/api/tma/agents', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (sRes.ok) {
        const j = (await sRes.json()) as { schedules?: ScheduleRow[] };
        setSchedules(Array.isArray(j.schedules) ? j.schedules : []);
      } else {
        setFetchErr(`HTTP ${sRes.status}`);
      }
      if (aRes.ok) {
        const j = (await aRes.json()) as { agents?: AgentLite[] };
        const list = Array.isArray(j.agents) ? j.agents.map((a) => ({ id: a.id, name: a.name })) : [];
        setAgents(list);
        if (list[0] && !fAgent) setFAgent(list[0].id);
      }
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(s: ScheduleRow) {
    if (!token) return;
    haptic.select();
    setBusyId(s.id);
    try {
      const res = await fetch(`/tg/api/tma/me/schedules/${s.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (res.ok) {
        setSchedules((prev) =>
          prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)),
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: ScheduleRow) {
    if (!token) return;
    setBusyId(s.id);
    try {
      const res = await fetch(`/tg/api/tma/me/schedules/${s.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    } finally {
      setBusyId(null);
    }
  }

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !fAgent || !fPrompt.trim()) return;
    setSaving(true);
    setFormErr(null);
    try {
      const body: Record<string, unknown> = {
        name: fName.trim() || undefined,
        prompt: fPrompt.trim(),
        schedule_kind: fKind,
        enabled: true,
      };
      if (fKind === 'interval') body.interval_minutes = fInterval;
      else {
        body.at_time = fTime;
        if (fKind === 'weekly') body.weekday = fWeekday;
      }
      const res = await fetch(`/tg/api/tma/agents/${fAgent}/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFormErr(j.error ?? `HTTP ${res.status}`);
        return;
      }
      // Reset + collapse, then reload the list.
      setFormOpen(false);
      setFName('');
      setFPrompt('');
      await load();
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header" aria-hidden>
          <div className="aiag-skeleton tma-skel-block tma-skel-block--title" />
          <div className="aiag-skeleton tma-skel-block tma-skel-block--wide" />
        </header>
        <section aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="tma-skel-card">
              <div className="aiag-skeleton tma-skel-block tma-skel-block--title" />
              <div className="aiag-skeleton tma-skel-block tma-skel-block--mid" />
              <div className="aiag-skeleton tma-skel-block tma-skel-block--wide" />
            </div>
          ))}
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
          <p className="tma-card-text">Расписания доступны только в Telegram Mini App.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-badge">Расписания</span>
          <h1 className="tma-title">Запуски по расписанию</h1>
          <p className="tma-subtitle">
            Агент сам запускается по расписанию. Каждый запуск тратит кредиты в рамках
            дневного лимита агента — как обычный запуск.
          </p>
        </header>

        {/* Honest «скоро» — mention-reply needs the Hermes chat bridge, not built. */}
        <section className="tma-card" style={{ opacity: 0.6 }}>
          <div className="tma-row">
            <span className="tma-card-title">Ответ на упоминание</span>
            <span style={soonPillStyle}>скоро</span>
          </div>
          <p className="tma-card-text">
            Автоответ, когда агента упоминают в чате. Появится вместе с чат-мостом Hermes.
          </p>
        </section>

        {fetchErr && <div className="tma-error">Ошибка: {fetchErr}</div>}

        {schedules.length === 0 && (
          <section className="tma-card">
            <p className="tma-card-text">
              Пока нет расписаний. Создайте первое — выберите агента, время и задание.
            </p>
          </section>
        )}

        {schedules.length > 0 && (
        <div className="aiag-stagger" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {schedules.map((s) => (
          <section className="tma-card" key={s.id} style={{ gap: 10 }}>
            <div className="tma-row">
              <span className="tma-card-title">{s.name || s.agent_name}</span>
              <button
                type="button"
                onClick={() => toggle(s)}
                disabled={busyId === s.id}
                className="tma-btn"
                style={{
                  padding: '4px 12px',
                  fontSize: 12,
                  color: s.enabled ? 'var(--accent-ink)' : 'var(--ink-muted)',
                  background: s.enabled ? 'var(--accent)' : 'transparent',
                  borderColor: s.enabled ? 'var(--accent)' : 'var(--line)',
                }}
              >
                {s.enabled ? 'вкл' : 'выкл'}
              </button>
            </div>

            <div className="tma-row">
              <span className="tma-card-text">Агент</span>
              <Link href={`/agents/${s.agent_id}`} className="tma-mono" style={{ fontSize: 13 }}>
                {s.agent_name}
              </Link>
            </div>

            <div className="tma-row">
              <span className="tma-card-text">Когда</span>
              <span className="tma-mono" style={{ fontSize: 13 }}>
                {humanizeWhen(s)}
              </span>
            </div>

            {s.enabled && (
              <div className="tma-row">
                <span className="tma-card-text">Следующий</span>
                <span className="tma-mono" style={{ fontSize: 13 }}>
                  ~{nextHHMM(s.next_run_at)}
                </span>
              </div>
            )}

            <p className="tma-card-text" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
              {s.prompt.length > 160 ? `${s.prompt.slice(0, 160)}…` : s.prompt}
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => remove(s)}
                disabled={busyId === s.id}
                className="tma-btn"
                style={{ padding: '4px 12px', fontSize: 12 }}
              >
                Удалить
              </button>
            </div>
          </section>
        ))}
        </div>
        )}

        {/* + Новое расписание */}
        {!formOpen ? (
          <button
            type="button"
            className="tma-btn tma-btn--primary"
            onClick={() => setFormOpen(true)}
            disabled={agents.length === 0}
          >
            {agents.length === 0 ? 'Сначала создайте агента' : '+ Новое расписание'}
          </button>
        ) : (
          <section className="tma-card">
            <h2 className="tma-card-title">Новое расписание</h2>
            <form
              onSubmit={createSchedule}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <label style={labelStyle}>
                <span className="tma-card-text">Агент</span>
                <select value={fAgent} onChange={(e) => setFAgent(e.target.value)} style={inputStyle}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>

              <label style={labelStyle}>
                <span className="tma-card-text">Название (необязательно)</span>
                <input
                  value={fName}
                  onChange={(e) => setFName(e.target.value)}
                  maxLength={120}
                  placeholder="Например: Утренний дайджест"
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                <span className="tma-card-text">Тип</span>
                <select
                  value={fKind}
                  onChange={(e) => setFKind(e.target.value as 'interval' | 'daily' | 'weekly')}
                  style={inputStyle}
                >
                  <option value="daily">Ежедневно в…</option>
                  <option value="weekly">Раз в неделю</option>
                  <option value="interval">По интервалу</option>
                </select>
              </label>

              {fKind === 'interval' && (
                <label style={labelStyle}>
                  <span className="tma-card-text">Частота</span>
                  <select
                    value={fInterval}
                    onChange={(e) => setFInterval(Number(e.target.value))}
                    style={inputStyle}
                  >
                    {INTERVAL_PRESETS.map((i) => (
                      <option key={i.value} value={i.value}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {(fKind === 'daily' || fKind === 'weekly') && (
                <label style={labelStyle}>
                  <span className="tma-card-text">Время (МСК)</span>
                  <input
                    type="time"
                    value={fTime}
                    onChange={(e) => setFTime(e.target.value)}
                    style={inputStyle}
                  />
                </label>
              )}

              {fKind === 'weekly' && (
                <label style={labelStyle}>
                  <span className="tma-card-text">День недели</span>
                  <select
                    value={fWeekday}
                    onChange={(e) => setFWeekday(Number(e.target.value))}
                    style={inputStyle}
                  >
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <option key={d} value={d}>
                        {WEEKDAYS[d]}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label style={labelStyle}>
                <span className="tma-card-text">Задание</span>
                <textarea
                  value={fPrompt}
                  onChange={(e) => setFPrompt(e.target.value)}
                  rows={3}
                  maxLength={16000}
                  placeholder="Например: собери утренний дайджест новостей по теме X"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>

              {formErr && <div className="tma-error">Ошибка: {formErr}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="tma-btn"
                  onClick={() => setFormOpen(false)}
                  disabled={saving}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="tma-btn tma-btn--primary"
                  disabled={saving || !fAgent || !fPrompt.trim()}
                  style={{ flex: 1 }}
                >
                  {saving ? 'Сохранение…' : 'Создать'}
                </button>
              </div>
            </form>
          </section>
        )}
      </main>
      <BottomNav />
    </>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
};

// Honest «скоро» pill — icon-word, never colour-alone (DESIGN.md status-pill rule).
const soonPillStyle: React.CSSProperties = {
  padding: '2px 10px',
  borderRadius: 999,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink-muted)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};
