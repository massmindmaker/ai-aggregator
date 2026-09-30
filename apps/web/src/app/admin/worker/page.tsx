import * as React from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Worker — Админка' };

const QUEUE_NAMES = ['upstream-poll', 'webhook-retry', 'email-send'] as const;
type QName = (typeof QUEUE_NAMES)[number];

interface QueueStats {
  name: QName;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  waiting: number;
  unavailable?: string;
}

interface RecentJob {
  queue: QName;
  id: string;
  name: string;
  status: 'active' | 'completed' | 'failed' | 'delayed' | 'waiting';
  createdAt: number;
  failedReason?: string;
}

/**
 * Fetch BullMQ stats. Imports `bullmq` + `ioredis` dynamically so the page
 * still renders (with an "unavailable" badge) when REDIS_URL is missing or
 * the worker isn't deployed yet.
 */
async function getStats(): Promise<{ queues: QueueStats[]; jobs: RecentJob[] }> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return {
      queues: QUEUE_NAMES.map((n) => ({
        name: n,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
        unavailable: 'REDIS_URL not set',
      })),
      jobs: [],
    };
  }

  let Queue: typeof import('bullmq').Queue;
  let IORedis: typeof import('ioredis').default;
  try {
    ({ Queue } = await import('bullmq'));
    ({ default: IORedis } = await import('ioredis'));
  } catch (err) {
    return {
      queues: QUEUE_NAMES.map((n) => ({
        name: n,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
        unavailable: `bullmq/ioredis not installed: ${(err as Error).message}`,
      })),
      jobs: [],
    };
  }

  const conn = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  try {
    const queues: QueueStats[] = [];
    const jobs: RecentJob[] = [];
    for (const name of QUEUE_NAMES) {
      const q = new Queue(name, { connection: conn });
      try {
        const counts = await q.getJobCounts('active', 'completed', 'failed', 'delayed', 'waiting');
        queues.push({
          name,
          active: counts.active ?? 0,
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
          waiting: counts.waiting ?? 0,
        });
        const recent = await q.getJobs(['active', 'failed', 'completed'], 0, 9, false);
        for (const j of recent) {
          jobs.push({
            queue: name,
            id: String(j.id),
            name: j.name,
            status: (await j.getState()) as RecentJob['status'],
            createdAt: j.timestamp,
            failedReason: j.failedReason,
          });
        }
      } finally {
        await q.close();
      }
    }
    jobs.sort((a, b) => b.createdAt - a.createdAt);
    return { queues, jobs: jobs.slice(0, 25) };
  } finally {
    await conn.quit();
  }
}

export default async function AdminWorkerPage() {
  const { queues, jobs } = await getStats();
  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-6xl">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Worker</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          BullMQ очереди фонового воркера. Источник: Redis (REDIS_URL).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {queues.map((q) => (
            <Card key={q.name}>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 font-mono">
                    <span
                      className={
                        q.unavailable
                          ? 'aiag-pulse-dot aiag-pulse-dot-muted'
                          : q.failed > 0
                            ? 'aiag-pulse-dot aiag-pulse-dot-danger'
                            : q.active > 0 || q.waiting > 0
                              ? 'aiag-pulse-dot aiag-pulse-dot-success'
                              : 'aiag-pulse-dot aiag-pulse-dot-muted'
                      }
                      aria-hidden
                    />
                    {q.name}
                  </span>
                  {q.unavailable ? (
                    <Badge variant="outline">offline</Badge>
                  ) : q.failed > 0 ? (
                    <Badge variant="destructive">{q.failed} failed</Badge>
                  ) : (
                    <Badge variant="secondary">ok</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {q.unavailable ? (
                  <p className="text-muted-foreground">{q.unavailable}</p>
                ) : (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">active</dt>
                    <dd className="text-right font-mono">{q.active}</dd>
                    <dt className="text-muted-foreground">waiting</dt>
                    <dd className="text-right font-mono">{q.waiting}</dd>
                    <dt className="text-muted-foreground">delayed</dt>
                    <dd className="text-right font-mono">{q.delayed}</dd>
                    <dt className="text-muted-foreground">completed</dt>
                    <dd className="text-right font-mono">{q.completed}</dd>
                    <dt className="text-muted-foreground">failed</dt>
                    <dd className="text-right font-mono">{q.failed}</dd>
                  </dl>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Последние задачи</CardTitle>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет задач.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">queue</th>
                    <th className="py-2 pr-4">id</th>
                    <th className="py-2 pr-4">name</th>
                    <th className="py-2 pr-4">status</th>
                    <th className="py-2 pr-4">created</th>
                    <th className="py-2 pr-4">error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={`${j.queue}:${j.id}`} className="border-t aiag-row-hover">
                      <td className="py-2 pr-4 font-mono text-xs">{j.queue}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{j.id}</td>
                      <td className="py-2 pr-4">{j.name}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={j.status === 'failed' ? 'destructive' : 'secondary'}>
                          {j.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {new Date(j.createdAt).toISOString().slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="py-2 pr-4 text-xs text-red-500">{j.failedReason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
