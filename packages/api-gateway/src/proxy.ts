import { safeFetch, SsrfError } from '@aiag/shared/server';
import type { ProxyRequestOptions, ProxyResponse } from './types';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Exact hosts the gateway is allowed to proxy to without IP-range checks.
// Everything else must DNS-resolve to a public IP (safeFetch enforces).
const PROXY_ALLOWLIST = ['127.0.0.1:4000', 'openrouter.ai'];

/**
 * Proxy request to upstream API
 */
export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResponse> {
  const { url, method, headers, body, timeout = DEFAULT_TIMEOUT } = options;

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    // Build request options
    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    // Add body for non-GET requests
    if (body && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'string') {
        fetchOptions.body = body;
      } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
        fetchOptions.body = body;
      } else {
        fetchOptions.body = JSON.stringify(body);
      }
    }

    // Make request through the SSRF guard. safeFetch enforces HTTPS-only,
    // DNS-resolves the host and rejects private / link-local / loopback / CGNAT
    // / IPv6-ULA targets, pins the socket to the validated IP (anti-rebind) and
    // re-validates every redirect hop. Trusted internal/openrouter hosts are
    // allowlisted exactly.
    const response = await safeFetch(url, {
      ...fetchOptions,
      allowlist: PROXY_ALLOWLIST,
    });

    // Parse response
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      const hopByHopHeaders = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ];
      if (!hopByHopHeaders.includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    // Read response body
    const contentType = response.headers.get('content-type') || '';
    let responseBody: unknown;

    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else if (contentType.includes('text/')) {
      responseBody = await response.text();
    } else {
      responseBody = await response.arrayBuffer();
    }

    // Calculate response time
    const responseTimeMs = Date.now() - startTime;

    // Try to extract token usage from response (common for LLM APIs)
    let tokensUsed: number | undefined;
    if (responseBody && typeof responseBody === 'object') {
      const body = responseBody as Record<string, unknown>;
      // OpenAI format
      if (body.usage && typeof body.usage === 'object') {
        const usage = body.usage as Record<string, number>;
        tokensUsed = usage.total_tokens || usage.input_tokens + usage.output_tokens;
      }
      // Anthropic format
      if (body.usage && typeof body.usage === 'object') {
        const usage = body.usage as Record<string, number>;
        tokensUsed = usage.input_tokens + usage.output_tokens;
      }
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      responseTimeMs,
      tokensUsed,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;

    if (error instanceof SsrfError) {
      // Blocked target (private/internal IP, non-HTTPS, encoded literal, etc.).
      return {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {},
        body: { error: 'Upstream address is not permitted' },
        responseTimeMs,
      };
    }

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          status: 504,
          statusText: 'Gateway Timeout',
          headers: {},
          body: { error: 'Upstream request timed out' },
          responseTimeMs,
        };
      }

      return {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {},
        body: { error: error.message },
        responseTimeMs,
      };
    }

    return {
      status: 500,
      statusText: 'Internal Server Error',
      headers: {},
      body: { error: 'Unknown error occurred' },
      responseTimeMs,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Build upstream URL from endpoint and request path
 */
export function buildUpstreamUrl(
  baseUrl: string,
  endpointPath: string,
  requestPath: string,
  queryString: string
): string {
  // Remove trailing slash from base URL
  const base = baseUrl.replace(/\/$/, '');

  // Combine paths
  let fullPath = endpointPath;
  if (requestPath && requestPath !== '/') {
    fullPath = `${endpointPath}${requestPath}`.replace(/\/+/g, '/');
  }

  // Build URL
  let url = `${base}${fullPath}`;

  // Add query string
  if (queryString) {
    url += `?${queryString}`;
  }

  return url;
}

/**
 * Filter and transform headers for upstream request
 */
export function prepareUpstreamHeaders(
  incomingHeaders: Headers,
  additionalHeaders?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};

  // Headers to exclude from forwarding
  const excludeHeaders = [
    'host',
    'authorization', // We'll add our own auth
    'x-api-key',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ];

  // Copy allowed headers
  incomingHeaders.forEach((value, key) => {
    if (!excludeHeaders.includes(key.toLowerCase())) {
      result[key] = value;
    }
  });

  // Add additional headers (like auth for upstream API)
  if (additionalHeaders) {
    Object.assign(result, additionalHeaders);
  }

  return result;
}
