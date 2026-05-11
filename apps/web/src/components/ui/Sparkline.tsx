'use client';

import { useMemo } from 'react';

interface Props {
  /** Массив значений (Y). X — порядковый индекс */
  data: number[];
  width?: number;
  height?: number;
  /** Цвет линии */
  color?: string;
  /** Заливка под линией (gradient fade) */
  fill?: boolean;
  /** Жирность stroke */
  strokeWidth?: number;
  /** Показывать точки */
  dots?: boolean;
  /** Анимация рисования при mount (stroke-dashoffset) */
  animate?: boolean;
  className?: string;
}

/**
 * Lightweight SVG sparkline.
 * Path рендерится через polyline или path commands.
 * Animation: stroke-dasharray + stroke-dashoffset = total length → 0.
 */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  color = 'var(--accent, #f59e0b)',
  fill = false,
  strokeWidth = 1.5,
  dots = false,
  animate = true,
  className = '',
}: Props) {
  const { d, fillD, pts, length } = useMemo(() => {
    if (data.length < 2)
      return { d: '', fillD: '', pts: [] as { x: number; y: number }[], length: 0 };

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 2;

    const points = data.map((v, i) => {
      const x = (i / (data.length - 1)) * (width - pad * 2) + pad;
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return { x, y };
    });

    const pathD = points
      .map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`))
      .join(' ');
    const last = points[points.length - 1];
    const first = points[0];
    const fillPathD = `${pathD} L${last.x},${height} L${first.x},${height} Z`;

    // Approximate path length для stroke-dashoffset
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      len += Math.sqrt(dx * dx + dy * dy);
    }

    return { d: pathD, fillD: fillPathD, pts: points, length: len };
  }, [data, width, height]);

  if (!d) return null;

  // Deterministic-ish gradient id (stable enough between SSR/CSR if data identical via useMemo,
  // but we use Math.random fallback — gradient id only needs to be unique within document).
  const gradientId = `aiag-spark-grad-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`aiag-sparkline ${className}`}
      aria-hidden="true"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.25" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={fillD} fill={`url(#${gradientId})`} />
        </>
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={
          animate
            ? {
                strokeDasharray: length,
                strokeDashoffset: length,
                animation: `aiag-sparkline-draw 1.4s cubic-bezier(.23,1,.32,1) forwards`,
              }
            : undefined
        }
      />
      {dots &&
        pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.5} fill={color} />
        ))}
    </svg>
  );
}
