'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { BottomNav } from '@/components/BottomNav';
import { hueFor } from '@/components/AgentCard';
import { Icon, ICONS } from '@/components/Icon';
import { AGENT_TEMPLATES, getTemplate } from '@/lib/agent-templates';
import { haptic } from '@/lib/haptics';
import { parseCreditsInput } from '@/lib/credits';

// Tools actually implemented by the agent-worker (apps/agent-worker/src/tools.ts).
const AVAILABLE_TOOLS: { id: string; label: string; hint: string }[] = [
  { id: 'web_search', label: 'Веб-поиск', hint: 'Поиск актуальной информации в интернете' },
  { id: 'calc', label: 'Калькулятор', hint: 'Точные арифметические вычисления' },
  { id: 'image_gen', label: 'Генерация картинок', hint: 'Картинка по текстовому описанию' },
  { id: 'memory', label: 'Память', hint: 'Запоминает факты между запусками' },
];
const AVAILABLE_TOOL_IDS = new Set(AVAILABLE_TOOLS.map((t) => t.id));

// P1-7: progressive disclosure — collapsed section with a one-line summary in
// the header. transform/opacity only (DESIGN.md motion rules).
function Accordion({
  title,
  summary,
  pill,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  pill?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`tma-acc${open ? ' tma-acc--open' : ''}`}>
      <button type="button" className="tma-acc-head" onClick={onToggle} aria-expanded={open}>
        <span className="tma-acc-chev" aria-hidden>
          ›
        </span>
        <span className="tma-acc-title">{title}</span>
        {pill}
        <span className="tma-acc-summary">{summary}</span>
      </button>
      {open && <div className="tma-acc-body">{children}</div>}
    </section>
  );
}

export default function NewAgentPage() {
  const router = useRouter();
  const { user, token, loading, error } = useAuth();
  const [pickedKind, setPickedKind] = useState<string | null>(null);
  // ?blank=1 → пустая форма «с нуля» (без сетки шаблонов и без префилла).
  const [blank, setBlank] = useState(false);
  // ?from=<id> → создание из опубликованного шаблона: форма префиллится спеком
  // шаблона, а на сабмите вызывается санкционированный clone-маршрут шаблона
  // (клонирование живёт ТОЛЬКО в потоке создания). null = обычное создание.
  const [cloneFromTemplateId, setCloneFromTemplateId] = useState<string | null>(null);
  const [cloneInsufficient, setCloneInsufficient] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  // Multimodel per-role: optional per-role model slots. Пусто = «как основная».
  const [imageModelSlug, setImageModelSlug] = useState('');
  const [voiceModelSlug, setVoiceModelSlug] = useState('');
  const [visionModelSlug, setVisionModelSlug] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  // AI-builder — «создать агента из слов». Генерация house-funded (не run, не дебет):
  // модель возвращает черновик-спек, которым предзаполняется обычная форма ниже.
  const [aiDescription, setAiDescription] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState(false);
  // role из спека → description агента (POST использует его как описание).
  const [aiRole, setAiRole] = useState('');
  // Budgets are entered in CREDITS (как поля цены и страница агента: дисплей =
  // центы/100). State держит сырой ввод-строку; на сабмите parseCreditsInput
  // конвертит в центы для бэка. Дефолты: 100 кр/день (=10000 центов), 10 кр/мес.
  const [dailyBudget, setDailyBudget] = useState('100');
  const [budget, setBudget] = useState('10');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Creator-membership gate: создание с нуля доступно только держателям членского
  // NFT. null = загрузка, затем boolean. false → честная панель вместо формы.
  const [isMember, setIsMember] = useState<boolean | null>(null);

  // Accordion open-state (multiple can be open).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  // Model registry for the picker (free-form slug lives only inside BYOK).
  const [models, setModels] = useState<{ slug: string; name: string }[]>([]);

  // "Свой агент" — Path 1 (external OpenAI-compatible endpoint)
  const [useExternal, setUseExternal] = useState(false);
  // Подрежим внешней секции: 'hermes' = гайд «Свой Hermes», 'custom' = generic.
  // Оба настраивают те же external_openai-поля; меняются только лейблы/подсказки.
  const [externalMode, setExternalMode] = useState<'hermes' | 'custom'>('custom');
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

  // ?blank=1 (вход «С нуля») → сразу пустая форма «personal», без сетки шаблонов
  // и без префилла. Поля уже пустые по умолчанию — только переключаем экран.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('blank')) {
      setBlank(true);
      setName('');
      setSystemPrompt('');
      setModelSlug('');
      setTools([]);
      setPickedKind('personal');
    }
  }, []);

  // ?from=<templateId> (вход «Создать из шаблона» из маркета / «Нанять») →
  // создание из ОПУБЛИКОВАННОГО шаблона. Тянем спек шаблона и префиллим форму;
  // ставим pickedKind='personal' (показываем форму, а не сетку шаблонов) и
  // запоминаем cloneFromTemplateId — на сабмите вызовем clone-маршрут шаблона.
  useEffect(() => {
    if (typeof window === 'undefined' || !token) return;
    const fromId = new URLSearchParams(window.location.search).get('from');
    if (!fromId) return;
    let cancelled = false;
    (async () => {
      try {
        // Одиночный GET шаблона уже существует — берём полный спек оттуда.
        const res = await fetch(`/tg/api/tma/templates/${fromId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        const tpl = data.template as {
          name?: string | null;
          description?: string | null;
          system_prompt?: string | null;
          model_slug?: string | null;
          tools?: unknown;
        } | null;
        if (cancelled || !tpl) return;
        setName(tpl.name ?? '');
        setSystemPrompt(tpl.system_prompt ?? '');
        setModelSlug(tpl.model_slug ?? '');
        setAiRole((tpl.description ?? '').trim());
        setTools(
          (Array.isArray(tpl.tools) ? (tpl.tools as unknown[]) : [])
            .filter((id): id is string => typeof id === 'string' && AVAILABLE_TOOL_IDS.has(id)),
        );
        setCloneFromTemplateId(fromId);
        setPickedKind('personal');
      } catch {
        // Сеть/парсинг отвалились — оставляем обычную форму создания.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Prefill form when template chosen. Skipped for AI-builder drafts — those
  // already filled the form from the generated spec; a template overwrite would
  // clobber it. Also skipped in blank mode (?blank=1) and create-from-template
  // (?from=, prefilled from the fetched spec) so neither path gets clobbered.
  useEffect(() => {
    if (!pickedKind || aiDraft || blank || cloneFromTemplateId) return;
    const t = getTemplate(pickedKind);
    if (!t) return;
    setName(t.name);
    setSystemPrompt(t.systemPrompt);
    setModelSlug(t.defaultModelSlug);
    // Seed from template, keeping only tools the worker actually implements
    // (e.g. code_interpreter is suggested by some templates but unimplemented).
    setTools(t.suggestedTools.filter((id) => AVAILABLE_TOOL_IDS.has(id)));
  }, [pickedKind]);

  // Handoff from /market/[slug] — pre-fill modelSlug from localStorage.
  // Пропускаем при создании из шаблона (?from=) — там модель берётся из спека.
  useEffect(() => {
    if (cloneFromTemplateId) return;
    try {
      const slug = localStorage.getItem('aiag_selected_model_slug');
      if (slug) {
        setModelSlug(slug);
        localStorage.removeItem('aiag_selected_model_slug');
      }
    } catch {
      // ignore
    }
  }, [pickedKind, cloneFromTemplateId]);

  // Дип-линк ?provider=1 / ?hermes=1 → сразу раскрываем секцию «Свой провайдер»
  // и включаем тумблер, чтобы обещанный путь приземлялся на нужный раздел.
  // ?hermes=1 (с дашборда «Подключить свой Hermes») дополнительно ставит
  // подрежим «Свой Hermes» с честными лейблами/подсказками.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const wantHermes = params.get('hermes');
    const wantProvider = params.get('provider');
    if (wantHermes) {
      setOpen((p) => ({ ...p, provider: true }));
      setUseExternal(true);
      setExternalMode('hermes');
    } else if (wantProvider) {
      setOpen((p) => ({ ...p, provider: true }));
      setUseExternal(true);
    }
  }, []);

  // В режиме «Свой Hermes» провайдер всегда = Custom (requiresBaseUrl), чтобы поле
  // «Адрес твоего Hermes» отрисовалось. Авто-выбираем его, когда провайдеры загружены.
  useEffect(() => {
    if (externalMode !== 'hermes' || providers.length === 0) return;
    const sel = providers.find((p) => p.id === providerId);
    if (sel?.requiresBaseUrl) return;
    const custom = providers.find((p) => p.requiresBaseUrl);
    if (custom) setProviderId(custom.id);
  }, [externalMode, providers, providerId]);

  // Membership status once authenticated. На ошибку считаем не-членом (fail-closed UI).
  useEffect(() => {
    if (!token) return;
    fetch('/tg/api/tma/membership', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { is_member: false }))
      .then((j) => setIsMember(!!j.is_member))
      .catch(() => setIsMember(false));
  }, [token]);

  // Load the BYOK provider catalog + model registry once authenticated.
  useEffect(() => {
    if (!token) return;
    fetch('/tg/api/tma/providers', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((j) => setProviders(Array.isArray(j.providers) ? j.providers : []))
      .catch(() => {});
    fetch('/tg/api/tma/marketplace', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((j) =>
        setModels(
          Array.isArray(j.models)
            ? j.models
                .filter((m: { slug?: unknown }) => typeof m.slug === 'string' && m.slug)
                .map((m: { slug: string; name?: string }) => ({
                  slug: m.slug,
                  name: m.name || m.slug,
                }))
            : [],
        ),
      )
      .catch(() => {});
  }, [token]);

  async function handleGenerate() {
    if (!token || !aiDescription.trim() || aiBusy) return;
    haptic.impact('medium');
    setAiBusy(true);
    setAiErr(null);
    try {
      const res = await fetch('/tg/api/tma/agents/ai-builder', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ description: aiDescription.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setAiErr(
          j.error === 'invalid_spec'
            ? 'Не удалось разобрать, переформулируй описание.'
            : 'Не получилось сгенерировать. Попробуй ещё раз.',
        );
        haptic.notify('error');
        return;
      }
      const { spec } = (await res.json()) as {
        spec: {
          name: string;
          role: string;
          system_prompt: string;
          model_slug: string;
          tools: string[];
        };
      };
      // Заполняем существующие поля формы сгенерированным черновиком.
      setPickedKind('personal');
      setName(spec.name);
      setSystemPrompt(spec.system_prompt);
      setModelSlug(spec.model_slug);
      setTools((spec.tools ?? []).filter((id) => AVAILABLE_TOOL_IDS.has(id)));
      setAiRole(spec.role ?? '');
      setAiDraft(true);
      // Раскрываем «Инструкцию» — её и надо проверить в первую очередь.
      setOpen((p) => ({ ...p, prompt: true }));
      haptic.notify('success');
    } catch {
      setAiErr('Не получилось сгенерировать. Попробуй ещё раз.');
      haptic.notify('error');
    } finally {
      setAiBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !pickedKind) return;

    // Создание из шаблона (?from=): санкционированный клон-на-создании. Вызываем
    // существующий clone-маршрут шаблона (сохраняет provenance/clone_count), а не
    // POST /agents. На успех — в инбокс /agents (как в маркете). 402 → пополнение.
    if (cloneFromTemplateId) {
      haptic.impact('medium');
      setSubmitting(true);
      setSubmitErr(null);
      setCloneInsufficient(false);
      try {
        const res = await fetch(`/tg/api/tma/templates/${cloneFromTemplateId}/clone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 402) {
          setCloneInsufficient(true);
          haptic.notify('error');
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (body.error === 'membership_required') {
            setIsMember(false);
            setSubmitErr('Создание агентов доступно только создателям (нужен членский NFT).');
          } else {
            setSubmitErr(body.error ?? `HTTP ${res.status}`);
          }
          haptic.notify('error');
          return;
        }
        const data = await res.json();
        if (data.agent_id) {
          haptic.notify('success');
          router.push('/agents');
          return;
        }
        setSubmitErr('clone_failed');
        haptic.notify('error');
      } catch (err) {
        setSubmitErr(err instanceof Error ? err.message : 'submit_failed');
        haptic.notify('error');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Ввод в кредитах → центы для бэка (как поля цены). Дневной бюджет обязателен
    // (> 0); месячный допускает пусто/0 = без месячного лимита.
    const dailyCents = parseCreditsInput(dailyBudget, 1_000_000);
    if (dailyCents === undefined || dailyCents === null) {
      setSubmitErr('Укажи дневной бюджет в кредитах (например 100)');
      haptic.notify('error');
      return;
    }
    const monthlyParsed = parseCreditsInput(budget, 1_000_000);
    if (monthlyParsed === undefined) {
      setSubmitErr('Месячный бюджет указан неверно');
      haptic.notify('error');
      return;
    }
    const monthlyCents = monthlyParsed ?? 0;
    haptic.impact('medium');
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
          description: aiRole.trim() || undefined,
          system_prompt: systemPrompt.trim(),
          model_slug: modelSlug.trim() || undefined,
          // Multimodel per-role: пусто = «как основная» (бэк сохранит NULL).
          image_model_slug: imageModelSlug.trim() || undefined,
          voice_model_slug: voiceModelSlug.trim() || undefined,
          vision_model_slug: visionModelSlug.trim() || undefined,
          tools,
          daily_budget_credits: dailyCents,
          budget_rub_monthly: monthlyCents,
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
        if (body.error === 'membership_required') {
          setIsMember(false);
          setSubmitErr('Создание агентов доступно только создателям (нужен членский NFT).');
        } else {
          setSubmitErr(body.error ?? `HTTP ${res.status}`);
        }
        haptic.notify('error');
        return;
      }
      const data = await res.json();
      haptic.notify('success');
      router.push(`/agents/${data.agent.id}`);
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : 'submit_failed');
      haptic.notify('error');
    } finally {
      setSubmitting(false);
    }
  }

  const isCustomProvider =
    providers.find((p) => p.id === providerId)?.requiresBaseUrl ?? false;

  // Summary lines for collapsed accordions.
  const promptTrimmed = systemPrompt.trim();
  const promptSummary = promptTrimmed
    ? promptTrimmed.slice(0, 40) + (promptTrimmed.length > 40 ? '…' : '')
    : 'пусто';
  const toolsSummary = tools.length
    ? AVAILABLE_TOOLS.filter((t) => tools.includes(t.id))
        .map((t) => t.label.toLowerCase())
        .join(', ')
    : 'без инструментов';
  const providerSummary =
    useExternal && providerId
      ? (providers.find((p) => p.id === providerId)?.name ?? 'свой провайдер')
      : 'AIAG';
  const mcpBudgetSummary = `${mcpUrl.trim() ? 'MCP подключён' : 'без MCP'} · ${dailyBudget.trim() || '0'} кр/день`;
  const roleCount =
    (imageModelSlug.trim() ? 1 : 0) +
    (voiceModelSlug.trim() ? 1 : 0) +
    (visionModelSlug.trim() ? 1 : 0);
  const rolesSummary = roleCount ? `${roleCount} переопределено` : 'всё как основная';

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

        {/* Гейт: создание с нуля — только для создателей (держателей членского NFT). */}
        {user && !error && isMember === false && (
          <section className="tma-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="tma-section-head">
              <h1 className="tma-title">Создание с нуля — ранний доступ</h1>
              <span className="tma-pill tma-pill--muted">◷ скоро</span>
            </div>
            <p className="tma-card-text" style={{ fontSize: 13, opacity: 0.8 }}>
              Сборка агентов с нуля пока в раннем доступе. Уже сейчас можно нанять
              или клонировать готового агента из каталога.
            </p>
            <Link href="/agents?tab=hire" className="tma-btn tma-btn--primary tma-btn--block">
              Нанять готового →
            </Link>
          </section>
        )}

        {user && !error && isMember !== false && !pickedKind && (
          <>
            {/* AI-builder — «создать агента из слов». Один amber primary в секции. */}
            <section className="tma-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 className="tma-card-text" style={{ fontWeight: 600, fontSize: 16 }}>
                ✨ Создать из слов
              </h2>
              <p className="tma-card-text" style={{ fontSize: 12, opacity: 0.75 }}>
                Опиши, что должен делать агент — ИИ соберёт черновик настроек, а ты
                проверишь и поправишь перед сохранением.
              </p>
              <textarea
                value={aiDescription}
                onChange={(e) => setAiDescription(e.target.value)}
                placeholder="Опиши агента словами… напр.: «бот, который кратко пересказывает статьи по ссылке и отвечает по-русски»"
                rows={4}
                maxLength={2000}
                className="tma-input"
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
              {aiErr && <div className="tma-error">{aiErr}</div>}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={aiBusy || !aiDescription.trim()}
                className="tma-btn tma-btn--primary"
              >
                {aiBusy ? 'Генерирую…' : 'Сгенерировать'}
              </button>
            </section>

            <header className="tma-header">
              <h1 className="tma-title">…или выберите шаблон</h1>
              <p className="tma-subtitle">Стартовая конфигурация — потом всё можно поправить.</p>
            </header>
            {/* P1-7: карточный язык каталога (tma-agent-card), не emoji-плитки. */}
            <div className="tma-agent-grid">
              {AGENT_TEMPLATES.map((t) => {
                const hue = hueFor(t.kind);
                return (
                  <button
                    key={t.kind}
                    type="button"
                    onClick={() => setPickedKind(t.kind)}
                    className="tma-agent-card tma-tpl-card"
                  >
                    <div
                      className="tma-agent-portrait"
                      style={{
                        background: `linear-gradient(155deg, oklch(0.34 0.09 ${hue}), oklch(0.17 0.045 ${hue}))`,
                        color: `oklch(0.93 0.11 ${hue})`,
                      }}
                    >
                      <span className="tma-agent-monogram">
                        {(t.name[0] ?? '?').toUpperCase()}
                      </span>
                    </div>
                    <div className="tma-agent-body">
                      <h2 className="tma-agent-name">{t.name}</h2>
                      <p className="tma-agent-role">{t.description}</p>
                      <span className="tma-agent-model" title={t.defaultModelSlug}>
                        {t.defaultModelSlug}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {user && !error && isMember !== false && pickedKind && (
          <>
            <header className="tma-header">
              <h1 className="tma-title">Новый агент</h1>
              <p className="tma-subtitle">
                {aiDraft
                  ? 'Черновик из описания'
                  : cloneFromTemplateId
                    ? 'Из шаблона — проверь и поправь перед созданием'
                    : blank
                      ? 'С нуля'
                      : `Шаблон: ${getTemplate(pickedKind)?.name ?? '—'}`}
              </p>
            </header>

            {aiDraft && (
              <div
                className="tma-card tma-success-box"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <Icon d={ICONS.check} size={14} />
                <span className="tma-card-text" style={{ fontSize: 12 }}>
                  Сгенерировано — это черновик, проверь и поправь перед сохранением.
                </span>
              </div>
            )}

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
                  className="tma-input"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="tma-card-text">Чат-модель</span>
                <select
                  value={modelSlug}
                  onChange={(e) => setModelSlug(e.target.value)}
                  className="tma-input"
                >
                  {!modelSlug && <option value="">— выберите модель —</option>}
                  {modelSlug && !models.some((m) => m.slug === modelSlug) && (
                    <option value={modelSlug}>{modelSlug}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>

              <Accordion
                title="Расширенные модели"
                summary={rolesSummary}
                open={!!open.roles}
                onToggle={() => toggle('roles')}
              >
                <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -4 }}>
                  Необязательно. Hermes-агент использует отдельную модель под задачу;
                  пусто = основная.
                </p>
                {(
                  [
                    { key: 'vision', label: 'Зрение', value: visionModelSlug, set: setVisionModelSlug },
                    { key: 'image', label: 'Картинки', value: imageModelSlug, set: setImageModelSlug },
                    { key: 'voice', label: 'Голос', value: voiceModelSlug, set: setVoiceModelSlug },
                  ] as const
                ).map((r) => (
                  <label key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="tma-card-text">{r.label}</span>
                    <select
                      value={r.value}
                      onChange={(e) => r.set(e.target.value)}
                      className="tma-input tma-mono"
                    >
                      <option value="">— по умолчанию = чат-модель —</option>
                      {r.value && !models.some((m) => m.slug === r.value) && (
                        <option value={r.value}>{r.value}</option>
                      )}
                      {models.map((m) => (
                        <option key={m.slug} value={m.slug}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </Accordion>

              <Accordion
                title="Инструкция"
                summary={promptSummary}
                open={!!open.prompt}
                onToggle={() => toggle('prompt')}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Инструкция агента</span>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    required
                    rows={8}
                    maxLength={8000}
                    className="tma-input"
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </label>
              </Accordion>

              <Accordion
                title="Инструменты"
                summary={toolsSummary}
                open={!!open.tools}
                onToggle={() => toggle('tools')}
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
              </Accordion>

              <Accordion
                title="Свой провайдер"
                summary={providerSummary}
                pill={<span className="tma-pill-free">0 комиссии</span>}
                open={!!open.provider}
                onToggle={() => toggle('provider')}
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
                    Подключить свой провайдер / ключ
                  </span>
                </label>
                <p className="tma-card-text" style={{ fontSize: 12, opacity: 0.75, marginTop: -6 }}>
                  Выбери провайдера и принеси свой ключ (OpenAI, Anthropic, OpenRouter,
                  DeepSeek… или «Custom» — любой OpenAI-совместимый URL: Ollama, vLLM,
                  твой Hermes за прокси). Платишь напрямую своему провайдеру.
                </p>

                {useExternal && (
                  <>
                    {/* Гайд-выбор: «Свой Hermes» vs «Другой OpenAI-совместимый».
                        Оба настраивают те же external_openai-поля. */}
                    <div className="tma-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {(
                        [
                          { id: 'hermes', label: 'Свой Hermes' },
                          { id: 'custom', label: 'Другой OpenAI-совместимый endpoint' },
                        ] as const
                      ).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="tma-chip"
                          onClick={() => {
                            setExternalMode(m.id);
                            setTestResult(null);
                          }}
                          style={{
                            cursor: 'pointer',
                            ...(externalMode === m.id
                              ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                              : {}),
                          }}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    {externalMode === 'hermes' && (
                      <p
                        className="tma-card-text"
                        style={{ fontSize: 12, opacity: 0.8, marginTop: -2 }}
                      >
                        Движок — твой Hermes. Комиссия 0% (платишь своему провайдеру).
                      </p>
                    )}

                    {externalMode !== 'hermes' && (
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">Провайдер</span>
                      <select
                        value={providerId}
                        onChange={(e) => {
                          setProviderId(e.target.value);
                          setTestResult(null);
                        }}
                        className="tma-input"
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
                    )}
                    {isCustomProvider && (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span className="tma-card-text">
                          {externalMode === 'hermes' ? 'Адрес твоего Hermes' : 'URL'}
                        </span>
                        <input
                          type="url"
                          value={extBaseUrl}
                          onChange={(e) => {
                            setExtBaseUrl(e.target.value);
                            setTestResult(null);
                          }}
                          placeholder={
                            externalMode === 'hermes'
                              ? 'http://твой-хост:8642/v1'
                              : 'https://example.com/v1'
                          }
                          className={`tma-input${externalMode === 'hermes' ? ' tma-mono' : ''}`}
                          required={isCustomProvider}
                        />
                        {externalMode === 'hermes' && (
                          <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                            REST-эндпоинт Hermes (OpenAI-совместимый).
                          </span>
                        )}
                      </label>
                    )}
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">
                        {externalMode === 'hermes' ? 'Ключ Hermes (API_SERVER_KEY)' : 'Ключ API'}
                      </span>
                      <input
                        type="password"
                        value={extApiKey}
                        onChange={(e) => {
                          setExtApiKey(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder="sk-…"
                        className="tma-input"
                        autoComplete="off"
                        required={useExternal}
                      />
                      {externalMode === 'hermes' && (
                        <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                          Bearer-ключ твоего Hermes; хранится в зашифрованном виде, показываем
                          только последние 4 знака.
                        </span>
                      )}
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="tma-card-text">
                        {externalMode === 'hermes' ? 'Профиль / агент' : 'Модель (опционально)'}
                      </span>
                      <input
                        type="text"
                        value={extModelSlug}
                        onChange={(e) => setExtModelSlug(e.target.value)}
                        placeholder={
                          externalMode === 'hermes'
                            ? 'backend-eng'
                            : 'например: llama-3.3-70b или gpt-4o'
                        }
                        className={`tma-input${externalMode === 'hermes' ? ' tma-mono' : ''}`}
                      />
                      <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                        {externalMode === 'hermes'
                          ? 'Имя профиля в твоём Hermes (= «модель» в его API).'
                          : 'Если пусто — используется поле «Модель» выше.'}
                      </span>
                    </label>
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
                      <div className="tma-card tma-success-box">
                        <p
                          className="tma-card-text"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        >
                          <Icon d={ICONS.check} size={14} /> Endpoint работает{' '}
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
              </Accordion>

              <Accordion
                title="MCP и бюджет"
                summary={mcpBudgetSummary}
                open={!!open.mcp}
                onToggle={() => toggle('mcp')}
              >
                <span className="tma-card-text" style={{ fontWeight: 600 }}>
                  MCP-сервер (скиллы) — опционально
                </span>
                <p className="tma-card-text" style={{ fontSize: 11, opacity: 0.7, marginTop: -6 }}>
                  Подключи внешний MCP-сервер (https) — его инструменты станут доступны агенту.
                  Только удалённый Streamable-HTTP. Вызовы бесплатны.
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
                    className="tma-input"
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
                      className="tma-input"
                    />
                  </label>
                )}

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text">Дневной бюджет, кр</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={dailyBudget}
                    onChange={(e) => setDailyBudget(e.target.value)}
                    placeholder="100"
                    className="tma-input tma-mono"
                    disabled={useExternal}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tma-card-text" style={{ opacity: 0.75 }}>
                    Месячный бюджет, кр
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    placeholder="10"
                    className="tma-input tma-mono"
                    disabled={useExternal}
                  />
                </label>
                {useExternal && (
                  <span className="tma-card-text" style={{ fontSize: 11, opacity: 0.6 }}>
                    Бюджеты не применяются для своего провайдера — оплата у твоего провайдера.
                  </span>
                )}
              </Accordion>

              {cloneInsufficient && (
                <div className="tma-card" style={{ padding: 14 }}>
                  <p className="tma-card-text">
                    Недостаточно кредитов. Пополните баланс и попробуйте снова.
                  </p>
                  <Link href="/profile/topup" className="tma-btn tma-btn--ghost">
                    Пополнить баланс
                  </Link>
                </div>
              )}

              {submitErr && <div className="tma-error">Ошибка: {submitErr}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setPickedKind(null);
                    setAiDraft(false);
                    setCloneFromTemplateId(null);
                    setCloneInsufficient(false);
                  }}
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
