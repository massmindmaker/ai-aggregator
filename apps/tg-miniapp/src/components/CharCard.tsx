'use client';

import Link from 'next/link';
import { haptic } from '@/lib/haptics';
import { monogram, placeholderVariant } from '@/components/AgentCard';

// ─────────────────────────────────────────────────────────────────────────────
// CharCard — полная карточка-персонаж (DESIGN.md / PRODUCT.md «коллекционная
// карта»). Восстанавливает сигнатуру, которую растеряла «функциональная плитка»:
// портрет с per-character OKLCH hue + live-dot, имя + бейдж модели, роль + автор,
// строка ХАРАКТЕРА (личность) и ряд статов (запуски · ★рейтинг · цена).
//
// Канон: docs/wireframes/design-board.html (charCard/ccard, экраны 03/05).
// Портрет + голо-фольга переиспользуют машинерию AgentCard (--holo-x/y/rx/ry +
// .tma-agent-portrait ::before/::after из globals.css).
// ─────────────────────────────────────────────────────────────────────────────

// ── Holo-tilt — зеркалит AgentCard ───────────────────────────────────────────
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

export interface CharCardProps {
  href: string;
  hue: number;
  name: string | null;
  /** Портрет персонажа (webp) — рендерится вместо монограммы; фольга поверх. */
  portraitImage?: string | null;
  /** Видео-луп персонажа (mp4, без звука) — poster = portraitImage. */
  portraitVideo?: string | null;
  /** Главная модель, рендерится в mono-пилюле рядом с именем. */
  modelBadge?: string | null;
  /** Роль/специализация (одна строка). */
  role?: string | null;
  /** Handle автора (@username), приглушённый. */
  author?: string | null;
  /** Строка ХАРАКТЕРА — сигнатура карточки. Рендерится ТОЛЬКО если задана. */
  trait?: string | null;
  /** Живой статус — пульсирующая точка поверх портрета. */
  live?: boolean;
  /** Ряд статов: запуски · ★рейтинг · цена. Каждый mono tabular-nums. */
  stats?: { runs?: string; rating?: string; price?: string };
  /** Демо-данные → приписать крошечный «демо» к статам. */
  demoStats?: boolean;
  /** Подпись amber-кнопки действия. */
  actionLabel?: string;
  /** Обработчик действия. Если задан — кнопка перехватывает клик (не Link). */
  onAction?: () => void;
  /** Компактный вариант (списки инбокса): меньший портрет + имя + роль в строку. */
  compact?: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function CharCard({
  href,
  hue,
  name,
  portraitImage,
  portraitVideo,
  modelBadge,
  role,
  author,
  trait,
  live = false,
  stats,
  demoStats = false,
  actionLabel,
  onAction,
  compact = false,
}: CharCardProps) {
  const playVideo = !!portraitVideo && !prefersReducedMotion();
  const portraitBg = `linear-gradient(155deg, oklch(0.34 0.09 ${hue}), oklch(0.17 0.045 ${hue}))`;
  const portraitInk = `oklch(0.93 0.11 ${hue})`;

  const portrait = (
    <div
      className="tma-agent-portrait cc-portrait"
      style={{ background: portraitBg, color: portraitInk }}
    >
      {playVideo ? (
        <video
          src={portraitVideo as string}
          poster={portraitImage ?? undefined}
          autoPlay
          muted
          loop
          playsInline
          className="cc-media"
          aria-hidden
        />
      ) : portraitImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={portraitImage} alt="" className="cc-media" aria-hidden />
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
      {live && <span className="cc-live aiag-pulse-dot" aria-hidden />}
    </div>
  );

  // ── Компактный вариант: горизонтальный, портрет + имя + роль одной строкой ──
  if (compact) {
    return (
      <Link
        href={href}
        className="tma-agent-card cc-card cc-card--compact"
        onPointerMove={holoMove}
        onPointerLeave={holoReset}
        onPointerCancel={holoReset}
      >
        {portrait}
        <div className="cc-body">
          <div className="cc-name">
            {name ?? 'Без имени'}
            {modelBadge && (
              <span className="cc-badge tma-mono" title={modelBadge}>
                {modelBadge}
              </span>
            )}
          </div>
          {role && <p className="cc-role cc-role--line">{role}</p>}
        </div>
      </Link>
    );
  }

  // ── Полный вариант ─────────────────────────────────────────────────────────
  const hasStats = !!stats && (stats.runs || stats.rating || stats.price);

  return (
    <Link
      href={href}
      className="tma-agent-card cc-card"
      onPointerMove={holoMove}
      onPointerLeave={holoReset}
      onPointerCancel={holoReset}
    >
      {portrait}
      <div className="cc-body">
        <div className="cc-name">
          {name ?? 'Без имени'}
          {modelBadge && (
            <span className="cc-badge tma-mono" title={modelBadge}>
              {modelBadge}
            </span>
          )}
        </div>
        {(role || author) && (
          <p className="cc-role">
            {role}
            {role && author && ' · '}
            {author && <span className="cc-author">{author}</span>}
          </p>
        )}
        {trait && <p className="cc-trait">{trait}</p>}

        {hasStats && (
          <div className="cc-stats">
            {stats?.runs && (
              <div className="cc-stat">
                <div className="cc-stat-v tma-mono">{stats.runs}</div>
                <div className="cc-stat-k">
                  запуски{demoStats && <span className="cc-demo">демо</span>}
                </div>
              </div>
            )}
            {stats?.rating && (
              <div className="cc-stat">
                <div className="cc-stat-v cc-stat-v--star tma-mono">
                  ★ {stats.rating}
                </div>
                <div className="cc-stat-k">
                  рейтинг{demoStats && <span className="cc-demo">демо</span>}
                </div>
              </div>
            )}
            {stats?.price && (
              <div className="cc-stat">
                <div className="cc-stat-v tma-mono">{stats.price}</div>
                <div className="cc-stat-k">цена</div>
              </div>
            )}
          </div>
        )}

        {actionLabel &&
          (onAction ? (
            <button
              type="button"
              className="cc-action tma-btn tma-btn--primary"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                haptic.impact('medium');
                onAction();
              }}
            >
              {actionLabel}
            </button>
          ) : (
            <span className="cc-action tma-btn tma-btn--primary">
              {actionLabel}
            </span>
          ))}
      </div>
    </Link>
  );
}
