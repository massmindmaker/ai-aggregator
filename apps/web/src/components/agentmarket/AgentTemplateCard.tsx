import * as React from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/Card';
import { placeholderHue } from '@/lib/marketplace/placeholders';
import {
  priceLabel,
  monogramLetter,
  type AgentTemplateRow,
} from '@/lib/agentmarket/catalog';

/**
 * Monogram avatar — first letter of the agent name in a deterministic
 * per-character hue tile. Founder decision (issue #28): no generated art in
 * W1. Hue derives from the template id (placeholderHue is a generic
 * hash-to-hue helper, reused from the models marketplace).
 */
function MonogramAvatar({
  id,
  name,
  size = 10,
}: {
  id: string;
  name: string | null;
  size?: number;
}) {
  const hue = placeholderHue(id);
  const letter = monogramLetter(name);
  return (
    <div
      aria-hidden
      className="rounded-md shrink-0 flex items-center justify-center font-semibold text-white/90 border border-white/10"
      style={{
        width: `${size * 0.25}rem`,
        height: `${size * 0.25}rem`,
        fontSize: size >= 14 ? '1.25rem' : '0.8rem',
        background: `linear-gradient(135deg, hsl(${hue} 60% 32%), hsl(${(hue + 40) % 360} 50% 20%))`,
      }}
    >
      {letter}
    </div>
  );
}

export { MonogramAvatar };

export function AgentTemplateCard({ template }: { template: AgentTemplateRow }) {
  const href = `/agentmarket/${template.id}`;
  const name = template.name ?? 'Без названия';
  const rating = template.avg_rating !== null ? Number(template.avg_rating) : null;

  return (
    <Link
      href={href}
      aria-label={`Открыть агента ${name}`}
      className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg aiag-glow-hover"
    >
      <Card className="h-full hover:border-primary/50 transition-colors">
        <CardContent className="p-4 flex flex-col gap-2.5">
          {/* Header */}
          <div className="flex items-start gap-2.5 min-w-0">
            <MonogramAvatar id={template.id} name={template.name} />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-sm leading-tight line-clamp-2 break-words group-hover:text-primary transition-colors">
                {name}
              </h3>
              {template.trait && (
                <p className="text-[11px] text-muted-foreground truncate">
                  {template.trait}
                </p>
              )}
            </div>
          </div>

          {/* Description */}
          {template.description && (
            <p className="text-[12px] text-muted-foreground line-clamp-2">
              {template.description}
            </p>
          )}

          {/* Stats row */}
          <div className="mt-auto pt-2 border-t border-border flex items-center justify-between gap-2">
            <span className="text-[12px] font-mono text-amber-500 truncate">
              {priceLabel(template.price_credits)}
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 flex items-center gap-2">
              {rating !== null && <span>★ {rating.toFixed(1)}</span>}
              <span>{template.clone_count} клонов</span>
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function AgentTemplateGrid({
  items,
  empty,
}: {
  items: AgentTemplateRow[];
  empty?: React.ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {empty ?? 'Пока нет опубликованных агентов.'}
      </div>
    );
  }
  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 aiag-stagger">
      {items.map((t) => (
        <AgentTemplateCard key={t.id} template={t} />
      ))}
    </div>
  );
}
