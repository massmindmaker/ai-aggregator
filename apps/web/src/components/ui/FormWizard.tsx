'use client';

import { ReactNode, useState, Children, isValidElement } from 'react';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';

interface WizardStepProps {
  title: string;
  /** Optional client-side validation. Return true to allow Next. */
  validate?: () => boolean | string;
  children: ReactNode;
}

/** Marker component — рендерит дети только если step активен. */
export function WizardStep({ children }: WizardStepProps) {
  return <>{children}</>;
}

interface FormWizardProps {
  /** Final submit handler when last step's Next button pressed */
  onSubmit: () => void | Promise<void>;
  /** Children should be <WizardStep ...> blocks */
  children: ReactNode;
  /** Label for final submit button */
  submitLabel?: string;
  /** Show below-progress hint text */
  hint?: string;
  className?: string;
}

export function FormWizard({
  onSubmit,
  children,
  submitLabel = 'Создать',
  hint,
  className = '',
}: FormWizardProps) {
  const steps = Children.toArray(children).filter(isValidElement) as React.ReactElement<WizardStepProps>[];
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = steps.length;
  const current = steps[active];
  const isLast = active === total - 1;

  async function handleNext() {
    setError(null);
    const validate = current.props.validate;
    if (validate) {
      const v = validate();
      if (v === false || typeof v === 'string') {
        setError(typeof v === 'string' ? v : 'Заполните все обязательные поля');
        return;
      }
    }

    if (!isLast) {
      setActive(active + 1);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Progress bar with step labels */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          {steps.map((s, i) => {
            const isDone = i < active;
            const isCurr = i === active;
            return (
              <div key={i} className="flex-1 flex items-center gap-2">
                <div
                  className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold transition-all ${
                    isDone ? 'bg-[var(--accent)] text-black' :
                    isCurr ? 'border-2 border-[var(--accent)] text-[var(--accent)]' :
                    'border border-white/10 text-white/40'
                  }`}
                >
                  {isDone ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <span className={`text-xs ${isCurr ? 'opacity-100' : 'opacity-50'} hidden sm:inline`}>
                  {s.props.title}
                </span>
                {i < total - 1 && (
                  <div className={`flex-1 h-px ${i < active ? 'bg-[var(--accent)]' : 'bg-white/10'}`} />
                )}
              </div>
            );
          })}
        </div>
        {hint && <p className="text-xs opacity-50">{hint}</p>}
      </div>

      {/* Active step */}
      <div className="min-h-[200px]">
        {current}
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="text-sm rounded-md px-3 py-2 border" style={{ borderColor: '#ef4444', color: '#ef4444' }}>
          {error}
        </div>
      )}

      {/* Nav */}
      <div className="flex justify-between items-center pt-4 border-t" style={{ borderColor: 'var(--line)' }}>
        <button
          type="button"
          onClick={() => setActive(Math.max(0, active - 1))}
          disabled={active === 0 || submitting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm hover:bg-white/[0.04] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
          Назад
        </button>
        <span className="text-xs opacity-50 tabular-nums">
          {active + 1} / {total}
        </span>
        <button
          type="button"
          onClick={handleNext}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-sm transition-all hover:-translate-y-px disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#000' }}
        >
          {submitting ? 'Сохранение…' : isLast ? submitLabel : 'Далее'}
          {!isLast && !submitting && <ChevronRight className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
