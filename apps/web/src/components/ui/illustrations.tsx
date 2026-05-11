/**
 * Micro-illustrations для EmptyState (240×160 default).
 * Стиль: outline + amber accent + subtle CellsSpot-подобный grid фон.
 * Все обязательно одного размера для consistency.
 */

const W = 240;
const H = 160;
const ACCENT = '#f59e0b';
const LINE = 'rgba(255,255,255,0.12)';
const MUTED = 'rgba(255,255,255,0.4)';

interface Props { className?: string; width?: number; height?: number; }

function baseProps({ width = W, height = H, className = '' }: Props) {
  return { width, height, viewBox: `0 0 ${W} ${H}`, fill: 'none', className } as const;
}

function GridBg() {
  return (
    <g opacity="0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <line key={`v${i}`} x1={i * 24} y1={0} x2={i * 24} y2={H} stroke={LINE} strokeWidth="0.5" />
      ))}
      {Array.from({ length: 7 }).map((_, i) => (
        <line key={`h${i}`} x1={0} y1={i * 24} x2={W} y2={i * 24} stroke={LINE} strokeWidth="0.5" />
      ))}
    </g>
  );
}

// 1. Keys — связка ключей (для /dashboard/keys empty)
export function IllKeys(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <circle cx="80" cy="80" r="22" stroke={ACCENT} strokeWidth="2.5" />
      <circle cx="80" cy="80" r="8" stroke={ACCENT} strokeWidth="2.5" />
      <line x1="102" y1="80" x2="180" y2="80" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="155" y1="80" x2="155" y2="95" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="170" y1="80" x2="170" y2="98" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="100" cy="105" r="14" stroke={MUTED} strokeWidth="2" />
      <line x1="114" y1="105" x2="155" y2="105" stroke={MUTED} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// 2. Models — куб/box с layered planes (для empty models list)
export function IllModels(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <g transform="translate(120,80)">
        <path d="M -40 0 L 0 -22 L 40 0 L 0 22 Z" stroke={ACCENT} strokeWidth="2" />
        <path d="M -40 0 L -40 30 L 0 52 L 0 22 Z" stroke={ACCENT} strokeWidth="2" />
        <path d="M 40 0 L 40 30 L 0 52 L 0 22 Z" stroke={ACCENT} strokeWidth="2" />
      </g>
      <g transform="translate(60,55)" opacity="0.4">
        <path d="M -16 0 L 0 -8 L 16 0 L 0 8 Z" stroke={MUTED} strokeWidth="1.5" />
      </g>
      <g transform="translate(190,110)" opacity="0.4">
        <path d="M -12 0 L 0 -6 L 12 0 L 0 6 Z" stroke={MUTED} strokeWidth="1.5" />
      </g>
    </svg>
  );
}

// 3. Submissions — paper/upload icon
export function IllSubmissions(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <rect x="86" y="40" width="58" height="76" rx="3" stroke={MUTED} strokeWidth="1.5" />
      <rect x="78" y="48" width="58" height="76" rx="3" stroke={MUTED} strokeWidth="1.5" />
      <rect x="70" y="56" width="58" height="76" rx="3" stroke={ACCENT} strokeWidth="2.5" fill="rgba(245,158,11,0.05)" />
      <line x1="80" y1="74" x2="118" y2="74" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <line x1="80" y1="86" x2="110" y2="86" stroke={ACCENT} strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
      <line x1="80" y1="98" x2="115" y2="98" stroke={ACCENT} strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
      <line x1="80" y1="110" x2="102" y2="110" stroke={ACCENT} strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// 4. Trophy
export function IllTrophy(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <g transform="translate(120,80)" stroke={ACCENT} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M -22 -30 L 22 -30 L 22 -10 C 22 6 10 18 0 18 C -10 18 -22 6 -22 -10 Z" />
        <path d="M -22 -22 L -32 -22 L -32 -8 L -22 -8" />
        <path d="M 22 -22 L 32 -22 L 32 -8 L 22 -8" />
        <line x1="-12" y1="18" x2="12" y2="18" />
        <line x1="0" y1="18" x2="0" y2="30" />
        <line x1="-16" y1="30" x2="16" y2="30" />
      </g>
      <circle cx="60" cy="60" r="2" fill={ACCENT} opacity="0.5" />
      <circle cx="180" cy="50" r="2.5" fill={ACCENT} />
      <circle cx="195" cy="100" r="1.8" fill={ACCENT} opacity="0.4" />
    </svg>
  );
}

// 5. Wallet
export function IllWallet(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <g transform="translate(120,80)">
        <rect x="-44" y="-26" width="88" height="56" rx="6" stroke={ACCENT} strokeWidth="2.5" fill="rgba(245,158,11,0.04)" />
        <rect x="26" y="-8" width="22" height="20" rx="3" stroke={ACCENT} strokeWidth="2" />
        <circle cx="37" cy="2" r="2.5" fill={ACCENT} />
      </g>
      <circle cx="80" cy="40" r="8" stroke={ACCENT} strokeWidth="1.5" />
      <text x="80" y="45" textAnchor="middle" fill={ACCENT} fontSize="10" fontFamily="monospace">₽</text>
      <circle cx="170" cy="125" r="6" stroke={ACCENT} strokeWidth="1.5" opacity="0.6" />
    </svg>
  );
}

// 6. Webhooks
export function IllWebhooks(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <circle cx="60" cy="50" r="12" stroke={ACCENT} strokeWidth="2.5" fill="rgba(245,158,11,0.08)" />
      <circle cx="180" cy="50" r="12" stroke={ACCENT} strokeWidth="2.5" />
      <circle cx="120" cy="110" r="14" stroke={ACCENT} strokeWidth="2.5" />
      <path d="M 70 58 Q 95 84 110 100" stroke={ACCENT} strokeWidth="2" strokeDasharray="4 3" />
      <path d="M 170 58 Q 145 84 130 100" stroke={ACCENT} strokeWidth="2" strokeDasharray="4 3" />
      <path d="M 70 50 Q 120 30 170 50" stroke={MUTED} strokeWidth="1.5" />
    </svg>
  );
}

// 7. Referrals
export function IllReferrals(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <g transform="translate(120,75)">
        <circle cx="0" cy="-12" r="11" stroke={ACCENT} strokeWidth="2.5" />
        <path d="M -18 22 Q 0 6 18 22 L 18 30 L -18 30 Z" stroke={ACCENT} strokeWidth="2.5" />
      </g>
      <g transform="translate(50,90)" opacity="0.6">
        <circle cx="0" cy="-8" r="8" stroke={ACCENT} strokeWidth="2" />
        <path d="M -12 18 Q 0 6 12 18 L 12 26 L -12 26 Z" stroke={ACCENT} strokeWidth="2" />
      </g>
      <g transform="translate(190,90)" opacity="0.6">
        <circle cx="0" cy="-8" r="8" stroke={ACCENT} strokeWidth="2" />
        <path d="M -12 18 Q 0 6 12 18 L 12 26 L -12 26 Z" stroke={ACCENT} strokeWidth="2" />
      </g>
      <line x1="65" y1="80" x2="105" y2="65" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="3 2" />
      <line x1="175" y1="80" x2="135" y2="65" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="3 2" />
    </svg>
  );
}

// 8. Generic fallback
export function IllGeneric(props: Props = {}) {
  return (
    <svg {...baseProps(props)} aria-hidden="true">
      <GridBg />
      <circle cx="120" cy="80" r="30" stroke={ACCENT} strokeWidth="2.5" />
      <circle cx="120" cy="80" r="14" stroke={ACCENT} strokeWidth="2" opacity="0.5" />
      <circle cx="120" cy="80" r="4" fill={ACCENT} />
    </svg>
  );
}

export type IllustrationVariant = 'keys' | 'models' | 'submissions' | 'trophy' | 'wallet' | 'webhooks' | 'referrals' | 'generic';

const REGISTRY = {
  keys: IllKeys,
  models: IllModels,
  submissions: IllSubmissions,
  trophy: IllTrophy,
  wallet: IllWallet,
  webhooks: IllWebhooks,
  referrals: IllReferrals,
  generic: IllGeneric,
} as const;

export function Illustration({ variant, ...rest }: { variant: IllustrationVariant } & Props) {
  const Component = REGISTRY[variant] ?? IllGeneric;
  return <Component {...rest} />;
}
