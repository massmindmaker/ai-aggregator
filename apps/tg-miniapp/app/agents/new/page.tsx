'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { AGENT_TEMPLATES, getTemplate } from '@/lib/agent-templates';

type ConnectionType = 'aiag' | 'external_openai';

interface TestResult {
  ok: boolean;
  models_count?: number;
  sample_model?: string;
  latency_ms?: number;
  reason?: string;
  detail?: string;
}

export default function NewAgentPage() {
  const router = useRouter();
  const { user, token, loading, error } = useAuth();
  const [pickedKind, setPickedKind] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  const [budget, setBudget] = useState(1000);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // External connection state
  const [connType, setConnType] = useState<ConnectionType>('aiag');
  const [extUrl, setExtUrl] = useState('');
  const [extKey, setExtKey] = useState('');
  const [extModel, setExtModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!pickedKind) return;
    const t = getTemplate(pickedKind);
    if (!t) return;
    setName(t.name);
    setSystemPrompt(t.systemPrompt);
    setModelSlug(t.defaultModelSlug);
  }, [pickedKind]);

  useEffect(() => {
    try {
      const slug = localStorage.getItem('aiag_selected_model_slug');
      if (slug) {
        setModelSlug(slug);
        localStorage.removeItem('aiag_selected_model_slug');
      }
    } catch {
      /* ignore */
    }
  }, [pickedKind]);

  async function handleTest() {
    if (!token) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/tg/api/tma/agents/test-connection', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          base_url: extUrl.trim(),
          api_key: extKey.trim(),
          model_slug: extModel.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => null)) as TestResult | null;
      setTestResult(body ?? { ok: false, reason: `HTTP ${res.status}` });
    } catch (err) {
      setTestResult({ ok: false, reason: 'network_error', detail: String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !pickedKind) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const payload: Record<string, unknown> = {
        template_kind: pickedKind,
        name: name.trim(),
        system_prompt: systemPrompt.trim(),
        budget_rub_monthly: budget,
        connection_type: connType,
      };
      if (connType === 'external_openai') {
        payload.external_base_url = extUrl.trim();
        payload.external_api_key = extKey.trim();
        payload.external_model_slug = extModel.trim() || undefined;
      } else {
        payload.model_slug = modelSlug.trim() || undefined;
      }
      const res = await fetch('/tg/api/tma/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
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

  const externalReadyToSave =
    connType === 'aiag' ||
    (testResult?.ok === true && extUrl.trim().length > 8 && extKey.trim().length > 8);

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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
                  <p className="tma-card-text" style={{ fontSize: 12 }}>{t.description}</p>
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

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

              {/* Connection picker */}
              <div className="tma-card" style={{ padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={() => setConnType('aiag')}
                    className={`tma-btn${connType === 'aiag' ? ' tma-btn--primary' : ''}`}
                    style={{ flex: 1 }}
                  >
                    AIAG модели
                  </button>
                  <button
                    type="button"
                    onClick={() => setConnType('external_openai')}
                    className={`tma-btn${connType === 'external_openai' ? ' tma-btn--primary' : ''}`}
                    style={{ flex: 1 }}
                  >
                    🌐 Свой агент
                  </button>
                </div>

                {connType === 'aiag' ? (
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
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">URL (OpenAI-совместимый, https)</span>
                      <input
                        type="url"
                        value={extUrl}
                        onChange={(e) => { setExtUrl(e.target.value); setTestResult(null); }}
                        placeholder="https://my-agent.example.com/v1"
                        style={inputStyle}
                        required
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">API-ключ</span>
                      <input
                        type="password"
                        value={extKey}
                        onChange={(e) => { setExtKey(e.target.value); setTestResult(null); }}
                        placeholder="sk-..."
                        style={inputStyle}
                        required
                        autoComplete="off"
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Модель (если у эндпоинта несколько)</span>
                      <input
                        type="text"
                        value={extModel}
                        onChange={(e) => setExtModel(e.target.value)}
                        placeholder="gpt-4o-mini / llama3.1 / etc"
                        style={inputStyle}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={handleTest}
                      className="tma-btn"
                      disabled={testing || extUrl.trim().length < 8 || extKey.trim().length < 8}
                    >
                      {testing ? 'Проверяю…' : 'Проверить соединение'}
                    </button>
                    {testResult && (
                      <div
                        className={testResult.ok ? 'tma-card' : 'tma-error'}
                        style={{ padding: 10, fontSize: 13 }}
                      >
                        {testResult.ok ? (
                          <>
                            ✓ Подключение работает. {testResult.models_count != null && (
                              <>Моделей: {testResult.models_count}. </>
                            )}
                            {testResult.sample_model && (
                              <>Пример: <code>{testResult.sample_model}</code>. </>
                            )}
                            {testResult.latency_ms != null && <>Лат: {testResult.latency_ms} мс.</>}
                          </>
                        ) : (
                          <>
                            ✗ {testResult.reason}
                            {testResult.detail && <div style={{ opacity: 0.7, marginTop: 4 }}>{testResult.detail}</div>}
                          </>
                        )}
                      </div>
                    )}
                    <p className="tma-card-text" style={{ fontSize: 12, opacity: 0.7 }}>
                      Ключ хранится в зашифрованном виде. Оплата моделей — по вашему API-ключу,
                      AIAG не списывает с баланса за эти запросы.
                    </p>
                  </div>
                )}
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Бюджет AIAG, ₽/мес (для tools — image_gen и др.)</span>
                <input
                  type="number"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                  min={0}
                  step={100}
                  style={inputStyle}
                />
              </label>

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
                  disabled={submitting || !externalReadyToSave}
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
