import * as React from 'react';
import { db, sql } from '@/lib/db';
import { rowsOf } from '@/lib/admin/rows';
import { requireAdmin } from '@/lib/admin/guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { KycRowActions } from './KycRowActions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'KYC очередь — AIAG Admin' };

type Row = {
  doc_id: string;
  user_id: string;
  email: string;
  kyc_type: string | null;
  kyc_status: string;
  doc_type: string;
  storage_key: string;
  uploaded_at: string;
};

async function fetchPending(): Promise<Row[]> {
  try {
    const r = await db.execute(sql`
      SELECT d.id::text AS doc_id,
             u.id::text AS user_id, u.email,
             u.kyc_type, u.kyc_status,
             d.doc_type, d.storage_key, d.uploaded_at::text
      FROM kyc_documents d
      JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending'
      ORDER BY d.uploaded_at ASC
      LIMIT 200
    `);
    return rowsOf<Row>(r);
  } catch (e) {
    console.error('[admin/kyc-queue] fetch failed', e);
    return [];
  }
}

async function fetchCounters(): Promise<{
  pending: number;
  approved_7d: number;
  rejected_7d: number;
}> {
  try {
    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='approved' AND reviewed_at > NOW() - INTERVAL '7 days')::int AS approved_7d,
        COUNT(*) FILTER (WHERE status='rejected' AND reviewed_at > NOW() - INTERVAL '7 days')::int AS rejected_7d
      FROM kyc_documents
    `);
    return (
      rowsOf<{ pending: number; approved_7d: number; rejected_7d: number }>(r)[0] ?? {
        pending: 0,
        approved_7d: 0,
        rejected_7d: 0,
      }
    );
  } catch {
    return { pending: 0, approved_7d: 0, rejected_7d: 0 };
  }
}

const S3_BASE = 'https://s3.timeweb.cloud/aiag-storage';

export default async function AdminKycQueuePage() {
  await requireAdmin();
  const [rows, counters] = await Promise.all([fetchPending(), fetchCounters()]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">KYC очередь</h1>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Pending</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-400">{counters.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Approved 7d</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{counters.approved_7d}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs text-muted-foreground">Rejected 7d</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-400">{counters.rejected_7d}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Документы на проверке</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">KYC type</th>
                <th className="text-left px-3 py-2">Doc</th>
                <th className="text-left px-3 py-2">Файл</th>
                <th className="text-left px-3 py-2">Загружен</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.doc_id} className="border-t">
                  <td className="px-3 py-2 text-xs font-mono">{r.email}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{r.kyc_type ?? '—'}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.doc_type}</td>
                  <td className="px-3 py-2 text-xs">
                    <a
                      href={`${S3_BASE}/${r.storage_key}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-400 underline"
                      title={r.storage_key}
                    >
                      открыть
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {new Date(r.uploaded_at).toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <KycRowActions
                      docId={r.doc_id}
                      userId={r.user_id}
                      kycType={r.kyc_type}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    Очередь пуста
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
