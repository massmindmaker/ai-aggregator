import * as React from 'react';
import Link from 'next/link';
import { Star, Zap, Shield } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { TransferWarningBadge } from '@/components/TransferWarningBadge';
import { cn } from '@/lib/utils';
import {
  type CatalogModel,
  MODEL_TYPE_LABEL_RU,
  isForeignHosted,
} from '@/lib/marketplace/catalog';
import { formatPriceLabel } from '@/lib/marketplace/pricing-calc';

interface ModelCardProps {
  model: CatalogModel;
}

const TYPE_ICON: Record<string, string> = {
  llm: '💬',
  image: '🎨',
  audio: '🎵',
  video: '🎬',
  embedding: '🔢',
  code: '💻',
  'speech-to-text': '🎤',
  'text-to-speech': '🔊',
  multimodal: '🌐',
};

export function ModelCard({ model }: ModelCardProps) {
  const foreign = isForeignHosted(model.orgSlug);
  const href = `/marketplace/${model.orgSlug}/${model.modelSlug}`;

  return (
    <Link
      href={href}
      aria-label={`Открыть модель ${model.name}`}
      className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg aiag-glow-hover"
    >
      <Card className="h-full hover:border-primary/50 transition-colors">
        <CardContent className="p-5 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                aria-hidden
                className="text-2xl shrink-0"
                title={MODEL_TYPE_LABEL_RU[model.type]}
              >
                {TYPE_ICON[model.type]}
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
                  {model.name}
                </h3>
                <p className="text-xs text-muted-foreground truncate">
                  {model.orgName}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {model.hostingRegion === 'ru' ? (
                <Badge
                  variant="secondary"
                  className="gap-1 text-[10px] h-5 bg-emerald-500/15 text-emerald-500 border-emerald-500/20"
                >
                  <Shield className="h-3 w-3" aria-hidden />
                  Хостинг РФ
                </Badge>
              ) : foreign ? (
                <TransferWarningBadge variant="chip" />
              ) : null}
            </div>
          </div>

          <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2.5rem]">
            {model.shortDescription}
          </p>

          <div className="flex flex-wrap gap-1">
            {model.tags.slice(0, 3).map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] h-5">
                {t}
              </Badge>
            ))}
            {model.derivedTags.includes('fast') && (
              <Badge
                variant="outline"
                className="text-[10px] h-5 gap-1 border-amber-500/40 text-amber-500"
              >
                <Zap className="h-3 w-3" aria-hidden />
                быстрая
              </Badge>
            )}
          </div>

          <div className="mt-auto pt-2 border-t border-border flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-foreground/80 truncate">
              {formatPriceLabel(model)}
            </span>
            <span className="inline-flex items-center gap-1 text-xs">
              <Star
                className="h-3 w-3 fill-amber-500 text-amber-500"
                aria-hidden
              />
              <span className="font-medium">
                {model.stats.avgRating.toFixed(1)}
              </span>
              <span className="text-muted-foreground">
                ({model.stats.totalReviews})
              </span>
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
      <CardContent className="p-5 flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <div className="h-8 w-8 bg-muted rounded animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted rounded animate-pulse w-1/2" />
            <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
          </div>
        </div>
        <div className="h-8 bg-muted rounded animate-pulse" />
        <div className="h-5 bg-muted rounded animate-pulse w-2/3" />
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
        'grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 aiag-stagger',
        className
      )}
    >
      {items.map((m) => (
        <ModelCard key={m.slug} model={m} />
      ))}
    </div>
  );
}
