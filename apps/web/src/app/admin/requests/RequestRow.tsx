'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';

type Props = {
  requestId: string;
  createdAt: string;
  userEmail: string | null;
  modelSlug: string;
  upstream: string;
  statusBadge: React.ReactNode;
  latencyMs: number | null;
  costRub: string | null;
};

export function RequestRow(p: Props) {
  const [open, setOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(false);

  const onOpen = async () => {
    setOpen(true);
    if (detail || loading) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/requests/${encodeURIComponent(p.requestId)}`);
      const j = await r.json();
      setDetail(j);
    } catch (e) {
      setDetail({ error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <tr className="border-t aiag-row-hover cursor-pointer" onClick={onOpen}>
        <td className="px-3 py-2 font-mono text-xs">{p.requestId}</td>
        <td className="px-3 py-2 text-xs">{new Date(p.createdAt).toLocaleString('ru-RU')}</td>
        <td className="px-3 py-2 text-xs">{p.userEmail ?? '—'}</td>
        <td className="px-3 py-2 text-xs">{p.modelSlug}</td>
        <td className="px-3 py-2 text-xs">{p.upstream}</td>
        <td className="px-3 py-2">{p.statusBadge}</td>
        <td className="px-3 py-2 text-right">{p.latencyMs ?? '—'} ms</td>
        <td className="px-3 py-2 text-right">{p.costRub ? Number(p.costRub).toFixed(4) : '—'}</td>
      </tr>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <span style={{ display: 'none' }} />
        </DialogTrigger>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request {p.requestId}</DialogTitle>
          </DialogHeader>
          {loading && <div className="text-sm text-muted-foreground">Загрузка...</div>}
          {detail != null && (
            <pre className="text-xs bg-muted/30 p-3 rounded overflow-x-auto">
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
