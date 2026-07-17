import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import MainLayout from '@/components/layout/MainLayout';
import { CellsSpot } from '@/components/animations/CellsSpot';
import { CountUp } from '@/components/ui/CountUp';

export const metadata: Metadata = {
  title: 'Для бизнеса — AI-Aggregator',
  description:
    'AI-Aggregator для бизнеса: договор с ИП/ООО, УПД, счёт, NDA, on-premise, выделенные ключи и SLA 99.9%.',
};

// HIDDEN (2026-07-17, founder decision): no separate "for business" terms —
// business customers just pick a pricing tier like everyone else. Gate the
// route behind a hard 404 instead of deleting the code — it stays in the
// repo for possible future use. To re-enable: remove this notFound() call
// and restore the MainNavbar / footer / CommandPalette entries pointing at
// /business.
export default function BusinessPage() {
  notFound();

  return (
    <MainLayout>
      {/* ───── HERO ───── */}
      <section className="relative overflow-hidden">
        <div
          className="aiag-aurora pointer-events-none"
          style={{ top: '10%', right: '15%' }}
        />
        <CellsSpot
          width={300}
          height={180}
          className="absolute right-12 top-12 hidden lg:block opacity-80 pointer-events-none"
          noMask
        />
        <div
          style={{
            padding: '96px 20px 64px',
            maxWidth: 1080,
            margin: '0 auto',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <div
            className="font-mono uppercase mb-3.5 inline-flex items-center gap-2"
            style={{
              fontSize: 11,
              color: 'var(--accent)',
              letterSpacing: '0.12em',
            }}
          >
            <span className="aiag-pulse-dot" />
            // Для бизнеса
          </div>
          <h1
            className="font-bold"
            style={{
              fontSize: 'clamp(36px, 5vw, 56px)',
              lineHeight: 1.05,
              letterSpacing: '-0.025em',
              margin: '0 0 24px',
              maxWidth: 760,
            }}
          >
            AI-инфраструктура для команд и юрлиц
          </h1>
          <p
            style={{
              fontSize: 18,
              color: 'var(--ink-muted)',
              lineHeight: 1.6,
              marginBottom: 40,
              maxWidth: 680,
            }}
          >
            Договор с ИП/ООО, УПД, счёт. NDA и 152-ФЗ. On-premise по запросу.
            Выделенные API-ключи, кастомные rate-limits, dedicated support в
            Slack/Telegram. SLA 99.9% с компенсацией.
          </p>

          <div className="flex gap-3.5 flex-wrap">
            <a
              href="mailto:team@ai-aggregator.ru?subject=Запрос%20договора%20—%20AI-Aggregator"
              className="inline-flex items-center gap-2 font-semibold rounded-sm hover:-translate-y-px transition-all"
              style={{
                padding: '14px 24px',
                fontSize: 15,
                background: 'var(--accent)',
                color: '#000',
                border: '1px solid var(--accent)',
              }}
            >
              Запросить договор →
            </a>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 font-semibold rounded-sm hover:bg-white/[0.04] transition-colors"
              style={{
                padding: '14px 24px',
                fontSize: 15,
                background: 'transparent',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
              }}
            >
              Тарифы
            </Link>
          </div>
        </div>
      </section>

      {/* ───── STATS INLINE ───── */}
      <section
        className="aiag-grid-bg-sm"
        style={{
          borderTop: '1px solid var(--line)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            margin: '0 auto',
            padding: '40px 20px',
          }}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-10"
        >
          <StatInline
            value={120}
            suffix="+"
            label="компаний на договоре"
          />
          <StatInline
            value={4.2}
            suffix="M"
            decimals={1}
            label="запросов в день"
          />
          <StatInline value={18} label="нативных интеграций" />
        </div>
      </section>

      {/* ───── FEATURES ───── */}
      <section style={{ padding: '80px 20px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <h2
            className="font-bold"
            style={{
              fontSize: 'clamp(28px, 3.5vw, 36px)',
              letterSpacing: '-0.02em',
              marginBottom: 12,
            }}
          >
            Что входит
          </h2>
          <p
            style={{
              fontSize: 16,
              color: 'var(--ink-muted)',
              marginBottom: 40,
              maxWidth: 600,
            }}
          >
            Готовая инфраструктура — без long-tail юридических рисков и
            долгого онбординга.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <FeatureCard
              title="Документы"
              text="Договор с ИП/ООО, ежемесячный УПД, счёт. Электронный документооборот через Контур.Диадок или СБИС."
            />
            <FeatureCard
              title="Безопасность"
              text="NDA, 152-ФЗ. Логи на нашей стороне. On-premise gateway по запросу с проксированием к провайдерам моделей."
            />
            <FeatureCard
              title="Выделенные ключи"
              text="Изолированные API-ключи на команду, кастомные rate-limits, биллинг по проектам, экспорт CSV/Excel."
            />
            <FeatureCard
              title="SLA 99.9%"
              text="Гарантия аптайма с компенсацией баланса при простое. Health-check каждой модели в реальном времени."
            />
            <FeatureCard
              title="Dedicated support"
              text="Выделенный канал в Slack или Telegram. Time-to-first-response ≤ 2 часа в рабочее время МСК."
            />
            <FeatureCard
              title="Каталог моделей"
              text="GPT-5, Claude Opus 4.7, Gemini 3 Pro, DeepSeek, YandexGPT, GigaChat — единый API, единый биллинг."
            />
          </div>
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section
        className="aiag-grid-bg-glow"
        style={{ borderTop: '1px solid var(--line)' }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: '0 auto',
            padding: '80px 20px',
            textAlign: 'center',
            position: 'relative',
          }}
        >
          <h2
            className="font-bold"
            style={{
              fontSize: 'clamp(28px, 3.5vw, 40px)',
              letterSpacing: '-0.02em',
              marginBottom: 16,
            }}
          >
            Подключим за один созвон
          </h2>
          <p
            style={{
              fontSize: 17,
              color: 'var(--ink-muted)',
              marginBottom: 32,
              lineHeight: 1.55,
            }}
          >
            Расскажите про объём, нужные модели и контур безопасности — пришлём
            оферту и тестовый ключ в течение дня.
          </p>
          <div className="flex gap-3 flex-wrap justify-center">
            <a
              href="mailto:team@ai-aggregator.ru?subject=Запрос%20договора%20—%20AI-Aggregator"
              className="inline-flex items-center gap-2 font-semibold rounded-sm hover:-translate-y-px transition-all"
              style={{
                padding: '14px 28px',
                fontSize: 15,
                background: 'var(--accent)',
                color: '#000',
                border: '1px solid var(--accent)',
              }}
            >
              Запросить договор →
            </a>
            <a
              href="https://t.me/aiaggregatorsupport"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 font-semibold rounded-sm hover:bg-white/[0.04] transition-colors"
              style={{
                padding: '14px 28px',
                fontSize: 15,
                background: 'transparent',
                color: 'var(--ink)',
                border: '1px solid var(--line)',
              }}
            >
              Написать в Telegram
            </a>
          </div>
        </div>
      </section>
    </MainLayout>
  );
}

function StatInline({
  value,
  suffix = '',
  decimals = 0,
  label,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
  label: string;
}) {
  return (
    <div>
      <div
        className="font-bold tabular-nums"
        style={{
          fontSize: 'clamp(32px, 4vw, 44px)',
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color: 'var(--ink)',
        }}
      >
        <CountUp end={value} decimals={decimals} suffix={suffix} />
      </div>
      <div
        className="font-mono uppercase mt-2"
        style={{
          fontSize: 11,
          color: 'var(--ink-muted)',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div
      className="aiag-glow-hover rounded-sm"
      style={{
        padding: '24px',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
      }}
    >
      <h3
        className="font-semibold mb-2"
        style={{ fontSize: 17, color: 'var(--ink)' }}
      >
        {title}
      </h3>
      <p
        style={{
          fontSize: 14,
          color: 'var(--ink-muted)',
          lineHeight: 1.55,
          margin: 0,
        }}
      >
        {text}
      </p>
    </div>
  );
}
