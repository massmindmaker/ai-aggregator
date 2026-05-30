'use client';

/**
 * StarField — a slow, cold, almost-still drift of faint stars behind the
 * manifesto. Deliberately restrained: most points barely move, a few amber
 * embers glimmer. Pauses when the tab is hidden, honours reduced-motion,
 * throttles to ~30fps, and rebuilds on resize. Pure canvas, no deps.
 */

import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  z: number; // depth 0..1 — parallax + size + brightness
  amber: boolean;
  tw: number; // twinkle phase
}

export default function StarField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let stars: Star[] = [];

    const build = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // density scales with area but capped so big screens stay performant
      const count = Math.min(220, Math.floor((w * h) / 9000));
      stars = Array.from({ length: count }, () => {
        const z = Math.random();
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          z,
          amber: Math.random() < 0.06, // a rare few embers
          tw: Math.random() * Math.PI * 2,
        };
      });
    };

    const draw = (drift: number, twinkle: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        // parallax: nearer stars (higher z) drift a touch faster, downward-left
        const px = (s.x - drift * (0.15 + s.z * 0.5)) % w;
        const x = px < 0 ? px + w : px;
        const y = s.y;
        const r = 0.35 + s.z * 1.15;
        const base = 0.12 + s.z * 0.4;
        const flick = reduceMotion
          ? 1
          : 0.7 + 0.3 * Math.sin(twinkle * (0.4 + s.z) + s.tw);
        const a = base * flick;

        if (s.amber) {
          ctx.fillStyle = `rgba(245, 158, 11, ${Math.min(0.9, a * 1.6)})`;
          ctx.shadowColor = 'rgba(245, 158, 11, 0.6)';
          ctx.shadowBlur = 6 * s.z;
        } else {
          ctx.fillStyle = `rgba(236, 233, 227, ${a})`;
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    };

    build();

    // Static render path for reduced-motion: one frame, no loop.
    if (reduceMotion) {
      draw(0, 0);
      const onResizeStatic = () => {
        build();
        draw(0, 0);
      };
      window.addEventListener('resize', onResizeStatic);
      return () => window.removeEventListener('resize', onResizeStatic);
    }

    let raf = 0;
    let last = 0;
    let drift = 0;
    let twinkle = 0;
    const frameMs = 1000 / 30;

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (t - last < frameMs) return;
      last = t;
      drift += 0.12; // very slow
      twinkle += 0.05;
      draw(drift, twinkle);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => build();
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="manifesto-stars"
      aria-hidden="true"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
