'use client';

/**
 * StarField — a scroll-coupled 3D WARP STAR TUNNEL behind the manifesto.
 *
 * The thesis: scrolling IS acceleration. At the top of the page the field is
 * near-still (calm dots around a vanishing point). As you scroll it spools up;
 * a flick adds a transient surge; and at the epilogue it bursts to lightspeed
 * — streaks elongate full-screen, an amber→white bloom blows the frame out,
 * then it settles into a slightly warmer "arrived" baseline.
 *
 * Projection: each star lives in (x,y,z) with x,y ∈ [-1,1], z ∈ (0,1].
 * Vanishing point = viewport centre. sx = cx + (x/z)*cx, sy = cy + (y/z)*cy.
 * Per frame z -= speed; respawn at z=1 when it crosses the eye. Stars are
 * recycled in place — no per-frame allocation. Streaks are drawn additively
 * (globalCompositeOperation = 'lighter'); their length tracks velocity, so the
 * same primitive reads as a dot when calm and a full light-line at warp.
 *
 * Hooks for the page / sibling effects:
 *   • window.__manifestoWarp()                  → trigger the climax burst
 *   • CustomEvent('manifesto:warp')             → same, fired on window
 *   • CustomEvent('manifesto:warpflash')        → EMITTED at the bloom peak so
 *                                                 a sibling can draw the cipher
 *
 * Trigger element: observes [data-warp-trigger] if present, else the last
 * .m-display, else the document bottom. (Page should add data-warp-trigger
 * to the final epilogue line for precise timing.)
 *
 * Native rAF (no fps cap), frame-rate independent via dt. One passive scroll
 * listener + one loop. Pauses on document.hidden. prefers-reduced-motion →
 * a single static mid-warp frame, no loop / scroll / burst, live-reactive.
 */

import { useEffect, useRef } from 'react';
import './warp.css';

interface Star {
  x: number; // [-1, 1]
  y: number; // [-1, 1]
  z: number; // (0, 1]
  pz: number; // previous z (for streak tail)
  amber: boolean;
}

// ── Tunable constants ──────────────────────────────────────────────────────
const BASE = 0.0006; // idle creep
const P_GAIN = 0.012; // scroll-progress contribution
const V_GAIN = 0.02; // scroll-velocity (flick) contribution
const STREAK_K = 0.9; // velocity → streak-length factor
const MAX_LEN_FRAC = 0.55; // streak cap as fraction of viewport diagonal
const AMBER_RATE = 0.06; // share of ember stars
const ARRIVED_BASE = 0.0016; // warmer settled baseline after the burst
const BURST_PEAK = 7; // speed multiplier headroom at climax (~6–8×)
const BURST_IN_MS = 270; // ramp 0→1 (easeInExpo)
const BURST_OUT_MS = 930; // decay 1→0 (easeOutExpo)

export default function StarField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePtr = window.matchMedia('(pointer: fine)').matches;
    const smallScreen = window.matchMedia('(max-width: 760px)').matches;

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let diag = 0;
    let maxLen = 0;
    let stars: Star[] = [];

    // touch / small screens: gentler gain + fewer stars to avoid nausea
    const pGain = smallScreen ? P_GAIN * 0.7 : P_GAIN;
    const densityScale = smallScreen ? 0.6 : 1;
    // far parallax layer — only on capable (fine-pointer) displays
    const FAR_COUNT = finePtr && !smallScreen ? 15 : 0;
    let farStars: Star[] = [];

    const spawn = (s: Star, atFar = false) => {
      s.x = Math.random() * 2 - 1;
      s.y = Math.random() * 2 - 1;
      s.z = atFar ? 0.85 + Math.random() * 0.15 : Math.random();
      s.pz = s.z;
      s.amber = Math.random() < AMBER_RATE;
    };

    const build = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w / 2;
      cy = h / 2;
      diag = Math.hypot(w, h);
      maxLen = diag * MAX_LEN_FRAC;

      const count = Math.floor(
        Math.min(220, (w * h) / 9000) * densityScale,
      );
      stars = Array.from({ length: count }, () => {
        const s: Star = { x: 0, y: 0, z: 1, pz: 1, amber: false };
        spawn(s);
        return s;
      });
      farStars = Array.from({ length: FAR_COUNT }, () => {
        const s: Star = { x: 0, y: 0, z: 1, pz: 1, amber: false };
        spawn(s, true);
        return s;
      });
    };

    // ── Render a single field pass (used by both the loop and static mode) ──
    const renderField = (speed: number, vpY: number, bloom: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      const drawLayer = (list: Star[], speedMul: number, dim: number) => {
        const sp = speed * speedMul;
        for (const s of list) {
          s.pz = s.z;
          s.z -= sp;
          if (s.z <= 0.0001) {
            spawn(s, dim < 1);
            continue;
          }
          // project current + previous (tail) positions
          const k = 1 / s.z;
          const pk = 1 / s.pz;
          const sx = cx + s.x * cx * k;
          const sy = vpY + s.y * cy * k;
          // off-frame guard (cheap)
          if (sx < -maxLen || sx > w + maxLen || sy < -maxLen || sy > h + maxLen)
            continue;
          const px = cx + s.x * cx * pk;
          const py = vpY + s.y * cy * pk;

          // streak length tracks velocity & nearness; clamps to a calm dot
          const rawLen = sp * STREAK_K * k * diag;
          const len = Math.min(rawLen, maxLen);
          const depth = 1 - s.z; // 0 far → ~1 near
          const a = (0.1 + depth * 0.55) * dim;

          // extend the tail along the radial direction so even at rest there's
          // a faint nub, and at warp it stretches to the projected previous pos
          let tx = px;
          let ty = py;
          const dx = sx - px;
          const dy = sy - py;
          const seg = Math.hypot(dx, dy) || 1;
          if (seg > len) {
            tx = sx - (dx / seg) * len;
            ty = sy - (dy / seg) * len;
          }

          if (s.amber) {
            ctx.strokeStyle = `rgba(245, 158, 11, ${Math.min(0.95, a * 1.5)})`;
          } else {
            ctx.strokeStyle = `rgba(236, 233, 227, ${a})`;
          }
          ctx.lineWidth = Math.max(0.4, depth * 1.8) * dim;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
      };

      // far parallax layer first (behind), dim + slow
      if (farStars.length) drawLayer(farStars, 0.25, 0.5);
      drawLayer(stars, 1, 1);

      // full-canvas amber→white radial bloom at the climax
      if (bloom > 0.001) {
        const g = ctx.createRadialGradient(cx, vpY, 0, cx, vpY, diag * 0.62);
        // amber core melting to white, fading to nothing at the rim
        g.addColorStop(0, `rgba(255, 244, 222, ${0.85 * bloom})`);
        g.addColorStop(0.18, `rgba(245, 158, 11, ${0.6 * bloom})`);
        g.addColorStop(0.55, `rgba(245, 158, 11, ${0.14 * bloom})`);
        g.addColorStop(1, 'rgba(245, 158, 11, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    // ════════════════════ STATIC (reduced-motion) PATH ════════════════════
    let staticMode = mql.matches;
    const renderStatic = () => {
      // a pretty mid-warp frame: medium speed, central VP, no bloom.
      // advance each star once to a pleasing spread, then draw stationary.
      for (const s of stars) {
        s.z = 0.12 + Math.random() * 0.85;
        s.pz = Math.min(1, s.z + 0.05);
      }
      renderField(0.05, cy, 0);
    };

    // ════════════════════════ LIVE ANIMATION STATE ════════════════════════
    let raf = 0;
    let last = 0;
    let p = 0; // smoothed scroll progress 0→1
    let targetP = 0;
    let vScroll = 0; // smoothed |scroll delta| / innerHeight
    let lastScrollY = window.scrollY;
    let baseSpeed = BASE; // promotes to ARRIVED_BASE after the burst

    // burst state
    let burst = 0; // current burst intensity 0→1
    let bursting = false;
    let burstT = 0; // ms elapsed in current burst phase
    let burstPhase: 'in' | 'out' | 'idle' = 'idle';
    let warpFired = false; // one-shot guard for the IO trigger
    let flashEmitted = false; // one-shot per burst for warpflash

    const easeInExpo = (x: number) => (x <= 0 ? 0 : Math.pow(2, 10 * (x - 1)));
    const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));

    const triggerWarp = () => {
      // re-armable for external callers, but the IO observer fires once.
      bursting = true;
      burstPhase = 'in';
      burstT = 0;
      flashEmitted = false;
    };

    const computeProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      targetP = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    };

    const onScroll = () => {
      const y = window.scrollY;
      const dv = Math.abs(y - lastScrollY) / Math.max(1, window.innerHeight);
      vScroll += dv; // accumulate; decays in the loop
      lastScrollY = y;
      computeProgress();
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) {
        last = t;
        return;
      }
      const dt = last ? Math.min(4, (t - last) / 16.67) : 1; // 60Hz == 120Hz
      last = t;

      // smooth chase toward scroll progress
      p += (targetP - p) * 0.06 * dt;
      // velocity surge decays
      vScroll *= Math.pow(0.9, dt);

      // burst envelope
      if (bursting) {
        burstT += dt * 16.67;
        if (burstPhase === 'in') {
          const x = Math.min(1, burstT / BURST_IN_MS);
          burst = easeInExpo(x);
          if (x >= 1) {
            burstPhase = 'out';
            burstT = 0;
            baseSpeed = ARRIVED_BASE; // settle warmer once we've punched through
          }
        } else if (burstPhase === 'out') {
          const x = Math.min(1, burstT / BURST_OUT_MS);
          burst = 1 - easeOutExpo(x);
          if (x >= 1) {
            burst = 0;
            bursting = false;
            burstPhase = 'idle';
          }
        }
      }

      // bloom alpha is a sine hump that peaks mid-burst (~0.85 handled in render)
      const bloom = Math.sin(Math.min(1, burst) * Math.PI) * (burst > 0 ? 1 : 0);

      // emit the cipher flash event right at the bloom peak (once per burst)
      if (!flashEmitted && burstPhase === 'out' && burst > 0.55) {
        flashEmitted = true;
        window.dispatchEvent(new CustomEvent('manifesto:warpflash'));
      }

      // ── the core speed equation ──
      // base drive = BASE/arrived + scroll-progress + flick-velocity; the burst
      // adds a multiplied spike on top (~BURST_PEAK× the progress drive).
      const drive = baseSpeed + p * pGain + vScroll * V_GAIN;
      const speed = (drive + burst * (baseSpeed + p * pGain) * BURST_PEAK) * dt;

      // descend the vanishing point as we scroll (tunnel target sinks)
      const vpY = cy + p * 40;

      renderField(Math.max(0.0002, speed), vpY, bloom);
    };

    // ════════════════════════════ WIRE-UP ════════════════════════════
    build();
    computeProgress();
    lastScrollY = window.scrollY;

    const startLoop = () => {
      cancelAnimationFrame(raf);
      last = 0;
      raf = requestAnimationFrame(loop);
    };

    const stopLoop = () => cancelAnimationFrame(raf);

    if (staticMode) {
      renderStatic();
    } else {
      startLoop();
    }

    // ── External warp hooks ──
    const warpHook = () => {
      if (staticMode) return;
      triggerWarp();
    };
    (window as unknown as { __manifestoWarp?: () => void }).__manifestoWarp =
      warpHook;
    window.addEventListener('manifesto:warp', warpHook as EventListener);

    // ── IntersectionObserver: fire the climax once when the epilogue lands ──
    let io: IntersectionObserver | null = null;
    const armObserver = () => {
      const target =
        document.querySelector('[data-warp-trigger]') ??
        (() => {
          const all = document.querySelectorAll('.m-display');
          return all.length ? all[all.length - 1] : document.body;
        })();
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !warpFired) {
              warpFired = true;
              warpHook();
            }
          }
        },
        { threshold: 0.6 },
      );
      io.observe(target as Element);
    };
    if (!staticMode) armObserver();

    // ── Scroll / resize / visibility / motion-pref listeners ──
    window.addEventListener('scroll', onScroll, { passive: true });

    const onResize = () => {
      build();
      computeProgress();
      if (staticMode) renderStatic();
    };
    window.addEventListener('resize', onResize);

    const onVisibility = () => {
      if (!document.hidden && !staticMode) {
        last = 0; // avoid a giant dt jump after the tab wakes
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // honour live reduced-motion changes
    const onMotionChange = () => {
      staticMode = mql.matches;
      if (staticMode) {
        stopLoop();
        io?.disconnect();
        io = null;
        renderStatic();
      } else {
        if (!io) armObserver();
        startLoop();
      }
    };
    if (mql.addEventListener) mql.addEventListener('change', onMotionChange);
    else mql.addListener(onMotionChange); // Safari < 14

    return () => {
      stopLoop();
      io?.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('manifesto:warp', warpHook as EventListener);
      if (mql.removeEventListener)
        mql.removeEventListener('change', onMotionChange);
      else mql.removeListener(onMotionChange);
      const win = window as unknown as { __manifestoWarp?: () => void };
      if (win.__manifestoWarp === warpHook) delete win.__manifestoWarp;
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
