'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export interface KycRow {
  doc_id: string;
  user_id: string;
  email: string;
  kyc_type: string | null;
  kyc_status: string;
  doc_type: string;
  storage_key: string;
  uploaded_at: string;
}

interface Props {
  rows: KycRow[];
  s3Base: string;
}

function isImage(key: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(key);
}

function isPdf(key: string): boolean {
  return /\.pdf$/i.test(key);
}

export function KycQueueClient({ rows, s3Base }: Props) {
  const [selected, setSelected] = React.useState<KycRow | null>(rows[0] ?? null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const approve = async () => {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/kyc/${selected.doc_id}/approve`, {
        method: 'POST',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `ERR ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!selected) return;
    const reason = window.prompt('Причина отказа?');
    if (!reason) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/kyc/${selected.doc_id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `ERR ${r.status}`);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'NETWORK_ERROR');
      setBusy(false);
    }
  };

  const docUrl = selected ? `${s3Base}/${selected.storage_key}` : null;

  if (rows.length === 0) {
    return (
      <div
        className="border rounded-lg p-12 text-center text-muted-foreground"
        style={{ borderColor: 'var(--line)' }}
      >
        Очередь пуста
      </div>
    );
  }

  return (
    <div
      className="grid lg:grid-cols-[40%_60%] gap-4"
      style={{ minHeight: 600 }}
    >
      {/* List */}
      <div
        className="border rounded-lg overflow-hidden flex flex-col"
        style={{ borderColor: 'var(--line)' }}
      >
        <div
          className="border-b px-4 py-3 flex items-center justify-between"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="text-sm font-semibold">В очереди</span>
          <span
            className="text-xs tabular-nums px-2 py-0.5 rounded-full font-semibold"
            style={{ background: 'var(--accent)', color: '#000' }}
          >
            {rows.length}
          </span>
        </div>
        <div className="flex-1 overflow-auto" style={{ maxHeight: 720 }}>
          {rows.map((r) => (
            <button
              key={r.doc_id}
              type="button"
              onClick={() => {
                setSelected(r);
                setErr(null);
              }}
              className={`w-full text-left px-4 py-3 border-b border-l-2 transition-all ${
                selected?.doc_id === r.doc_id
                  ? 'bg-white/[0.04] border-l-[var(--accent)]'
                  : 'border-l-transparent hover:bg-white/[0.02]'
              }`}
              style={{ borderBottomColor: 'var(--line)' }}
            >
              <div className="font-mono text-xs truncate">{r.email}</div>
              <div className="flex items-center gap-2 mt-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {r.kyc_type ?? '—'}
                </Badge>
                <span className="text-[10px] opacity-50">{r.doc_type}</span>
              </div>
              <div className="text-[10px] opacity-50 mt-1">
                {new Date(r.uploaded_at).toLocaleString('ru-RU')}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail / Viewer */}
      <div
        className="border rounded-lg overflow-hidden flex flex-col"
        style={{ borderColor: 'var(--line)' }}
      >
        {selected ? (
          <>
            <div
              className="border-b px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
              style={{ borderColor: 'var(--line)' }}
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{selected.email}</div>
                <div className="text-[10px] opacity-50 font-mono truncate">
                  {selected.storage_key}
                </div>
              </div>
              <div className="flex gap-2 items-center">
                {docUrl && (
                  <a
                    href={docUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs underline opacity-70 hover:opacity-100"
                  >
                    Открыть в новой вкладке
                  </a>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={reject}
                  disabled={busy}
                >
                  Отклонить
                </Button>
                <Button size="sm" onClick={approve} disabled={busy}>
                  Подтвердить
                </Button>
              </div>
            </div>
            {err && (
              <div className="px-4 py-2 text-xs text-red-400 bg-red-500/10 border-b" style={{ borderColor: 'var(--line)' }}>
                {err}
              </div>
            )}
            <div
              className="flex-1 flex items-center justify-center bg-black/30 aiag-grid-bg-sm overflow-auto"
              style={{ minHeight: 480 }}
            >
              {docUrl && isImage(selected.storage_key) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={docUrl}
                  alt={`KYC document for ${selected.email}`}
                  className="max-w-full max-h-[640px] object-contain"
                />
              ) : docUrl && isPdf(selected.storage_key) ? (
                <iframe
                  src={docUrl}
                  className="w-full h-full border-0"
                  style={{ minHeight: 600 }}
                  title={`KYC document — ${selected.email}`}
                />
              ) : (
                <div className="text-sm opacity-60 p-8 text-center">
                  Предпросмотр недоступен для этого формата.
                  {docUrl && (
                    <div className="mt-3">
                      <a
                        href={docUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400 underline"
                      >
                        Скачать файл
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center opacity-50 text-sm">
            Выберите запись из списка
          </div>
        )}
      </div>
    </div>
  );
}
