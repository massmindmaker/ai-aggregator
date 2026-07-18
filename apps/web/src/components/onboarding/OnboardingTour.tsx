'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Sparkles, Boxes, Play, Key, Trophy } from 'lucide-react';
import { CellsSpot } from '@/components/animations/CellsSpot';
import Link from 'next/link';

const STORAGE_KEY = 'aiag_onboarding_seen_v1';

interface Step {
  icon: React.ReactNode;
  title: string;
  description: string;
  visual: React.ReactNode;
  cta?: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    icon: <Sparkles className="w-5 h-5" />,
    // No hardcoded model count: the old "400+" claimed ~6x the real catalog.
    title: 'Один API. Весь каталог моделей.',
    description: 'AIAG — это шлюз ко всем популярным LLM и AI-моделям. Платишь в рублях, без VPN, drop-in замена OpenAI SDK.',
    visual: <CellsSpot width={320} height={180} />,
  },
  {
    icon: <Boxes className="w-5 h-5" />,
    title: 'Маркетплейс моделей',
    description: 'GPT-4, Claude, DeepSeek, Qwen, Yandex GPT, Gigachat и десятки других — все с понятными ценами в рублях и метриками использования.',
    visual: <CellsSpot width={320} height={180} cellSize={6} />,
    cta: { label: 'Смотреть модели', href: '/marketplace' },
  },
  {
    icon: <Play className="w-5 h-5" />,
    title: 'Песочница без регистрации',
    description: 'Попробуй любую модель прямо в браузере. 5 бесплатных запросов в день для гостей — не нужна карта.',
    visual: (
      <div
        className="rounded-lg border p-4 font-mono text-xs leading-relaxed aiag-grid-bg-sm"
        style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)' }}
      >
        <div style={{ color: 'var(--ink-muted)' }}>{'> Расскажи про AIAG'}</div>
        <div style={{ color: 'var(--accent)' }}>AIAG — единый шлюз...</div>
        <div
          className="inline-block w-1.5 h-3 align-middle ml-0.5 animate-pulse"
          style={{ background: 'var(--accent)' }}
        />
      </div>
    ),
    cta: { label: 'Открыть песочницу', href: '/playground' },
  },
  {
    icon: <Key className="w-5 h-5" />,
    title: 'Drop-in API за 2 минуты',
    description: 'Уже используешь OpenAI SDK? Меняешь base_url — и получаешь доступ ко всем моделям. Совместимый формат.',
    visual: (
      <pre
        className="rounded-lg border p-4 text-xs leading-relaxed font-mono aiag-grid-bg-sm overflow-x-auto"
        style={{ borderColor: 'var(--line)', background: 'var(--bg-elev)', color: 'var(--ink)' }}
      >
{`from openai import OpenAI

client = OpenAI(
  api_key="YOUR_KEY",
  base_url="https://ai-aggregator.ru/v1"
)`}
      </pre>
    ),
    cta: { label: 'Создать API-ключ', href: '/register' },
  },
  {
    icon: <Trophy className="w-5 h-5" />,
    title: 'Конкурсы и призовой фонд',
    description: 'Решай ML-задачи, попадай в лидерборд и забирай призы. Загружай решение — наш sandbox-evaluator считает score автоматически.',
    visual: <CellsSpot width={320} height={180} cellSize={10} />,
    cta: { label: 'К конкурсам', href: '/contests' },
  },
];

export function OnboardingTour() {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      if (typeof window === 'undefined') return;
      if (localStorage.getItem(STORAGE_KEY)) return;
      t = setTimeout(() => {
        // Mark as shown the moment the tour actually opens, not only when the
        // user closes it — otherwise navigating away before closing (e.g. a
        // full page reload) re-triggers the tour on every subsequent visit.
        try {
          localStorage.setItem(STORAGE_KEY, '1');
        } catch {
          /* ignore */
        }
        setOpen(true);
      }, 1200);
    } catch {
      /* localStorage unavailable */
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, []);

  function close() {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  function next() {
    if (active < STEPS.length - 1) setActive(active + 1);
    else close();
  }

  function prev() {
    if (active > 0) setActive(active - 1);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!open) return null;
  const step = STEPS[active];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 aiag-drawer-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="absolute inset-0 bg-black/80" onClick={close} />

      <div
        className="relative w-full max-w-lg rounded-2xl border overflow-hidden shadow-2xl aiag-grid-bg-sm"
        style={{ background: 'var(--bg-elev)', borderColor: 'var(--line)' }}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={close}
          aria-label="Пропустить онбординг"
          className="absolute top-3 right-3 z-10 p-2 rounded-md text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-white/[0.04] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header — icon + progress dots */}
        <div className="px-6 pt-6 pb-3 flex items-center gap-3">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg"
            style={{
              background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
              color: 'var(--accent)',
            }}
          >
            {step.icon}
          </div>
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className="h-1 rounded-full transition-all"
                style={{
                  width: i === active ? 24 : 8,
                  background: i <= active ? 'var(--accent)' : 'rgba(255,255,255,0.15)',
                }}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pb-6">
          <h2 id="onboarding-title" className="text-xl font-semibold mb-2" key={`title-${active}`}>
            {step.title}
          </h2>
          <p className="text-sm opacity-70 mb-5" key={`desc-${active}`}>
            {step.description}
          </p>
          <div className="mb-5 flex items-center justify-center" key={`visual-${active}`}>
            {step.visual}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={prev}
              disabled={active === 0}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-sm hover:bg-white/[0.04] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
              Назад
            </button>

            <span className="text-xs opacity-50 tabular-nums">
              {active + 1} / {STEPS.length}
            </span>

            <div className="flex items-center gap-2">
              {step.cta && (
                <Link
                  href={step.cta.href}
                  onClick={close}
                  className="inline-flex items-center px-3 py-1.5 text-sm rounded-sm hover:bg-white/[0.04] transition-colors"
                  style={{ color: 'var(--accent)' }}
                >
                  {step.cta.label}
                </Link>
              )}
              <button
                type="button"
                onClick={next}
                className="inline-flex items-center gap-1 px-4 py-2 text-sm font-semibold rounded-sm transition-all hover:-translate-y-px"
                style={{ background: 'var(--accent)', color: '#000' }}
              >
                {active === STEPS.length - 1 ? 'Готово' : 'Далее'}
                {active < STEPS.length - 1 && <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
