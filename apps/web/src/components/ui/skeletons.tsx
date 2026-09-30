import type { CSSProperties } from 'react';

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  style?: CSSProperties;
}

/** Базовый shimmer-блок. Используется внутри других skeleton'ов. */
export function Skeleton({ className = '', width, height, style }: SkeletonProps) {
  return (
    <div
      className={`aiag-skeleton ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

interface SkeletonTableProps {
  rows?: number;
  cols?: number;
  showHeader?: boolean;
  className?: string;
}

/** Skeleton для таблиц — header + N строк × M колонок */
export function SkeletonTable({ rows = 5, cols = 4, showHeader = true, className = '' }: SkeletonTableProps) {
  return (
    <div className={`w-full ${className}`} aria-busy="true" aria-label="Загрузка таблицы">
      {showHeader && (
        <div
          className="grid gap-3 pb-3 border-b mb-3"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, borderColor: 'var(--line)' }}
        >
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} height={12} className="opacity-50" />
          ))}
        </div>
      )}
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton
                key={c}
                height={14}
                width={c === 0 ? '70%' : c === cols - 1 ? '40%' : '85%'}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface SkeletonGridProps {
  count?: number;
  cols?: number;
  cardHeight?: number;
  className?: string;
}

/** Skeleton для карточных грид-листингов (marketplace, каталог моделей) */
export function SkeletonGrid({ count = 8, cols = 4, cardHeight = 180, className = '' }: SkeletonGridProps) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${100 / cols}%, 1fr))` }}
      aria-busy="true"
      aria-label="Загрузка карточек"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border p-4 flex flex-col gap-3"
          style={{ borderColor: 'var(--line)', height: cardHeight }}
        >
          <div className="flex items-center gap-3">
            <Skeleton width={32} height={32} className="rounded-full shrink-0" />
            <Skeleton height={12} className="flex-1" />
          </div>
          <Skeleton height={20} width="75%" />
          <Skeleton height={10} width="100%" />
          <Skeleton height={10} width="60%" />
          <div className="mt-auto flex justify-between items-center">
            <Skeleton height={14} width={70} />
            <Skeleton height={14} width={50} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface SkeletonFormProps {
  fields?: number;
  className?: string;
}

/** Skeleton для форм (label + input × N + submit button) */
export function SkeletonForm({ fields = 5, className = '' }: SkeletonFormProps) {
  return (
    <div className={`space-y-4 ${className}`} aria-busy="true" aria-label="Загрузка формы">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton height={10} width="25%" />
          <Skeleton height={36} className="rounded-md" />
        </div>
      ))}
      <Skeleton height={40} width={140} className="rounded-md mt-6" />
    </div>
  );
}

interface SkeletonChartProps {
  className?: string;
  /** 'bar' (вертикальные столбцы) или 'line' (линейный плейсхолдер) */
  variant?: 'bar' | 'line';
  height?: number;
}

/** Skeleton для chart-зон (analytics, revenue, usage) */
export function SkeletonChart({ className = '', variant = 'bar', height = 200 }: SkeletonChartProps) {
  if (variant === 'line') {
    return (
      <div className={className} style={{ height }} aria-busy="true">
        <Skeleton className="w-full h-full rounded-md" />
      </div>
    );
  }
  return (
    <div
      className={`flex items-end gap-2 ${className}`}
      style={{ height }}
      aria-busy="true"
      aria-label="Загрузка графика"
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${30 + ((i * 37) % 60)}%` }} />
      ))}
    </div>
  );
}

/** Skeleton для KPI tile (label + большое число) */
export function SkeletonStatTile({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border p-4 space-y-3 ${className}`}
      style={{ borderColor: 'var(--line)' }}
    >
      <Skeleton height={10} width="40%" />
      <Skeleton height={28} width="60%" />
      <Skeleton height={8} width="80%" className="opacity-50" />
    </div>
  );
}
