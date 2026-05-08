/**
 * AIAG worker entry point.
 *
 * Wires up:
 *   - Shared .env loading (/srv/aiag/shared/.env on VPS)
 *   - Redis connection
 *   - All BullMQ workers (upstream-poll, contest-eval, webhook-retry, email-send)
 *   - Health probes (upstream + internal)
 *   - HTTP /health on PORT (default 4001) for pm2 / nginx
 *   - Graceful SIGTERM / SIGINT shutdown
 */
import { createServer } from 'node:http';
import { loadSharedEnv } from './env.js';
import { logger } from './logger.js';
import { createRedisConnection } from './redis.js';
import { startUpstreamPollWorker } from './queues/upstream-poll.js';
import { startContestEvalWorker } from './queues/contest-eval.js';
import { startWebhookRetryWorker } from './queues/webhook-retry.js';
import { startEmailSendWorker } from './queues/email-send.js';
import { startCloseContestsCron } from './queues/close-contests-cron.js';
import { startFinalizeEarningsCron } from './queues/finalize-earnings-cron.js';
import { runEvaluation } from './eval-runner/runner.js';
import { startInternalProbe } from './probes/internal-probe.js';

async function main(): Promise<void> {
  loadSharedEnv();

  const connection = createRedisConnection();
  logger.info('redis connected');

  // ---------------------------------------------------------------------------
  // Queue workers — for now most use stub deps; gateway/web will adopt them.
  // The contest-eval worker is real (runs python via systemd-run on Linux).
  // ---------------------------------------------------------------------------
  const upstreamPoll = startUpstreamPollWorker(connection, {
    poll: async () => {
      // TODO Phase 2: route via UpstreamRegistry.get(upstream).pollPrediction(id)
      logger.warn('upstream-poll: poll() stub — returning pending');
      return { status: 'pending' };
    },
    sink: async (input) => {
      // TODO Phase 2: UPDATE prediction_jobs SET status=$1, output_url=$2 WHERE id=$3
      logger.info(input, 'upstream-poll sink (stub)');
    },
  });

  const contestEval = startContestEvalWorker(connection, {
    run: runEvaluation,
    sink: async (input) => {
      // TODO Phase 2: UPDATE evaluations SET status=$1, public_score=$2 WHERE submission_id=$3
      logger.info(input, 'contest-eval sink (stub)');
    },
  });

  const webhookRetry = startWebhookRetryWorker(connection);
  const emailSend = startEmailSendWorker(connection);

  // ---------------------------------------------------------------------------
  // Phase 14 crons — closeContestsCron (hourly) + finalizeEarningsCron (daily).
  // Both lazy-import @aiag/database so the worker still boots when DATABASE_URL
  // is absent (dev / smoke / CI), matching the internalProbe pingPg pattern.
  // ---------------------------------------------------------------------------
  const closeContests = startCloseContestsCron(connection, {
    runOnce: async () => {
      if (!process.env.DATABASE_URL) return { contestsProcessed: 0, awardsCreated: 0 };
      const { createDb, sql } = await import('@aiag/database');
      const db = createDb(process.env.DATABASE_URL);
      const { runCloseContestsOnce } = await import('./queues/close-contests-cron.js');
      return runCloseContestsOnce(
        db as unknown as Parameters<typeof runCloseContestsOnce>[0],
        sql as unknown as Parameters<typeof runCloseContestsOnce>[1]
      );
    },
  });

  const finalizeEarnings = startFinalizeEarningsCron(connection, {
    runOnce: async () => {
      if (!process.env.DATABASE_URL) return { rowsTransitioned: 0 };
      const { createDb, sql } = await import('@aiag/database');
      const db = createDb(process.env.DATABASE_URL);
      const { runFinalizeEarningsOnce } = await import('./queues/finalize-earnings-cron.js');
      return runFinalizeEarningsOnce(
        db as unknown as Parameters<typeof runFinalizeEarningsOnce>[0],
        sql as unknown as Parameters<typeof runFinalizeEarningsOnce>[1]
      );
    },
  });

  const workers = [upstreamPoll, contestEval, webhookRetry, emailSend, closeContests, finalizeEarnings];

  // ---------------------------------------------------------------------------
  // Probes
  // ---------------------------------------------------------------------------
  const internalProbe = startInternalProbe({
    pingPg: async () => {
      // Lazy DB import to keep the worker bootable without DATABASE_URL in dev.
      if (!process.env.DATABASE_URL) return;
      const { createDb, sql } = await import('@aiag/database');
      const db = createDb(process.env.DATABASE_URL);
      await db.execute(sql`SELECT 1`);
    },
    pingRedis: async () => {
      const pong = await connection.ping();
      if (pong !== 'PONG') throw new Error(`redis ping returned ${pong}`);
    },
  });

  // Upstream probe is wired to a no-op listUpstreams in Phase 1 — real impl
  // pulls from `upstreams` table once gateway/admin agree on slugs.

  // ---------------------------------------------------------------------------
  // /health server
  // ---------------------------------------------------------------------------
  const port = Number(process.env.PORT ?? 4001);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'aiag-worker', uptime: process.uptime() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'worker http /health listening');
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown initiated');
    internalProbe.stop();
    server.close();
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('aiag-worker started');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker bootstrap failed');
  process.exit(1);
});
