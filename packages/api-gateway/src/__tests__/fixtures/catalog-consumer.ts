import {
  CATALOG_MAX_DATA_ITEMS,
  parseCatalogResponseV1,
  type CatalogItemV1,
  type CatalogMode,
  type CatalogResponseV1,
} from '@aiag/shared/catalog-contract';

/**
 * AG-owned read-only catalog consumer fixture. It depends only on the shared
 * catalog contract: no DB, projector, auth, provider or runtime imports. The
 * HTTP transport is injected, pagination inputs are bounded and every failure
 * is folded into one fixed error type without echoing server diagnostics.
 * The returned preflight is advisory only: it never reads pricing amounts and
 * can never be used for price or budget locking.
 */

export type CatalogConsumerFetch = (
  url: string,
  init?: Readonly<{ method?: string; headers?: Record<string, string> }>,
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type CatalogConsumerErrorKind = 'input' | 'network' | 'http' | 'schema' | 'exhausted';

export class CatalogConsumerError extends Error {
  constructor(
    readonly kind: CatalogConsumerErrorKind,
    readonly status: number | null,
    readonly code: string | null,
    readonly retryAfter: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogConsumerError';
  }
}

export interface CatalogConsumerConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: CatalogConsumerFetch;
  readonly pageLimit?: number;
  readonly maxPages?: number;
}

export interface CatalogPreflight {
  readonly revision: string | null;
  readonly revisionVerified: boolean;
  readonly availability: 'empty' | 'all_available' | 'all_unavailable' | 'mixed';
  readonly modes: readonly CatalogMode[];
  readonly invocationPath: string | null;
  readonly settlementUnit: 'microcredit' | null;
}

export interface CatalogConsumeResult {
  readonly items: readonly CatalogItemV1[];
  readonly pages: number;
  readonly preflight: CatalogPreflight;
}

const DEFAULT_PAGE_LIMIT = 20;
const DEFAULT_MAX_PAGES = 5;
const HARD_MAX_PAGES = 10;
const CATALOG_PATH = '/v1/catalog';
const HTTP_CODES: Readonly<Record<number, readonly string[]>> = {
  400: ['INVALID_CATALOG_QUERY', 'INVALID_CATALOG_CURSOR'],
  401: ['UNAUTHORIZED'], 402: ['PAYMENT_REQUIRED'], 404: ['NOT_FOUND'],
  409: ['CATALOG_REVISION_CHANGED'], 429: ['RATE_LIMITED'],
  503: ['SERVICE_UNAVAILABLE', 'KEY_POLICY_UNAVAILABLE', 'CATALOG_UNAVAILABLE'],
};

function validateTransport(config: CatalogConsumerConfig): void {
  let url: URL;
  try { url = new URL(config.baseUrl); }
  catch { throw new CatalogConsumerError('input', null, null, null, 'Invalid catalog base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new CatalogConsumerError('input', null, null, null, 'Invalid catalog base URL');
  if (typeof config.fetch !== 'function' || !config.apiKey || /[\r\n]/.test(config.apiKey))
    throw new CatalogConsumerError('input', null, null, null, 'Invalid catalog transport configuration');
}

function invalidPage(): never {
  throw new CatalogConsumerError('schema', 200, null, null, 'Catalog response failed strict schema validation');
}

function boundedPageLimit(pageLimit: number | undefined): number {
  const value = pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > CATALOG_MAX_DATA_ITEMS)
    throw new CatalogConsumerError('input', null, null, null, 'Catalog page limit is out of bounds');
  return value;
}

function boundedMaxPages(maxPages: number | undefined): number {
  const value = maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_PAGES)
    throw new CatalogConsumerError('input', null, null, null, 'Catalog page budget is out of bounds');
  return value;
}

function catalogPageUrl(baseUrl: string, limit: number, cursor: string | null): string {
  const url = new URL(CATALOG_PATH, baseUrl);
  url.searchParams.set('limit', String(limit));
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  return url.toString();
}

async function fetchPage(
  fetchFn: CatalogConsumerFetch,
  baseUrl: string,
  apiKey: string,
  limit: number,
  cursor: string | null,
): Promise<CatalogResponseV1> {
  let response: Awaited<ReturnType<CatalogConsumerFetch>>;
  try {
    response = await fetchFn(catalogPageUrl(baseUrl, limit, cursor), {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
  } catch {
    throw new CatalogConsumerError('network', null, null, null, 'Catalog request failed');
  }
  if (response.status !== 200) {
    let code: string | null = null;
    try {
      const body: unknown = JSON.parse(await response.text());
      if (
        body !== null && typeof body === 'object' && 'error' in body &&
        (body as { error?: { code?: unknown } }).error !== null &&
        typeof (body as { error: { code?: unknown } }).error === 'object' &&
        typeof (body as { error: { code: unknown } }).error.code === 'string'
      ) code = (body as { error: { code: string } }).error.code;
    } catch {
      // Envelope stays fixed even when the body is unreadable.
    }
    if (code === null || !HTTP_CODES[response.status]?.includes(code)) code = null;
    const rawRetry = response.headers.get('retry-after');
    const retry = [429, 503].includes(response.status) && /^(?:[1-9][0-9]*)$/.test(rawRetry ?? '')
      && Number.isSafeInteger(Number(rawRetry)) ? rawRetry : null;
    throw new CatalogConsumerError(
      'http',
      response.status,
      code,
      retry,
      `Catalog request failed with status ${response.status}`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CatalogConsumerError('network', null, null, null, 'Catalog response was unreadable');
  }
  try {
    return parseCatalogResponseV1(JSON.parse(text));
  } catch {
    throw new CatalogConsumerError('schema', 200, null, null, 'Catalog response failed strict schema validation');
  }
}

function advisoryPreflight(firstPage: Pick<CatalogResponseV1, 'data' | 'catalogRevision'> | null): CatalogPreflight {
  if (firstPage === null)
    return Object.freeze({ revision: null, revisionVerified: false, availability: 'empty' as const, modes: Object.freeze([]) as readonly CatalogMode[], invocationPath: null, settlementUnit: null });
  const states = firstPage.data.map((item) => item.availability.state);
  const modes = Object.freeze([...new Set(firstPage.data.flatMap((item) =>
    item.invocation !== null ? [...item.invocation.parameters.aiag_mode.availableValues] : [],
  ))]);
  const paths = new Set(firstPage.data.map((item) =>
    item.invocation !== null ? item.invocation.path : null,
  ));
  paths.delete(null);
  const units = new Set(firstPage.data.map((item) =>
    item.pricing !== null ? item.pricing.settlementUnit : null,
  ));
  units.delete(null);
  return Object.freeze({
    revision: firstPage.catalogRevision,
    revisionVerified: /^sha256:[0-9a-f]{64}$/.test(firstPage.catalogRevision),
    availability: states.length === 0
      ? 'empty'
      : states.every((state) => state === 'available')
        ? 'all_available'
        : states.every((state) => state === 'unavailable')
          ? 'all_unavailable'
          : 'mixed',
    modes,
    invocationPath: paths.size === 1 ? [...paths][0]! : null,
    settlementUnit: units.size === 1 && units.has('microcredit') ? 'microcredit' : null,
  });
}

/** Reads the whole advertised catalog page-bounded and returns advisory facts only. */
export async function consumePublicCatalog(config: CatalogConsumerConfig): Promise<CatalogConsumeResult> {
  validateTransport(config);
  const fetchFn = config.fetch;
  const pageLimit = boundedPageLimit(config.pageLimit);
  const maxPages = boundedMaxPages(config.maxPages);
  const items: CatalogItemV1[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let cursor: string | null = null;
  let firstPage: CatalogResponseV1 | null = null;
  let pages = 0;
  while (pages < maxPages) {
    const response = await fetchPage(fetchFn, config.baseUrl, config.apiKey, pageLimit, cursor);
    pages++;
    if (response.page.limit !== pageLimit || (firstPage && response.catalogRevision !== firstPage.catalogRevision)) invalidPage();
    firstPage ??= response;
    for (const item of response.data) {
      if (seenIds.has(item.model.id) || seenSlugs.has(item.model.slug)) invalidPage();
      seenIds.add(item.model.id); seenSlugs.add(item.model.slug);
    }
    items.push(...response.data);
    if (response.page.nextCursor === null)
      return Object.freeze({ items: Object.freeze(items), pages, preflight: advisoryPreflight({ catalogRevision: firstPage.catalogRevision, data: items }) });
    cursor = response.page.nextCursor;
  }
  throw new CatalogConsumerError('exhausted', null, null, null, 'Catalog pagination exceeded the bounded page budget');
}
