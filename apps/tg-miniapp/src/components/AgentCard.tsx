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

function monogram(name: string | null): string {
  const t = (name ?? '?').trim();
  return (t[0] ?? '?').toUpperCase();
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

export function AgentCard({
  href,
  hue,
  name,
  role,
  model,
  metricLabel,
  metricAccent = false,
  rating,
  countLabel,
  featured = false,
}: AgentCardProps) {
  return (
    <Link
      href={href}
      className={`tma-agent-card${featured ? ' tma-agent-card--featured' : ''}`}
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
        <span className="tma-agent-monogram">{monogram(name)}</span>
        {featured && <span className="tma-agent-featured-tag">★ топ</span>}
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
