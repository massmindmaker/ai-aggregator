import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import type { Metadata } from 'next';
import MainLayout from '@/components/layout/MainLayout';
import HeroAnimation from '@/components/HeroAnimation';
import HeroTerminal from '@/components/home/HeroTerminal';
import HomeFaq from '@/components/home/HomeFaq';
import { ScenarioCardLink } from '@/components/home/ScenarioCardLink';
import { CellsSpot } from '@/components/animations/CellsSpot';
import { CodeTabsDemo } from '@/components/home/CodeTabsDemo';
import { TopModelsLeaderboard } from '@/components/home/TopModelsLeaderboard';
import { CountUp } from '@/components/ui/CountUp';
import type { ModelType } from '@/lib/marketplace/catalog';
import { filtersToSearchParams } from '@/lib/marketplace/filters';

/**
 * Storefront numbers are derived from the live catalog, never hand-written —
 * the hardcoded "400+ моделей" claimed ~6x the real catalog. `getAllModels`
 * and `getAllOrgs` are synchronous pure reads over the generated catalog
 * (no DB, no network), so module scope is safe here.
 *
 * 🔴 AG-7 (2026-09-30): the same rule now applies to PRICES and to the tier
 * cards below. This file used to print hand-typed "0.2 rub / 1k tok" strings and
 * five subscription tiers (Basic/Starter/Growth/Pro/Business) that the billing
 * code does not know: prices are billed in CREDITS (pricing-calc.ts docblock)
 * and `TIERS` in lib/payments/providers.ts has exactly three ids
 * (basic|starter|pro) — Growth/Business returned 400 BAD_TIER at checkout.
 * Both blocks are now derived from those two modules.
 *
 * Gram-storefront (2026-10-09): the pricing section below sells Gram top-up
 * packages projected from the active TON checkout policy (`readGramPricing`),
 * not ruble subscriptions.
 */

import { getModelBySlug } from '@/lib/marketplace/catalog';
import { formatPriceLabel } from '@/lib/marketplace/pricing-calc';
import {
  readGramPricing,
  type GramPackageView,
  type GramPricingView,
} from '@/lib/ton-wallet/pricing-packages';

// Gram-storefront (task 5, fix round 1): HomePage reads the live TON checkout
// policy via `readGramPricing` (DB) — without this the route stays static and
// the build would bake in a fallback "Цена — на странице оплаты" or a stale
// fx snapshot. Mirrors pricing/page.tsx.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title:
    'AI-Aggregator — любая AI-модель, один API, оплата в Gram',
  description:
    'Подключайте AI-модели через OpenAI-совместимый API. GPT-5, Claude, Flux, Veo и открытые модели. Оплата в Gram (TON), курс фиксируется на счёте. Deploy в РФ-регионе.',
};

/**
 * Each scenario links to `/marketplace` pre-filtered to the model
 * type/tag that actually matches it in the live catalog (checked against
 * `apps/web/src/lib/marketplace/catalog.generated.ts`, 2026-07-17: 69
 * models — llm 36 / image 15 / video 10 / audio 5 / embedding 3, `code`
 * exists only as a tag, never as `type`).
 *
 * RAG/Docs maps to `types: ['embedding']` rather than `['embedding','llm']`:
 * the llm-inclusive variant returns 39/69 models — almost identical to the
 * Chatbot card's 36 — which would make the "curated" scenario list a
 * near-duplicate of Chatbot/Support (a Potemkin filter, not a real one).
 * Embedding-only stays small but honest and distinct.
 */
const scenarios: Array<{
  icon: string;
  title: string;
  desc: string;
  filter: { types?: ModelType[]; tags?: string[] };
}> = [
  {
    icon: '💬',
    title: 'Chatbot / Support',
    desc: 'GPT-5, Claude, DeepSeek. Контекст до 200k, один OpenAI-совместимый endpoint.',
    filter: { types: ['llm'] },
  },
  {
    icon: '📄',
    title: 'RAG / Docs',
    desc: 'Embedding-модели для индексации плюс LLM для ответа. Русские: ЯндексGPT, GigaChat.',
    filter: { types: ['embedding'] },
  },
  {
    icon: '</>',
    title: 'Code / DevTool',
    desc: 'Claude Sonnet, DeepSeek, Qwen — по тегу «code» в каталоге.',
    filter: { tags: ['code'] },
  },
  {
    icon: '🖼',
    title: 'Image / Avatar',
    desc: 'Flux, Imagen, Midjourney, Stable Diffusion — генерация изображений.',
    filter: { types: ['image'] },
  },
  {
    icon: '🎙',
    title: 'Audio / Voice',
    desc: 'ElevenLabs, Suno — синтез речи и генерация музыки.',
    filter: { types: ['audio'] },
  },
];

function scenarioHref(filter: { types?: ModelType[]; tags?: string[] }): string {
  const qs = filtersToSearchParams(filter).toString();
  return qs ? `/marketplace?${qs}` : '/marketplace';
}

const providers = [
  'OpenAI',
  'Anthropic',
  'Google',
  'DeepSeek',
  'Qwen',
  'Meta Llama',
  'Mistral',
  'xAI',
  'Stability AI',
  'Black Forest Labs',
  'ElevenLabs',
  'Yandex',
  'Sber',
];

interface HeroStat {
  label: string;
  end?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Static value used when no `end` is given (e.g. "<150мс"). */
  staticValue?: string;
}

// Hero counters removed by founder decision (2026-08-23):
// Uptime and latency stats were REMOVED, not re-estimated: we have no
// measurement pipeline (`requests` is empty), so any number here would be
// invented. Re-add only when backed by real telemetry.
const heroStats: HeroStat[] = []; // счётчики убраны по решению основателя (2026-08-23)

/** Slugs for the decorative floating cards — resolved against the live catalog. */
const FLOATING_MODEL_SLUGS = [
  'openai/gpt-5-5',
  'flux-pro-1-1',
  'elevenlabs-tts-hf',
];

/**
 * 🔴 AG-7 (2026-09-30): these were four hand-written cards with hand-typed
 * prices in rubles ("0.2 rub / 1k tok" for a model the catalog prices at 0.9
 * credits/1k). Prices are now read from the same catalog the marketplace uses
 * and printed by `formatPriceLabel`, which renders CREDITS ("кр") — the unit
 * billing actually charges in. Slugs are resolved through `getModelBySlug`, so
 * a card can only render if that model is in the catalog right now.
 */
const TOP_MODEL_SLUGS: Array<{ slug: string; code: string }> = [
  { slug: 'openai/gpt-5-5', code: 'G5' },
  { slug: 'anthropic/claude-sonnet-4-6', code: 'C4' },
  { slug: 'flux-pro-1-1', code: 'FX' },
  { slug: 'stable-diffusion-3-5', code: 'SD' },
];

/** Chip text for the "горячее сейчас" cards, from the real model type. */
const MODEL_TYPE_CHIP: Record<string, string> = {
  llm: 'chat',
  image: 'image',
  video: 'video',
  audio: 'audio',
  embedding: 'embedding',
};

const topModels = TOP_MODEL_SLUGS.flatMap(({ slug, code }) => {
  const model = getModelBySlug(slug);
  if (!model) return [];
  return [
    {
      code,
      slug: model.slug,
      title: model.name,
      provider: model.orgName,
      chips: [MODEL_TYPE_CHIP[model.type] ?? model.type],
      price: formatPriceLabel(model),
      href: `/marketplace/${model.orgSlug}/${model.modelSlug}`,
    },
  ];
});

const steps = [
  {
    num: '// 01',
    title: 'Выберите модель',
    desc: `Каталог с фильтром по модальности, цене и latency. Playground без регистрации.`,
    code: (
      <>
        GET <span style={{ color: '#a1e89b' }}>/marketplace?tag=image</span>
      </>
    ),
  },
  {
    num: '// 02',
    title: 'Получите API-ключ',
    desc: 'Пополните баланс в Gram (TON). Ключ в дашборде через 10 секунд.',
    code: (
      <>
        Authorization: Bearer{' '}
        <span style={{ color: 'var(--accent)' }}>sk_aiag_live_...</span>
      </>
    ),
  },
  {
    num: '// 03',
    title: 'Подключите в коде',
    desc: 'OpenAI-совместимый endpoint. Поменяйте base_url — и всё работает.',
    code: (
      <>
        <span style={{ color: '#93c5fd' }}>base_url</span>=
        <span style={{ color: '#a1e89b' }}>{'"api.ai-aggregator.ru/v1"'}</span>
      </>
    ),
  },
];

const compareRows = [
  {
    feat: 'Крипто-оплата Gram (TON)',
    us: { kind: 'check', text: '✓ Gram (TON), курс фиксируется на счёте' },
    cells: [
      { kind: 'cross', text: '✗ только US card' },
      { kind: 'cross', text: '✗ только US card' },
      { kind: 'cross', text: '✗ только фиат (ЮKassa)' },
    ],
  },
  {
    feat: 'Работает без VPN',
    us: { kind: 'check', text: '✓ РФ-регион' },
    cells: [
      { kind: 'cross', text: '✗ geo-блок' },
      { kind: 'meh', text: '~ частично' },
      { kind: 'check', text: '✓' },
    ],
  },
  {
    // 🔴 AG-7: this row used to advertise chat + image + audio. `/v1/catalog`
    // can only mark `chat` and `embedding` models `available`
    // (public-catalog.ts:519-521) — image/video/audio resolve to
    // unavailable('no_admitted_deployment'). Media is served by its own
    // endpoints, so the honest claim is the two catalog types, not three
    // modalities.
    feat: 'Каталог моделей',
    us: { kind: 'check', text: '✓ LLM + эмбеддинги в /v1/catalog' },
    cells: [
      { kind: 'check', text: '✓ 1000+ (image heavy)' },
      { kind: 'check', text: '✓ 500k+ (часто без API)' },
      { kind: 'meh', text: '~ 30 LLM' },
    ],
  },
  {
    feat: 'OpenAI-совместимый API',
    us: { kind: 'check', text: '✓ drop-in replacement' },
    cells: [
      { kind: 'cross', text: '✗ свой формат' },
      { kind: 'meh', text: '~ Inference API' },
      { kind: 'check', text: '✓' },
    ],
  },
  // "Latency из РФ" row removed: it quoted "< 100ms" for us and invented
  // per-competitor numbers, none of which are measured anywhere. Restore only
  // with a real latency benchmark behind it.
  {
    feat: 'Кастом-модели / авторская публикация',
    us: { kind: 'check', text: '✓ публикация из кабинета + 70% ML-инженеру' },
    cells: [
      { kind: 'cross', text: '✗' },
      { kind: 'cross', text: '✗' },
      { kind: 'cross', text: '✗' },
    ],
  },
  {
    feat: 'Договор + закр. документы',
    us: { kind: 'check', text: '✓ ИП / ООО, УПД, счёт' },
    cells: [
      { kind: 'cross', text: '✗' },
      { kind: 'cross', text: '✗' },
      { kind: 'check', text: '✓' },
    ],
  },
];

const cellColor: Record<string, string> = {
  check: 'var(--success)',
  cross: 'var(--danger)',
  meh: 'var(--ink-muted)',
};

/**
 * 🔴 AG-7 (2026-09-30): this block used to advertise five tiers — Basic 990,
 * Starter 2490, **Growth 4490**, Pro 6990, **Business 29900** — and per-tier
 * promises ("+1000 руб на баланс", "-10% на запросы", "5 API-ключей",
 * "Retention логов 90 дней") that exist nowhere in the code. Growth and
 * Business are not in `TIERS` at all: `getTier()` returned null and checkout
 * answered 400 BAD_TIER, i.e. two of the five cards on the home page were
 * unpurchasable.
 *
 * Gram-storefront (2026-10-09): the section sells no ruble subscriptions at
 * all anymore. Cards are Gram top-up packages projected from the active TON
 * checkout policy via `readGramPricing` (task 3) — the same view /pricing
 * invoices from. Without a policy NO price is invented: the three canonical
 * packages render with the line "Цена — на странице оплаты" and the CTA still
 * leads to /pricing.
 */
const HOME_PACKAGE_IDS = ['credit-1200', 'credit-3200', 'credit-10000'];

/** Canonical ids/labels shown when the checkout policy is unavailable. */
const DEFAULT_HOME_PACKAGES = [
  { id: 'credit-1200', label: 'Basic — 1 200 кредитов' },
  { id: 'credit-3200', label: 'Starter — 3 200 кредитов' },
  { id: 'credit-10000', label: 'Pro — 10 000 кредитов' },
];

interface HomePackageCard {
  id: string;
  label: string;
  featured: boolean;
  price: ReactNode;
  desc: string;
  cta: string;
}

/** Up to three packages: the canonical ids when present, else the first three. */
function pickHomePackages(view: GramPricingView): GramPackageView[] {
  const preferred = HOME_PACKAGE_IDS.flatMap((id) => {
    const pkg = view.packages.find((p) => p.id === id);
    return pkg ? [pkg] : [];
  });
  const chosen = [...(preferred.length > 0 ? preferred : view.packages)];
  for (const pkg of view.packages) {
    if (chosen.length >= 3) break;
    if (!chosen.some((p) => p.id === pkg.id)) chosen.push(pkg);
  }
  return chosen.slice(0, 3);
}

function buildHomePackageCards(view: GramPricingView | null): HomePackageCard[] {
  if (!view || view.packages.length === 0) {
    return DEFAULT_HOME_PACKAGES.map((pkg, i) => ({
      id: pkg.id,
      label: pkg.label,
      featured: i === 1,
      price: (
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Цена — на странице оплаты
        </span>
      ),
      desc: 'Пополнение в Gram (TON).',
      cta: 'Подключить',
    }));
  }
  return pickHomePackages(view).map((pkg, i) => ({
    id: pkg.id,
    label: pkg.label,
    featured: i === 1,
    price: (
      <>
        {'≈ '}
        {pkg.grams}
        <span style={{ color: 'var(--accent)', fontSize: 14 }}> GRAM</span>
      </>
    ),
    desc: `${pkg.credits} кредитов`,
    cta: 'Подключить',
  }));
}

export default async function HomePage() {
  // Never throws (task 3): null when the policy is missing/unparsable —
  // buildHomePackageCards then renders the no-price fallback cards.
  const gramPricing = await readGramPricing();
  const homePackages = buildHomePackageCards(gramPricing);

  return (
    <MainLayout>
      {/* ═══ HERO ═══ */}
      <section className="aiag-hero relative isolate overflow-hidden">
        {/* Layer: cellular automaton canvas (full-bleed) */}
        <div className="aiag-hero-canvas">
          <HeroAnimation
            className="absolute inset-0"
            opacity={1}
            cellSize={5}
            density={0.32}
            tickMs={140}
          />
        </div>
        {/* Layer: SVG-style lattice overlay */}
        <div className="aiag-hero-lattice" />
        {/* Layer: vignette overlay */}
        <div className="aiag-hero-overlay" />

        {/* Layer: aurora accent spots */}
        <div className="aiag-aurora" style={{ top: '10%', left: '15%', zIndex: 0 }} />
        <div
          className="aiag-aurora"
          style={{ top: '40%', right: '10%', zIndex: 0, animationDelay: '6s' }}
        />

        {/* Floating model cards (right side) — hidden on mobile via CSS.
            Prices come from the catalog via formatPriceLabel (credits, "кр"),
            and the slugs are resolved from the live catalog, so a card can
            only render for a model that is actually listed. AG-7 replaced the
            hand-typed ruble prices here — including the card for the
            transcription model, unsold since migration 0093. */}
        <div
          className="aiag-floating-cards absolute inset-0 pointer-events-none"
          style={{ zIndex: 0 }}
        >
          {FLOATING_MODEL_SLUGS.map((slug, i) => {
            const model = getModelBySlug(slug);
            if (!model) return null;
            return (
              <div key={slug} className={`aiag-float-card fc-${i + 1}`}>
                <div
                  className="font-semibold mb-1 text-[12px]"
                  style={{ color: 'var(--ink)' }}
                >
                  {model.orgSlug} / {model.modelSlug}
                </div>
                <div style={{ color: 'var(--ink-muted)' }}>
                  {model.type} ·{' '}
                  <span style={{ color: 'var(--accent)' }}>
                    {formatPriceLabel(model)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="aiag-hero-grid relative items-center"
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            zIndex: 1,
          }}
        >
          <div className="min-w-0">
            <span
              className="aiag-hero-badge aiag-fade-up inline-flex items-center font-mono uppercase rounded-sm"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                letterSpacing: '0.1em',
                marginBottom: 24,
                padding: '7px 12px',
                background: 'rgba(245,158,11,0.12)',
                border: '1px solid rgba(245,158,11,0.28)',
                '--fade-dur': '500ms',
                '--fade-delay': '100ms',
              } as CSSProperties}
            >
              <span
                className="aiag-pulse inline-block rounded-full mr-2"
                style={{
                  width: 6,
                  height: 6,
                  background: 'var(--accent)',
                }}
              />
              оплата в Gram · без VPN
            </span>

            <h1
              className="aiag-fade-up font-bold"
              style={{
                fontSize: 'clamp(36px, 8vw, 84px)',
                lineHeight: 0.98,
                letterSpacing: '-0.035em',
                margin: '0 0 28px',
                '--fade-dur': '700ms',
                '--fade-delay': '300ms',
              } as CSSProperties}
            >
              Any AI model.
              <br />
              One API.
              <br />
              Payments in <span style={{ color: 'var(--accent)' }}>Gram.</span>
            </h1>

            <p
              className="aiag-fade-up text-[18px]"
              style={{
                lineHeight: 1.55,
                color: 'var(--ink-muted)',
                maxWidth: 540,
                margin: '0 0 36px',
                '--fade-dur': '500ms',
                '--fade-delay': '1000ms',
              } as CSSProperties}
            >
              Подключайте AI-модели через OpenAI-совместимый API. GPT-5,
              Claude, Flux, Veo и открытые модели. Пополнение в Gram (TON),
              списание в кредитах. Deploy в РФ-регионе.
            </p>

            <div className="flex gap-3.5 flex-wrap">
              <Link
                href="/marketplace"
                className="aiag-fade-up inline-flex items-center gap-2 font-semibold rounded-sm transition-all hover:-translate-y-px"
                style={{
                  padding: '14px 24px',
                  fontSize: 15,
                  background: 'var(--accent)',
                  color: '#000',
                  border: '1px solid var(--accent)',
                  boxShadow: '0 0 0 0 rgba(245,158,11,0)',
                  '--fade-dur': '500ms',
                  '--fade-delay': '1200ms',
                } as CSSProperties}
              >
                Запустить модель <span>→</span>
              </Link>
              <Link
                href="/docs"
                className="aiag-fade-up inline-flex items-center gap-2 font-semibold rounded-sm transition-colors hover:bg-white/[0.04]"
                style={{
                  padding: '14px 24px',
                  fontSize: 15,
                  background: 'transparent',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  '--fade-dur': '500ms',
                  '--fade-delay': '1280ms',
                } as CSSProperties}
              >
                Документация
              </Link>
            </div>

            <div
              className="aiag-hero-stats aiag-fade-up flex gap-6 flex-wrap font-mono"
              style={{
                marginTop: 32,
                fontSize: 12,
                color: 'var(--ink-muted)',
                '--fade-dur': '500ms',
                '--fade-delay': '1400ms',
              } as CSSProperties}
            >
              <span className="inline-flex items-center gap-1.5">
                <span style={{ color: 'var(--success)' }}>✓</span> Оплата в
                Gram (TON)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span style={{ color: 'var(--success)' }}>✓</span>{' '}
                OpenAI-совместимый API
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* ═══ Inline stat counters ═══ */}
      <section style={{ padding: '48px 20px 8px' }}>
        <div
          className="mx-auto grid grid-cols-2 gap-6"
          style={{ maxWidth: 1280 }}
        >
          {heroStats.map((s) => (
            <div key={s.label}>
              <div
                className="text-3xl font-bold tabular-nums"
                style={{ color: 'var(--accent)', letterSpacing: '-0.02em' }}
              >
                {s.end !== undefined ? (
                  <CountUp
                    end={s.end}
                    decimals={s.decimals ?? 0}
                    prefix={s.prefix ?? ''}
                    suffix={s.suffix ?? ''}
                  />
                ) : (
                  s.staticValue
                )}
              </div>
              <div
                className="text-xs uppercase opacity-60 tracking-wider mt-1 font-mono"
                style={{ color: 'var(--ink-muted)' }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══ Provider logos marquee ═══ */}
      <section
        className="mt-8 overflow-hidden border-y"
        style={{ borderColor: 'var(--line)' }}
      >
        <div className="py-8">
          <p
            className="text-xs uppercase opacity-50 tracking-widest text-center mb-6 font-mono"
            style={{ color: 'var(--ink-muted)' }}
          >
            Под капотом — лучшие модели мира
          </p>
          <div className="relative">
            <div
              className="aiag-logo-track whitespace-nowrap"
              style={{ gap: 12 }}
            >
              {[...providers, ...providers].map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className="shrink-0 px-5 py-2 rounded-full border text-sm tracking-wide opacity-60 hover:opacity-100 transition-opacity"
                  style={{
                    borderColor: 'var(--line)',
                    background: 'rgba(255,255,255,0.02)',
                    color: 'var(--ink)',
                  }}
                >
                  {name}
                </div>
              ))}
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 left-0 w-24"
              style={{
                background:
                  'linear-gradient(to right, var(--bg), transparent)',
              }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-24"
              style={{
                background: 'linear-gradient(to left, var(--bg), transparent)',
              }}
            />
          </div>
        </div>
      </section>

      {/* ═══ Code-tabs demo with streaming preview ═══ */}
      <CodeTabsDemo />

      {/* ═══ Live top-models leaderboard ═══ */}
      <TopModelsLeaderboard />

      {/* ═══ Scenarios ═══ */}
      <section className="aiag-grid-bg-glow overflow-hidden" style={{ padding: '96px 20px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="mb-14">
            <div
              className="font-mono uppercase mb-3.5"
              style={{ fontSize: 11, color: 'var(--accent)', letterSpacing: '0.12em' }}
            >
              {'// Что вы строите?'}
            </div>
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px, 4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                margin: '0 0 16px',
              }}
            >
              Выберите сценарий — получите нужные модели
            </h2>
            <p
              style={{ fontSize: 17, color: 'var(--ink-muted)', maxWidth: 600 }}
            >
              Пять готовых направлений с примерами запуска. Откройте любой — и
              получите curated список моделей с метриками.
            </p>
          </div>

          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
          >
            {scenarios.map((s) => (
              <ScenarioCardLink
                key={s.title}
                href={scenarioHref(s.filter)}
                className="block transition-all hover:-translate-y-1"
                style={{
                  padding: 24,
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  background: 'var(--bg-elev)',
                }}
              >
                <div
                  className="grid place-items-center mb-4"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 2,
                    background: 'rgba(245,158,11,0.12)',
                    color: 'var(--accent)',
                    fontSize: 18,
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}
                >
                  {s.icon}
                </div>
                <div className="font-semibold text-[15px] mb-1.5">
                  {s.title}
                </div>
                <div
                  className="font-mono"
                  style={{ fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.5 }}
                >
                  {s.desc}
                </div>
              </ScenarioCardLink>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ Catalog teaser ═══ */}
      <section style={{ padding: '32px 20px 96px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="flex justify-between items-end mb-8 flex-wrap gap-4">
            <div>
              <div
                className="font-mono uppercase mb-3.5"
                style={{
                  fontSize: 11,
                  color: 'var(--accent)',
                  letterSpacing: '0.12em',
                }}
              >
                {'// Топ-модели недели'}
              </div>
              <h2
                className="font-bold"
                style={{
                  fontSize: 'clamp(32px, 4vw, 48px)',
                  lineHeight: 1.05,
                  letterSpacing: '-0.025em',
                  margin: '0 0 8px',
                }}
              >
                Горячее сейчас
              </h2>
              <p style={{ fontSize: 17, color: 'var(--ink-muted)', maxWidth: 600 }}>
                Модели из каталога. Списание в кредитах, деплой в РФ-регионе.
              </p>
            </div>
            <Link
              href="/marketplace"
              className="inline-flex items-center gap-2 px-4 py-2.5 font-semibold rounded-sm hover:bg-white/[0.04] transition-colors"
              style={{
                fontSize: 13,
                border: '1px solid var(--line)',
                color: 'var(--ink)',
              }}
            >
              Весь каталог <span>→</span>
            </Link>
          </div>

          <div
            className="grid gap-5"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
          >
            {topModels.map((m) => (
              <Link
                key={m.slug}
                href={m.href}
                className="block transition-all hover:-translate-y-1 cursor-pointer"
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  padding: 20,
                }}
              >
                <div className="flex items-center gap-2.5 mb-3">
                  <div
                    className="grid place-items-center font-mono font-bold"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 3,
                      background: 'var(--bg-surface)',
                      fontSize: 13,
                      color: 'var(--accent)',
                      border: '1px solid var(--line)',
                    }}
                  >
                    {m.code}
                  </div>
                  <div>
                    <div className="font-semibold text-[14px]">{m.title}</div>
                    <div
                      className="font-mono"
                      style={{ fontSize: 11, color: 'var(--ink-muted)' }}
                    >
                      {m.provider}
                    </div>
                  </div>
                </div>
                <div className="my-2">
                  {m.chips.map((c) => (
                    <span
                      key={c}
                      className="inline-block font-mono mr-1"
                      style={{
                        padding: '3px 8px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid var(--line)',
                        borderRadius: 2,
                        fontSize: 10,
                        color: 'var(--ink-muted)',
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--ink-muted)',
                    lineHeight: 1.5,
                    margin: '12px 0',
                    minHeight: 36,
                  }}
                >
                  {m.title} — {m.provider}. Цена и доступность — из каталога.
                </div>
                <div
                  className="flex items-center font-mono"
                  style={{
                    paddingTop: 12,
                    borderTop: '1px solid var(--line)',
                    fontSize: 12,
                  }}
                >
                  <div
                    className="font-semibold"
                    style={{ color: 'var(--accent)' }}
                  >
                    {m.price}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ How it works ═══ */}
      <section
        className="aiag-grid-bg-glow-alt overflow-hidden"
        style={{ padding: '96px 20px', backgroundColor: 'var(--bg-elev)' }}
      >
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="mb-14 flex items-start justify-between gap-6 flex-wrap">
            <div className="min-w-0 flex-1">
            <div
              className="font-mono uppercase mb-3.5"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                letterSpacing: '0.12em',
              }}
            >
              {'// Как это работает'}
            </div>
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px, 4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                margin: '0 0 16px',
              }}
            >
              Первый запрос за 2 минуты
            </h2>
            <p style={{ fontSize: 17, color: 'var(--ink-muted)', maxWidth: 600 }}>
              OpenAI SDK → меняете base URL → работает. Без миграции кода.
            </p>
            </div>
            <div className="hidden md:block shrink-0">
              <CellsSpot width={240} height={160} cellSize={6} />
            </div>
          </div>

          <div
            className="grid gap-8"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
          >
            {steps.map((s) => (
              <div
                key={s.num}
                style={{
                  padding: '32px 28px',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  background: 'var(--bg-surface)',
                }}
              >
                <div
                  className="font-mono"
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    letterSpacing: '0.1em',
                    marginBottom: 16,
                  }}
                >
                  {s.num}
                </div>
                <div className="font-semibold mb-2.5" style={{ fontSize: 22 }}>
                  {s.title}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: 'var(--ink-muted)',
                    lineHeight: 1.6,
                    marginBottom: 16,
                  }}
                >
                  {s.desc}
                </div>
                <div
                  className="font-mono overflow-x-auto"
                  style={{
                    padding: '12px 14px',
                    background: '#0f0f11',
                    border: '1px solid var(--line)',
                    borderRadius: 3,
                    fontSize: 12,
                    color: 'var(--ink-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.code}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ Comparison ═══ */}
      <section style={{ padding: '96px 20px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="mb-14">
            <div
              className="font-mono uppercase mb-3.5"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                letterSpacing: '0.12em',
              }}
            >
              {'// Чем отличаемся'}
            </div>
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px, 4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                margin: '0 0 16px',
              }}
            >
              AI-Aggregator vs альтернативы
            </h2>
            <p style={{ fontSize: 17, color: 'var(--ink-muted)', maxWidth: 600 }}>
              Прямое сравнение по критериям, важным для российского
              разработчика.
            </p>
          </div>

          <div
            className="overflow-x-auto"
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--line)',
              borderRadius: 6,
            }}
          >
            <table
              className="w-full"
              style={{ borderCollapse: 'collapse', minWidth: 600 }}
            >
              <thead>
                <tr>
                  <th
                    className="font-mono uppercase font-semibold"
                    style={{
                      width: '30%',
                      padding: '16px 20px',
                      textAlign: 'left',
                      borderBottom: '1px solid var(--line)',
                      background: 'var(--bg-surface)',
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Критерий
                  </th>
                  <th
                    className="font-mono uppercase font-semibold"
                    style={{
                      padding: '16px 20px',
                      textAlign: 'left',
                      borderBottom: '1px solid var(--line)',
                      background: 'rgba(245,158,11,0.12)',
                      fontSize: 12,
                      color: 'var(--accent)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    AI-Aggregator
                  </th>
                  {['Replicate', 'Hugging Face', 'Polza.ai'].map((h) => (
                    <th
                      key={h}
                      className="font-mono uppercase font-semibold"
                      style={{
                        padding: '16px 20px',
                        textAlign: 'left',
                        borderBottom: '1px solid var(--line)',
                        background: 'var(--bg-surface)',
                        fontSize: 12,
                        color: 'var(--ink-muted)',
                        letterSpacing: '0.08em',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row, idx) => (
                  <tr
                    key={idx}
                    className="hover:bg-white/[0.02] transition-colors"
                  >
                    <td
                      className="font-medium"
                      style={{
                        padding: '16px 20px',
                        borderBottom:
                          idx === compareRows.length - 1
                            ? 'none'
                            : '1px solid var(--line)',
                        fontSize: 14,
                        color: 'var(--ink)',
                      }}
                    >
                      {row.feat}
                    </td>
                    <td
                      className="font-mono"
                      style={{
                        padding: '16px 20px',
                        borderBottom:
                          idx === compareRows.length - 1
                            ? 'none'
                            : '1px solid var(--line)',
                        fontSize: 14,
                        background: 'rgba(245,158,11,0.04)',
                        color: cellColor[row.us.kind],
                      }}
                    >
                      {row.us.text}
                    </td>
                    {row.cells.map((c, i) => (
                      <td
                        key={i}
                        className="font-mono"
                        style={{
                          padding: '16px 20px',
                          borderBottom:
                            idx === compareRows.length - 1
                              ? 'none'
                              : '1px solid var(--line)',
                          fontSize: 14,
                          color: cellColor[c.kind],
                        }}
                      >
                        {c.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ═══ Pricing ═══ */}
      <section
        style={{ padding: '96px 20px', background: 'var(--bg-elev)' }}
      >
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="mb-14">
            <div
              className="font-mono uppercase mb-3.5"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                letterSpacing: '0.12em',
              }}
            >
              {'// Тарифы'}
            </div>
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px, 4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                margin: '0 0 16px',
              }}
            >
              Pay-as-you-go или депозит
            </h2>
            <p style={{ fontSize: 17, color: 'var(--ink-muted)', maxWidth: 600 }}>
              Платите за фактическое использование: цена запроса одна и та же
              вне зависимости от тарифа. Пакеты пополнения — разовым депозитом
              в Gram (TON).
            </p>
          </div>

          <div
            className="aiag-pricing-grid grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}
          >
            {homePackages.map((p) => (
              <div
                key={p.id}
                className={`relative transition-all hover:-translate-y-0.5`}
                style={{
                  background: p.featured
                    ? 'linear-gradient(180deg, rgba(245,158,11,0.08) 0%, var(--bg-surface) 100%)'
                    : 'var(--bg-surface)',
                  border: `1px solid ${p.featured ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 4,
                  padding: '22px 18px',
                }}
              >
                {p.featured && (
                  <div
                    className="absolute font-bold uppercase"
                    style={{
                      top: -10,
                      left: 18,
                      background: 'var(--accent)',
                      color: '#000',
                      padding: '3px 10px',
                      fontSize: 10,
                      borderRadius: 2,
                      letterSpacing: '0.08em',
                    }}
                  >
                    Популярный
                  </div>
                )}
                <div
                  className="font-mono uppercase mb-2.5"
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-muted)',
                    letterSpacing: '0.1em',
                  }}
                >
                  {p.label}
                </div>
                <div
                  className="font-mono font-bold"
                  style={{ fontSize: 24, letterSpacing: '-0.02em' }}
                >
                  {p.price}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-muted)',
                    lineHeight: 1.5,
                    margin: '14px 0',
                  }}
                >
                  {p.desc}
                </div>
                <Link
                  href="/pricing"
                  className="block text-center font-semibold transition-all"
                  style={{
                    padding: 8,
                    border: `1px solid ${p.featured ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 2,
                    fontSize: 12,
                    background: p.featured ? 'var(--accent)' : 'transparent',
                    color: p.featured ? '#000' : 'var(--ink)',
                  }}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <section style={{ padding: '96px 20px' }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div className="text-center mb-14">
            <div
              className="font-mono uppercase mb-3.5"
              style={{
                fontSize: 11,
                color: 'var(--accent)',
                letterSpacing: '0.12em',
              }}
            >
              {'// FAQ'}
            </div>
            <h2
              className="font-bold"
              style={{
                fontSize: 'clamp(32px, 4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                margin: 0,
              }}
            >
              Часто задаваемые вопросы
            </h2>
          </div>
          <HomeFaq />
        </div>
      </section>

      {/* ═══ Bottom CTA ═══ */}
      <section
        className="relative overflow-hidden isolate text-center"
        style={{
          padding: '100px 20px',
          borderTop: '1px solid var(--line)',
          background:
            'radial-gradient(ellipse at center top, rgba(245,158,11,0.08), transparent 60%)',
        }}
      >
        <h2
          className="font-bold"
          style={{
            fontSize: 'clamp(40px, 5vw, 64px)',
            letterSpacing: '-0.03em',
            lineHeight: 1.02,
            margin: '0 0 20px',
          }}
        >
          Любая модель. Один API.
          <br />
              <span style={{ color: 'var(--accent)' }}>Оплата Gram (TON).</span>
        </h2>
        <p
          style={{
            color: 'var(--ink-muted)',
            fontSize: 17,
            margin: '0 auto 32px',
            maxWidth: 520,
          }}
        >
          Оплата в Gram (TON), SDK на 6 языках. Первый
          запрос за 2 минуты.
        </p>
        <div className="flex gap-3.5 flex-wrap justify-center">
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 font-semibold rounded-sm hover:-translate-y-px transition-all"
            style={{
              padding: '14px 24px',
              fontSize: 15,
              background: 'var(--accent)',
              color: '#000',
              border: '1px solid var(--accent)',
            }}
          >
            Запустить модель <span>→</span>
          </Link>
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 font-semibold rounded-sm hover:bg-white/[0.04] transition-colors"
            style={{
              padding: '14px 24px',
              fontSize: 15,
              background: 'transparent',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
            }}
          >
            Документация
          </Link>
        </div>
      </section>

      {/* ═══ Footer ═══ */}
      <footer
        style={{
          padding: '56px 20px 32px',
          borderTop: '1px solid var(--line)',
          background: 'var(--bg-elev)',
        }}
      >
        <div
          className="grid gap-12"
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          }}
        >
          <div style={{ gridColumn: 'span 2' }} className="min-w-0">
            <div className="font-mono font-bold tracking-tight text-[15px]">
              ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
            </div>
            <p
              style={{
                color: 'var(--ink-muted)',
                fontSize: 13,
                lineHeight: 1.6,
                marginTop: 12,
                maxWidth: 320,
              }}
            >
              Маркетплейс AI-моделей с OpenAI-совместимым API. Пополнение
              в Gram (TON), списание в кредитах. Deploy в РФ-регионе.
            </p>
          </div>

          {[
            {
              h: 'Продукт',
              links: [
                ['Маркетплейс', '/marketplace'],
                ['Тарифы', '/pricing'],
              ],
            },
            {
              h: 'Разработчикам',
              links: [
                ['Документация', '/docs'],
                ['API Reference', '/docs'],
                ['Status', '/status'],
              ],
            },
            {
              h: 'Компания',
              links: [
                ['Хроника', '/manifesto'],
              ],
            },
            {
              h: 'Правовое',
              links: [['Конфиденциальность', '/privacy']],
            },
          ].map((col) => (
            <div key={col.h}>
              <h4
                className="font-mono uppercase"
                style={{
                  fontSize: 11,
                  color: 'var(--ink-muted)',
                  letterSpacing: '0.1em',
                  margin: '0 0 16px',
                }}
              >
                {col.h}
              </h4>
              {col.links.map(([label, href]) => (
                <Link
                  key={label}
                  href={href}
                  className="block hover:text-[var(--accent)] transition-colors"
                  style={{
                    color: 'var(--ink-muted)',
                    fontSize: 13,
                    padding: '4px 0',
                  }}
                >
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </div>
        <div
          className="flex flex-col md:flex-row justify-between gap-2 font-mono"
          style={{
            maxWidth: 1280,
            margin: '40px auto 0',
            paddingTop: 24,
            borderTop: '1px solid var(--line)',
            fontSize: 11,
            color: 'var(--ink-muted)',
            letterSpacing: '0.05em',
          }}
        >
          <div>© {new Date().getFullYear()} AI-AGGREGATOR · MADE IN RU</div>
        </div>
      </footer>
    </MainLayout>
  );
}
