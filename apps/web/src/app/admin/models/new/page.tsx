import * as React from 'react';
import { redirect } from 'next/navigation';
import { db, sql } from '@/lib/db';
import { requireAdmin } from '@/lib/admin/guard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';

export const metadata = { title: 'Новая модель — Админка' };

async function createModel(formData: FormData) {
  'use server';
  await requireAdmin();
  const slug = String(formData.get('slug') ?? '').trim();
  const type = String(formData.get('type') ?? '').trim();
  const displayName = String(formData.get('display_name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();

  if (!slug || !type) throw new Error('slug и type обязательны');
  if (!/^[a-z0-9/_-]+$/.test(slug)) throw new Error('slug: только a-z, 0-9, /_-');

  await db.execute(sql`
    INSERT INTO models (slug, type, enabled, display_name, description)
    VALUES (${slug}, ${type}, true, ${displayName || null}, ${description || null})
    ON CONFLICT (slug) DO NOTHING
  `);

  redirect(`/admin/models/${encodeURIComponent(slug)}/edit`);
}

export default async function NewModelPage() {
  await requireAdmin();
  return (
    <div className="container mx-auto px-4 py-10 max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight mb-6">Новая модель</h1>

      <form action={createModel} className="space-y-4">
        <div>
          <Label htmlFor="slug">Slug *</Label>
          <Input
            id="slug"
            name="slug"
            placeholder="provider/model-name"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Канонический идентификатор — например `openai/gpt-4o` или `flux-pro-1-1`.
          </p>
        </div>

        <div>
          <Label htmlFor="type">Тип *</Label>
          <select
            id="type"
            name="type"
            required
            className="w-full rounded border bg-background px-3 py-2 text-sm"
            defaultValue="chat"
          >
            <option value="chat">chat (LLM)</option>
            <option value="embedding">embedding</option>
            <option value="image">image</option>
            <option value="audio">audio</option>
            <option value="video">video</option>
          </select>
        </div>

        <div>
          <Label htmlFor="display_name">Display name</Label>
          <Input id="display_name" name="display_name" placeholder="GPT-4o" />
        </div>

        <div>
          <Label htmlFor="description">Описание</Label>
          <textarea
            id="description"
            name="description"
            rows={4}
            className="w-full rounded border bg-background px-3 py-2 text-sm"
            placeholder="Краткое описание модели на русском"
          />
        </div>

        <div className="flex gap-2 pt-4">
          <Button type="submit">Создать</Button>
          <Button asChild variant="outline">
            <a href="/admin/models">Отмена</a>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          После создания вы сможете добавить upstream-маршруты на странице
          редактирования.
        </p>
      </form>
    </div>
  );
}
