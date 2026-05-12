import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import http from 'node:http';
import { runAgent } from './agent-runner.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const PORT = Number(process.env.PORT ?? 3101);

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const worker = new Worker(
  'agent-run',
  async (job) => {
    const runId = (job.data as { runId?: string })?.runId;
    if (!runId) throw new Error('missing runId');
    console.log(`[agent-worker] processing run=${runId} job=${job.id}`);
    await runAgent(runId);
  },
  { connection, concurrency: 4 },
);

worker.on('completed', (job) => {
  console.log(`[agent-worker] ✓ job=${job.id}`);
});
worker.on('failed', (job, err) => {
  console.error(`[agent-worker] ✗ job=${job?.id}: ${err.message}`);
});

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'agent-worker' }));
  })
  .listen(PORT, () => {
    console.log(`[agent-worker] healthcheck on :${PORT}`);
  });

console.log('[agent-worker] listening on agent-run queue');

async function shutdown(): Promise<void> {
  console.log('[agent-worker] shutting down…');
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
