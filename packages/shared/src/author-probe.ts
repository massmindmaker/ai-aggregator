import { createHash } from 'node:crypto';
import { safeFetch, SsrfError } from './safe-fetch';
import type { AuthorManifestV1 } from './author-manifest';

const MAX_RESPONSE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export class AuthorProbeError extends Error {
  constructor(readonly code: 'ENDPOINT_BLOCKED' | 'ENDPOINT_UNAVAILABLE' | 'INVALID_PROBE_RESPONSE') {
    super(code);
    this.name = 'AuthorProbeError';
  }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new AuthorProbeError('INVALID_PROBE_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  let rejectAbort: (error: AuthorProbeError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new AuthorProbeError('ENDPOINT_UNAVAILABLE'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) { completed = true; break; }
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AuthorProbeError('INVALID_PROBE_RESPONSE');
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (completed) reader.releaseLock();
    else void reader.cancel().catch(() => undefined).finally(() => {
      try { reader.releaseLock(); } catch { /* pending read settles after cancel */ }
    });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AuthorProbeError('INVALID_PROBE_RESPONSE'); }
}

/**
 * Probe validates a candidate endpoint. No raw output or token is persisted.
 * maxRedirects=0 prevents the Bearer token from reaching another origin.
 */
export async function probeAuthorEndpoint(
  manifest: AuthorManifestV1,
  authToken: string,
  options: { now?: () => Date } = {},
): Promise<{ checkedAt: string; responseDigest: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const body = JSON.stringify({
    model: manifest.model.slug,
    messages: [{ role: 'user', content: 'health probe' }],
    stream: false,
    max_tokens: 1,
  });
  let response: Response;
  try {
    response = await safeFetch(manifest.endpoint.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
      maxRedirects: 0,
      maxBufferedResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new AuthorProbeError(error instanceof SsrfError ? 'ENDPOINT_BLOCKED' : 'ENDPOINT_UNAVAILABLE');
  }
  try {
    if (response.status !== 200 ||
        response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      throw new AuthorProbeError('INVALID_PROBE_RESPONSE');
    }
    const raw = await boundedBody(response, controller.signal);
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new AuthorProbeError('INVALID_PROBE_RESPONSE'); }
    const result = value as {
      object?: unknown;
      choices?: Array<{ index?: unknown; message?: { role?: unknown; content?: unknown } }>;
    };
    if (!result || result.object !== 'chat.completion' || !Array.isArray(result.choices) ||
        result.choices.length !== 1 || result.choices[0]?.index !== 0 ||
        result.choices[0]?.message?.role !== 'assistant' ||
        typeof result.choices[0]?.message?.content !== 'string') {
      throw new AuthorProbeError('INVALID_PROBE_RESPONSE');
    }
    return {
      checkedAt: (options.now ?? (() => new Date()))().toISOString(),
      responseDigest: 'sha256:' + createHash('sha256').update(raw, 'utf8').digest('hex'),
    };
  } catch (error) {
    if (error instanceof AuthorProbeError) throw error;
    throw new AuthorProbeError('ENDPOINT_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
