'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { AGENT_TEMPLATES, getTemplate } from '@/lib/agent-templates';

// Tools actually implemented by the agent-worker (apps/agent-worker/src/tools.ts).
const AVAILABLE_TOOLS: { id: string; label: string; hint: string }[] = [
  { id: 'web_search', label: 'Веб-поиск', hint: 'Поиск актуальной информации в интернете' },
  { id: 'calc', label: 'Калькулятор', hint: 'Точные арифметические вычисления' },
  { id: 'image_gen', label: 'Генерация картинок', hint: 'Картинка по текстовому описанию' },
  { id: 'memory', label: 'Память', hint: 'Запоминает факты между запусками' },
];
const AVAILABLE_TOOL_IDS = new Set(AVAILABLE_TOOLS.map((t) => t.id));

export default function NewAgentPage() {
  const router = useRouter();
  const { user, token, loading, error } = useAuth();
  const [pickedKind, setPickedKind] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [budget, setBudget] = useState(1000);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // "Свой агент" — Path 1 (external OpenAI-compatible endpoint)
  const [useExternal, setUseExternal] = useState(false);
  const [extBaseUrl, setExtBaseUrl] = useState('');
  const [extApiKey, setExtApiKey] = useState('');
  const [extModelSlug, setExtModelSlug] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; status?: number; model_count?: number; sample_models?: string[] }
    | { ok: false; reason: string }
    | null
  >(null);

  // Provider picker (catalog BYOK) — fetched from /tg/api/tma/providers.
  const [providers, setProviders] = useState<
    { id: string; name: string; apiBase: string | null; requiresBaseUrl: boolean }[]
  >([]);
  const [providerId, setProviderId] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpAuth, setMcpAuth] = useState('');

  async function handleTest() {
    if (!token) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/tg/api/tma/agents/test-external', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          base_url: (() => {
            const sel = providers.find((p) => p.id === providerId);
            return sel?.requiresBaseUrl ? extBaseUrl.trim() : (sel?.apiBase ?? '');
          })(),
          api_key: extApiKey.trim(),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setTestResult({
          ok: true,
          status: j.status,
          model_count: j.model_count,
          sample_models: j.sample_models,
        });
      } else {
        setTestResult({
          ok: false,
          reason: j.error ?? j.reason ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        reason: err instanceof Error ? err.message : 'test_failed',
      });
    } finally {
      setTesting(false);
    }
  }

  // Prefill form when template chosen
  useEffect(() => {
    if (!pickedKind) return;
    const t = getTemplate(pickedKind);
    if (!t) return;
    setName(t.name);
    setSystemPrompt(t.systemPrompt);
    setModelSlug(t.defaultModelSlug);
    // Seed from template, keeping only tools the worker actually implements
    // (e.g. code_interpreter is suggested by some templates but unimplemented).
    setTools(t.suggestedTools.filter((id) => AVAILABLE_TOOL_IDS.has(id)));
  }, [pickedKind]);

  // Handoff from /market/[slug] — pre-fill modelSlug from localStorage
  useEffect(() => {
    try {
      const slug = localStorage.getItem('aiag_selected_model_slug');
      if (slug) {
        setModelSlug(slug);
        localStorage.removeItem('aiag_selected_model_slug');
      }
    } catch {
      // ignore
    }
  }, [pickedKind]);

  // Load the BYOK provider catalog once authenticated.
  useEffect(() => {
    if (!token) return;
    fetch('/tg/api/tma/providers', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((j) => setProviders(Array.isArray(j.providers) ? j.providers : []))
      .catch(() => {});
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !pickedKind) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const res = await fetch('/tg/api/tma/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          template_kind: pickedKind,
          name: name.trim(),
          system_prompt: systemPrompt.trim(),
          model_slug: modelSlug.trim() || undefined,
          tools,
          budget_rub_monthly: budget,
          mcp_endpoint_url: mcpUrl.trim() || undefined,
          mcp_auth: mcpAuth.trim() || undefined,
          // BYOK via the provider catalog → backend routes through external_openai
          // (worker isExternal=true → 0 commission). No provider chosen → our gateway.
          ...(useExternal && providerId
            ? {
                provider_id: providerId,
                external_api_key: extApiKey.trim(),
                external_base_url: providers.find((p) => p.id === providerId)?.requiresBaseUrl
                  ? extBaseUrl.trim()
                  : undefined,
                external_model_slug: extModelSlug.trim() || undefined,
              }
            : { connection_type: 'aiag' }),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      router.push(`/agents/${data.agent.id}`);
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : 'submit_failed');
    } finally {
      setSubmitting(false);
    }
  }

  const isCustomProvider =
    providers.find((p) => p.id === providerId)?.requiresBaseUrl ?? false;

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/agents" className="tma-back-link">
          ← Назад
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

        {user && !error && !pickedKind && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">Выберите шаблон</h1>
              <p className="tma-subtitle">Стартовая конфигурация — потом всё можно поправить.</p>
            </header>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
              }}
            >
              {AGENT_TEMPLATES.map((t) => (
                <button
                  key={t.kind}
                  type="button"
                  onClick={() => setPickedKind(t.kind)}
                  className="tma-card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: '1px solid var(--line)',
                  }}
                >
                  <div style={{ fontSize: 28 }}>{t.emoji}</div>
                  <h2 className="tma-card-title">{t.name}</h2>
                  <p className="tma-card-text" style={{ fontSize: 12 }}>
                    {t.description}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}

        {user && !error && pickedKind && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">{getTemplate(pickedKind)?.emoji} Новый агент</h1>
              <p className="tma-subtitle">Шаблон: {getTemplate(pickedKind)?.name}</p>
            </header>

            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Имя</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={200}
                  style={inputStyle}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">System prompt</span>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  required
                  rows={8}
                  maxLength={8000}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Модель (slug OpenRouter)</span>
                <input
                  type="text"
                  value={modelSlug}
                  onChange={(e) => setModelSlug(e.target.value)}
                  placeholder="anthropic/claude-3.5-sonnet"
                  style={inputStyle}
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
                    const checked = tools.includes(tool.id);
                    return (
                      <label
                        key={tool.id}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setTools((prev) =>
                              e.target.checked
                                ? [...prev, tool.id]
                                : prev.filter((t) => t !== tool.id),
                            )
                          }
                          style={{ marginTop: 2 }}
                        />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span className="tma-card-text" style={{ fontWeight: 600 }}>
                            {tool.label}
                          </span>
                          <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.65 }}>
                            {tool.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Бюджет, кр/мес</span>
                <input
                  type="number"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                  min={0}
                  step={100}
                  style={inputStyle}
                  disabled={useExternal}
                />
                {useExternal && (
                  <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                    Не применяется для своего агента — оплата у твоего провайдера.
                  </span>
                )}
              </label>

              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  background: 'var(--bg-surface)',
                }}
              >
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={useExternal}
                    onChange={(e) => {
                      setUseExternal(e.target.checked);
                      setTestResult(null);
                    }}
                  />
                  <span className="tma-card-text" style={{ fontWeight: 600 }}>
                    🌐 Свой провайдер / ключ — 0 комиссии
                  </span>
                </label>
                <p className="tma-card-text" style={{ fontSize: 12, opacity: 0.75, marginTop: -6 }}>
                  Выбери провайдера и принеси свой ключ (OpenAI, Anthropic, OpenRouter,
                  DeepSeek… или «Custom» — любой OpenAI-совместимый URL: Ollama, vLLM,
                  твой Hermes за прокси). Свой ключ — комиссия 0.
                </p>

                {useExternal && (
                  <>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Провайдер</span>
                      <select
                        value={providerId}
                        onChange={(e) => {
                          setProviderId(e.target.value);
                          setTestResult(null);
                        }}
                        style={inputStyle}
                        required={useExternal}
                      >
                        <option value="">— выбери провайдера —</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {isCustomProvider && (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span className="tma-card-text">URL</span>
                        <input
                          type="url"
                          value={extBaseUrl}
                          onChange={(e) => {
                            setExtBaseUrl(e.target.value);
                            setTestResult(null);
                          }}
                          placeholder="https://example.com/v1"
                          style={inputStyle}
                          required={isCustomProvider}
                        />
                      </label>
                    )}
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">API key</span>
                      <input
                        type="password"
                        value={extApiKey}
                        onChange={(e) => {
                          setExtApiKey(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder="sk-…"
                        style={inputStyle}
                        autoComplete="off"
                        required={useExternal}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Модель (опционально)</span>
                      <input
                        type="text"
                        value={extModelSlug}
                        onChange={(e) => setExtModelSlug(e.target.value)}
                        placeholder="например: llama-3.3-70b или gpt-4o"
                        style={inputStyle}
                      />
                      <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                        Если пусто — используется поле «Модель» выше.
                      </span>
                    </label>
                    <span className="tma-card-text" style={{ fontSize: 11, color: '#22c55e' }}>
                      Свой ключ — комиссия 0. Платишь напрямую своему провайдеру.
                    </span>
                    <button
                      type="button"
                      onClick={handleTest}
                      disabled={
                        testing ||
                        !providerId ||
                        !extApiKey.trim() ||
                        (isCustomProvider && !extBaseUrl.trim())
                      }
                      className="tma-btn"
                    >
                      {testing ? 'Проверяю…' : 'Проверить соединение'}
                    </button>
                    {testResult?.ok && (
                      <div
                        className="tma-card"
                        style={{ background: 'rgba(34,197,94,0.12)', borderColor: '#22c55e' }}
                      >
                        <p className="tma-card-text">
                          ✓ Endpoint работает{' '}
                          {testResult.model_count != null
                            ? `(моделей: ${testResult.model_count})`
                            : ''}
                        </p>
                        {testResult.sample_models && testResult.sample_models.length > 0 && (
                          <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7 }}>
                            Примеры: {testResult.sample_models.join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                    {testResult && !testResult.ok && (
                      <div className="tma-error">Не получилось: {testResult.reason}</div>
                    )}
                  </>
                )}
              </div>

              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  background: 'var(--bg-surface)',
                }}
              >
                <span className="tma-card-text" style={{ fontWeight: 600 }}>
                  🧩 MCP-сервер (скиллы) — опционально
                </span>
                <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -6 }}>
                  Подключи внешний MCP-сервер (https) — его инструменты станут доступны агенту.
                  Только удалённый Streamable-HTTP. Вызовы бесплатны (0 комиссии).
                </p>
                {/* C11: проверенные пресеты (2026-06) — клик заполняет URL; ручной ввод остаётся. */}
                <div className="tma-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { label: 'Notion', url: 'https://mcp.notion.com/mcp' },
                    { label: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
                    { label: 'Linear', url: 'https://mcp.linear.app/sse' },
                    { label: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
                  ].map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="tma-chip"
                      onClick={() => setMcpUrl(p.url)}
                      style={{
                        cursor: 'pointer',
                        ...(mcpUrl === p.url
                          ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                          : {}),
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">URL</span>
                  <input
                    type="url"
                    value={mcpUrl}
                    onChange={(e) => setMcpUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    style={inputStyle}
                  />
                </label>
                {mcpUrl.trim() && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="tma-card-text">Auth-заголовок (опц.)</span>
                    <input
                      type="password"
                      value={mcpAuth}
                      onChange={(e) => setMcpAuth(e.target.value)}
                      placeholder="Bearer …"
                      autoComplete="off"
                      style={inputStyle}
                    />
                  </label>
                )}
              </div>

              {submitErr && <div className="tma-error">Ошибка: {submitErr}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setPickedKind(null)}
                  className="tma-btn"
                  disabled={submitting}
                >
                  Назад к шаблонам
                </button>
                <button
                  type="submit"
                  className="tma-btn tma-btn--primary"
                  disabled={submitting}
                  style={{ flex: 1 }}
                >
                  {submitting ? 'Создание…' : 'Создать агента'}
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

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
};
