'use client';

import Link from 'next/link';

// ─────────────────────────────────────────────────────────────────────────────
// AgentCard — the collectible-character card (DESIGN.md / PRODUCT.md signature).
// One component, used in BOTH /agents (user's agents) and /templates (catalog),
// so the catalog speaks ONE card language instead of three. Per-character OKLCH
// hue, a portrait area (monogram-in-gradient now, ready for real art later),
// name, role one-liner, the main model (mono), runs/clones + ★ rating, a budget
// or price line (mono кр), and a featured 2px-accent ring.
//
// Replaces the legacy `tma-nft-*` markup (NFT was removed) with `tma-agent-card`.
// ─────────────────────────────────────────────────────────────────────────────

// Per-character accent hues (OKLCH H). Deterministic per id → a card always wears
// the same colour across sessions and across the two surfaces.
const HUES = [28, 235, 340, 165, 60, 290, 200, 130];

export function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

// Двухбуквенная монограмма: инициалы первых двух слов, иначе первые 2 символа.
// Читается как «карта персонажа», а не «одна буква в цветном квадрате».
export function monogram(name: string | null): string {
  const t = (name ?? '').trim();
  if (!t) return '··';
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

// Детерминированный «вариант фактуры» (0..N-1) из id/имени → у каждой карты
// свой фоновый глиф/угол поверх общего per-hue градиента, чтобы плитки
// различались не только оттенком. Используется как data-атрибут (CSS-паттерн).
const PLACEHOLDER_VARIANTS = 6;
export function placeholderVariant(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % PLACEHOLDER_VARIANTS;
}

// ── Holo-tilt (R2-design) ────────────────────────────────────────────────────
// Палец/курсор водит блик и фольгу (--holo-x/y) и слегка наклоняет карту
// (--holo-rx/ry). DeviceOrientation в Telegram WebView ненадёжен — поэтому
// touch/pointer; без взаимодействия CSS сам «дышит» (aiag-holo-drift).
function holoMove(e: React.PointerEvent<HTMLAnchorElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  el.dataset.holoLive = '1';
  el.style.setProperty('--holo-x', `${(x * 100).toFixed(1)}%`);
  el.style.setProperty('--holo-y', `${(y * 100).toFixed(1)}%`);
  el.style.setProperty('--holo-rx', `${((y - 0.5) * -7).toFixed(2)}deg`);
  el.style.setProperty('--holo-ry', `${((x - 0.5) * 7).toFixed(2)}deg`);
}

function holoReset(e: React.PointerEvent<HTMLAnchorElement>) {
  const el = e.currentTarget;
  delete el.dataset.holoLive;
  el.style.removeProperty('--holo-x');
  el.style.removeProperty('--holo-y');
  el.style.removeProperty('--holo-rx');
  el.style.removeProperty('--holo-ry');
}

export interface AgentCardProps {
  href: string;
  hue: number;
  name: string | null;
  /** Портрет персонажа (webp) — рендерится вместо монограммы; фольга поверх. */
  portraitImage?: string | null;
  /** Видео-луп персонажа (mp4, без звука) — poster = portraitImage. */
  portraitVideo?: string | null;
  /** Role/persona one-liner (description). Clamped to 2 lines. */
  role?: string | null;
  /** Main model slug, rendered in mono. */
  model?: string | null;
  /** Bottom-left metric: budget «кр/мес» on agents, price «кр» on templates. */
  metricLabel: string;
  /** true → metric is the amber price (paid template); false → muted. */
  metricAccent?: boolean;
  /** ★ average rating (already formatted) + count, OR a runs/clones fallback. */
  rating?: { value: string; count: number } | null;
  /** Fallback metric shown when there is no rating (e.g. «12 запусков»). */
  countLabel?: string | null;
  /** Featured = 2px amber ring (DESIGN.md `aiag-featured-ring`). */
  featured?: boolean;
}

const mediaStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  zIndex: 0, // фольга (::before z1) и блик (::after z2) ложатся ПОВЕРХ медиа
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function AgentCard({
  href,
  hue,
  name,
  portraitImage,
  portraitVideo,
  role,
  model,
  metricLabel,
  metricAccent = false,
  rating,
  countLabel,
  featured = false,
}: AgentCardProps) {
  const playVideo = !!portraitVideo && !prefersReducedMotion();
  return (
    <Link
      href={href}
      className={`tma-agent-card${featured ? ' tma-agent-card--featured aiag-featured-ring' : ''}`}
      onPointerMove={holoMove}
      onPointerLeave={holoReset}
      onPointerCancel={holoReset}
    >
      <div
        className="tma-agent-portrait"
        style={{
          background: `linear-gradient(155deg, oklch(0.34 0.09 ${hue}), oklch(0.17 0.045 ${hue}))`,
          color: `oklch(0.93 0.11 ${hue})`,
        }}
      >
        {playVideo ? (
          <video
            src={portraitVideo as string}
            poster={portraitImage ?? undefined}
            autoPlay
            muted
            loop
            playsInline
            style={mediaStyle}
            aria-hidden
          />
        ) : portraitImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={portraitImage} alt="" style={mediaStyle} aria-hidden />
        ) : (
          <span
            className="tma-mono-placeholder"
            data-pattern={placeholderVariant(name ?? href)}
            aria-hidden
          >
            <span className="tma-mono-glyph" />
            <span className="tma-mono-sheen" />
            <span className="tma-agent-monogram">{monogram(name)}</span>
          </span>
        )}
        {featured && (
          <span className="tma-agent-featured-tag" aria-label="топ">
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 7.1-1.01L12 2z" />
            </svg>
            топ
          </span>
        )}
      </div>
      <div className="tma-agent-body">
        <h3 className="tma-agent-name">{name ?? 'Без имени'}</h3>
        {role && <p className="tma-agent-role">{role}</p>}
        {model && (
          <span className="tma-agent-model" title={model}>
            {model}
          </span>
        )}
        <div className="tma-agent-meta">
          <span
            className={metricAccent ? 'tma-agent-metric tma-agent-metric--accent' : 'tma-agent-metric'}
          >
            {metricLabel}
          </span>
          {rating ? (
            <span className="tma-rating">
              <span className="tma-rating-star">★</span>
              <span className="tma-rating-value">{rating.value}</span>
              {rating.count > 0 && (
                <span className="tma-rating-count">({rating.count})</span>
              )}
            </span>
          ) : (
            countLabel && <span className="tma-agent-count">{countLabel}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
