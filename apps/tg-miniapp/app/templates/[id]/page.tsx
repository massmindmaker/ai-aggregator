'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';

interface Template {
  id: string;
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  model_slug: string | null;
  tools: unknown;
  mcp_endpoint_url: string | null;
  suggested_skills: unknown;
  price_credits: string | null;
  visibility: string;
  fork_parent_id: string | null;
  clone_count: number;
  author_tg_user_id: string;
  created_at: string;
}

function priceLabel(price: string | null): string {
  if (price === null) return 'бесплатно';
  const n = Number(price);
  if (!Number.isFinite(n)) return 'бесплатно';
  return `${n} кр`;
}

export default function TemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { token, loading, error } = useAuth();

  const [template, setTemplate] = useState<Template | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  // Set when the clone route answers 402 — paid author-rent isn't built yet (Slice 2).
  const [rentLocked, setRentLocked] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}`);
      if (res.status === 404) {
        setFetchErr('Шаблон не найден');
        return;
      }
      if (!res.ok) {
        setFetchErr(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setTemplate(data.template);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'fetch_failed');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isPaid = template ? template.price_credits !== null : false;
  const cloneDisabled = cloning || rentLocked || isPaid;

  async function handleClone() {
    if (!token || !id) return;
    setCloning(true);
    setCloneErr(null);
    try {
      const res = await fetch(`/tg/api/tma/templates/${id}/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 402) {
        // rent_not_available_yet — honest UI: paid rent is "скоро".
        setRentLocked(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCloneErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.agent_id) {
        router.push(`/agents/${data.agent_id}`);
        return;
      }
      setCloneErr('clone_failed');
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : 'clone_failed');
    } finally {
      setCloning(false);
    }
  }

  const tools = Array.isArray(template?.tools) ? (template!.tools as unknown[]) : [];

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <Link href="/templates" className="tma-back-link">
          ← К шаблонам
        </Link>

        {fetchErr && <div className="tma-error">{fetchErr}</div>}

        {template && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">{template.name ?? 'Без имени'}</h1>
              {template.description && (
                <p className="tma-subtitle">{template.description}</p>
              )}
              <div className="tma-row" style={{ marginTop: 4 }}>
                <span
                  className={isPaid ? 'tma-price-strong' : 'tma-nft-supply'}
                  style={isPaid ? { fontVariantNumeric: 'tabular-nums' } : undefined}
                >
                  {priceLabel(template.price_credits)}
                </span>
                <span className="tma-mono">⧉ {template.clone_count} клонов</span>
              </div>
            </header>

            {/* Clone CTA — the one primary action on this screen. */}
            <button
              type="button"
              onClick={handleClone}
              disabled={cloneDisabled || loading || !!error}
              className="tma-btn tma-btn--primary"
              title={
                isPaid || rentLocked
                  ? 'Платная аренда шаблонов появится позже'
                  : undefined
              }
            >
              {cloning
                ? 'Клонирование…'
                : isPaid || rentLocked
                  ? 'Скоро: аренда'
                  : 'Клонировать'}
            </button>

            {(isPaid || rentLocked) && (
              <div className="tma-card" style={{ padding: 14 }}>
                <p className="tma-card-text">
                  Автор задал цену аренды этого шаблона. Платная аренда ещё не
                  запущена — пока можно клонировать только бесплатные шаблоны.
                </p>
              </div>
            )}

            {!loading && error && (
              <p className="tma-card-text">
                {error === 'Не открыто в Telegram'
                  ? 'Откройте через @aiag_bot, чтобы клонировать'
                  : `Ошибка: ${error}`}
              </p>
            )}

            {cloneErr && <div className="tma-error">Ошибка: {cloneErr}</div>}

            {template.model_slug && (
              <section className="tma-card">
                <h2 className="tma-card-title">Модель</h2>
                <p className="tma-card-text">
                  <code>{template.model_slug}</code>
                </p>
              </section>
            )}

            {template.system_prompt && (
              <section className="tma-card">
                <h2 className="tma-card-title">System prompt</h2>
                <p
                  className="tma-card-text"
                  style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}
                >
                  {template.system_prompt}
                </p>
              </section>
            )}

            {(tools.length > 0 || template.mcp_endpoint_url) && (
              <section className="tma-card">
                <h2 className="tma-card-title">Что внутри</h2>
                {tools.length > 0 && (
                  <ul className="tma-list">
                    {tools.map((t, i) => (
                      <li key={i}>{String(t)}</li>
                    ))}
                  </ul>
                )}
                {template.mcp_endpoint_url && (
                  <p className="tma-card-text tma-text-small">
                    MCP-сервер: <code>{template.mcp_endpoint_url}</code>
                  </p>
                )}
              </section>
            )}

            <p className="tma-card-text tma-text-small">
              При клонировании настройки переносятся к вам. Ключи и приватные
              данные автора не передаются — подключение настраиваете сами.
            </p>
          </>
        )}
      </main>
      <BottomNav />
    </>
  );
}
