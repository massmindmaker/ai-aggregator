import { describe, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/playground/run/route';

// These tests exercise body validation (model/prompt/streaming), not the IP
// rate-limit gate added in guard.ts/rate-limit.ts (covered by
// playground-guard.test.ts). Without a real Redis (none in this test env,
// no REDIS_URL) `consumePlaygroundHit` fails closed and every request would
// 429 before reaching the validation this file is meant to test — so the
// Redis-backed hit counter is mocked to always allow, same as an IP that is
// within quota.
vi.mock('@/app/api/playground/run/rate-limit', () => ({
  consumePlaygroundHit: vi.fn(async () => ({ allowed: true })),
  refundPlaygroundHit: vi.fn(async () => {}),
}));

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/playground/run', {
    method: 'POST',
    // x-real-ip: without it every request hits the fail-closed IP gate
    // (guard.ts) and 403s before model/prompt validation ever runs.
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.1' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

describe('POST /api/playground/run', () => {
  it('rejects request without model', async () => {
    const res = await POST(makeRequest({ prompt: 'hi' }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('model_required');
  });

  it('rejects request without prompt', async () => {
    const res = await POST(makeRequest({ model: 'openai/gpt-4-turbo' }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('prompt_required');
  });

  it('returns 404 for unknown model', async () => {
    const res = await POST(
      makeRequest({ model: 'fake/nope', prompt: 'hi' }),
    );
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe('model_not_found');
  });

  it('streams SSE events with delta chunks for known model', async () => {
    const res = await POST(
      makeRequest({ model: 'openai/gpt-4-turbo', prompt: 'Привет' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toMatch(/"delta"/);
    expect(text).toMatch(/"done":true/);
  }, 10000);
});
