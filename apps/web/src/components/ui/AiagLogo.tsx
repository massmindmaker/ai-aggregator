'use client';

interface Props {
  /** Размер высоты в пикселях. Width auto-scales. */
  height?: number;
  /** Цвет основной типографики. По умолчанию current text color. */
  color?: string;
  /** Включить chain-glow анимацию */
  animated?: boolean;
  className?: string;
}

/**
 * AI Aggregator logo — wordmark "ai-aggregator" + chain of dots
 * underneath that travels with an amber glow when `animated`.
 *
 * Dots representation: 5 кругляшков прогрессивно увеличиваются слева направо.
 * При animated=true свет последовательно зажигает каждую точку с задержкой,
 * создавая ощущение направленного потока.
 */
export function AiagLogo({ height = 24, color, animated = true, className = '' }: Props) {
  return (
    <div className={`inline-flex items-center gap-2 ${className}`} style={{ height }}>
      {/* Chain of dots (left → right, smallest → largest) */}
      <svg
        viewBox="0 0 60 24"
        height={height}
        width={height * 2.5}
        aria-hidden="true"
        style={{ overflow: 'visible' }}
      >
        {[
          { cx: 6,  r: 2.2 },
          { cx: 16, r: 2.8 },
          { cx: 27, r: 3.4 },
          { cx: 40, r: 4.0 },
          { cx: 54, r: 4.6 },
        ].map((d, i) => (
          <circle
            key={i}
            cx={d.cx}
            cy={12}
            r={d.r}
            fill="currentColor"
            opacity={0.35}
            className={animated ? 'aiag-logo-dot' : ''}
            style={animated ? { animationDelay: `${i * 180}ms` } : undefined}
          />
        ))}
      </svg>

      {/* Wordmark */}
      <span
        className="font-semibold tracking-tight tabular-nums"
        style={{
          color: color ?? 'currentColor',
          fontSize: height * 0.7,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
        }}
      >
        ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
      </span>
    </div>
  );
}
