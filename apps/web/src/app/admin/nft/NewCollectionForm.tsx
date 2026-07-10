'use client';

import * as React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { tonToNano } from '@aiag/shared/client';

export function NewCollectionForm() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [slug, setSlug] = React.useState('');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [imageUrl, setImageUrl] = React.useState('');
  const [startonusId, setStartonusId] = React.useState('');
  const [priceTon, setPriceTon] = React.useState('');
  const [maxSupply, setMaxSupply] = React.useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!slug.trim()) return setError('Укажите slug');
    if (!name.trim()) return setError('Укажите название');
    if (!priceTon.trim() || Number(priceTon) <= 0) return setError('Укажите цену в TON (> 0)');

    let priceNano: string;
    try {
      priceNano = tonToNano(priceTon).toString();
    } catch {
      return setError('Некорректная цена TON');
    }

    setBusy(true);
    try {
      const body = {
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || null,
        image_url: imageUrl.trim() || null,
        startonus_collection_id: startonusId.trim() || null,
        price_nano_ton: priceNano,
        max_supply: maxSupply.trim() ? Number(maxSupply) : null,
      };
      const r = await fetch('/api/admin/nft/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof j.error === 'string' ? j.error : j.message ?? `Ошибка ${r.status}`);
        return;
      }
      window.location.href = '/admin/nft';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="text-xs uppercase text-muted-foreground">Слаг</label>
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="cosmo-cats-2026"
          required
        />
        <p className="text-[11px] text-muted-foreground mt-1">a-z, 0-9, дефис</p>
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Название</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Описание</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full border rounded-md px-3 py-2 bg-background text-sm min-h-[80px]"
        />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Image URL</label>
        <Input
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://..."
        />
      </div>
      <div>
        <label className="text-xs uppercase text-muted-foreground">Startonus Collection ID</label>
        <Input
          value={startonusId}
          onChange={(e) => setStartonusId(e.target.value)}
          placeholder="из @startonus_bot"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs uppercase text-muted-foreground">Цена TON</label>
          <Input
            type="number"
            step="0.000000001"
            min="0"
            value={priceTon}
            onChange={(e) => setPriceTon(e.target.value)}
            placeholder="1.5"
            required
          />
        </div>
        <div>
          <label className="text-xs uppercase text-muted-foreground">Max supply (опц.)</label>
          <Input
            type="number"
            min="1"
            value={maxSupply}
            onChange={(e) => setMaxSupply(e.target.value)}
            placeholder="∞"
          />
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/5 px-3 py-2 rounded">
          {error}
        </div>
      )}

      <Button type="submit" disabled={busy}>
        {busy ? 'Создаю...' : 'Создать'}
      </Button>
    </form>
  );
}
