'use client';

import * as React from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  parseFiltersFromSearchParams,
  filtersToSearchParams,
  type MarketplaceFilters,
} from '@/lib/marketplace/filters';

const SORTS: Array<{ value: MarketplaceFilters['sort']; label: string }> = [
  { value: 'popular', label: 'По популярности' },
  { value: 'rating', label: 'По рейтингу' },
  { value: 'cheap', label: 'Сначала дешёвые' },
  { value: 'fast', label: 'Сначала быстрые' },
  { value: 'new', label: 'По алфавиту' },
];

export function SearchAndSort() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = React.useMemo(
    () =>
      parseFiltersFromSearchParams(
        new URLSearchParams(searchParams?.toString())
      ),
    [searchParams]
  );

  const [query, setQuery] = React.useState(filters.q ?? '');
  React.useEffect(() => {
    setQuery(filters.q ?? '');
  }, [filters.q]);

  const applyPatch = React.useCallback(
    (patch: Partial<MarketplaceFilters>) => {
      const next = { ...filters, ...patch, page: 1 };
      const qs = filtersToSearchParams(next).toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
      // The results grid is server-rendered from `searchParams`. Next's
      // client Router Cache can serve a stale RSC payload for a URL that
      // was visited earlier in the session (e.g. toggling sort back and
      // forth) even though the address bar updates correctly — force a
      // fresh fetch so the dropdown label and card order always match the
      // URL immediately, same as the filter checkboxes.
      router.refresh();
    },
    [filters, router, pathname]
  );

  // Debounced search
  React.useEffect(() => {
    const handle = setTimeout(() => {
      if (query === (filters.q ?? '')) return;
      applyPatch({ q: query || undefined });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="flex flex-col sm:flex-row gap-2 w-full">
      <div className="relative flex-1">
        <Search
          className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск моделей, провайдеров, тегов…"
          className="ps-9"
          aria-label="Поиск по каталогу"
        />
      </div>
      <Select
        value={filters.sort}
        onValueChange={(v) =>
          applyPatch({ sort: v as MarketplaceFilters['sort'] })
        }
      >
        <SelectTrigger className="w-full sm:w-[220px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
