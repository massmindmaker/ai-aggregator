import * as React from 'react';
import Link from 'next/link';
import { db, sql } from '@/lib/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { nanoToTon } from '@aiag/shared';
import { CollectionStatusActions } from './CollectionStatusActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'NFT-коллекции — AIAG Admin' };

type Row = {
  id: string;
  slug: string;
  name: string;
  status: string;
  price_nano_ton: string;
  max_supply: number | null;
  minted_count: number;
  startonus_collection_id: string | null;
  created_at: string;
};

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'draft', label: 'Черновики' },
  { key: 'active', label: 'Активные' },
  { key: 'sold_out', label: 'Распроданы' },
  { key: 'archived', label: 'Архив' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

function normalizeFilter(v: string | undefined): FilterKey {
  if (v === 'draft' || v === 'active' || v === 'sold_out' || v === 'archived') return v;
  return 'all';
}

async function fetchCollections(status: FilterKey): Promise<Row[]> {
  try {
    const r =
      status === 'all'
        ? await db.execute(sql`
            SELECT id::text, slug, name, status,
                   price_nano_ton::text, max_supply, minted_count,
                   startonus_collection_id, created_at
            FROM nft_collections
            ORDER BY created_at DESC
            LIMIT 500
          `)
        : await db.execute(sql`
            SELECT id::text, slug, name, status,
                   price_nano_ton::text, max_supply, minted_count,
                   startonus_collection_id, created_at
            FROM nft_collections
            WHERE status = ${status}
            ORDER BY created_at DESC
            LIMIT 500
          `);
    return ((r as unknown as { rows?: Row[] }).rows ?? (r as unknown as Row[])) || [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

function statusVariant(s: string): 'default' | 'outline' | 'secondary' {
  if (s === 'active') return 'default';
  if (s === 'sold_out' || s === 'archived') return 'secondary';
  return 'outline';
}

export default async function AdminNftPage({
  searchParams,
}: {
  searchParams?: Promise<{ status?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const filter = normalizeFilter(sp.status);
  const rows = await fetchCollections(filter);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">NFT-коллекции</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Каталог mint-шаблонов Startonus. Транзакции — в TON через TON Connect.
          </p>
        </div>
        <Link
          href="/admin/nft/new"
          className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium hover:bg-amber-400"
        >
          + Создать
        </Link>
      </div>

      <div className="flex gap-1 mb-4 text-xs">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          const href = f.key === 'all' ? '/admin/nft' : `/admin/nft?status=${f.key}`;
          return (
            <Link
              key={f.key}
              href={href}
              className={`px-3 py-1.5 rounded-sm font-medium transition-colors ${
                active
                  ? 'bg-amber-500 text-black'
                  : 'border border-border hover:bg-muted/40 text-muted-foreground'
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {FILTERS.find((f) => f.key === filter)?.label ?? 'Все'} ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Слаг</th>
                <th className="text-left px-3 py-2">Название</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-right px-3 py-2">Цена TON</th>
                <th className="text-right px-3 py-2">Supply</th>
                <th className="text-left px-3 py-2">Startonus ID</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t aiag-row-hover">
                  <td className="px-3 py-2 font-mono text-xs">{c.slug}</td>
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2">
                    <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {nanoToTon(c.price_nano_ton)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {c.minted_count} / {c.max_supply ?? '∞'}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {c.startonus_collection_id ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      <CollectionStatusActions collectionId={c.id} currentStatus={c.status} />
                      <Link
                        href={`/admin/nft/${c.id}`}
                        className="text-amber-500 hover:text-amber-400 text-xs"
                      >
                        Открыть →
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Нет коллекций. Создайте первую через @startonus_bot и зарегистрируйте здесь.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
