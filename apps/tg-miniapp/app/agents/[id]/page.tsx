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

        {agent && !editing && (
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

            <button
              type="button"
              onClick={startEdit}
              className="tma-btn"
              disabled={runActive}
              title={runActive ? 'Дождитесь завершения запуска' : undefined}
            >
              {runActive ? 'Идёт запуск — редактирование недоступно' : '✎ Редактировать'}
            </button>

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
                <span className="tma-card-text">Бюджет, ₽/мес</span>
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
