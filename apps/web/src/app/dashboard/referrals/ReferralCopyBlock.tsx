'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Sonner';

export function ReferralCopyBlock({ code, link }: { code: string; link: string }) {
  const [copied, setCopied] = React.useState<'code' | 'link' | null>(null);

  const copy = async (kind: 'code' | 'link', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
      toast.success(
        kind === 'code' ? 'Реферальный код скопирован' : 'Реферальная ссылка скопирована',
        { duration: 2000 }
      );
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
    'AIAG — единый шлюз к российским и зарубежным AI-моделям. Регистрируйся по моей ссылке и получи бонус на баланс'
  )}`;
  const vkShare = `https://vk.com/share.php?url=${encodeURIComponent(link)}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-center">
        <div className="flex-1">
          <div className="text-xs text-muted-foreground mb-1">Код</div>
          <div className="font-mono text-2xl font-semibold tracking-wider bg-muted/30 rounded-md px-3 py-2">
            {code}
          </div>
        </div>
        <Button onClick={() => copy('code', code)} variant="outline">
          {copied === 'code' ? 'Скопировано' : 'Скопировать код'}
        </Button>
      </div>

      <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-center">
        <div className="flex-1">
          <div className="text-xs text-muted-foreground mb-1">Ссылка</div>
          <div className="font-mono text-xs bg-muted/30 rounded-md px-3 py-2 break-all">{link}</div>
        </div>
        <Button onClick={() => copy('link', link)}>
          {copied === 'link' ? 'Скопировано' : 'Скопировать ссылку'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        <a
          href={tgShare}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-md border text-xs hover:bg-muted/40 transition-colors"
        >
          Поделиться в Telegram
        </a>
        <a
          href={vkShare}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-md border text-xs hover:bg-muted/40 transition-colors"
        >
          Поделиться во ВКонтакте
        </a>
      </div>
    </div>
  );
}
