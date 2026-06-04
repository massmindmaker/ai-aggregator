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
  tools: unknown;
  connection_type?: string;
  external_base_url?: string | null;
  external_api_key_hint?: string | null;
  external_model_slug?: string | null;
  mcp_endpoint_url?: string | null;
  mcp_auth_set?: boolean;
  mcp_oauth_set?: boolean;
  mcp_oauth_scope?: string | null;
}

// Tools implemented by the agent-worker (apps/agent-worker/src/tools.ts).
const AVAILABLE_TOOLS: { id: string; label: string }[] = [
  { id: 'web_search', label: 'Веб-поиск' },
  { id: 'calc', label: 'Калькулятор' },
  { id: 'image_gen', label: 'Генерация картинок' },
  { id: 'memory', label: 'Память' },
];

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

interface Schedule {
  id: string;
  agent_id: string;
  prompt: string;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
}

// Interval presets (minutes). Floor is 15m — mirrors the API + migration CHECK.
const SCHEDULE_INTERVALS: { value: number; label: string }[] = [
  { value: 15, label: 'каждые 15 минут' },
  { value: 60, label: 'каждый час' },
  { value: 360, label: 'каждые 6 часов' },
  { value: 1440, label: 'каждые 24 часа' },
];

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

  // ---- publish-as-template ----
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  // Empty = free template (price_credits NULL). Else a positive integer (credits).
  const [pPrice, setPPrice] = useState('');

  // ---- edit mode ----
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eDescription, setEDescription] = useState('');
  const [eSystemPrompt, setESystemPrompt] = useState('');
  const [eModelSlug, setEModelSlug] = useState('');
  const [eBudget, setEBudget] = useState(0);
  const [eTools, setETools] = useState<string[]>([]);
  // connection editing
  const [providers, setProviders] = useState<
    { id: string; name: string; apiBase: string | null; requiresBaseUrl: boolean }[]
  >([]);
  const [connSel, setConnSel] = useState(''); // '' = не менять; 'aiag' = шлюз; <id> = провайдер
  const [connKey, setConnKey] = useState('');
  const [connUrl, setConnUrl] = useState('');
  const [connModel, setConnModel] = useState('');
  // MCP (skills) editing. mcpSel: '' = не менять; 'clear' = отключить; 'set' = задать новый.
  const [mcpSel, setMcpSel] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpAuth, setMcpAuth] = useState('');
  // MCP OAuth (R19). oauthUrl + oauthClientId feed the /start call → openLink out.
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthErr, setOauthErr] = useState<string | null>(null);

  // ---- schedule (self-running agent) ----
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [schPrompt, setSchPrompt] = useState('');
  const [schInterval, setSchInterval] = useState(1440);
  const [schEnabled, setSchEnabled] = useState(true);
  const [schSaving, setSchSaving] = useState(false);
  const [schErr, setSchErr] = useState<string | null>(null);

  const runActive = runs.some((r) => r.status === 'pending' || r.status === 'running');

  function startEdit() {
    if (!agent) return;
    setEName(agent.name);
    setEDescription(agent.description ?? '');
    setESystemPrompt(agent.system_prompt);
    setEModelSlug(agent.model_slug ?? '');
    setEBudget(Number(agent.budget_rub_monthly));
    setETools(Array.isArray(agent.tools) ? (agent.tools as string[]) : []);
    setConnSel('');
    setConnKey('');
    setConnUrl('');
    setConnModel('');
    setMcpSel('');
    setMcpUrl('');
    setMcpAuth('');
    setOauthUrl(agent.mcp_endpoint_url ?? '');
    setOauthClientId('');
    setOauthErr(null);
    setEditErr(null);
    setEditing(true);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id) return;
    setSaving(true);
    setEditErr(null);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: eName.trim(),
          description: eDescription.trim(),
          system_prompt: eSystemPrompt.trim(),
          model_slug: eModelSlug.trim(),
          budget_rub_monthly: eBudget,
          tools: eTools,
          // Connection change is opt-in: 'aiag' → back to gateway; a provider id →
          // BYOK (external_openai, 0 commission); '' → leave connection untouched.
          ...(connSel === 'aiag'
            ? { reset_connection: true }
            : connSel
              ? {
                  provider_id: connSel,
                  external_api_key: connKey.trim(),
                  external_base_url: providers.find((p) => p.id === connSel)?.requiresBaseUrl
                    ? connUrl.trim()
                    : undefined,
                  external_model_slug: connModel.trim() || undefined,
                }
              : {}),
          // MCP change is opt-in: 'clear' → detach the MCP server; 'set' → attach a new
          // URL (+ optional auth); '' → leave the MCP columns untouched.
          ...(mcpSel === 'clear'
            ? { reset_mcp: true }
            : mcpSel === 'set'
              ? {
                  mcp_endpoint_url: mcpUrl.trim(),
                  mcp_auth: mcpAuth.trim() || undefined,
                }
              : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setEditErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.agent) setAgent(data.agent);
      setEditing(false);
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  // MCP OAuth (R19): call /start, then openLink() the authorize URL out to the
  // system browser (the consent screen needs a real address bar; the webview
  // can't catch the callback). The PKCE verifier + state live server-side.
  async function handleMcpOauth() {
    if (!token || !id) return;
    const server = oauthUrl.trim();
    const clientId = oauthClientId.trim();
    if (!server || !clientId) {
      setOauthErr('Укажите URL MCP-сервера и client_id');
      return;
    }
    setOauthBusy(true);
    setOauthErr(null);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/mcp-oauth/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ server_url: server, client_id: clientId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        authorize_url?: string;
        error?: string;
      };
      if (!res.ok || !data.authorize_url) {
        setOauthErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const tg = (window as unknown as { Telegram?: { WebApp?: { openLink?: (u: string) => void } } })
        .Telegram?.WebApp;
      if (tg?.openLink) {
        tg.openLink(data.authorize_url);
      } else {
        window.open(data.authorize_url, '_blank');
      }
    } catch (err) {
      setOauthErr(err instanceof Error ? err.message : 'oauth_failed');
    } finally {
      setOauthBusy(false);
    }
  }

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
    if (!token) return;
    fetch('/tg/api/tma/providers', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((j) => setProviders(Array.isArray(j.providers) ? j.providers : []))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token || !id) return;
    fetch(`/tg/api/tma/agents/${id}/schedule`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { schedule: null }))
      .then((j) => {
        const s: Schedule | null = j.schedule ?? null;
        setSchedule(s);
        if (s) {
          setSchPrompt(s.prompt);
          setSchInterval(s.interval_minutes);
          setSchEnabled(s.enabled);
        }
      })
      .catch(() => {});
  }, [token, id]);

  async function handleSaveSchedule(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id || !schPrompt.trim()) return;
    setSchSaving(true);
    setSchErr(null);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/schedule`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prompt: schPrompt.trim(),
          interval_minutes: schInterval,
          enabled: schEnabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSchErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setSchedule(data.schedule ?? null);
    } catch (err) {
      setSchErr(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSchSaving(false);
    }
  }

  async function handleDeleteSchedule() {
    if (!token || !id) return;
    setSchSaving(true);
    setSchErr(null);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/schedule`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSchedule(null);
        setSchPrompt('');
        setSchEnabled(true);
      } else {
        setSchErr(`HTTP ${res.status}`);
      }
    } catch (err) {
      setSchErr(err instanceof Error ? err.message : 'delete_failed');
    } finally {
      setSchSaving(false);
    }
  }

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

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id) return;
    setPublishing(true);
    setPublishErr(null);
    // Empty price → free template (NULL). Else a positive integer in credits.
    let price: number | null = null;
    const trimmed = pPrice.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n <= 0) {
        setPublishErr('Цена — целое число кредитов больше нуля (или оставьте пусто)');
        setPublishing(false);
        return;
      }
      price = n;
    }
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ price_credits: price }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setPublishErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setPublishedId(data.template_id ?? null);
      setPublishOpen(false);
    } catch (err) {
      setPublishErr(err instanceof Error ? err.message : 'publish_failed');
    } finally {
      setPublishing(false);
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

        {agent && !editing && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">{agent.name}</h1>
              {agent.description && (
                <p className="tma-subtitle">{agent.description}</p>
              )}
              {agent.model_slug && (
                <p className="tma-subtitle">
                  <code>{agent.model_slug}</code> · {Number(agent.budget_rub_monthly).toFixed(0)} кр/мес
                </p>
              )}
            </header>

            <button
              type="button"
              onClick={startEdit}
              className="tma-btn"
              disabled={runActive}
              title={runActive ? 'Дождитесь завершения запуска' : undefined}
            >
              {runActive ? 'Идёт запуск — редактирование недоступно' : '✎ Редактировать'}
            </button>

            {/* Канбан/swarm — read-only board of the user's connected Hermes.
                Only meaningful for an external_openai (connect-your-own-Hermes)
                agent; the page itself shows an honest empty state otherwise. */}
            {agent.connection_type === 'external_openai' && (
              <Link href={`/agents/${id}/kanban`} className="tma-btn">
                ▤ Канбан (swarm)
              </Link>
            )}

            {/* Publish as a public template — shares the spec (no keys/data). */}
            {publishedId ? (
              <div className="tma-success">
                Опубликовано как шаблон.{' '}
                <Link
                  href={`/templates/${publishedId}`}
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                >
                  Открыть
                </Link>
              </div>
            ) : !publishOpen ? (
              <button
                type="button"
                onClick={() => {
                  setPublishErr(null);
                  setPublishOpen(true);
                }}
                className="tma-btn"
              >
                ⤴ Опубликовать как шаблон
              </button>
            ) : (
              <form onSubmit={handlePublish} className="tma-card" style={{ padding: 16 }}>
                <h2 className="tma-card-title">Опубликовать как шаблон</h2>
                <p className="tma-card-text tma-text-small">
                  Поделитесь настройкой агента. Ключи, память и история не
                  передаются — только спек.
                </p>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Цена аренды, кр (пусто = бесплатно)</span>
                  <input
                    type="number"
                    value={pPrice}
                    onChange={(ev) => setPPrice(ev.target.value)}
                    min={1}
                    step={1}
                    placeholder="бесплатно"
                    style={editInputStyle}
                  />
                </label>
                {pPrice.trim() && (
                  <p className="tma-card-text tma-text-small">
                    Платная аренда появится позже — пока другие смогут клонировать
                    только бесплатные шаблоны.
                  </p>
                )}
                {publishErr && <div className="tma-error">Ошибка: {publishErr}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setPublishOpen(false)}
                    className="tma-btn"
                    disabled={publishing}
                  >
                    Отмена
                  </button>
                  <button
                    type="submit"
                    className="tma-btn tma-btn--primary"
                    disabled={publishing}
                    style={{ flex: 1 }}
                  >
                    {publishing ? 'Публикация…' : 'Опубликовать'}
                  </button>
                </div>
              </form>
            )}

            <section className="tma-card">
              <h2 className="tma-card-title">System prompt</h2>
              <p
                className="tma-card-text"
                style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}
              >
                {agent.system_prompt}
              </p>
            </section>

            {/* Расписание — агент запускает сам себя по интервалу. Каждый запуск
                списывается как обычный (в рамках дневного бюджета). */}
            <section className="tma-card" style={{ padding: 16 }}>
              <h2 className="tma-card-title">⏰ Расписание</h2>
              <p className="tma-card-text tma-text-small">
                Агент сам запускается по расписанию с этим заданием. Каждый запуск
                тратит кредиты в рамках дневного лимита — как обычный запуск.
              </p>

              {schedule?.enabled && (
                <p className="tma-card-text tma-text-small" style={{ marginTop: 4 }}>
                  Активно ·{' '}
                  {SCHEDULE_INTERVALS.find((i) => i.value === schedule.interval_minutes)?.label ??
                    `каждые ${schedule.interval_minutes} мин`}{' '}
                  · следующий запуск ~<code>{formatHHMM(schedule.next_run_at)}</code>
                </p>
              )}
              {schedule && !schedule.enabled && (
                <p className="tma-card-text tma-text-small" style={{ marginTop: 4 }}>
                  Выключено.
                </p>
              )}

              <form
                onSubmit={handleSaveSchedule}
                style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Задание для запуска</span>
                  <textarea
                    value={schPrompt}
                    onChange={(e) => setSchPrompt(e.target.value)}
                    rows={3}
                    maxLength={16000}
                    placeholder="Например: собери утренний дайджест новостей по теме X"
                    style={{ ...editInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Частота</span>
                  <select
                    value={schInterval}
                    onChange={(e) => setSchInterval(Number(e.target.value))}
                    style={editInputStyle}
                  >
                    {SCHEDULE_INTERVALS.map((i) => (
                      <option key={i.value} value={i.value}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={schEnabled}
                    onChange={(e) => setSchEnabled(e.target.checked)}
                  />
                  <span className="tma-card-text">Включить расписание</span>
                </label>

                {schErr && <div className="tma-error">Ошибка: {schErr}</div>}

                <div style={{ display: 'flex', gap: 8 }}>
                  {schedule && (
                    <button
                      type="button"
                      onClick={handleDeleteSchedule}
                      className="tma-btn"
                      disabled={schSaving}
                    >
                      Удалить
                    </button>
                  )}
                  <button
                    type="submit"
                    className="tma-btn tma-btn--primary"
                    disabled={schSaving || !schPrompt.trim()}
                    style={{ flex: 1 }}
                  >
                    {schSaving ? 'Сохранение…' : schedule ? 'Сохранить' : 'Создать расписание'}
                  </button>
                </div>
              </form>
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

        {agent && editing && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">Редактирование</h1>
              <p className="tma-subtitle">{agent.name}</p>
            </header>

            <form
              onSubmit={handleSaveEdit}
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Имя</span>
                <input
                  type="text"
                  value={eName}
                  onChange={(e) => setEName(e.target.value)}
                  required
                  maxLength={200}
                  style={editInputStyle}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Описание</span>
                <input
                  type="text"
                  value={eDescription}
                  onChange={(e) => setEDescription(e.target.value)}
                  maxLength={500}
                  style={editInputStyle}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">System prompt</span>
                <textarea
                  value={eSystemPrompt}
                  onChange={(e) => setESystemPrompt(e.target.value)}
                  required
                  rows={8}
                  maxLength={8000}
                  style={{ ...editInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Модель (slug OpenRouter)</span>
                <input
                  type="text"
                  value={eModelSlug}
                  onChange={(e) => setEModelSlug(e.target.value)}
                  placeholder="anthropic/claude-3.5-sonnet"
                  style={editInputStyle}
                />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="tma-card-text">Инструменты</span>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: 12,
                    background: 'var(--bg-surface)',
                  }}
                >
                  {AVAILABLE_TOOLS.map((tool) => {
                    const checked = eTools.includes(tool.id);
                    return (
                      <label
                        key={tool.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(ev) =>
                            setETools((prev) =>
                              ev.target.checked
                                ? [...prev, tool.id]
                                : prev.filter((t) => t !== tool.id),
                            )
                          }
                        />
                        <span className="tma-card-text">{tool.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Бюджет, кр/мес</span>
                <input
                  type="number"
                  value={eBudget}
                  onChange={(e) => setEBudget(Number(e.target.value))}
                  min={0}
                  step={100}
                  style={editInputStyle}
                />
              </label>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  background: 'var(--bg-surface)',
                }}
              >
                <span className="tma-card-text" style={{ fontWeight: 600 }}>
                  Подключение
                </span>
                <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -4 }}>
                  Сейчас:{' '}
                  {agent.connection_type === 'external_openai'
                    ? `свой провайдер${agent.external_api_key_hint ? ` (${agent.external_api_key_hint})` : ''} · 0 комиссии`
                    : 'наш шлюз (с наценкой)'}
                </p>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Сменить на</span>
                  <select
                    value={connSel}
                    onChange={(e) => setConnSel(e.target.value)}
                    style={editInputStyle}
                  >
                    <option value="">— не менять —</option>
                    <option value="aiag">Наш шлюз (с наценкой)</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — свой ключ, 0 комиссии
                      </option>
                    ))}
                  </select>
                </label>
                {connSel && connSel !== 'aiag' && (
                  <>
                    {providers.find((p) => p.id === connSel)?.requiresBaseUrl && (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span className="tma-card-text">URL</span>
                        <input
                          type="url"
                          value={connUrl}
                          onChange={(e) => setConnUrl(e.target.value)}
                          placeholder="https://example.com/v1"
                          style={editInputStyle}
                        />
                      </label>
                    )}
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">API key (введи заново)</span>
                      <input
                        type="password"
                        value={connKey}
                        onChange={(e) => setConnKey(e.target.value)}
                        placeholder="sk-…"
                        autoComplete="off"
                        style={editInputStyle}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Модель (опционально)</span>
                      <input
                        type="text"
                        value={connModel}
                        onChange={(e) => setConnModel(e.target.value)}
                        placeholder="gpt-4o"
                        style={editInputStyle}
                      />
                    </label>
                  </>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  background: 'var(--bg-surface)',
                }}
              >
                <span className="tma-card-text" style={{ fontWeight: 600 }}>
                  🧩 MCP-сервер (скиллы)
                </span>
                <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -4 }}>
                  Сейчас:{' '}
                  {agent.mcp_endpoint_url
                    ? `подключён${
                        agent.mcp_oauth_set ? ' (OAuth)' : agent.mcp_auth_set ? ' (с auth)' : ''
                      } · ${agent.mcp_endpoint_url}`
                    : 'не подключён'}
                  {agent.mcp_oauth_set && agent.mcp_oauth_scope
                    ? ` · scope: ${agent.mcp_oauth_scope}`
                    : ''}
                </p>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Изменить</span>
                  <select
                    value={mcpSel}
                    onChange={(e) => setMcpSel(e.target.value)}
                    style={editInputStyle}
                  >
                    <option value="">— не менять —</option>
                    <option value="set">Задать новый MCP-сервер</option>
                    {agent.mcp_endpoint_url && <option value="clear">Отключить MCP</option>}
                  </select>
                </label>
                {mcpSel === 'set' && (
                  <>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">URL</span>
                      <input
                        type="url"
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder="https://mcp.example.com/mcp"
                        style={editInputStyle}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Auth-заголовок (опц.)</span>
                      <input
                        type="password"
                        value={mcpAuth}
                        onChange={(e) => setMcpAuth(e.target.value)}
                        placeholder="Bearer …"
                        autoComplete="off"
                        style={editInputStyle}
                      />
                    </label>
                  </>
                )}

                {/* MCP OAuth (R19) — авторизация по OAuth 2.1 + PKCE вместо статичного токена. */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 12,
                    marginTop: 4,
                  }}
                >
                  <span className="tma-card-text" style={{ fontWeight: 600, fontSize: 13 }}>
                    Войти через OAuth
                  </span>
                  <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -4 }}>
                    {agent.mcp_oauth_set
                      ? 'Подключено по OAuth. Можно переподключить.'
                      : 'Для серверов, защищённых OAuth 2.1. Откроется браузер для входа.'}
                  </p>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="tma-card-text">URL MCP-сервера</span>
                    <input
                      type="url"
                      value={oauthUrl}
                      onChange={(e) => setOauthUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      style={editInputStyle}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="tma-card-text">client_id</span>
                    <input
                      type="text"
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                      placeholder="client_id"
                      autoComplete="off"
                      style={editInputStyle}
                    />
                  </label>
                  {oauthErr && <div className="tma-error">Ошибка: {oauthErr}</div>}
                  <button
                    type="button"
                    onClick={handleMcpOauth}
                    className="tma-btn"
                    disabled={oauthBusy}
                  >
                    {oauthBusy ? 'Открываем…' : 'Войти через OAuth'}
                  </button>
                </div>
              </div>

              {editErr && <div className="tma-error">Ошибка: {editErr}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="tma-btn"
                  disabled={saving}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="tma-btn tma-btn--primary"
                  disabled={saving}
                  style={{ flex: 1 }}
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            </form>
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}

/** Format an ISO timestamp as local HH:MM for the "next run ~HH:MM" hint. */
function formatHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const editInputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
};

const bubbleStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 12,
  maxWidth: '85%',
  fontSize: 14,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
