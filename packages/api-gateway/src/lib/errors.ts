/**
 * Typed gateway error classes mapped to HTTP responses (per Spec §10).
 */
import type { Hono } from 'hono';
import { logger } from './logger';

/**
 * Standard AiagError→response mapping. Mount on ANY Hono app (server.ts and
 * bare test apps alike) so thrown AiagErrors become proper HTTP responses
 * instead of unhandled 500s.
 */
export function applyAiagErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof AiagError) {
      logger.warn({ err, code: err.code }, 'aiag_error');
      // T10 (agentic rail): an error may carry a retry hint (e.g. the 402
      // insufficient-funds topup hint, 30s). Additive only — no pre-existing
      // AiagError sets retryAfterSeconds, so nothing changes for them.
      if (
        typeof err.retryAfterSeconds === 'number' &&
        Number.isSafeInteger(err.retryAfterSeconds) &&
        err.retryAfterSeconds > 0
      ) {
        c.header('Retry-After', String(err.retryAfterSeconds));
      }
      return c.json(err.toResponseBody(), err.status as any);
    }
    logger.error({ err: String(err) }, 'unhandled');
    return c.json(
      { error: { code: 'INTERNAL', message: 'Internal error' } },
      500
    );
  });
}

export class AiagError extends Error {
  /**
   * Optional Retry-After hint in seconds, rendered as a response header by
   * applyAiagErrorHandler. Set so far only by InsufficientFundsError (T10).
   */
  retryAfterSeconds?: number;

  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AiagError';
  }

  toResponseBody(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const errors = {
  badRequest: (m: string, d?: unknown) => new AiagError('BAD_REQUEST', 400, m, d),
  // Optional second argument keeps the default 401 code ('UNAUTHORIZED') for
  // every pre-existing caller while letting auth distinguish rejection
  // reasons (e.g. 'KEY_EXPIRED') inside the standard {error:{code}} body.
  unauthorized: (m = 'Invalid API key', code = 'UNAUTHORIZED') =>
    new AiagError(code, 401, m),
  paymentRequired: (m = 'Insufficient funds') => new AiagError('PAYMENT_REQUIRED', 402, m),
  forbidden: (m: string) => new AiagError('FORBIDDEN', 403, m),
  notFound: (m: string) => new AiagError('NOT_FOUND', 404, m),
  rateLimited: (retryAfterSec: number, m = 'Rate limit exceeded') =>
    new AiagError('RATE_LIMITED', 429, m, { retryAfterSec }),
  upstreamError: (m: string) => new AiagError('UPSTREAM_ERROR', 502, m),
  unsupported: (m = 'Operation unavailable in this execution mode') =>
    new AiagError('UNSUPPORTED_EXECUTION_CONTRACT', 501, m),
  unavailable: (m: string) => new AiagError('SERVICE_UNAVAILABLE', 503, m),
  overloaded: (m = 'Upstream overloaded') => new AiagError('UPSTREAM_OVERLOADED', 529, m),
};
