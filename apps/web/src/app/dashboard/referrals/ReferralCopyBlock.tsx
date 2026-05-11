'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Sonner';
import { Send, Share2, MessageCircle } from 'lucide-react';

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

  const pitch =
    'AIAG — единый шлюз к российским и зарубежным AI-моделям. Регистрируйся по моей ссылке и получи бонус на баланс';
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(pitch)}`;
  const vkShare = `https://vk.com/share.php?url=${encodeURIComponent(link)}`;
  const waShare = `https://wa.me/?text=${encodeURIComponent(`${pitch} — ${link}`)}`;

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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs hover:bg-muted/40 transition-colors"
        >
          <Send className="h-3 w-3" />
          Telegram
        </a>
        <a
          href={vkShare}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs hover:bg-muted/40 transition-colors"
        >
          <Share2 className="h-3 w-3" />
          ВКонтакте
        </a>
        <a
          href={waShare}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs hover:bg-muted/40 transition-colors"
        >
          <MessageCircle className="h-3 w-3" />
          WhatsApp
        </a>
      </div>
    </div>
  );
}
