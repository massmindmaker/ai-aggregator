'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { hueFor } from '@/components/AgentCard';
import { RunTrace } from '@/components/RunTrace';
import { Icon, ICONS } from '@/components/Icon';
import { fmtCredits, parseCreditsInput } from '@/lib/credits';
import { haptic } from '@/lib/haptics';
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
  cloneable?: boolean;
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
  tool_calls?: Array<{
    name: string;
    args?: unknown;
    result?: string | null;
    cost_credits?: number;
    duration_ms?: number;
    status?: string;
  }>;
}

// K-sched: расписания на вкладке агента теперь READ-ONLY список (поддерживает все
// типы interval/daily/weekly). Раньше вкладка делала LIMIT 1 + форсила kind='interval',
// молча затирая полноценные daily/weekly — редактирование вынесено на /schedules.
interface Schedule {
  id: string;
  agent_id: string;
  name: string | null;
  prompt: string;
  schedule_kind: 'interval' | 'daily' | 'weekly' | string;
  interval_minutes: number | null;
  at_time: string | null; // "HH:MM:SS"
  weekday: number | null; // 0=Sun..6=Sat
  enabled: boolean;
  next_run_at: string;
}

const SCHED_WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** Человекочитаемое «когда» из kind+params (read-only показ на вкладке агента). */
function humanizeScheduleWhen(s: Schedule): string {
  if (s.schedule_kind === 'interval' && s.interval_minutes != null) {
    const m = s.interval_minutes;
    if (m % 1440 === 0) return `каждые ${m / 1440} сут`;
    if (m % 60 === 0) return `каждые ${m / 60} ч`;
    return `каждые ${m} мин`;
  }
  if (s.schedule_kind === 'daily' && s.at_time) {
    return `${s.at_time.slice(0, 5)} ежедневно`;
  }
  if (s.schedule_kind === 'weekly' && s.at_time && s.weekday != null) {
    return `${SCHED_WEEKDAYS[s.weekday] ?? '?'} ${s.at_time.slice(0, 5)}`;
  }
  return '—';
}

// P1-6: локальная сегментация перегруженной страницы (useState, без роутинга).
type TabKey = 'dialog' | 'settings' | 'monetize' | 'schedule';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dialog', label: 'Диалог' },
  { key: 'settings', label: 'Настройки' },
  { key: 'monetize', label: 'Публикация' },
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
  // K1: confirm-sheet вместо window.confirm() — confirm не работает в Telegram iOS WebView.
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // ---- publish-as-template ----
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  // Empty = free template (price_credits NULL). Else a positive integer (credits).
  const [pPrice, setPPrice] = useState('');

  // ---- direct-clone opt-in (2026-06-12) ----
  const [cloneSaving, setCloneSaving] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);

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

  // ---- schedule (self-running agent) — READ-ONLY список на вкладке агента ----
  const [schedules, setSchedules] = useState<Schedule[]>([]);
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
    haptic.impact('medium');
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
        haptic.notify('error');
        return;
      }
      const data = await res.json();
      if (data.agent) setAgent(data.agent);
      setEditing(false);
      haptic.notify('success');
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : 'save_failed');
      haptic.notify('error');
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

  // K2a: сегмент «Настройки» по умолчанию READ-ONLY. Авто-startEdit() убран —
  // форма редактирования открывается только по кнопке «Редактировать».

  // READ-ONLY: тянем ВСЕ расписания юзера и фильтруем по этому агенту (поддержка
  // interval/daily/weekly). Редактирование/создание/удаление — на экране /schedules,
  // который умеет все типы. Здесь ничего не затираем и не форсим interval.
  useEffect(() => {
    if (!token || !id) return;
    fetch(`/tg/api/tma/me/schedules`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { schedules: [] }))
      .then((j) => {
        const all: Schedule[] = Array.isArray(j.schedules) ? j.schedules : [];
        setSchedules(all.filter((s) => s.agent_id === id));
      })
      .catch(() => setSchErr('Не удалось загрузить расписания.'));
  }, [token, id]);

  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'pending' || r.status === 'running');
    if (!hasActive) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [runs, load]);

  // Тактильный «готово»: когда прогон перестаёт быть активным (был active →
  // стал не-active), даём success-вибро. Ошибочный финал → error-вибро.
  const prevRunActive = useRef(false);
  useEffect(() => {
    if (prevRunActive.current && !runActive) {
      const last = runs[0];
      if (last && (last.status === 'error' || last.status === 'failed')) {
        haptic.notify('error');
      } else {
        haptic.notify('success');
      }
    }
    prevRunActive.current = runActive;
  }, [runActive, runs]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !id || !input.trim()) return;
    haptic.impact('medium');
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
        haptic.notify('error');
      }
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!token || !id) return;
    setDeleteConfirm(false);
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

  // Toggle direct-clone opt-in (PATCH cloneable). Spec-data only, no money path.
  async function handleToggleCloneable(next: boolean) {
    if (!token || !id || cloneSaving) return;
    haptic.impact('light');
    setCloneSaving(true);
    setCloneErr(null);
    try {
      const res = await fetch(`/tg/api/tma/agents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cloneable: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCloneErr(body.error ?? `HTTP ${res.status}`);
        haptic.notify('error');
        return;
      }
      const data = await res.json();
      if (data.agent) setAgent(data.agent);
    } catch (err) {
      setCloneErr(err instanceof Error ? err.message : 'save_failed');
      haptic.notify('error');
    } finally {
      setCloneSaving(false);
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
                {/* Метрик-стрип (mono): прогоны · бюджет/мес · последний запуск.
                    runs ограничены 20 последними (см. роут LIMIT 20) → показываем
                    «20+» при переполнении, чтобы число не врало. */}
                <div className="tma-spec" style={{ marginTop: 8 }}>
                  <div className="tma-spec-cell">
                    <span className="tma-spec-label">Прогонов</span>
                    <span className="tma-spec-value">
                      <span className="tma-num">{runs.length >= 20 ? '20+' : runs.length}</span>
                    </span>
                  </div>
                  <div className="tma-spec-cell">
                    <span className="tma-spec-label">Бюджет</span>
                    <span className="tma-spec-value">
                      <span className="tma-num">{fmtCredits(agent.budget_rub_monthly)}</span> кр/мес
                    </span>
                  </div>
                  {runs[0] && (
                    <div className="tma-spec-cell">
                      <span className="tma-spec-label">Последний запуск</span>
                      <span className="tma-spec-value tma-mono">{formatRunAt(runs[0].created_at)}</span>
                    </div>
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
                    className="tma-input tma-mono"
                  />
                </label>
                {/* P6: аренда работает (API /rent) — показываем честный итог цены,
                    без «появится позже». */}
                {pPrice.trim() ? (
                  <p className="tma-card-text tma-text-small">
                    Платный шаблон: арендатор платит вам{' '}
                    <span className="tma-mono">{pPrice.trim()}</span> кр/мес. Сумму
                    получаете полностью — AIAG берёт <span className="tma-mono">0</span> с аренды.
                  </p>
                ) : (
                  <p className="tma-card-text tma-text-small">
                    Бесплатный шаблон: другие смогут клонировать настройку без оплаты автору.
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

            {/* Прямое клонирование — разрешить другим клонировать настройку
                этого агента по ссылке (без ключей, памяти и истории — только спек). */}
            <div className="tma-card" style={{ padding: 16 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  cursor: cloneSaving ? 'default' : 'pointer',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="tma-card-title" style={{ margin: 0 }}>
                    Разрешить клонирование
                  </span>
                  <span className="tma-card-text tma-text-small">
                    Другие смогут клонировать настройку этого агента. Передаётся только
                    спек — ключи, память и история остаются у вас.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={!!agent.cloneable}
                  disabled={cloneSaving}
                  onChange={(e) => handleToggleCloneable(e.target.checked)}
                />
              </label>
              {cloneErr && (
                <div className="tma-error" style={{ marginTop: 8 }}>
                  Ошибка: {cloneErr}
                </div>
              )}
            </div>

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
                Агент сам запускается по расписанию с заданием. Каждый запуск тратит
                кредиты в рамках дневного лимита — как обычный запуск. Создание и
                редактирование расписаний (интервал / ежедневно / по дням недели) —
                на отдельном экране.
              </p>

              {schErr && (
                <div className="tma-error" style={{ marginTop: 8 }}>
                  Ошибка: {schErr}
                </div>
              )}

              {schedules.length === 0 ? (
                <p
                  className="tma-card-text tma-text-small"
                  style={{ marginTop: 12, opacity: 0.7 }}
                >
                  У этого агента пока нет расписаний.
                </p>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: '12px 0 0',
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {schedules.map((s) => (
                    <li
                      key={s.id}
                      className="tma-card"
                      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span className={`tma-pill ${s.enabled ? 'tma-pill--ok' : ''}`}>
                          {s.enabled ? 'активно' : 'выключено'}
                        </span>
                        <span className="tma-card-text tma-text-small tma-mono">
                          {humanizeScheduleWhen(s)}
                        </span>
                        {s.enabled && (
                          <span
                            className="tma-card-text tma-text-small"
                            style={{ opacity: 0.7 }}
                          >
                            · следующий ~<span className="tma-mono">{formatHHMM(s.next_run_at)}</span>
                          </span>
                        )}
                      </div>
                      {s.name && (
                        <span className="tma-card-text tma-text-small" style={{ fontWeight: 600 }}>
                          {s.name}
                        </span>
                      )}
                      <span
                        className="tma-card-text tma-text-small"
                        style={{
                          opacity: 0.8,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {s.prompt}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <Link
                href="/schedules"
                className="tma-btn"
                style={{ display: 'inline-block', marginTop: 12, textAlign: 'center' }}
              >
                Управлять расписаниями →
              </Link>
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

            <form onSubmit={handleSend} className="tma-composer">
              {/* K2b: textarea с автовысотой. Enter = отправка, Shift+Enter = перенос. */}
              <textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  e.currentTarget.style.height = 'auto';
                  e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 120) + 'px';
                }}
                onFocus={(e) => {
                  // Клавиатура не должна перекрывать композер: подтягиваем его в зону
                  // видимости после появления keyboard (короткая задержка под анимацию TG).
                  const el = e.currentTarget;
                  setTimeout(() => {
                    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }, 250);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Сообщение агенту…"
                disabled={sending}
                className="tma-input"
                style={{ flex: 1, resize: 'none', overflow: 'hidden', maxHeight: 120 }}
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

            {/* P3: Канбан/swarm — доступен ВСЕГДА. Сам /kanban показывает честный
                empty-state для не-Hermes агентов, поэтому условие по connection_type
                убрано (раньше ссылка пряталась для всех, кроме external_openai). */}
            <Link
              href={`/agents/${id}/kanban`}
              className="tma-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <Icon d={ICONS.board} /> Канбан (swarm)
            </Link>
            </>
            )}
          </>
        )}

        {/* === Сегмент «Настройки»: READ-ONLY вид + кнопка «Редактировать». === */}
        {agent && tab === 'settings' && !editing && (
          <>
            <section className="tma-spec">
              <div className="tma-spec-cell tma-spec-cell--wide">
                <span className="tma-spec-label">Имя</span>
                <span className="tma-spec-value">{agent.name}</span>
              </div>
              {agent.description && (
                <div className="tma-spec-cell tma-spec-cell--wide">
                  <span className="tma-spec-label">Описание</span>
                  <span className="tma-spec-value">{agent.description}</span>
                </div>
              )}
              <div className="tma-spec-cell tma-spec-cell--wide">
                <span className="tma-spec-label">Модель</span>
                <span className="tma-spec-value tma-mono" title={agent.model_slug ?? ''}>
                  {agent.model_slug || '— не выбрана —'}
                </span>
              </div>
              <div className="tma-spec-cell">
                <span className="tma-spec-label">Бюджет</span>
                <span className="tma-spec-value">
                  <span className="tma-num">{fmtCredits(agent.budget_rub_monthly)}</span> кр/мес
                </span>
              </div>
              <div className="tma-spec-cell">
                <span className="tma-spec-label">Дневной лимит</span>
                <span className="tma-spec-value">
                  <span className="tma-num">
                    {fmtCredits(agent.daily_budget_credits ?? '0')}
                  </span>{' '}
                  кр/день
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
              {/* P12: статус MCP виден ВСЕГДА (иконка + слово, не цвет один).
                  Подключён = есть URL; способ авторизации (OAuth/токен) уточняется. */}
              <div className="tma-spec-cell tma-spec-cell--wide">
                <span className="tma-spec-label">MCP</span>
                <span className="tma-spec-value">
                  {agent.mcp_endpoint_url ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className="tma-pill tma-pill--ok"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Icon d={ICONS.check} /> подключён
                        {agent.mcp_oauth_set ? ' (OAuth)' : agent.mcp_auth_set ? ' (токен)' : ''}
                      </span>
                      <span className="tma-mono" title={agent.mcp_endpoint_url}>
                        {agent.mcp_endpoint_url}
                      </span>
                    </span>
                  ) : (
                    <span className="tma-pill tma-pill--muted">✗ не настроен</span>
                  )}
                </span>
              </div>
            </section>

            {/* P5: «Подключение» вынесено из формы редактирования на видное место.
                Показывает текущий провайдер + hint ключа (P4) READ-ONLY; «Сменить»
                переиспользует существующий startEdit() (форма провайдера ниже). */}
            <section className="tma-card" style={{ padding: 16 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-title" style={{ margin: 0 }}>
                    Подключение
                  </span>
                  {agent.connection_type === 'external_openai' ? (
                    <>
                      <span
                        className="tma-pill tma-pill--ok"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          alignSelf: 'flex-start',
                        }}
                      >
                        <Icon d={ICONS.check} /> свой провайдер · 0 комиссии
                      </span>
                      {agent.external_base_url && (
                        <span className="tma-card-text tma-text-small">
                          URL:{' '}
                          <span className="tma-mono" title={agent.external_base_url}>
                            {agent.external_base_url}
                          </span>
                        </span>
                      )}
                      {agent.external_api_key_hint && (
                        <span className="tma-card-text tma-text-small">
                          Ключ: <span className="tma-mono">…{agent.external_api_key_hint}</span>
                        </span>
                      )}
                      {agent.external_model_slug && (
                        <span className="tma-card-text tma-text-small">
                          Модель:{' '}
                          <span className="tma-mono" title={agent.external_model_slug}>
                            {agent.external_model_slug}
                          </span>
                        </span>
                      )}
                    </>
                  ) : (
                    <span
                      className="tma-pill tma-pill--accent"
                      style={{ alignSelf: 'flex-start' }}
                    >
                      AIAG (наценка)
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    haptic.impact('light');
                    startEdit();
                  }}
                  className="tma-btn"
                  style={{ flexShrink: 0 }}
                >
                  Сменить
                </button>
              </div>
            </section>

            <button
              type="button"
              onClick={() => {
                haptic.impact('medium');
                startEdit();
              }}
              className="tma-btn tma-btn--primary"
            >
              Редактировать
            </button>

            {/* Опасная зона — в самом конце настроек. */}
            <button
              type="button"
              onClick={() => setDeleteConfirm(true)}
              disabled={deleting}
              className="tma-btn tma-btn--danger"
            >
              {deleting ? 'Удаление…' : 'Удалить агента'}
            </button>
          </>
        )}

        {/* === Сегмент «Настройки»: форма редактирования (editing===true). === */}
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
                {/* «Отмена» закрывает форму → возврат к READ-ONLY виду настроек. */}
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
                  disabled={saving || runActive}
                  title={runActive ? 'Дождитесь завершения запуска' : undefined}
                  style={{ flex: 1 }}
                >
                  {saving ? 'Сохранение…' : runActive ? 'Идёт запуск…' : 'Сохранить'}
                </button>
              </div>
            </form>
          </>
        )}
      </main>

      {/* K1: bottom-sheet подтверждения удаления (window.confirm не работает в TG iOS). */}
      {deleteConfirm && (
        <div className="tma-sheet-scrim" onClick={() => setDeleteConfirm(false)}>
          <div
            className="tma-sheet"
            role="dialog"
            aria-label="Удалить агента?"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tma-sheet-handle" />
            <h3 className="tma-sheet-title">Удалить агента?</h3>
            <p className="tma-card-text">Действие необратимо.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setDeleteConfirm(false)}
                className="tma-btn"
                disabled={deleting}
                style={{ flex: 1 }}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="tma-btn tma-btn--danger"
                disabled={deleting}
                style={{ flex: 1 }}
              >
                {deleting ? 'Удаление…' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
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

/** Compact local "ДД.ММ HH:MM" for the header metric strip (last run). */
function formatRunAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

