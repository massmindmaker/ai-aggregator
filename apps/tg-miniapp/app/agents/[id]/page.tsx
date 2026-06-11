'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { hueFor } from '@/components/AgentCard';
import { RunTrace } from '@/components/RunTrace';
import { Icon, ICONS } from '@/components/Icon';
import { fmtCredits, parseCreditsInput } from '@/lib/credits';
import { TransferPanel } from './TransferPanel';

interface Agent {
  id: string;
  template_kind: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model_slug: string | null;
  budget_rub_monthly: string;
  daily_budget_credits?: string;
  tools: unknown;
  connection_type?: string;
  external_base_url?: string | null;
  external_api_key_hint?: string | null;
  external_model_slug?: string | null;
  mcp_endpoint_url?: string | null;
  mcp_auth_set?: boolean;
  mcp_oauth_set?: boolean;
  mcp_oauth_scope?: string | null;
  transferable?: boolean;
  transfer_price_credits?: string | null;
  nft_address?: string | null;
}

// C11: проверенные MCP-пресеты (2026-06). Клик заполняет URL эндпоинта;
// авторизация — через существующий OAuth/токен-флоу. Ручной ввод остаётся.
const MCP_PRESETS: { label: string; url: string }[] = [
  { label: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { label: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  { label: 'Linear', url: 'https://mcp.linear.app/sse' },
  { label: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
];

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

// P1-6: локальная сегментация перегруженной страницы (useState, без роутинга).
type TabKey = 'dialog' | 'settings' | 'monetize' | 'schedule';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dialog', label: 'Диалог' },
  { key: 'settings', label: 'Настройки' },
  { key: 'monetize', label: 'Монетизация' },
  { key: 'schedule', label: 'Расписание' },
];

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { token, loading, error } = useAuth();

  const [agent, setAgent] = useState<Agent | null>(null);
  // P1-6: активный сегмент страницы («Диалог» по умолчанию).
  const [tab, setTab] = useState<TabKey>('dialog');
  // P1-6: реестр моделей (prod-таблица models) для пикера в настройках.
  const [models, setModels] = useState<{ slug: string; name: string }[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  // R2.1-A4: модельный тариф для подсказки цены ДО отправки (null = BYOK/нет данных).
  const [modelRate, setModelRate] = useState<{
    in_per_1m_credits: string;
    out_per_1m_credits: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  // P0-3: ошибка отправки живёт У КОМПОЗЕРА, а не в шапке страницы.
  const [sendErr, setSendErr] = useState<string | null>(null);
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
  // C10: дневной бюджет (кр) — worker-гард daily_budget_credits.
  const [eDailyBudget, setEDailyBudget] = useState(0);
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
    setEDailyBudget(Number(agent.daily_budget_credits ?? '10000'));
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
          daily_budget_credits: Math.round(eDailyBudget),
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
      setModelRate(data.model_rate ?? null);
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

  // P1-6: реестр моделей для пикера (slug обязан существовать в шлюзе —
  // незарегистрированный слаг = утечка маржи, см. находку c8c4ed0).
  useEffect(() => {
    if (!token) return;
    fetch('/tg/api/tma/marketplace', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) => setModels(Array.isArray(j.models) ? j.models : []))
      .catch(() => {});
  }, [token]);

  // P1-6: форма настроек видна сразу в сегменте «Настройки» — инициализируем
  // state редактирования при входе (и переинициализируем после сохранения/сброса).
  useEffect(() => {
    if (tab !== 'settings' || !agent || editing) return;
    startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, agent, editing]);

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
        setSendErr(null);
        await load();
      } else {
        const body = await res.json().catch(() => ({}));
        setSendErr(body.error ?? `HTTP ${res.status}`);
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
    // P0-1: цена вводится в КРЕДИТАХ (дробь допустима) → храним центы.
    let price: number | null = null;
    const trimmed = pPrice.trim();
    if (trimmed) {
      const parsed = parseCreditsInput(trimmed, 1000);
      if (parsed === undefined || parsed === null) {
        setPublishErr('Цена — число от 0,01 до 1 000 кр (или оставьте пусто)');
        setPublishing(false);
        return;
      }
      price = parsed;
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

        {agent && (
          <>
            {/* Hero — the collectible-character card + headline facts. */}
            <section className="tma-detail-hero">
              <div
                className="tma-detail-portrait"
                style={{
                  background: `linear-gradient(155deg, oklch(0.34 0.09 ${hueFor(agent.id)}), oklch(0.17 0.045 ${hueFor(agent.id)}))`,
                  color: `oklch(0.93 0.11 ${hueFor(agent.id)})`,
                }}
              >
                {(agent.name?.trim()[0] ?? '?').toUpperCase()}
              </div>
              <div className="tma-detail-hero-body">
                <h1 className="tma-title">{agent.name}</h1>
                {agent.description && (
                  <p className="tma-subtitle">{agent.description}</p>
                )}
                <div className="tma-chips" style={{ marginTop: 2 }}>
                  <span
                    className={
                      agent.connection_type === 'external_openai'
                        ? 'tma-pill tma-pill--ok'
                        : 'tma-pill tma-pill--accent'
                    }
                  >
                    {agent.connection_type === 'external_openai'
                      ? 'свой провайдер · 0 комиссии'
                      : 'наш шлюз · с наценкой'}
                  </span>
                  {agent.mcp_endpoint_url && (
                    <span className="tma-pill tma-pill--muted">MCP подключён</span>
                  )}
                </div>
              </div>
            </section>

            {/* P1-6: сегмент-контрол — страница разбита на 4 локальных сегмента. */}
            <div className="tma-segment tma-segment--fit" role="tablist" aria-label="Разделы агента">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`tma-segment-btn${tab === t.key ? ' is-active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Spec strip — model + budget in one mono-numeric glance. */}
            {tab === 'dialog' && (
            <section className="tma-spec">
              {agent.model_slug && (
                <div className="tma-spec-cell">
                  <span className="tma-spec-label">Модель</span>
                  <span className="tma-spec-value tma-mono" title={agent.model_slug}>
                    {agent.model_slug}
                  </span>
                </div>
              )}
              <div className="tma-spec-cell">
                <span className="tma-spec-label">Бюджет</span>
                <span className="tma-spec-value">
                  {/* #3: бюджет хранится в центах → показываем ÷100 через общий fmtCredits. */}
                  <span className="tma-num">{fmtCredits(agent.budget_rub_monthly)}</span> кр/мес
                </span>
              </div>
              {Array.isArray(agent.tools) && (agent.tools as string[]).length > 0 && (
                <div className="tma-spec-cell tma-spec-cell--wide">
                  <span className="tma-spec-label">Инструменты</span>
                  <div className="tma-chips">
                    {(agent.tools as string[]).map((t) => (
                      <span key={t} className="tma-chip">
                        {AVAILABLE_TOOLS.find((x) => x.id === t)?.label ?? t}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>
            )}

            {/* === Сегмент «Монетизация»: публикация шаблона + трансфер === */}
            {tab === 'monetize' && (
            <>
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
                className="tma-btn tma-btn--primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <Icon d={ICONS.publish} /> Опубликовать как шаблон
              </button>
            ) : (
              <form onSubmit={handlePublish} className="tma-card" style={{ padding: 16 }}>
                <h2 className="tma-card-title">Опубликовать как шаблон</h2>
                <p className="tma-card-text tma-text-small">
                  Поделитесь настройкой агента. Ключи, память и история не
                  передаются — только спек.
                </p>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Цена аренды, кр/мес (пусто = бесплатно)</span>
                  <input
                    type="number"
                    value={pPrice}
                    onChange={(ev) => setPPrice(ev.target.value)}
                    min={0.01}
                    max={1000}
                    step={0.01}
                    placeholder="бесплатно"
                    className="tma-input"
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

            <TransferPanel
              agentId={id!}
              isOwner={true}
              transferable={!!agent.transferable}
              transferPriceCredits={agent.transfer_price_credits ?? null}
              token={token}
              onChanged={load}
            />
            </>
            )}

            {/* === Сегмент «Расписание» === */}
            {/* Расписание — агент запускает сам себя по интервалу. Каждый запуск
                списывается как обычный (в рамках дневного бюджета). */}
            {tab === 'schedule' && (
            <section className="tma-card" style={{ padding: 16 }}>
              <h2 className="tma-card-title tma-title-icon">
                <Icon d={ICONS.clock} /> Расписание
              </h2>
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
                    className="tma-input"
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Частота</span>
                  <select
                    value={schInterval}
                    onChange={(e) => setSchInterval(Number(e.target.value))}
                    className="tma-input"
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
            )}

            {/* === Сегмент «Диалог»: лента запусков + композер === */}
            {tab === 'dialog' && (
            <>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* #17: заголовок «Диалог» убран — сегмент-таб уже подписывает секцию.
                  Оставлена только поясняющая строка про память/цену. */}
              {runs.length > 0 && (
                <span className="tma-section-sub">
                  агент помнит последние <span className="tma-num">10</span> сообщений · цена за каждый ответ
                </span>
              )}
              {/* Run-trace: newest first, with per-run cost/duration/status. */}
              <RunTrace runs={runs} />
            </section>

            {/* R2.1-B7: живой статус вместо тишины после 202 (поллинг уже идёт). */}
            {runActive && (
              <div
                className="tma-card-text tma-text-small"
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                role="status"
              >
                <span
                  className="aiag-pulse-dot"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    position: 'relative',
                    display: 'inline-block',
                  }}
                />
                Агент работает… ответ появится здесь, уведомление придёт в чат бота.
              </div>
            )}

            <form onSubmit={handleSend} style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Сообщение агенту…"
                disabled={sending}
                className="tma-input"
                style={{ flex: 1 }}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="tma-btn tma-btn--primary"
                aria-label="Отправить"
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                {sending ? '…' : <Icon d={ICONS.send} />}
              </button>
            </form>

            {/* P0-3: ошибка отправки — рядом с инпутом, с действием. */}
            {sendErr && (
              <div className="tma-error" style={{ marginTop: 0 }}>
                {sendErr === 'insufficient_balance' ? (
                  <>
                    Недостаточно кредитов для запуска.{' '}
                    <Link href="/profile/topup" style={{ color: 'var(--accent)' }}>
                      Пополнить баланс
                    </Link>
                  </>
                ) : (
                  <>Не удалось отправить: {sendErr}</>
                )}
              </div>
            )}

            {/* R2.1-A4: честная цена ДО отправки — тариф из реестра, не выдумка. */}
            {agent.connection_type !== 'aiag' ? (
              <p className="tma-card-text tma-text-small" style={{ margin: 0 }}>
                Свой провайдер: <span className="tma-mono">0</span> комиссии, платите
                напрямую своему провайдеру.
              </p>
            ) : modelRate ? (
              <p className="tma-card-text tma-text-small" style={{ margin: 0 }}>
                От <span className="tma-mono">1</span> кр за прогон · тариф модели:{' '}
                <span className="tma-mono">↓{fmtCredits(modelRate.in_per_1m_credits)}</span> /{' '}
                <span className="tma-mono">↑{fmtCredits(modelRate.out_per_1m_credits)}</span> кр за 1M
                токенов · итог по факту ответа.
              </p>
            ) : null}

            {/* Канбан/swarm — read-only board of the user's connected Hermes.
                Only meaningful for an external_openai (connect-your-own-Hermes)
                agent; the page itself shows an honest empty state otherwise. */}
            {agent.connection_type === 'external_openai' && (
              <Link
                href={`/agents/${id}/kanban`}
                className="tma-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <Icon d={ICONS.board} /> Канбан (swarm)
              </Link>
            )}
            </>
            )}
          </>
        )}

        {/* === Сегмент «Настройки»: форма видна сразу (editing инициализирует
            startEdit() при входе в сегмент), удаление — в самом конце. === */}
        {agent && tab === 'settings' && editing && (
          <>
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
                  className="tma-input"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Описание</span>
                <input
                  type="text"
                  value={eDescription}
                  onChange={(e) => setEDescription(e.target.value)}
                  maxLength={500}
                  className="tma-input"
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
                  className="tma-input"
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </label>

              {/* P1-6: модель — пикер из реестра вместо свободного текста
                  (незарегистрированный слаг = 400 в шлюзе + утечка маржи).
                  Свободный ввод слага остаётся только в BYOK-блоке ниже. */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Модель</span>
                <select
                  value={eModelSlug}
                  onChange={(e) => setEModelSlug(e.target.value)}
                  className="tma-input tma-mono"
                >
                  <option value="">— не выбрана —</option>
                  {models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name} · {m.slug}
                    </option>
                  ))}
                  {eModelSlug && !models.some((m) => m.slug === eModelSlug) && (
                    <option value={eModelSlug}>
                      {eModelSlug}
                      {models.length > 0 ? ' (вне реестра)' : ''}
                    </option>
                  )}
                </select>
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
                  className="tma-input tma-mono"
                />
              </label>

              {/* C10: дневной лимит — атомарный гард воркера (daily_budget_credits). */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Дневной бюджет, кр</span>
                <input
                  type="number"
                  value={eDailyBudget}
                  onChange={(e) => setEDailyBudget(Number(e.target.value))}
                  min={1}
                  max={1000000}
                  step={50}
                  className="tma-input tma-mono"
                />
                <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                  Жёсткий потолок трат за день. Запуски сверх лимита блокируются до
                  следующих суток.
                </span>
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
                    className="tma-input"
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
                          className="tma-input"
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
                        className="tma-input"
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Модель (опционально)</span>
                      <input
                        type="text"
                        value={connModel}
                        onChange={(e) => setConnModel(e.target.value)}
                        placeholder="gpt-4o"
                        className="tma-input"
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
                <span
                  className="tma-card-text"
                  style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon d={ICONS.puzzle} /> MCP-сервер (скиллы)
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
                    className="tma-input"
                  >
                    <option value="">— не менять —</option>
                    <option value="set">Задать новый MCP-сервер</option>
                    {agent.mcp_endpoint_url && <option value="clear">Отключить MCP</option>}
                  </select>
                </label>
                {mcpSel === 'set' && (
                  <>
                    {/* C11: пресеты — клик заполняет URL (и URL для OAuth-входа ниже). */}
                    <div className="tma-chips">
                      {MCP_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className="tma-chip"
                          onClick={() => {
                            setMcpUrl(p.url);
                            setOauthUrl(p.url);
                          }}
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
                      <button
                        type="button"
                        className="tma-chip"
                        onClick={() => setMcpUrl('')}
                        style={{ cursor: 'pointer' }}
                      >
                        Свой URL
                      </button>
                    </div>
                    <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
                      Подключение через OAuth провайдера. Список пресетов проверен 2026-06.
                    </p>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">URL</span>
                      <input
                        type="url"
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder="https://mcp.example.com/mcp"
                        className="tma-input"
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
                        className="tma-input"
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
                      className="tma-input"
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
                      className="tma-input"
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
                {/* «Сбросить» возвращает форму к сохранённым значениям:
                    editing=false → эффект входа в сегмент вызовет startEdit(). */}
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="tma-btn"
                  disabled={saving}
                >
                  Сбросить
                </button>
                <button
                  type="submit"
                  className="tma-btn tma-btn--primary"
                  disabled={saving || runActive}
                  title={runActive ? 'Дождитесь завершения запуска' : undefined}
                  style={{ flex: 1 }}
                >
                  {saving ? 'Сохранение…' : runActive ? 'Идёт запуск…' : 'Сохранить'}
                </button>
              </div>
            </form>

            {/* Опасная зона — в самом конце настроек, вне общего потока. */}
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="tma-btn tma-btn--danger"
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

/** Format an ISO timestamp as local HH:MM for the "next run ~HH:MM" hint. */
function formatHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

