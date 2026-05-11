/**
 * Deterministic placeholder stats for the marketplace UI.
 *
 * FIXME: replace with real stats from `requests` / telemetry table once the
 * pipeline is ready. Until then we render honest placeholders derived from the
 * model slug so the layout has realistic-looking numbers without inventing
 * fake charts.
 */

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic "weekly runs" formatted as `1.4M` / `420K`.
 * FIXME: replace with real stats from requests table when telemetry pipeline ready.
 */
export function placeholderRuns(slug: string): string {
  const n = (hashString(slug) % 4_800_000) + 200_000;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

/**
 * Deterministic weekly trend % in range [-12, +18].
 * FIXME: replace with real stats from requests table when telemetry pipeline ready.
 */
export function placeholderTrend(slug: string): number {
  return (hashString(slug) % 31) - 12;
}

/**
 * Stable hash → hue (0..359). Used to colour fallback initial-circles.
 */
export function placeholderHue(slug: string): number {
  return hashString(slug) % 360;
}
