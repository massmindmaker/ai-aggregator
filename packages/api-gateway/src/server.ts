/**
 * Plan 04 Gateway — Hono server.
 *
 * Default export is Bun.serve-compatible: { port, fetch, idleTimeout }.
 * Tests import named { app } and call `app.fetch(new Request(...))`.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { logger } from './lib/logger';
import { config } from './config';
import { AiagError, applyAiagErrorHandler, errors } from './lib/errors';
import { requireApiKey } from './middleware/auth-plan04';
import { rateLimit, rpmOnly } from './middleware/rate-limit-plan04';
import { keyLimits } from './middleware/key-limits';
import { piiFilter, setPiiResolveModel } from './middleware/pii-filter';
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
import { storedMedia } from './routes/v1/stored-media';
import { storedTranscription } from './routes/v1/stored-transcription';
import { storedBatches } from './routes/v1/stored-batches';
import { catalogRoute } from './routes/v1/catalog';
import { usage } from './routes/v1/usage';
import { organizationKeys } from './routes/v1/organization-keys';
import { agentRegister } from './routes/v1/agent-register';
import { agentTopup } from './routes/v1/agent-topup';
import { agentKeys } from './routes/v1/agent-keys';
import { agentPolicy } from './routes/v1/agent-policy';
import { catalogHttpBoundary } from './catalog/http-contract';
import { adminProxy } from './routes/admin/proxyTest';
import { adminCatalog } from './routes/admin/catalog';
import { registerGatewayEgressExecutor } from './egress-executor';
import { resolveModelWithOverride } from './routing/resolver';

import { storedChat, respondStoredChat, unsupportedStoredExecution } from './routes/v1/stored-chat';
import { fixedStoredChatHttpError } from './billing/stored-chat-http-contract';
import { storedEmbeddings } from './routes/v1/stored-embeddings';
import { storedCompletions } from './routes/v1/stored-completions';

// server-node.ts imports this module directly in production, so startup wiring
// must live on this path rather than relying on the package barrel (index.ts).
registerGatewayEgressExecutor();

// F-3 (security review): the PII filter's resolver seam existed but was never
// called anywhere in production, so transborder was decided purely by a
// hand-written slug-prefix regex that was missing kie/fal/replicate/openrouter/
// huggingface/groq. Wire it to the same resolver the router uses so residency
// comes from the actual candidate rows. resolveModelWithOverride (not
// resolveModel) keeps the harness/test override honoured.
setPiiResolveModel(resolveModelWithOverride);

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

applyAiagErrorHandler(app);

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

// ---- /v1/agent: headless agent registration rail ----------------------------
// public by design: registration bootstrap — the caller has no gateway key
// yet; the TON wallet proof IS the authentication. Mounted on the ROOT app
// ahead of both /v1 execution assemblies so their requireApiKey chain cannot
// capture it (endpoint handlers registered earlier terminate the chain).
// Abuse is bounded by the route's own Redis sliding-window guards
// (agentreg:glob / agentreg:addr:*) plus the service-side challenge caps.
app.route('/v1/agent', agentRegister);

// ---- /v1 routes: auth + rate-limit + pii ------------------------------------
// This is intentionally before either assembly's shared guards: catalog has a
// fixed public error envelope while every other v1 route retains its own one.
app.use('/v1/catalog', catalogHttpBoundary);
app.use('/v1/catalog/', catalogHttpBoundary);
// ---- /v1/usage + /v1/organization -----------------------------------------
// Mounted on the ROOT app, ahead of both execution-mode assemblies, because
// their contracts differ and neither fits:
//
//  - The stored-mode assembly copies GET handlers one by one and rewrites
//    their error envelope; the legacy assembly hangs keyLimits (the per-key
//    monthly cost cap) off every /v1/* path. A buyer must still be able to
//    READ its receipts while its spending is blocked, so /v1/usage must not
//    sit behind that cap — hence its own mount with auth + RPM only.
//  - /v1/organization/keys is a POST that mints credentials. In stored mode
//    an unlisted POST falls through to the "unsupported execution" envelope,
//    which would report a 403/400 from the mint guard as a 501 storage
//    outage. Own mount keeps the real status.
//
// Both still authenticate with the same requireApiKey and the same
// fresh gateway_api_keys lookup as every other /v1 route: orgId comes from
// the verified key row, never from the request.
app.use('/v1/usage/*', requireApiKey);
app.use('/v1/usage/*', rateLimit);
app.route('/v1/usage', usage);
app.use('/v1/organization/*', requireApiKey);
app.use('/v1/organization/*', rateLimit);
app.route('/v1/organization', organizationKeys);

// ---- /v1/agent/topup + /v1/agent/invoices: headless agent topup rail -------
// Same root-app mount pattern as /v1/usage and /v1/organization above, so it
// behaves identically in the legacy and stored assemblies (the execution-mode
// sub-apps below mount later and never capture these paths). Registration
// (/v1/agent/challenge|register) stays PUBLIC: it is mounted even earlier and
// its handlers terminate the chain before these middlewares — this sub-app
// carries no handlers for those paths. Auth is the gateway key; orgId comes
// from the fresh key row. The route adds its own coarse mint window
// (agenttop:<key_id> 12/5min) on top of the per-key RPM limiter here.
app.use('/v1/agent/topup', requireApiKey);
app.use('/v1/agent/topup/*', requireApiKey);
app.use('/v1/agent/topup', rateLimit);
app.use('/v1/agent/topup/*', rateLimit);
app.use('/v1/agent/invoices/*', requireApiKey);
app.use('/v1/agent/invoices/*', rateLimit);
app.route('/v1/agent', agentTopup);

// ---- /v1/agent/keys + /v1/agent/revoke: agent key lifecycle (Task 7) ------
// Same root-app mount pattern as /v1/usage, /v1/organization and the topup
// rail above: auth + per-key RPM only (guarded single-row UPDATEs and one
// org-scoped SELECT need nothing heavier). orgId/keyId come from the fresh
// key row. The public registration sub-app mounted earlier carries no
// handlers for these paths, so its bootstrap contract is untouched. Note
// POST /v1/agent/keys/:id/rotate may target the calling key itself — after a
// self-rotate the current bearer is dead by design (see agent-keys.ts).
app.use('/v1/agent/keys', requireApiKey);
app.use('/v1/agent/keys/*', requireApiKey);
app.use('/v1/agent/keys', rateLimit);
app.use('/v1/agent/keys/*', rateLimit);
app.use('/v1/agent/revoke', requireApiKey);
app.use('/v1/agent/revoke', rateLimit);
app.route('/v1/agent', agentKeys);

// ---- /v1/agent/policy: routing policy + opt-in quotas (Task 8) -------------
// Same root-app mount pattern as the key-lifecycle rail above: auth + per-key
// RPM here, plus the route's own coarse 30/min window (agentpolicy:<key_id>)
// because policy reads/writes are single-row work. orgId/keyId come from the
// fresh key row; quota writes run through the 0108 SQL entrypoints, which
// carry the same live-key -> active-principal authorization as 0106/0107.
// Limits are opt-in self-service: an agent that never PUTs a quota field is
// unlimited, and nothing here imposes or tightens a default cap.
app.use('/v1/agent/policy', requireApiKey);
app.use('/v1/agent/policy/*', requireApiKey);
app.use('/v1/agent/policy', rateLimit);
app.use('/v1/agent/policy/*', rateLimit);
app.route('/v1/agent', agentPolicy);

if (config.GATEWAY_HTTP_EXECUTION_MODE !== 'legacy') {
  // Early cache policy includes auth, RPM, unsupported routes and 404 responses.
  app.use('/v1/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  const restricted = new Hono();
  restricted.onError((error, c) => {
    // Existing read handlers/guards retain their public contract, without diagnostic logging.
    if (['GET', 'HEAD'].includes(c.req.method) && error instanceof AiagError)
      return c.json(error.toResponseBody(), error.status as ContentfulStatusCode);
    // Execution paths preserve only known operational envelopes; no arbitrary diagnostics.
    if (error instanceof AiagError && error.code === 'UNAUTHORIZED')
      return c.json(errors.unauthorized().toResponseBody(), 401);
    // 0105 TTL: an expired key must stay a 401 KEY_EXPIRED on execution paths
    // too — falling through to the 503 request-state envelope would tell
    // clients to retry a dead key instead of rotating it.
    if (error instanceof AiagError && error.code === 'KEY_EXPIRED')
      return c.json(errors.unauthorized('API key expired', 'KEY_EXPIRED').toResponseBody(), 401);
    if (error instanceof AiagError && error.code === 'SERVICE_UNAVAILABLE' && error.message === 'Authentication unavailable')
      return c.json(errors.unavailable('Authentication unavailable').toResponseBody(), 503);
    if (error instanceof AiagError && error.code === 'RATE_LIMITED') {
      const retry = Number(c.res.headers.get('Retry-After'));
      return c.json(errors.rateLimited(Number.isSafeInteger(retry) && retry > 0 ? retry : 60).toResponseBody(), 429);
    }
    const mediaExecutionPath = /\/(?:images\/generations|video\/generations|audio\/(?:speech|transcriptions))\/?$/.test(c.req.path);
    if (mediaExecutionPath && error instanceof AiagError && error.code === 'PAYMENT_REQUIRED')
      return c.json(errors.paymentRequired().toResponseBody(), 402);
    if (mediaExecutionPath && error instanceof AiagError && error.code === 'UNSUPPORTED_EXECUTION_CONTRACT')
      return c.json(errors.unsupported('Execution contract unsupported').toResponseBody(), 501);
    if (mediaExecutionPath && error instanceof AiagError && error.code === 'BAD_REQUEST')
      return c.json(errors.badRequest('Invalid media request').toResponseBody(), 400);
    if (error instanceof AiagError && error.code === 'MEDIA_IDEMPOTENCY_CONFLICT')
      return c.json(error.toResponseBody(), 409);
    return respondStoredChat(c, fixedStoredChatHttpError('request_state_unavailable'));
  });
  restricted.use('*', requireApiKey);
  const aliases = (path: string) => [path, `${path}/`];
  restricted.on('POST', aliases('/chat/completions'), rpmOnly, storedChat);
  if (config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings' || config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions' || ['stored_chat_embeddings_completions_stream','stored_chat_embeddings_completions_stream_media','stored_chat_embeddings_completions_stream_media_batches'].includes(config.GATEWAY_HTTP_EXECUTION_MODE))
    restricted.on('POST', aliases('/embeddings'), rpmOnly, storedEmbeddings);
  if (config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions' || ['stored_chat_embeddings_completions_stream','stored_chat_embeddings_completions_stream_media','stored_chat_embeddings_completions_stream_media_batches'].includes(config.GATEWAY_HTTP_EXECUTION_MODE))
    restricted.on('POST', aliases('/completions'), rpmOnly, storedCompletions);
  if (['stored_chat_embeddings_completions_stream_media','stored_chat_embeddings_completions_stream_media_batches'].includes(config.GATEWAY_HTTP_EXECUTION_MODE)) {
    restricted.route('/', storedMedia);
    restricted.route('/', storedTranscription);
  }
  if (config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions_stream_media_batches') {
    for (const route of storedBatches.routes) {
      const path = route.path === '/' ? '/batches' : `/batches${route.path}`;
      if (route.method === 'POST')
        restricted.on('POST', aliases(path), rpmOnly, route.handler);
      else if (route.method === 'GET')
        restricted.on('GET', aliases(path), rateLimit, keyLimits, piiFilter, modelStatusMiddleware(), route.handler);
    }
  }
  const unsupported = [
    ...(config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions' || ['stored_chat_embeddings_completions_stream','stored_chat_embeddings_completions_stream_media','stored_chat_embeddings_completions_stream_media_batches'].includes(config.GATEWAY_HTTP_EXECUTION_MODE) ? [] : ['/completions']),
    ...(config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_only' ? ['/embeddings'] : []),
    ...(['stored_chat_embeddings_completions_stream_media','stored_chat_embeddings_completions_stream_media_batches'].includes(config.GATEWAY_HTTP_EXECUTION_MODE) ? [] : ['/images/generations','/video/generations','/audio/speech','/audio/transcriptions']),
    ...(config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions_stream_media_batches' ? [] : ['/batches'])];
  for (const path of unsupported)
    restricted.on(['POST', 'PUT', 'PATCH', 'DELETE'], aliases(path), unsupportedStoredExecution);
  restricted.on(['PUT', 'PATCH', 'DELETE'], aliases('/chat/completions'), unsupportedStoredExecution);
  if (config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings' || config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions')
    restricted.on(['PUT', 'PATCH', 'DELETE'], aliases('/embeddings'), unsupportedStoredExecution);
  if (config.GATEWAY_HTTP_EXECUTION_MODE === 'stored_chat_embeddings_completions')
    restricted.on(['PUT', 'PATCH', 'DELETE'], aliases('/completions'), unsupportedStoredExecution);

  // Copy only the existing read handlers, with their existing operational guards.
  // Importing the batches module must never mount its POST/queue capability here.
  for (const [prefix, routes] of [['/catalog', catalogRoute], ['/models', modelsRoute], ['/balance', balanceRoute], ['/batches', batches]] as const) {
    for (const route of routes.routes) {
      if (route.method !== 'GET') continue;
      const path = route.path === '/' ? prefix : `${prefix}${route.path}`;
      restricted.on('GET', aliases(path), rateLimit, keyLimits, piiFilter, modelStatusMiddleware(), route.handler);
    }
  }
  app.route('/v1', restricted);
} else {
  app.use('/v1/*', requireApiKey);
  app.use('/v1/*', rateLimit);
  app.use('/v1/*', keyLimits);
  app.use('/v1/*', piiFilter);
  app.use('/v1/*', modelStatusMiddleware());

  app.route('/v1/chat', chat);
  app.route('/v1/completions', completions);
  app.route('/v1/embeddings', embeddings);
  app.route('/v1/catalog', catalogRoute);
  app.route('/v1/catalog/', catalogRoute);
  app.route('/v1/models', modelsRoute);
  app.route('/v1/balance', balanceRoute);
  app.route('/v1/images', images);
  app.route('/v1/video', video);
  app.route('/v1/audio', audio);
  app.route('/v1/batches', batches);
}

// ---- /api/admin: ops diagnostics. Own guard (AIAG_ADMIN_KEY bearer/x-admin-
// key, fail-closed) — deliberately OUTSIDE the /v1 API-key middleware chain.
app.route('/api/admin/proxy', adminProxy);
app.route('/api/admin/catalog', adminCatalog);

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
