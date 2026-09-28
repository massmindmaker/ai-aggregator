import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../safe-fetch')>();
  return { ...actual, safeFetch: vi.fn() };
});
import { parseAuthorSubmission } from '../author-manifest';
import { AuthorProbeError, probeAuthorEndpoint } from '../author-probe';
import { safeFetch, SsrfError } from '../safe-fetch';

const manifest = parseAuthorSubmission({
  name: 'Example model', slug: 'example-model',
  description: 'A text model submitted for review.',
  endpointUrl: 'https://author.example.com/v1/chat/completions',
  authToken: 'private-author-token',
}).manifest;
const output = {
  id: 'chat-1', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('author endpoint probe', () => {
  it('sends one bounded text request, forbids redirect and returns only digest evidence', async () => {
    const transport = vi.mocked(safeFetch).mockImplementation(async (_url, options) => {
      if (!options) throw new Error('Probe options missing');
      expect(options.method).toBe('POST');
      expect(options.maxRedirects).toBe(0);
      expect(options.maxBufferedResponseBytes).toBe(64 * 1024);
      expect(options.allowlist).toBeUndefined();
      expect(options.headers).toEqual({
        Authorization: 'Bearer private-author-token', 'Content-Type': 'application/json',
      });
      expect(JSON.parse(options.body as string)).toEqual({
        model: 'example-model', messages: [{ role: 'user', content: 'health probe' }],
        stream: false, max_tokens: 1,
      });
      return new Response(JSON.stringify(output), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const result = await probeAuthorEndpoint(manifest, 'private-author-token', {
      now: () => new Date('2026-09-28T00:00:00Z'),
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.checkedAt).toBe('2026-09-28T00:00:00.000Z');
    expect(result.responseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('private-author-token');
    expect(JSON.stringify(result)).not.toContain('ok');
  });

  it('maps SSRF and redirect policy failures without exposing transport diagnostics', async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new SsrfError('private address'));
    await expect(probeAuthorEndpoint(manifest, 'secret'))
      .rejects.toMatchObject({ code: 'ENDPOINT_BLOCKED' } satisfies Partial<AuthorProbeError>);
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response('', {
      status: 302, headers: { location: 'https://other.example.com' },
    }));
    await expect(probeAuthorEndpoint(manifest, 'secret'))
      .rejects.toMatchObject({ code: 'INVALID_PROBE_RESPONSE' } satisfies Partial<AuthorProbeError>);
  });

  it('rejects malformed or oversized success response', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response('{', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await expect(probeAuthorEndpoint(manifest, 'secret'))
      .rejects.toMatchObject({ code: 'INVALID_PROBE_RESPONSE' } satisfies Partial<AuthorProbeError>);
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response('x'.repeat(65 * 1024), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await expect(probeAuthorEndpoint(manifest, 'secret'))
      .rejects.toMatchObject({ code: 'INVALID_PROBE_RESPONSE' } satisfies Partial<AuthorProbeError>);
  });

  it('times out a stalled transport without another request', async () => {
    vi.useFakeTimers();
    const transport = vi.mocked(safeFetch).mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = probeAuthorEndpoint(manifest, 'secret');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ENDPOINT_UNAVAILABLE',
    } satisfies Partial<AuthorProbeError>);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled response body after headers', async () => {
    vi.useFakeTimers();
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response(
      new ReadableStream<Uint8Array>({ start() { /* body never completes */ } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const pending = probeAuthorEndpoint(manifest, 'secret');
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'ENDPOINT_UNAVAILABLE',
    } satisfies Partial<AuthorProbeError>);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });
});
