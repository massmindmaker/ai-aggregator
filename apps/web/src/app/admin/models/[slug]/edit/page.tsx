import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db, sql } from '@/lib/db';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ModelStatusActions } from './ModelStatusActions';
import { ImageUpload } from './_components/ImageUpload';

export const dynamic = 'force-dynamic';

interface ModelRow {
  id: string;
  slug: string;
  type: string;
  enabled: boolean;
  display_name: string | null;
  description: string | null;
  status: string;
  frozen_reason: string | null;
  depublished_reason: string | null;
  image_url: string | null;
}

interface UpstreamRow {
  id: string;
  upstream_id: string;
  upstream_model_id: string;
  price_per_1k_input: string;
  price_per_1k_output: string;
  price_per_image: string | null;
  price_per_audio_sec: string | null;
  markup: string;
  enabled: boolean;
}

async function getData(slug: string) {
  const modelRes = await db.execute(sql`
    SELECT id::text AS id, slug, type, enabled, display_name, description,
           status, frozen_reason, depublished_reason, image_url
    FROM models WHERE slug = ${slug} LIMIT 1
  `);
  const mr = modelRes as unknown as { rows?: ModelRow[] } | ModelRow[];
  const modelRows = Array.isArray(mr) ? mr : mr.rows ?? [];
  const model = modelRows?.[0];
  if (!model) return null;

  const upRes = await db.execute(sql`
    SELECT id, upstream_id, upstream_model_id,
      price_per_1k_input, price_per_1k_output, price_per_image,
      price_per_audio_sec, markup, enabled
    FROM model_upstreams WHERE model_id = ${model.id}
    ORDER BY upstream_id
  `);
  const ur = upRes as unknown as { rows?: UpstreamRow[] } | UpstreamRow[];
  const upstreams = Array.isArray(ur) ? ur : ur.rows ?? [];

  const allUpRes = await db.execute(sql`SELECT id, provider FROM upstreams ORDER BY id`);
  type UpRow = { id: string; provider: string };
  const aur = allUpRes as unknown as { rows?: UpRow[] } | UpRow[];
  const allUpstreams = Array.isArray(aur) ? aur : aur.rows ?? [];

  return { model, upstreams, allUpstreams };
}

export default async function EditModelPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const data = await getData(slug);
  if (!data) notFound();
  const { model, upstreams, allUpstreams } = data;

  async function updateModel(formData: FormData) {
    'use server';
    const enabled = formData.get('enabled') === 'on';
    const displayName = String(formData.get('display_name') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    const type = String(formData.get('type') ?? '').trim();
    await db.execute(sql`
      UPDATE models
      SET enabled = ${enabled},
          display_name = ${displayName || null},
          description = ${description || null},
          type = ${type},
          updated_at = NOW()
      WHERE id = ${model.id}
    `);
    revalidatePath(`/admin/models/${slug}/edit`);
  }

  async function disableModel() {
    'use server';
    await db.execute(sql`UPDATE models SET enabled = false WHERE id = ${model.id}`);
    redirect('/admin/models');
  }

  async function addUpstream(formData: FormData) {
    'use server';
    const upstreamId = String(formData.get('upstream_id') ?? '').trim();
    const upstreamModelId = String(formData.get('upstream_model_id') ?? '').trim();
    const pIn = String(formData.get('price_per_1k_input') ?? '0');
    const pOut = String(formData.get('price_per_1k_output') ?? '0');
    const pImg = String(formData.get('price_per_image') ?? '');
    const pAud = String(formData.get('price_per_audio_sec') ?? '');
    // Floor mirrors DB constraint chk_markup_floor (migration 0047): no upstream below 1.20.
    const markup = String(formData.get('markup') ?? '1.20');
    if (!upstreamId || !upstreamModelId) return;
    await db.execute(sql`
      INSERT INTO model_upstreams
        (model_id, upstream_id, upstream_model_id,
         price_per_1k_input, price_per_1k_output,
         price_per_image, price_per_audio_sec, markup)
      VALUES (${model.id}, ${upstreamId}, ${upstreamModelId},
        ${pIn}::numeric, ${pOut}::numeric,
        ${pImg || null}, ${pAud || null}, ${markup}::numeric)
      ON CONFLICT (model_id, upstream_id) DO UPDATE
        SET upstream_model_id = EXCLUDED.upstream_model_id,
            price_per_1k_input = EXCLUDED.price_per_1k_input,
            price_per_1k_output = EXCLUDED.price_per_1k_output,
            price_per_image = EXCLUDED.price_per_image,
            price_per_audio_sec = EXCLUDED.price_per_audio_sec,
            markup = EXCLUDED.markup
    `);
    revalidatePath(`/admin/models/${slug}/edit`);
  }

  async function deleteUpstream(formData: FormData) {
    'use server';
    const id = String(formData.get('id'));
    await db.execute(sql`DELETE FROM model_upstreams WHERE id = ${id}`);
    revalidatePath(`/admin/models/${slug}/edit`);
  }

  return (
    <div className="container mx-auto px-4 py-10 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{model.display_name ?? model.slug}</h1>
        <Badge variant="outline">{model.type}</Badge>
        {model.enabled ? (
          <Badge variant="success">enabled</Badge>
        ) : (
          <Badge variant="destructive">disabled</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground font-mono mb-8">{model.slug}</p>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Статус модели</h2>
        <ModelStatusActions
          modelId={model.id}
          modelSlug={model.slug}
          status={model.status}
          frozenReason={model.frozen_reason}
          depublishedReason={model.depublished_reason}
        />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Обложка</h2>
        <ImageUpload slug={model.slug} currentImageUrl={model.image_url} />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Основные поля</h2>
        <form action={updateModel} className="space-y-4">
          <div>
            <Label>Display name</Label>
            <Input name="display_name" defaultValue={model.display_name ?? ''} />
          </div>
          <div>
            <Label>Тип</Label>
            <select
              name="type"
              defaultValue={model.type}
              className="w-full rounded border bg-background px-3 py-2 text-sm"
            >
              {['chat', 'embedding', 'image', 'audio', 'video'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Описание</Label>
            <textarea
              name="description"
              rows={3}
              defaultValue={model.description ?? ''}
              className="w-full rounded border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enabled"
              name="enabled"
              defaultChecked={model.enabled}
            />
            <Label htmlFor="enabled">Enabled</Label>
          </div>
          <div className="flex gap-2">
            <Button type="submit">Сохранить</Button>
            <form action={disableModel}>
              <Button type="submit" variant="destructive">
                Отключить и вернуться к списку
              </Button>
            </form>
          </div>
        </form>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">Upstream-маршруты</h2>
        <div className="rounded-lg border mb-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Upstream</TableHead>
                <TableHead>Upstream model id</TableHead>
                <TableHead>In/1k</TableHead>
                <TableHead>Out/1k</TableHead>
                <TableHead>Img</TableHead>
                <TableHead>Audio/s</TableHead>
                <TableHead>Markup</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upstreams.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    Нет маршрутов. Добавьте ниже.
                  </TableCell>
                </TableRow>
              ) : (
                upstreams.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.upstream_id}</TableCell>
                    <TableCell className="font-mono text-xs">{u.upstream_model_id}</TableCell>
                    <TableCell>{u.price_per_1k_input}</TableCell>
                    <TableCell>{u.price_per_1k_output}</TableCell>
                    <TableCell>{u.price_per_image ?? '—'}</TableCell>
                    <TableCell>{u.price_per_audio_sec ?? '—'}</TableCell>
                    <TableCell>{u.markup}</TableCell>
                    <TableCell>
                      <form action={deleteUpstream}>
                        <input type="hidden" name="id" value={u.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          ✕
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <details className="border rounded p-4">
          <summary className="cursor-pointer font-medium">+ Добавить маршрут</summary>
          <form action={addUpstream} className="grid grid-cols-2 gap-3 mt-4">
            <div>
              <Label>Upstream</Label>
              <select
                name="upstream_id"
                required
                className="w-full rounded border bg-background px-3 py-2 text-sm"
              >
                {allUpstreams.map((u) => (
                  <option key={u.id} value={u.id}>{u.id} ({u.provider})</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Upstream model id</Label>
              <Input name="upstream_model_id" placeholder="openai/gpt-4o" required />
            </div>
            <div>
              <Label>Price per 1k input (RUB)</Label>
              <Input name="price_per_1k_input" type="number" step="0.0001" defaultValue="0" />
            </div>
            <div>
              <Label>Price per 1k output (RUB)</Label>
              <Input name="price_per_1k_output" type="number" step="0.0001" defaultValue="0" />
            </div>
            <div>
              <Label>Price per image (RUB)</Label>
              <Input name="price_per_image" type="number" step="0.01" placeholder="(image only)" />
            </div>
            <div>
              <Label>Price per audio sec (RUB)</Label>
              <Input name="price_per_audio_sec" type="number" step="0.001" placeholder="(audio only)" />
            </div>
            <div>
              <Label>Markup</Label>
              <Input name="markup" type="number" step="0.01" min="1.20" defaultValue="1.20" />
            </div>
            <div className="col-span-2">
              <Button type="submit">Добавить</Button>
            </div>
          </form>
        </details>
      </section>
    </div>
  );
}
