import * as React from 'react';
import Link from 'next/link';
import { TrendingUp, TrendingDown, Shield, Globe } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import {
  type CatalogModel,
  isForeignHosted,
} from '@/lib/marketplace/catalog';
import { formatPriceLabel } from '@/lib/marketplace/pricing-calc';
import {
  placeholderRuns,
  placeholderTrend,
  placeholderHue,
} from '@/lib/marketplace/placeholders';

interface ModelCardProps {
  model: CatalogModel;
}

function ProviderAvatar({ model }: { model: CatalogModel }) {
  if (model.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={model.imageUrl}
        alt=""
        width={32}
        height={32}
        className="h-8 w-8 rounded-md object-cover shrink-0 border border-white/10"
      />
    );
  }
  const hue = placeholderHue(model.orgSlug);
  const letter = model.orgName.charAt(0).toUpperCase();
  return (
    <div
      aria-hidden
      className="h-8 w-8 rounded-md shrink-0 flex items-center justify-center text-xs font-semibold text-white/90 border border-white/10"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 60% 32%), hsl(${(hue + 40) % 360} 50% 20%))`,
      }}
    >
      {letter}
    </div>
  );
}

function TrendChip({ trend }: { trend: number }) {
  if (trend === 0) return null;
  const up = trend > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
        up ? 'text-emerald-500' : 'text-red-500'
      )}
      title="Изменение за неделю (placeholder)"
    >
      <Icon className="h-3 w-3" aria-hidden />
      {up ? '+' : ''}
      {trend.toFixed(1)}%
    </span>
  );
}

export function ModelCard({ model }: ModelCardProps) {
  const foreign = isForeignHosted(model.orgSlug);
  const href = `/marketplace/${model.orgSlug}/${model.modelSlug}`;
  const runs = placeholderRuns(model.slug);
  const trend = placeholderTrend(model.slug);

  return (
    <Link
      href={href}
      aria-label={`Открыть модель ${model.name}`}
      className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg aiag-glow-hover"
    >
      <Card className="h-full hover:border-primary/50 transition-colors">
        <CardContent className="p-4 flex flex-col gap-2.5">
          {/* Header */}
          <div className="flex items-start gap-2.5 min-w-0">
            <ProviderAvatar model={model} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
                <span className="truncate">{model.orgName}</span>
                {model.hostingRegion === 'ru' ? (
                  <Shield
                    className="h-3 w-3 text-emerald-500 shrink-0"
                    aria-label="Хостинг РФ"
                  />
                ) : foreign ? (
                  <Globe
                    className="h-3 w-3 text-amber-500/80 shrink-0"
                    aria-label="Трансгран. передача (152-ФЗ)"
                  />
                ) : null}
              </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="font-semibold text-sm leading-tight line-clamp-2 break-words group-hover:text-primary transition-colors">
                  {model.name}
                </h3>
                {model.version && (
                  <span className="inline-flex items-center shrink-0 text-[10px] font-mono px-1 py-px rounded border border-border/60 text-muted-foreground/70 bg-muted/40 leading-none">
                    v{model.version}
                  </span>
                )}
              </div>
              {model.supersededBySlug && (
                <span
                  className="inline-flex items-center text-[10px] text-amber-500/80 leading-none mt-0.5"
                  title={`Новее: ${model.supersededByName ?? model.supersededBySlug}`}
                >
                  ↑ новее
                </span>
              )}
            </div>
            <TrendChip trend={trend} />
          </div>

          {/* Description */}
          <p className="text-[12px] text-muted-foreground line-clamp-1">
            {model.shortDescription}
          </p>

          {/* Tags (compact, optional) */}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {model.tags.slice(0, 2).map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className="text-[10px] h-4 px-1.5 font-normal text-muted-foreground/80"
                >
                  {t}
                </Badge>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="mt-auto pt-2 border-t border-border flex items-center justify-between gap-2">
            <span className="text-[12px] font-mono text-amber-500 truncate">
              {formatPriceLabel(model)}
            </span>
            <span
              className="text-[11px] text-muted-foreground tabular-nums shrink-0"
              title="Запросов за неделю (placeholder)"
            >
              {runs} runs
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function ModelCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5">
          <div className="h-8 w-8 bg-muted rounded-md animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
            <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
          </div>
        </div>
        <div className="h-3 bg-muted rounded animate-pulse" />
        <div className="h-4 bg-muted rounded animate-pulse w-1/2" />
      </CardContent>
    </Card>
  );
}

export function ModelGrid({
  items,
  empty,
  className,
}: {
  items: CatalogModel[];
  empty?: React.ReactNode;
  className?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        {empty ?? 'Моделей не найдено. Попробуйте изменить фильтры.'}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 aiag-stagger',
        className
      )}
    >
      {items.map((m) => (
        <ModelCard key={m.slug} model={m} />
      ))}
    </div>
  );
}
