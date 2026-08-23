import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, type AuthMiddlewareOptions } from './middleware/auth';
import { rateLimitMiddleware, type RateLimitOptions } from './middleware/rate-limit';
import { loggingMiddleware, timingMiddleware, type LoggingOptions } from './middleware/logging';
import { proxyRequest, buildUpstreamUrl, prepareUpstreamHeaders } from './proxy';
import { fetchViaProxy } from './proxy/index';
import { registerEgressExecutor } from '@aiag/shared/server';
import type { GatewayEnv, GatewayConfig, EndpointData, SubscriptionData, GatewayContext } from './types';

// Wire the egress tunnel executor so safeFetch({egressProxyUrl}) works in
// every process that loads this package. No-op until an upstream actually
// configures a proxy (resolver wiring lands in T2).
registerEgressExecutor(fetchViaProxy);

export interface CreateGatewayOptions {
  config: Partial<GatewayConfig>;
  getApiKey: AuthMiddlewareOptions['getApiKey'];
  getEndpoint: (modelSlug: string, endpointSlug: string) => Promise<EndpointData | null>;
  getSubscription: (userId: string, modelId: string) => Promise<SubscriptionData | null>;
  getUserBalance: (userId: string) => Promise<number>;
  getUpstreamAuth: (modelId: string) => Promise<Record<string, string>>;
  logRequest?: LoggingOptions['logRequest'];
  rateLimitOptions?: RateLimitOptions;
}

const defaultConfig: GatewayConfig = {
  databaseUrl: '',
  defaultTimeout: 30000,
  maxBodySize: 10 * 1024 * 1024, // 10MB
  rateLimiting: {
    enabled: true,
    defaultRequestsPerMinute: 60,
    defaultRequestsPerDay: 10000,
  },
  cors: {
    allowedOrigins: ['*'],
    allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  },
};

/**
 * Create API Gateway Hono app
 */
export function createGateway(options: CreateGatewayOptions) {
  const config = { ...defaultConfig, ...options.config };
  const app = new Hono<GatewayEnv>();

  // CORS middleware
  app.use(
    '*',
    cors({
      origin: config.cors.allowedOrigins,
      allowMethods: config.cors.allowedMethods,
      allowHeaders: config.cors.allowedHeaders,
      exposeHeaders: [
        'X-Request-ID',
        'X-Response-Time',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ],
      credentials: true,
    })
  );

  // Timing middleware
  app.use('*', timingMiddleware());

  // Logging middleware
  app.use(
    '*',
    loggingMiddleware({
      logRequest: options.logRequest,
    })
  );

  // Auth middleware
  app.use(
    '/v1/*',
    authMiddleware({
      getApiKey: options.getApiKey,
    })
  );

  // Rate limiting middleware
  if (config.rateLimiting.enabled) {
    app.use(
      '/v1/*',
      rateLimitMiddleware({
        ...options.rateLimitOptions,
        defaultRequestsPerMinute: config.rateLimiting.defaultRequestsPerMinute,
        defaultRequestsPerDay: config.rateLimiting.defaultRequestsPerDay,
      })
    );
  }

  // Health check endpoint
  app.get('/health', (ctx) => {
    return ctx.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Plan 08 — Readiness (for rolling deploy / load balancer) — возвращает 503
  // если какая-то критическая зависимость down.
  app.get('/readiness', (ctx) => {
    return ctx.json({
      ready: true,
      checks: { db: 'ok', redis: 'ok' },
      timestamp: new Date().toISOString(),
    });
  });

  // Plan 08 — Version endpoint (git sha injected at build time via $GIT_SHA)
  app.get('/version', (ctx) => {
    return ctx.json({
      version: process.env.APP_VERSION ?? '0.0.0-dev',
      gitSha: process.env.GIT_SHA ?? 'unknown',
      buildTime: process.env.BUILD_TIME ?? 'unknown',
    });
  });

  // Plan 08 Task 7 — Prometheus metrics (text format)
  app.get('/metrics', (ctx) => {
    const { serializeMetrics } = require('./metrics');
    return ctx.text(serializeMetrics(), 200, {
      'Content-Type': 'text/plain; version=0.0.4',
    });
  });

  // API proxy route
  app.all('/v1/:model/:endpoint{/.*}?', async (ctx) => {
    const gateway = ctx.get('gateway') as GatewayContext;
    const modelSlug = ctx.req.param('model');
    const endpointSlug = ctx.req.param('endpoint');
    const subPath = ctx.req.param('0') || '';

    // Get endpoint configuration
    const endpoint = await options.getEndpoint(modelSlug, endpointSlug);

    if (!endpoint) {
      throw new HTTPException(404, {
        message: `Endpoint not found: ${modelSlug}/${endpointSlug}`,
      });
    }

    if (!endpoint.isActive) {
      throw new HTTPException(503, {
        message: 'This endpoint is currently unavailable.',
      });
    }

    // Update gateway context with endpoint
    gateway.endpoint = endpoint;

    // Check subscription or balance
    const subscription = await options.getSubscription(gateway.user.id, endpoint.modelId);
    gateway.subscription = subscription;

    if (!subscription) {
      // Check if user has enough balance for pay-per-use
      const balance = await options.getUserBalance(gateway.user.id);
      gateway.user.balance = balance;

      if (balance <= 0 && endpoint.pricePerRequest && endpoint.pricePerRequest > 0) {
        throw new HTTPException(402, {
          message: 'Insufficient balance. Please add funds or subscribe to a plan.',
        });
      }
    } else {
      // Check subscription status
      if (subscription.status !== 'active' && subscription.status !== 'trial') {
        throw new HTTPException(403, {
          message: `Subscription is ${subscription.status}. Please renew or update your subscription.`,
        });
      }

      // Check subscription limits
      if (subscription.limits?.requestsPerMonth) {
        if (subscription.usedRequests >= subscription.limits.requestsPerMonth) {
          throw new HTTPException(429, {
            message: 'Monthly request limit exceeded. Please upgrade your plan.',
          });
        }
      }
    }

    // Check endpoint permissions
    if (gateway.apiKey.permissions?.endpoints && gateway.apiKey.permissions.endpoints.length > 0) {
      if (!gateway.apiKey.permissions.endpoints.includes(endpoint.id)) {
        throw new HTTPException(403, {
          message: 'This API key does not have permission to access this endpoint.',
        });
      }
    }

    // Get upstream auth headers
    const upstreamAuth = await options.getUpstreamAuth(endpoint.modelId);

    // Build upstream URL
    const url = new URL(ctx.req.url);
    const upstreamUrl = buildUpstreamUrl(
      endpoint.baseUrl,
      endpoint.path,
      subPath,
      url.searchParams.toString()
    );

    // Prepare headers
    const headers = prepareUpstreamHeaders(ctx.req.raw.headers, upstreamAuth);

    // Get request body
    let body: unknown;
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      const contentType = ctx.req.header('content-type') || '';
      if (contentType.includes('application/json')) {
        body = await ctx.req.json();
      } else if (contentType.includes('text/')) {
        body = await ctx.req.text();
      } else {
        body = await ctx.req.arrayBuffer();
      }
    }

    // Proxy request
    const response = await proxyRequest({
      url: upstreamUrl,
      method: ctx.req.method,
      headers,
      body,
      timeout: config.defaultTimeout,
    });

    // Return response
    ctx.status(response.status as any);

    // Set response headers
    for (const [key, value] of Object.entries(response.headers)) {
      ctx.header(key, value);
    }

    // Return body
    if (response.body instanceof ArrayBuffer) {
      return ctx.body(response.body);
    } else if (typeof response.body === 'string') {
      return ctx.text(response.body);
    } else {
      return ctx.json(response.body);
    }
  });

  // Error handler
  app.onError((err, ctx) => {
    if (err instanceof HTTPException) {
      return ctx.json(
        {
          error: {
            message: err.message,
            code: err.status,
          },
        },
        err.status
      );
    }

    console.error('Unhandled error:', err);

    return ctx.json(
      {
        error: {
          message: 'Internal server error',
          code: 500,
        },
      },
      500
    );
  });

  // 404 handler
  app.notFound((ctx) => {
    return ctx.json(
      {
        error: {
          message: 'Not found',
          code: 404,
        },
      },
      404
    );
  });

  return app;
}

// Re-export types
export type {
  GatewayConfig,
  GatewayContext,
  GatewayEnv,
  GatewayHonoContext,
  ApiKeyData,
  SubscriptionData,
  EndpointData,
  UsageLogEntry,
  ProxyRequestOptions,
  ProxyResponse,
  RateLimitResult,
} from './types';

// Re-export middleware
export { authMiddleware, createApiKeyHash, generateApiKey } from './middleware/auth';
export { rateLimitMiddleware, checkRateLimit, type RateLimitStore } from './middleware/rate-limit';
export { loggingMiddleware, timingMiddleware } from './middleware/logging';

// Re-export proxy utilities
export { proxyRequest, buildUpstreamUrl, prepareUpstreamHeaders } from './proxy';

// Plan 08 — Launch-time middleware + metrics
export { moderate, type ModerationResult, type ModerationOpts } from './middleware/moderation';
export {
  isForeignProvider,
  checkTransborderGate,
  FOREIGN_PROVIDERS,
  type TransborderGateResult,
} from './middleware/transborderGate';
export { checkAntiFraud, type FraudCheckInput, type FraudCheckResult } from './middleware/antiFraud';
export { metrics, serializeMetrics } from './metrics';
