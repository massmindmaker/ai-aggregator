import { ReactNode } from 'react';
import Link from 'next/link';
import { CellsSpot } from '@/components/animations/CellsSpot';

interface Props {
  title: string;
  description?: string;
  /** Optional icon (lucide или emoji) — рендерится поверх CellsSpot */
  icon?: ReactNode;
  /** CTA: либо href (внутренний/внешний линк) либо onClick */
  actionLabel?: string;
  actionHref?: string;
  actionOnClick?: () => void;
  /** Размер CellsSpot. По умолчанию medium. */
  size?: 'sm' | 'md' | 'lg';
  /** Скрыть CellsSpot если visualClutter не нужен */
  noVisual?: boolean;
  className?: string;
}

const SIZE = {
  sm: { w: 160, h: 100, pad: 'py-8' },
  md: { w: 240, h: 160, pad: 'py-12' },
  lg: { w: 320, h: 200, pad: 'py-16' },
};

/**
 * Универсальный empty state.
 * - CellsSpot декорация (можно скрыть через noVisual)
 * - Title (h3)
 * - Description (1-2 строки)
 * - CTA (опциональная)
 */
export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  actionHref,
  actionOnClick,
  size = 'md',
  noVisual = false,
  className = '',
}: Props) {
  const s = SIZE[size];

  return (
    <div className={`flex flex-col items-center text-center ${s.pad} ${className}`}>
      {!noVisual && (
        <div className="relative mb-6">
          <CellsSpot width={s.w} height={s.h} cellSize={size === 'sm' ? 6 : 8} />
          {icon && (
            <div
              className="absolute inset-0 flex items-center justify-center text-3xl opacity-90"
              style={{ color: 'var(--accent)' }}
            >
              {icon}
            </div>
          )}
        </div>
      )}
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      {description && (
        <p className="text-sm opacity-60 max-w-md mb-6">{description}</p>
      )}
      {actionLabel && (actionHref || actionOnClick) && (
        actionHref ? (
          <Link
            href={actionHref}
            className="inline-flex items-center px-4 py-2 text-sm font-semibold rounded-sm transition-all hover:-translate-y-px"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            {actionLabel}
          </Link>
        ) : (
          <button
            type="button"
            onClick={actionOnClick}
            className="inline-flex items-center px-4 py-2 text-sm font-semibold rounded-sm transition-all hover:-translate-y-px"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            {actionLabel}
          </button>
        )
      )}
    </div>
  );
}

export default EmptyState;
