/**
 * Sigil — the AIAG 4-node graph mark rendered as a static (server) SVG so it
 * can be used as a recurring motif/divider throughout the manifesto without
 * shipping the interactive client logo. Same geometry as
 * components/ui/AiagLogo.tsx (lower-left → upper-mid → lower-right → ember).
 */
export function Sigil({
  size = 28,
  className = '',
  glow = false,
  dim = 1,
}: {
  size?: number;
  className?: string;
  glow?: boolean;
  dim?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      width={size}
      height={size}
      className={`${glow ? 'm-sigil-glow' : ''} ${className}`}
      style={{ overflow: 'visible', opacity: dim }}
      aria-hidden="true"
    >
      <line x1="9" y1="22" x2="15" y2="9" stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="15" y1="9" x2="22" y2="21" stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="24.5" y1="18" x2="26" y2="10" stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="11.5" y1="22" x2="14.5" y2="22" stroke="#f59e0b" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="22" r="4.2" fill="#f59e0b" />
      <circle cx="15" cy="9" r="4.2" fill="#f59e0b" />
      <circle cx="22" cy="21" r="4.2" fill="#f59e0b" />
      <circle cx="26" cy="8" r="2.4" fill="#f59e0b" opacity="0.65" />
    </svg>
  );
}
