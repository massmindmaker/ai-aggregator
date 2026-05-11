'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from '@/components/ui/Sonner';

interface Props {
  slug: string;
  currentImageUrl?: string | null;
}

export function ImageUpload({ slug, currentImageUrl }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData(e.currentTarget);
      const res = await fetch(`/api/admin/models/${slug}/image`, { method: 'POST', body: fd });
      if (res.ok) {
        toast.success('Обложка загружена');
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        const msg = body.error ?? 'Ошибка загрузки';
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="border rounded-sm p-4 space-y-3" style={{ borderColor: 'var(--line)' }}>
      <div className="font-semibold text-sm">Обложка модели</div>
      {currentImageUrl && (
        <img src={currentImageUrl} alt="cover" className="w-32 h-32 object-cover rounded" />
      )}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 flex-wrap">
        <input
          type="file"
          name="image"
          accept="image/png,image/jpeg,image/webp"
          className="text-sm"
          required
        />
        <span className="text-xs opacity-50">PNG/JPEG/WebP, до 2 МБ</span>
        <button
          type="submit"
          disabled={uploading}
          className="px-3 py-1.5 text-sm bg-[var(--accent)] text-black rounded-sm font-semibold disabled:opacity-50"
        >
          {uploading ? 'Загрузка…' : 'Загрузить'}
        </button>
      </form>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
