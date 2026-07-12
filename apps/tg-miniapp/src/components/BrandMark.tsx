// AIAG chain-glow brand mark — same 4-node zigzag icon as apps/web's
// AiagLogo.tsx (icon-only here; TMA screens run inside Telegram's own
// chrome, no wordmark needed). Used on the pre-auth gate ("Откройте через
// @aiag_bot…") — the closest thing TMA has to a splash screen — to wire up
// DESIGN.md's aiag-logo-dot chain-glow, which had no consumer in TMA
// (issue #23).
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', margin: '0 auto 12px' }}
    >
      <line x1="9" y1="22" x2="15" y2="9" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" />
      <line x1="15" y1="9" x2="22" y2="21" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" />
      <line x1="24.5" y1="18" x2="26" y2="10" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      <line x1="11.5" y1="22" x2="14.5" y2="22" stroke="#f59e0b" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
      {/* Halo-слой — bloom за каждым узлом (transform/opacity, БЕЗ filter). */}
      <circle cx="9" cy="22" r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '0ms' }} />
      <circle cx="15" cy="9" r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '300ms' }} />
      <circle cx="22" cy="21" r="4.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '600ms' }} />
      <circle cx="26" cy="8" r="2.5" fill="#f59e0b" className="aiag-logo-halo" style={{ animationDelay: '900ms' }} />

      <circle cx="9" cy="22" r="4.5" fill="#f59e0b" className="aiag-logo-dot" style={{ animationDelay: '0ms' }} />
      <circle cx="15" cy="9" r="4.5" fill="#f59e0b" className="aiag-logo-dot" style={{ animationDelay: '300ms' }} />
      <circle cx="22" cy="21" r="4.5" fill="#f59e0b" className="aiag-logo-dot" style={{ animationDelay: '600ms' }} />
      <circle cx="26" cy="8" r="2.5" fill="#f59e0b" opacity="0.65" className="aiag-logo-dot" style={{ animationDelay: '900ms' }} />
    </svg>
  );
}
