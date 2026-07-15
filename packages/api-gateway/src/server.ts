/**
 * Plan 04 Gateway — Hono server.
 *
 * Default export is Bun.serve-compatible: { port, fetch, idleTimeout }.
 * Tests import named { app } and call `app.fetch(new Request(...))`.
 */
import { Hono } from 'hono';
import { logger } from './lib/logger';
import { config } from './config';
import { AiagError, errors } from './lib/errors';
import { requireApiKey } from './middleware/auth-plan04';
import { rateLimit } from './middleware/rate-limit-plan04';
import { keyLimits } from './middleware/key-limits';
import { piiFilter } from './middleware/pii-filter';
import { modelStatusMiddleware } from './middleware/model-status-check';
import { requestIdMiddleware } from './middleware/request-id';
import { chat } from './routes/v1/chat';
import { completions } from './routes/v1/completions';
import { embeddings } from './routes/v1/embeddings';
import { models as modelsRoute } from './routes/v1/models';
import { balance as balanceRoute } from './routes/v1/balance';
import { images } from './routes/v1/images';
import { video } from './routes/v1/video';
import { audio } from './routes/v1/audio';
import { batches } from './routes/v1/batches';

const bootTime = Date.now();

export const app = new Hono();

// ---- in-flight counter for graceful shutdown --------------------------------
let inFlight = 0;
app.use('*', async (_c, next) => {
  inFlight++;
  try {
    await next();
  } finally {
    inFlight--;
  }
});

app.use('*', requestIdMiddleware());

app.onError((err, c) => {
  if (err instanceof AiagError) {
    logger.warn({ err, code: err.code }, 'aiag_error');
    return c.json(err.toResponseBody(), err.status as any);
  }
  logger.error({ err: String(err) }, 'unhandled');
  return c.json(
    { error: { code: 'INTERNAL', message: 'Internal error' } },
    500
  );
});

app.get('/health', (c) =>
  c.json({
    ok: true,
    runtime:
      typeof (globalThis as any).Bun !== 'undefined'
        ? `bun ${(globalThis as any).Bun.version}`
        : `node ${process.version}`,
    uptime_s: Math.floor((Date.now() - bootTime) / 1000),
    ts: Date.now(),
  })
);

app.get('/', (c) =>
  c.json({ service: 'aiag-gateway', version: '0.4.0-code' })
);

// ---- /v1 routes: auth + rate-limit + pii ------------------------------------
app.use('/v1/*', requireApiKey);
app.use('/v1/*', rateLimit);
app.use('/v1/*', keyLimits);
app.use('/v1/*', piiFilter);
app.use('/v1/*', modelStatusMiddleware());

app.route('/v1/chat', chat);
app.route('/v1/completions', completions);
app.route('/v1/embeddings', embeddings);
app.route('/v1/models', modelsRoute);
app.route('/v1/balance', balanceRoute);
app.route('/v1/images', images);
app.route('/v1/video', video);
app.route('/v1/audio', audio);
app.route('/v1/batches', batches);

app.notFound((c) =>
  c.json(errors.notFound('Route not found').toResponseBody(), 404)
);

// ---- Graceful shutdown ------------------------------------------------------
async function drain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (inFlight > 0) logger.warn({ inFlight }, 'shutdown_drain_timeout');
}

let server: { stop?: () => void | Promise<void> } | null = null;

if (process.env.NODE_ENV !== 'test') {
  ['SIGTERM', 'SIGINT'].forEach((sig) =>
    process.on(sig, async () => {
      logger.info({ sig, inFlight }, 'shutdown_begin');
      try {
        if (server && typeof (server as any).stop === 'function') {
          await (server as any).stop();
        }
      } catch {
        /* ignore */
      }
      await drain(config.SHUTDOWN_DRAIN_TIMEOUT_MS);
      logger.info('shutdown_complete');
      process.exit(0);
    })
  );
}

export default {
  port: config.PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
