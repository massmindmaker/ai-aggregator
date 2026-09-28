import * as React from "react";
import Link from "next/link";
import { db, sql } from "@/lib/db";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";

export const metadata = { title: "Модели — Админка" };
export const dynamic = "force-dynamic";

interface ModelRow {
  id: string;
  slug: string;
  type: string;
  enabled: boolean;
  display_name: string | null;
  upstream_count: number;
}

const TYPES = ["all", "chat", "image", "video", "audio", "embedding"] as const;

async function getModels(typeFilter?: string): Promise<ModelRow[]> {
  try {
    const where =
      typeFilter && typeFilter !== "all"
        ? sql`WHERE m.type = ${typeFilter}`
        : sql``;
    const result = await db.execute(sql`
      SELECT m.id, m.slug, m.type, m.enabled, m.display_name,
        (SELECT COUNT(*)::int FROM model_upstreams mu WHERE mu.model_id = m.id) AS upstream_count
      FROM models m
      ${where}
      ORDER BY m.type, m.slug
    `);
    const r = result as unknown as { rows?: ModelRow[] } | ModelRow[];
    const rows = Array.isArray(r) ? r : (r.rows ?? []);
    return rows ?? [];
  } catch {
    return [];
  }
}

export default async function AdminModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const activeType = params.type ?? "all";
  const models = await getModels(activeType);

  return (
    <div className="container mx-auto px-4 py-10 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Модели</h1>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link href="/admin/author-models">Модели авторов</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/models/new">+ Создать модель</Link>
          </Button>
        </div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {TYPES.map((t) => (
          <Link
            key={t}
            href={t === "all" ? "/admin/models" : `/admin/models?type=${t}`}
            className={`px-3 py-1 rounded text-sm border ${
              activeType === t
                ? "bg-primary text-primary-foreground border-primary"
                : "hover:bg-muted"
            }`}
          >
            {t}
          </Link>
        ))}
      </div>

      <p className="text-sm text-muted-foreground mb-3">
        Всего: {models.length}
      </p>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slug</TableHead>
              <TableHead>Название</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Upstreams</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  Нет моделей. Создайте первую или примените seed-миграцию.
                </TableCell>
              </TableRow>
            ) : (
              models.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">{m.slug}</TableCell>
                  <TableCell>{m.display_name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{m.type}</Badge>
                  </TableCell>
                  <TableCell>{m.upstream_count}</TableCell>
                  <TableCell>
                    {m.enabled ? (
                      <Badge variant="success">enabled</Badge>
                    ) : (
                      <Badge variant="outline">disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        href={`/admin/models/${encodeURIComponent(m.slug)}/edit`}
                      >
                        Edit
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
