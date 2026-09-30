'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Label } from '@/components/ui/Label';
import {
  MODEL_TYPE_LABEL_RU,
  type ModelType,
  type HostingRegion,
} from '@/lib/marketplace/catalog';
import {
  parseFiltersFromSearchParams,
  filtersToSearchParams,
  type MarketplaceFilters,
} from '@/lib/marketplace/filters';
import { cn } from '@/lib/utils';

interface Props {
  orgs: Array<{ slug: string; name: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  initialFilters?: MarketplaceFilters;
  className?: string;
  onClose?: () => void;
}

// 🔴 AG-7 (2026-09-30): this list used to include `code`, `multimodal` and
// `text-to-speech` — types no entry in `catalog.generated.ts` ever has
// (`code` exists only as a TAG; `speech-to-text` was withdrawn from sale by
// migration 0093). Each of those checkboxes produced an empty results page.
// The list is now exactly the types the live catalog contains.
const ALL_TYPES: ModelType[] = [
  'llm',
  'image',
  'audio',
  'video',
  'embedding',
];

const REGIONS: Array<{ value: HostingRegion; label: string }> = [
  { value: 'ru', label: 'Россия (🛡 152-ФЗ)' },
  { value: 'eu', label: 'Европа' },
  { value: 'us', label: 'США' },
  { value: 'global', label: 'Global CDN' },
];

// 🔴 AG-7: the "Возможности" filter group is gone entirely. Every capability
// it offered (Streaming, Function calling, Vision, JSON Schema, Batch API) is
// declared `false` by the contract the gateway actually executes
// (public-catalog.ts:638-651), so filtering by them could only ever surface
// models the buyer cannot use. `MarketplaceFilters.capabilities` stays in the
// URL schema so old shared links keep parsing; nothing writes it any more.

export function FilterPanel({ orgs, tags, className, onClose }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Parse live from URL so we stay in sync with browser navigation.
  const filters = React.useMemo(() => {
    const sp = new URLSearchParams(searchParams?.toString());
    return parseFiltersFromSearchParams(sp);
  }, [searchParams]);

  const updateFilters = React.useCallback(
    (patch: Partial<MarketplaceFilters>) => {
      const next = { ...filters, ...patch, page: 1 };
      const sp = filtersToSearchParams(next);
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [filters, router, pathname]
  );

  const toggleInArray = <T extends string>(
    arr: T[],
    value: T,
    key: keyof MarketplaceFilters
  ) => {
    const next = arr.includes(value)
      ? arr.filter((v) => v !== value)
      : [...arr, value];
    updateFilters({ [key]: next } as Partial<MarketplaceFilters>);
  };

  const clearAll = () => router.push(pathname);

  return (
    <aside
      aria-label="Фильтры каталога"
      className={cn('space-y-5 text-sm', className)}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-base">Фильтры</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="h-7 text-xs"
          >
            Сбросить
          </Button>
          {onClose && (
            <button
              type="button"
              aria-label="Закрыть фильтры"
              onClick={onClose}
              className="p-1 rounded hover:bg-secondary md:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <FilterGroup label="Тип модели">
        {ALL_TYPES.map((t) => (
          <CheckRow
            key={t}
            id={`type-${t}`}
            checked={filters.types.includes(t)}
            label={MODEL_TYPE_LABEL_RU[t]}
            onChange={() => toggleInArray(filters.types, t, 'types')}
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Хостинг">
        {REGIONS.map((r) => (
          <CheckRow
            key={r.value}
            id={`region-${r.value}`}
            checked={filters.regions.includes(r.value)}
            label={r.label}
            onChange={() => toggleInArray(filters.regions, r.value, 'regions')}
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Провайдер">
        {orgs.map((o) => (
          <CheckRow
            key={o.slug}
            id={`org-${o.slug}`}
            checked={filters.orgs.includes(o.slug)}
            label={`${o.name} (${o.count})`}
            onChange={() => toggleInArray(filters.orgs, o.slug, 'orgs')}
          />
        ))}
      </FilterGroup>

      <FilterGroup label="Теги">
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 12).map((t) => {
            const active = filters.tags.includes(t.tag);
            return (
              <button
                key={t.tag}
                type="button"
                onClick={() => toggleInArray(filters.tags, t.tag, 'tags')}
                className={cn(
                  'px-2 py-0.5 rounded-full text-xs border transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-secondary'
                )}
                aria-pressed={active}
              >
                {t.tag}
              </button>
            );
          })}
        </div>
      </FilterGroup>
    </aside>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function CheckRow({
  id,
  checked,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <Label
        htmlFor={id}
        className="text-sm font-normal cursor-pointer select-none"
      >
        {label}
      </Label>
    </div>
  );
}

// `computeFacets` moved to `@/lib/marketplace/facets` — exporting a server
// helper from this `'use client'` file caused server components to import
// a client reference and crash with "TypeError: f is not a function".
export { computeFacets } from '@/lib/marketplace/facets';
