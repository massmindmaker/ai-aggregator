import { decodeCatalogCursor, type CatalogCursorV1 } from '@aiag/shared/catalog-contract';
import type { Context, MiddlewareHandler } from 'hono';
import { AiagError } from '../lib/errors';

export type CatalogHttpError = Readonly<{
  status: 400 | 409 | 503;
  code: 'INVALID_CATALOG_QUERY' | 'INVALID_CATALOG_CURSOR' | 'CATALOG_REVISION_CHANGED' | 'KEY_POLICY_UNAVAILABLE' | 'CATALOG_UNAVAILABLE';
  message: string;
}>;

export type CatalogHttpRequest = Readonly<{ limit: number; cursor: CatalogCursorV1 | null }>;

const descriptor = {
  invalidQuery: { status: 400, code: 'INVALID_CATALOG_QUERY', message: 'Invalid catalog query' },
  invalidCursor: { status: 400, code: 'INVALID_CATALOG_CURSOR', message: 'Invalid catalog cursor' },
  revisionChanged: { status: 409, code: 'CATALOG_REVISION_CHANGED', message: 'Catalog changed; restart pagination' },
  keyPolicyUnavailable: { status: 503, code: 'KEY_POLICY_UNAVAILABLE', message: 'Key policy unavailable' },
  catalogUnavailable: { status: 503, code: 'CATALOG_UNAVAILABLE', message: 'Catalog unavailable' },
} as const satisfies Record<string, CatalogHttpError>;

export const catalogHttpErrors = Object.freeze(descriptor);

const catalogErrorKey = 'catalogHttpError';

function catalogError(c: Context, error: CatalogHttpError): Response {
  c.set(catalogErrorKey as never, error as never);
  if (error.status === 503) c.header('Retry-After', '2');
  return c.json({ error: { code: error.code, message: error.message } }, error.status);
}

/** Captures the only two query parameters without retaining arbitrary request text. */
export function captureCatalogHttpRequest(url: string): CatalogHttpRequest | CatalogHttpError {
  const query = new URL(url).searchParams;
  const names = new Set<string>();
  for (const [name] of query) {
    if ((name !== 'limit' && name !== 'cursor') || names.has(name))
      return catalogHttpErrors.invalidQuery;
    names.add(name);
  }
  const rawLimit = query.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
    return catalogHttpErrors.invalidQuery;
  const rawCursor = query.get('cursor');
  if (rawCursor === '') return catalogHttpErrors.invalidCursor;
  if (rawCursor === null) return Object.freeze({ limit: rawLimit === null ? 20 : Number(rawLimit), cursor: null });
  try {
    return Object.freeze({ limit: rawLimit === null ? 20 : Number(rawLimit), cursor: decodeCatalogCursor(rawCursor) });
  } catch {
    return catalogHttpErrors.invalidCursor;
  }
}

export function respondCatalogHttpError(c: Context, error: CatalogHttpError): Response {
  return catalogError(c, error);
}

function boundaryError(c: Context, status: number): void {
  const retry = c.res.headers.get('Retry-After');
  const retryAfter = /^(?:[1-9][0-9]*)$/.test(retry ?? '') && Number.isSafeInteger(Number(retry))
    ? retry!
    : '60';
  const body = status === 401 ? { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }
    : status === 402 ? { error: { code: 'PAYMENT_REQUIRED', message: 'Payment required' } }
    : status === 404 ? { error: { code: 'NOT_FOUND', message: 'Route not found' } }
    : status === 429 ? { error: { code: 'RATE_LIMITED', message: 'Rate limited' } }
    : { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } };
  const headers = new Headers(c.res.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Type', 'application/json');
  if (status === 429) headers.set('Retry-After', retryAfter);
  else if (status >= 500) headers.set('Retry-After', '2');
  c.res = new Response(JSON.stringify(body), { status: [401, 402, 404, 429].includes(status) ? status : 503, headers });
}

function knownGuardStatus(error: unknown): number {
  if (error instanceof AiagError && [401, 402, 429, 503].includes(error.status)) return error.status;
  return 503;
}

/**
 * Applies only to the two exact catalog paths. It deliberately builds every
 * envelope from fixed descriptors, never from a guard response or exception.
 */
export const catalogHttpBoundary: MiddlewareHandler = async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  try {
    await next();
  } catch (error) {
    boundaryError(c, knownGuardStatus(error));
    return;
  }
  const own = c.get(catalogErrorKey as never) as CatalogHttpError | undefined;
  if (own) return catalogError(c, own);
  if (c.res.status >= 400) boundaryError(c, c.res.status);
  return;
};
