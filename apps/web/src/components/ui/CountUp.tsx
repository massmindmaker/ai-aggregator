'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Целевое значение */
  end: number;
  /** Длительность в ms */
  duration?: number;
  /** Префикс (например "₽" или "$") */
  prefix?: string;
  /** Суффикс (например "%" или "k") */
  suffix?: string;
  /** Десятичные знаки */
  decimals?: number;
  /** Разделитель тысяч (по умолчанию неразрывный пробел) */
  separator?: string;
  className?: string;
  /** Начинать с этого числа. По умолчанию 0. */
  start?: number;
}

/**
 * Animated count-up при mount или intersection.
 * Использует IntersectionObserver чтобы анимация запускалась
 * когда элемент виден.
 */
export function CountUp({
  end,
  duration = 1400,
  prefix = '',
  suffix = '',
  decimals = 0,
  separator = ' ',
  className = '',
  start = 0,
}: Props) {
  const [value, setValue] = useState(start);
  const ref = useRef<HTMLSpanElement>(null);
  const animatedRef = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const node = ref.current;

    const animate = () => {
      if (animatedRef.current) return;
      animatedRef.current = true;

      const startTime = performance.now();
      const tick = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // easeOutCubic
        const eased = 1 - Math.pow(1 - progress, 3);
        setValue(start + (end - start) * eased);
        if (progress < 1) requestAnimationFrame(tick);
        else setValue(end);
      };
      requestAnimationFrame(tick);
    };

    // Если в reduced-motion — сразу финал
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(end);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) animate();
        });
      },
      { threshold: 0.3 }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [end, duration, start]);

  const formatted = value
    .toFixed(decimals)
    .replace(/\B(?=(\d{3})+(?!\d))/g, separator);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
