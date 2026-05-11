'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { AGENT_TEMPLATES, getTemplate } from '@/lib/agent-templates';

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

  // Prefill form when template chosen
  useEffect(() => {
    if (!pickedKind) return;
    const t = getTemplate(pickedKind);
    if (!t) return;
    setName(t.name);
    setSystemPrompt(t.systemPrompt);
    setModelSlug(t.defaultModelSlug);
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
          budget_rub_monthly: budget,
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

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Бюджет, ₽/мес</span>
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
