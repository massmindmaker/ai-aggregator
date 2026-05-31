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
 * At the climax our brand SIGIL crystallises out of the lightspeed flash at
 * screen centre (a centered SVG overlay, animated via CSS, timed off the same
 * burst clock the canvas uses), then settles.
 *
 * Projection: each star lives in (x,y,z) with x,y ∈ [-1,1], z ∈ (0,1].
 * Vanishing point = viewport centre. sx = cx + (x/z)*cx, sy = cy + (y/z)*cy.
 * Per frame z -= speed; respawn at z=1 when it crosses the eye. Stars are
 * recycled in place — no per-frame allocation. Streaks are drawn additively
 * (globalCompositeOperation = 'lighter'); their length tracks velocity, so the
 * same primitive reads as a dot when calm and a full light-line at warp.
 *
 * ── PERFORMANCE (the page also runs a heavy per-char living-text layer) ──
 *   • DPR capped at 1.5.
 *   • Star count = min(160, w*h/12000), ×0.5 on small/touch.
 *   • Far parallax layer ≤10 stars, dropped on small / coarse-pointer.
 *   • Zero per-frame allocation: stars/arrays reused; bloom gradient cached
 *     per (size,bloom-bucket); only string interpolation is the rgba alpha.
 *   • Draw batched by colour: ALL white streaks in one beginPath/stroke, then
 *     ALL amber — two stroke calls per layer, no per-star state churn besides
 *     lineWidth bucketing. No per-star shadow/gradient.
 *   • Scroll listener is passive and does NO layout reads — it only caches the
 *     raw scrollY; progress (which reads scrollHeight) is computed inside rAF.
 *   • Single rAF; pauses on document.hidden; idles (cancels rAF) once fully
 *     scrolled AND settled (no burst, velocity drained, progress chase done),
 *     re-arming on scroll / resize / warp.
 *   • dt-normalised (60Hz == 120Hz). Full prefers-reduced-motion static frame.
 *
 * Hooks for the page / sibling effects:
 *   • window.__manifestoWarp()                  → trigger the climax burst
 *   • CustomEvent('manifesto:warp')             → same, fired on window
 *   • CustomEvent('manifesto:warpflash')        → EMITTED at the bloom peak
 *
 * Trigger element: observes [data-warp-trigger] if present, else the last
 * .m-display, else the document bottom.
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
const DPR_CAP = 1.5; // perf: render at most 1.5× device pixels
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
const IDLE_EPS = 0.00025; // |targetP - p| below this counts as "settled"

export default function StarField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const logoRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePtr = window.matchMedia('(pointer: fine)').matches;
    const smallScreen = window.matchMedia('(max-width: 760px)').matches;

    let dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let diag = 0;
    let maxLen = 0;
    let stars: Star[] = [];

    // touch / small screens: gentler gain + fewer stars to avoid nausea + cost
    const pGain = smallScreen ? P_GAIN * 0.7 : P_GAIN;
    // ×0.5 on small or coarse-pointer (touch) devices
    const densityScale = smallScreen || !finePtr ? 0.5 : 1;
    // far parallax layer — only on capable (fine-pointer, non-small) displays
    const FAR_COUNT = finePtr && !smallScreen ? 10 : 0;
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
      dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w / 2;
      cy = h / 2;
      diag = Math.hypot(w, h);
      maxLen = diag * MAX_LEN_FRAC;
      // bloom gradient depends on geometry → invalidate cache on rebuild
      bloomCacheKey = -1;

      const count = Math.floor(Math.min(160, (w * h) / 12000) * densityScale);
      // reuse the existing array where possible (no churn on resize)
      if (stars.length !== count) {
        stars = Array.from({ length: count }, () => {
          const s: Star = { x: 0, y: 0, z: 1, pz: 1, amber: false };
          spawn(s);
          return s;
        });
      }
      if (farStars.length !== FAR_COUNT) {
        farStars = Array.from({ length: FAR_COUNT }, () => {
          const s: Star = { x: 0, y: 0, z: 1, pz: 1, amber: false };
          spawn(s, true);
          return s;
        });
      }
    };

    // ── Cached bloom gradient (rebuilt only when bloom strength bucket flips) ─
    let bloomGrad: CanvasGradient | null = null;
    let bloomCacheKey = -1;
    let bloomVpY = -1;
    const getBloomGradient = (vpY: number, bloom: number): CanvasGradient => {
      // bucket bloom into 24 steps so we don't rebuild the gradient every frame
      const bucket = Math.round(bloom * 24);
      if (bloomGrad && bloomCacheKey === bucket && bloomVpY === vpY) {
        return bloomGrad;
      }
      const b = bucket / 24;
      const g = ctx.createRadialGradient(cx, vpY, 0, cx, vpY, diag * 0.62);
      g.addColorStop(0, `rgba(255, 244, 222, ${0.85 * b})`);
      g.addColorStop(0.18, `rgba(245, 158, 11, ${0.6 * b})`);
      g.addColorStop(0.55, `rgba(245, 158, 11, ${0.14 * b})`);
      g.addColorStop(1, 'rgba(245, 158, 11, 0)');
      bloomGrad = g;
      bloomCacheKey = bucket;
      bloomVpY = vpY;
      return g;
    };

    // ── Render a single field pass (used by both the loop and static mode) ──
    // Two-pass batched draw: collect geometry once, then stroke all white
    // streaks in a single path and all amber streaks in a second path. This
    // collapses thousands of strokeStyle/lineWidth assignments into a handful.
    const renderField = (speed: number, vpY: number, bloom: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      const drawLayer = (list: Star[], speedMul: number, dim: number) => {
        const sp = speed * speedMul;
        // bucket by (white|amber) × lineWidth(1|2|3) to keep stroke calls tiny.
        // We accumulate path segments per bucket, then stroke once per bucket.
        // Six begin/stroke pairs max per layer vs. one-per-star previously.
        for (let bucket = 0; bucket < 6; bucket++) {
          const amberBucket = bucket >= 3;
          const widthBucket = bucket % 3; // 0→thin 1→mid 2→thick
          let opened = false;
          let maxAlpha = 0;

          for (const s of list) {
            // advance is done ONCE (bucket 0); later buckets reuse z/pz.
            if (bucket === 0) {
              s.pz = s.z;
              s.z -= sp;
              if (s.z <= 0.0001) {
                spawn(s, dim < 1);
              }
            }
            if (s.z <= 0.0001) continue;
            if (s.amber !== amberBucket) continue;

            const k = 1 / s.z;
            const sx = cx + s.x * cx * k;
            const sy = vpY + s.y * cy * k;
            if (
              sx < -maxLen ||
              sx > w + maxLen ||
              sy < -maxLen ||
              sy > h + maxLen
            )
              continue;

            const depth = 1 - s.z; // 0 far → ~1 near
            const lw = Math.max(0.4, depth * 1.8) * dim;
            // assign each star to one of three width buckets
            const wb = lw < 0.9 ? 0 : lw < 1.5 ? 1 : 2;
            if (wb !== widthBucket) continue;

            const pk = 1 / s.pz;
            const px = cx + s.x * cx * pk;
            const py = vpY + s.y * cy * pk;

            const rawLen = sp * STREAK_K * k * diag;
            const len = Math.min(rawLen, maxLen);
            const a = (0.1 + depth * 0.55) * dim;
            if (a > maxAlpha) maxAlpha = a;

            let tx = px;
            let ty = py;
            const dx = sx - px;
            const dy = sy - py;
            const seg = Math.hypot(dx, dy) || 1;
            if (seg > len) {
              tx = sx - (dx / seg) * len;
              ty = sy - (dy / seg) * len;
            }

            if (!opened) {
              ctx.beginPath();
              opened = true;
            }
            ctx.moveTo(tx, ty);
            ctx.lineTo(sx, sy);
          }

          if (opened) {
            // one colour + one width for the whole bucket; alpha = bucket max
            // (depth-bucketing keeps stars of similar brightness together so a
            // single alpha reads correctly without per-star state changes).
            ctx.lineWidth =
              widthBucket === 0 ? 0.6 : widthBucket === 1 ? 1.2 : 1.8;
            if (amberBucket) {
              ctx.strokeStyle = `rgba(245, 158, 11, ${Math.min(0.95, maxAlpha * 1.5)})`;
            } else {
              ctx.strokeStyle = `rgba(236, 233, 227, ${maxAlpha})`;
            }
            ctx.stroke();
          }
        }
      };

      // far parallax layer first (behind), dim + slow
      if (farStars.length) drawLayer(farStars, 0.25, 0.5);
      drawLayer(stars, 1, 1);

      // full-canvas amber→white radial bloom at the climax (cached gradient)
      if (bloom > 0.001) {
        ctx.fillStyle = getBloomGradient(vpY, bloom);
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    // ════════════════════ STATIC (reduced-motion) PATH ════════════════════
    let staticMode = mql.matches;
    const renderStatic = () => {
      // a pretty mid-warp frame: medium speed, central VP, no bloom.
      for (const s of stars) {
        s.z = 0.12 + Math.random() * 0.85;
        s.pz = Math.min(1, s.z + 0.05);
      }
      renderField(0.05, cy, 0);
    };

    // ════════════════════════ LIVE ANIMATION STATE ════════════════════════
    let raf = 0;
    let running = false;
    let last = 0;
    let p = 0; // smoothed scroll progress 0→1
    let targetP = 0;
    let vScroll = 0; // smoothed |scroll delta| / innerHeight
    let cachedScrollY = window.scrollY; // raw, set by listener (no layout read)
    let lastScrollY = window.scrollY;
    let scrollDirty = true; // recompute progress (reads scrollHeight) in rAF
    let baseSpeed = BASE; // promotes to ARRIVED_BASE after the burst

    // burst state
    let burst = 0; // current burst intensity 0→1
    let bursting = false;
    let burstT = 0; // ms elapsed in current burst phase
    let burstPhase: 'in' | 'out' | 'idle' = 'idle';
    let warpFired = false; // one-shot guard for the IO trigger
    let flashEmitted = false; // one-shot per burst for warpflash
    let logoStarted = false; // one-shot per burst for the logo overlay

    const easeInExpo = (x: number) => (x <= 0 ? 0 : Math.pow(2, 10 * (x - 1)));
    const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));

    // ── Logo overlay: crystallise the brand sigil out of the flash ──
    const playLogo = () => {
      const el = logoRef.current;
      if (!el) return;
      if (staticMode) {
        // reduced motion: just show it, no keyframes
        el.classList.add('is-static');
        return;
      }
      // restart the CSS keyframe animation reliably
      el.classList.remove('is-igniting');
      // force reflow so re-adding the class replays the animation
      void el.offsetWidth;
      el.classList.add('is-igniting');
    };

    const triggerWarp = () => {
      bursting = true;
      burstPhase = 'in';
      burstT = 0;
      flashEmitted = false;
      logoStarted = false;
      ensureRunning();
    };

    const onScroll = () => {
      // PERF: no layout reads here — just cache the raw scrollY and flag.
      cachedScrollY = window.scrollY;
      scrollDirty = true;
      ensureRunning();
    };

    const loop = (t: number) => {
      if (document.hidden) {
        // keep the loop alive but cheap; resync the clock on wake
        last = t;
        raf = requestAnimationFrame(loop);
        return;
      }
      const dt = last ? Math.min(4, (t - last) / 16.67) : 1; // 60Hz == 120Hz
      last = t;

      // recompute progress + velocity from the cached scrollY (layout read
      // happens here, in rAF, at most once per dirty frame — not per event)
      if (scrollDirty) {
        const max =
          document.documentElement.scrollHeight - window.innerHeight;
        targetP =
          max > 0 ? Math.min(1, Math.max(0, cachedScrollY / max)) : 0;
        const dv =
          Math.abs(cachedScrollY - lastScrollY) /
          Math.max(1, window.innerHeight);
        vScroll += dv;
        lastScrollY = cachedScrollY;
        scrollDirty = false;
      }

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

      // bloom alpha is a sine hump that peaks mid-burst
      const bloom = Math.sin(Math.min(1, burst) * Math.PI) * (burst > 0 ? 1 : 0);

      // at the bloom peak: emit the flash event AND ignite the logo (once)
      if (burstPhase === 'out' && burst > 0.55) {
        if (!flashEmitted) {
          flashEmitted = true;
          window.dispatchEvent(new CustomEvent('manifesto:warpflash'));
        }
        if (!logoStarted) {
          logoStarted = true;
          playLogo();
        }
      }

      // ── the core speed equation ──
      const drive = baseSpeed + p * pGain + vScroll * V_GAIN;
      const speed = (drive + burst * (baseSpeed + p * pGain) * BURST_PEAK) * dt;

      // descend the vanishing point as we scroll (tunnel target sinks)
      const vpY = cy + p * 40;

      renderField(Math.max(0.0002, speed), vpY, bloom);

      // ── IDLE BAIL: fully scrolled + settled + no burst → stop the rAF ──
      const settled =
        !bursting &&
        burst === 0 &&
        vScroll < 0.0005 &&
        Math.abs(targetP - p) < IDLE_EPS &&
        !scrollDirty;
      if (settled) {
        // one final draw already happened this frame; park the loop.
        running = false;
        return; // do NOT request another frame
      }
      raf = requestAnimationFrame(loop);
    };

    const ensureRunning = () => {
      if (staticMode || running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    };

    const stopLoop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    // ════════════════════════════ WIRE-UP ════════════════════════════
    build();
    lastScrollY = window.scrollY;
    cachedScrollY = window.scrollY;

    if (staticMode) {
      renderStatic();
      // show the logo statically at the climax position (no animation)
      playLogo();
    } else {
      ensureRunning();
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
      scrollDirty = true;
      if (staticMode) renderStatic();
      else ensureRunning();
    };
    window.addEventListener('resize', onResize);

    const onVisibility = () => {
      if (!document.hidden && !staticMode) {
        last = 0; // avoid a giant dt jump after the tab wakes
        ensureRunning();
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
        playLogo();
      } else {
        if (!io) armObserver();
        ensureRunning();
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
    <>
      <canvas
        ref={canvasRef}
        className="manifesto-stars"
        aria-hidden="true"
        style={{ width: '100%', height: '100%' }}
      />
      {/* Brand sigil that crystallises out of the lightspeed flash. Absolutely
       * positioned overlay above the canvas; animated entirely from warp.css,
       * ignited by the burst clock (.is-igniting) or shown static for reduced
       * motion (.is-static). Geometry mirrors Sigil.tsx / AiagLogo.tsx. */}
      <div ref={logoRef} className="m-warp-logo" aria-hidden="true">
        <svg
          className="m-warp-logo-svg"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 32 32"
          fill="none"
          width="160"
          height="160"
        >
          {/* connecting lines — drawn via stroke-dashoffset */}
          <line className="m-wl-line m-wl-l1" x1="9" y1="22" x2="15" y2="9" />
          <line className="m-wl-line m-wl-l2" x1="15" y1="9" x2="22" y2="21" />
          <line className="m-wl-line m-wl-l3" x1="24.5" y1="18" x2="26" y2="10" />
          <line className="m-wl-line m-wl-l4" x1="11.5" y1="22" x2="14.5" y2="22" />
          {/* nodes — staggered scale-in */}
          <circle className="m-wl-node m-wl-n1" cx="9" cy="22" r="4.2" />
          <circle className="m-wl-node m-wl-n2" cx="15" cy="9" r="4.2" />
          <circle className="m-wl-node m-wl-n3" cx="22" cy="21" r="4.2" />
          <circle className="m-wl-node m-wl-n4" cx="26" cy="8" r="2.4" />
        </svg>
      </div>
    </>
  );
}
