'use client';

interface Props {
  /** Размер в пикселях (квадратный SVG icon). */
  height?: number;
  /** Цвет основной типографики. По умолчанию current text color. */
  color?: string;
  /** Включить chain-glow анимацию (свет бежит по цепочке кругов) */
  animated?: boolean;
  className?: string;
  /** Не рендерить wordmark (только иконку) */
  iconOnly?: boolean;
}

/**
 * AI Aggregator brand mark — оригинальная иконка из 4 амбер-кругов
 * (зигзаг M-shape) соединённых линиями + wordmark "ai-aggregator".
 *
 * При animated=true свет последовательно "пробегает" по цепочке
 * от нижнего-левого круга к верхнему-правому через middle-top и lower-right,
 * как сигнал по графу.
 *
 * Порядок круга в цепочке (chain index 0..3):
 *   0 — (9, 22)  большой, нижний-левый
 *   1 — (15, 9)  большой, верхний-middle
 *   2 — (22, 21) большой, нижний-правый
 *   3 — (26, 8)  маленький, верхний-правый (финальная "точка отправки")
 */
export function AiagLogo({
  height = 26,
  color,
  animated = true,
  className = '',
  iconOnly = false,
}: Props) {
  const cls = animated ? 'aiag-logo-dot' : '';

  return (
    <div className={`inline-flex items-center gap-2 ${className}`} style={{ height }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        className="shrink-0"
        style={{ width: height, height, overflow: 'visible' }}
        aria-hidden="true"
      >
        {/* Соединительные линии — приглушённый амбер, под кругами */}
        <line x1="9"    y1="22"   x2="15"   y2="9"  stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="3"   strokeLinecap="round" />
        <line x1="15"   y1="9"    x2="22"   y2="21" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="3"   strokeLinecap="round" />
        <line x1="24.5" y1="18"   x2="26"   y2="10" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="2"   strokeLinecap="round" />
        <line x1="11.5" y1="22"   x2="14.5" y2="22" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />

        {/* Halo-слой — bloom за каждым узлом (transform/opacity, БЕЗ filter;
            заменяет прежний drop-shadow, issue #23). Рисуется первым → под
            узлами. */}
        {animated && (
          <>
            <circle cx="9"  cy="22" r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '0ms' }} />
            <circle cx="15" cy="9"  r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '300ms' }} />
            <circle cx="22" cy="21" r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '600ms' }} />
            <circle cx="26" cy="8"  r="2.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '900ms' }} />
          </>
        )}

        {/* 4 круга в порядке цепочки — задержка animation-delay по индексу */}
        <circle cx="9"  cy="22" r="4.5" fill="#f59e0b"
                className={cls} style={animated ? { animationDelay: '0ms' } : undefined} />
        <circle cx="15" cy="9"  r="4.5" fill="#f59e0b"
                className={cls} style={animated ? { animationDelay: '300ms' } : undefined} />
        <circle cx="22" cy="21" r="4.5" fill="#f59e0b"
                className={cls} style={animated ? { animationDelay: '600ms' } : undefined} />
        <circle cx="26" cy="8"  r="2.5" fill="#f59e0b" opacity="0.65"
                className={cls} style={animated ? { animationDelay: '900ms' } : undefined} />
      </svg>

      {!iconOnly && (
        <span
          className="font-mono font-bold tracking-tight"
          style={{
            color: color ?? 'currentColor',
            fontSize: height * 0.6,
          }}
        >
          ai<span style={{ color: 'var(--accent)' }}>-</span>aggregator
        </span>
      )}
    </div>
  );
}
