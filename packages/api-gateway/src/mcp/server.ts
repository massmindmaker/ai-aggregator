/**
 * MCP facade for headless agents (plan 2026-10-09 agentic-rail, Task 11).
 *
 * POST /mcp — a Model Context Protocol Streamable HTTP endpoint INSIDE the
 * gateway process (the host has 6 GB RAM; no separate MCP service). Auth is
 * the same Bearer gateway key as every /v1 route: server.ts mounts
 * requireApiKey (+ rateLimit) ahead of this sub-app, so orgId/keyId come from
 * the fresh gateway_api_keys row and the 0105 KEY_EXPIRED path applies here
 * too, for free, before any MCP code runs.
 *
 * ── Transport: stateless Streamable HTTP ─────────────────────────────────────
 * WebStandardStreamableHTTPServerTransport with `sessionIdGenerator:
 * undefined` + `enableJsonResponse: true`: every POST is self-contained
 * (initialize / tools/list / tools/call), answers as plain JSON-RPC over
 * HTTP (no SSE stream), and a fresh McpServer+transport pair is built per
 * request — the SDK's documented stateless pattern. GET is not required by
 * the facade and answers 405 (notifications-only POSTs still get 202).
 *
 * ── Zero new business logic ──────────────────────────────────────────────────
 * Tools and the `aiag://catalog` resource do not reimplement anything: the
 * service seam below mounts the REAL route handlers (agent-topup, agent-keys,
 * agent-policy, balance, models, chat) on an in-process Hono sub-app and
 * calls them via `app.request()` — an in-memory dispatch, never an HTTP
 * loopback to ourselves. Every route guard (org scoping, topup/policy Redis
 * windows, guarded UPDATEs, audit rows, error envelopes, and — since the
 * review-wave guard-parity fix — the legacy /v1/* execution guards
 * keyLimits/piiFilter/modelStatus) applies to MCP callers exactly as to HTTP
 * callers; only requireApiKey + rateLimit are not re-run inside the dispatch
 * because the outer /mcp mount already executed them on the real request.
 *
 * ── Error mapping ────────────────────────────────────────────────────────────
 * Non-2xx route replies become CallToolResult.isError with the gateway's own
 * {error:{code,message}} envelope 1:1 (see mcp/tools.ts). Protocol-level
 * failures (bad JSON-RPC, unknown method, unsupported protocol version) are
 * JSON-RPC errors produced by the transport/SDK. Auth failures never reach
 * JSON-RPC at all: they are plain HTTP 401 from requireApiKey.
 */
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import { requestIdMiddleware } from '../middleware/request-id';
import { keyLimits } from '../middleware/key-limits';
import { piiFilter } from '../middleware/pii-filter';
import { modelStatusMiddleware } from '../middleware/model-status-check';
import { applyAiagErrorHandler } from '../lib/errors';
import { balance as balanceRoute } from '../routes/v1/balance';
import { models as modelsRoute } from '../routes/v1/models';
import { chat as chatRoute } from '../routes/v1/chat';
import { agentTopup } from '../routes/v1/agent-topup';
import { agentKeys } from '../routes/v1/agent-keys';
import { agentPolicy } from '../routes/v1/agent-policy';
import { readPublicCatalog, PublicCatalogError } from '../catalog/public-catalog';
import { registerAgentTools, type AgentGatewayService, type ServiceReply } from './tools';

/** Facade surface version — mirrored in GET / (`0.4.0-code`). */
const FACADE_VERSION = '0.4.0';

/**
 * Builds the per-request service seam: the existing v1 routes mounted on a
 * private Hono app, pre-authenticated with the calling key. `app.request()`
 * dispatches in-memory (no sockets), so an MCP tool call costs one Hono
 * handler invocation — the same code path as the public HTTP route.
 */
export function createAgentGatewayService(key: AuthenticatedApiKey): AgentGatewayService {
  const app = new Hono();
  // Fresh per-request trace + settlement ids (same middleware the public
  // server runs first): chat settlement keeps its server-minted stl_<uuid>
  // identity, exactly like the HTTP path.
  app.use('*', requestIdMiddleware());
  app.use('*', async (c, next) => {
    c.set('apiKey' as never, key as never);
    c.set('orgId' as never, key.org_id as never);
    await next();
  });
  // Guard parity (review wave, T-a2): the legacy assembly in server.ts mounts
  // keyLimits → piiFilter → modelStatusMiddleware on /v1/* after auth. The
  // sub-app skips requireApiKey + rateLimit — the outer /mcp mount already
  // ran both on the real request, and the in-process dispatch carries no
  // Authorization header to re-authenticate with — but the three execution
  // guards below run here with identical order and semantics, so an MCP
  // caller cannot bypass the key's model_whitelist / monthly cost cap, PII
  // transborder policy or the model freeze/depublish state. They read only
  // the apiKey/orgId context set above.
  app.use('/v1/*', keyLimits);
  app.use('/v1/*', piiFilter);
  app.use('/v1/*', modelStatusMiddleware());
  applyAiagErrorHandler(app);
  // Same assemblies server.ts mounts: the route modules own every guard.
  app.route('/v1/agent', agentTopup);
  app.route('/v1/agent', agentKeys);
  app.route('/v1/agent', agentPolicy);
  app.route('/v1/balance', balanceRoute);
  app.route('/v1/models', modelsRoute);
  app.route('/v1/chat', chatRoute);

  async function dispatch(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<ServiceReply> {
    const res = await app.request(`http://mcp.internal${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const parsed = await res.json().catch(() => ({}));
    return { status: res.status, body: parsed };
  }

  return {
    get: (path) => dispatch('GET', path),
    post: (path, body) => dispatch('POST', path, body ?? {}),
    put: (path, body) => dispatch('PUT', path, body),
    async readCatalogSnapshot() {
      // `aiag://catalog` — the public-catalog snapshot for THIS key (the same
      // readPublicCatalog the /v1/catalog route uses; one page, limit 100).
      try {
        const snapshot = await readPublicCatalog({ key, limit: 100, cursor: null });
        return { status: 200, body: snapshot as unknown };
      } catch (e) {
        // Same availability contract the HTTP catalog renders; no internals.
        const kind = e instanceof PublicCatalogError ? e.kind : 'catalog_unavailable';
        return {
          status: 503,
          body: { error: { code: 'SERVICE_UNAVAILABLE', message: `Catalog unavailable (${kind})` } },
        };
      }
    },
  };
}

/**
 * Handles one (already authenticated) MCP Streamable-HTTP POST. Stateless:
 * a fresh McpServer + transport per request, closed when the response is
 * ready. `enableJsonResponse` keeps replies plain JSON-RPC (no SSE), which
 * is all a tool-driving agent needs and the cheapest thing to proxy.
 */
export async function handleMcpRequest(request: Request, key: AuthenticatedApiKey): Promise<Response> {
  const service = createAgentGatewayService(key);
  const server = new McpServer(
    { name: 'aiag-gateway', version: FACADE_VERSION },
    { capabilities: { logging: {} } },
  );
  registerAgentTools(server, service);
  server.registerResource(
    'catalog',
    'aiag://catalog',
    {
      title: 'AI Aggregator catalog snapshot',
      description:
        'One-page public catalog snapshot (models, availability, invocation contracts, retail pricing) ' +
        'for the calling key. Same data as GET /v1/catalog, limit 100.',
      mimeType: 'application/json',
    },
    async (uri) => {
      // On a snapshot failure the body IS the gateway {error:{code,message}}
      // envelope (see readCatalogSnapshot) — the agent reads the code from the
      // JSON text instead of a success payload.
      const reply = await service.readCatalogSnapshot();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(reply.body),
          },
        ],
      };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } finally {
    // Stateless: the response body is fully materialised in JSON mode, so the
    // per-request instances can be disposed right away.
    await server.close().catch(() => {});
  }
}

/**
 * The Hono sub-app server.ts mounts at /mcp (behind requireApiKey +
 * rateLimit). POST carries the whole Streamable-HTTP contract; other methods
 * are explicitly 405 rather than falling into the generic 404 envelope.
 */
export const mcpFacade = new Hono();

mcpFacade.post('/', async (c) => {
  const key = c.get('apiKey' as never) as AuthenticatedApiKey | undefined;
  if (!key) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }, 401);
  }
  const response = await handleMcpRequest(c.req.raw, key);
  return response;
});

mcpFacade.on(['GET', 'PUT', 'DELETE', 'PATCH'], '/', (c) =>
  c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint accepts POST only' } }, 405),
);
