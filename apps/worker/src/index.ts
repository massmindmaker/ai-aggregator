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
import { startTonReconciliationFromEnv, TonReconciliationStartupError, type TonCloseResult } from './ton-payment-bootstrap.js';
import {
  logGatewaySettlementRecoveryBoundaryFailure,
  startGatewaySettlementRecoveryFromEnv,
} from './gateway-settlement-recovery-bootstrap.js';
import { createRedisConnection } from './redis.js';
import { startUpstreamPollWorker } from './queues/upstream-poll.js';
import { MediaJobDb } from './queues/upstream-poll-db.js';
import { startMediaPollRecovery } from './queues/media-poll-recovery.js';
import { createMediaKieAdapter } from './media-kie.js';
import { startContestEvalWorker } from './queues/contest-eval.js';
import { startWebhookRetryWorker } from './queues/webhook-retry.js';
import { startEmailSendWorker } from './queues/email-send.js';
import { startCloseContestsCron } from './queues/close-contests-cron.js';
import { startFinalizeEarningsCron } from './queues/finalize-earnings-cron.js';
import { runEvaluation } from './eval-runner/runner.js';
import { startInternalProbe } from './probes/internal-probe.js';
import { startCatalogSyncCron } from './catalog/sync-cron.js';

let tonReconciliation: Awaited<ReturnType<typeof startTonReconciliationFromEnv>> | undefined;
let tonClosing: Promise<TonCloseResult | undefined> | undefined;
function closeTonReconciliation(): Promise<TonCloseResult | undefined> {
  if (!tonReconciliation) return Promise.resolve(undefined);
  tonClosing ??= Promise.resolve().then(() => tonReconciliation!.close()).then(result => {
    logger.info({ component: 'ton-reconciliation', result }, 'TON reconciliation closed');
    return result;
  });
  return tonClosing;
}

async function main(): Promise<void> {
  loadSharedEnv();
  tonReconciliation = await startTonReconciliationFromEnv({
    env: process.env,
    onResult: (sourceId, result) => logger.info({ component: 'ton-reconciliation', sourceId, result }, 'TON reconciliation observation'),
  });
  // These modules import gateway runtime/storage bindings. Load them only
  // after shared env is present so DATABASE_URL is captured correctly.
  const { startBatchProcessWorker } = await import('./queues/batch-process.js');
  const { startBatchProcessRecovery } = await import('./queues/batch-process-recovery.js');
  const gatewaySettlementRecovery = await startGatewaySettlementRecoveryFromEnv({
    env: process.env,
    logger,
  });

  const connection = createRedisConnection();
  logger.info('redis connected');

  // ---------------------------------------------------------------------------
  // Queue workers — for now most use stub deps; gateway/web will adopt them.
  // The contest-eval worker is real (runs python via systemd-run on Linux).
  // ---------------------------------------------------------------------------
  const mediaDb = new MediaJobDb(process.env.DATABASE_URL ?? '');
  const kie = createMediaKieAdapter(process.env);
  const upstreamPoll = startUpstreamPollWorker(connection, {
    load: (jobId) => mediaDb.load(jobId),
    markProcessing: (jobId) => mediaDb.markProcessing(jobId),
    poll: async (job) => {
      if (!kie || !job.providerTaskId) throw new Error('MEDIA_PROVIDER_UNAVAILABLE');
      const family = job.providerFamily === 'video' ? 'veo' : job.providerFamily;
      const result = await kie.pollAsync(job.providerTaskId, { request_id: job.id, family } as never);
      if (result.status === 'pending') return { status: 'pending' as const };
      if (result.status === 'completed') return { status: 'completed' as const, output: result.output };
      return { status: 'failed' as const, error: result.error ?? 'provider_failed' };
    },
    finalize: (job, status, output, error) => mediaDb.finalize(job, status, output, error),
  });
  const mediaPollRecovery = startMediaPollRecovery(connection, mediaDb);
  const contestEval = startContestEvalWorker(connection, {
    run: runEvaluation,
    sink: async (input) => {
      // TODO Phase 2: UPDATE evaluations SET status=$1, public_score=$2 WHERE submission_id=$3
      logger.info(input, 'contest-eval sink (stub)');
    },
  });

  const webhookRetry = startWebhookRetryWorker(connection);
  const emailSend = startEmailSendWorker(connection);
  const batchProcess = startBatchProcessWorker(connection);
  const batchProcessRecovery = startBatchProcessRecovery(connection);

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

  const workers = [
    upstreamPoll,
    mediaPollRecovery,
    contestEval,
    webhookRetry,
    emailSend,
    batchProcess,
    batchProcessRecovery,
    closeContests,
    finalizeEarnings,
    ...(gatewaySettlementRecovery === null ? [] : [gatewaySettlementRecovery]),
  ];

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

  // models.dev catalog sync (T4) — no-op unless MODELS_DEV_SYNC=on.
  startCatalogSyncCron();

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
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ signal }, 'shutdown initiated');
      let clean = true;
      try { internalProbe.stop(); server.close(); } catch { clean = false; }
      // Await all owners even when one close fails. TON's close has its own finite budgets.
      const results = await Promise.allSettled([
        closeTonReconciliation(),
        ...workers.map(w => Promise.resolve().then(() => w.close())),
      ]);
      const ton = results[0];
      if (results.some(result => result.status === 'rejected')) clean = false;
      if (ton.status === 'fulfilled' && ton.value &&
          (ton.value.kind !== 'closed' || ton.value.mutationOutcome !== 'known')) clean = false;
      const resources = await Promise.allSettled([
        Promise.resolve().then(() => mediaDb.close()),
        Promise.resolve().then(() => connection.quit()),
      ]);
      if (resources.some(result => result.status === 'rejected')) clean = false;
      logger.info({ clean }, 'shutdown complete');
      process.exit(clean ? 0 : 1);
    })();
    return shuttingDown;
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('aiag-worker started');
}

main().catch(async (err) => {
  try { await closeTonReconciliation(); }
  catch { logger.error({ component: 'ton-reconciliation', classification: 'close_failed' }, 'TON reconciliation cleanup failed'); }
  if (err instanceof TonReconciliationStartupError) {
    logger.fatal({ component: 'ton-reconciliation', classification: 'startup_refused' }, 'TON reconciliation startup refused');
  } else if (!logGatewaySettlementRecoveryBoundaryFailure(logger, err)) {
    logger.fatal({ err }, 'worker bootstrap failed');
  }
  process.exit(1);
});
