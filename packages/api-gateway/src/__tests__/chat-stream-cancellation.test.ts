import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { resumeAfterFirst } from '../routes/v1/chat';
import { streamSseAndSettle } from '../streaming/sse';

const { settleCharge, incrementSpendCounters, logRequest } = vi.hoisted(() => ({
  settleCharge: vi.fn().mockResolvedValue(undefined),
  incrementSpendCounters: vi.fn().mockResolvedValue(undefined),
  logRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../billing/settle', () => ({
  assertPositiveBalance: vi.fn(),
  settleCharge,
}));
vi.mock('../billing/spend-counters', () => ({ incrementSpendCounters }));
vi.mock('../logging/stream', () => ({ logRequest }));

function controlledIterator(next: AsyncIterator<string>['next']) {
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  return { iterator: { next, return: close }, close };
}

describe('resumeAfterFirst iterator protocol', () => {
  it('closes the upstream when cancelled immediately after the prefetched chunk', async () => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const { iterator, close } = controlledIterator(next);
    const resumed = resumeAfterFirst(iterator, { done: false, value: 'first' })[
      Symbol.asyncIterator
    ]();

    await expect(resumed.next()).resolves.toEqual({ done: false, value: 'first' });
    expect(next).not.toHaveBeenCalled();
    await resumed.return?.();
    await resumed.return?.();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the upstream once when cancelled after a later chunk', async () => {
    const next = vi.fn(async () => ({ done: false as const, value: 'second' }));
    const { iterator, close } = controlledIterator(next);
    const resumed = resumeAfterFirst(iterator, { done: false, value: 'first' })[
      Symbol.asyncIterator
    ]();

    await resumed.next();
    await expect(resumed.next()).resolves.toEqual({ done: false, value: 'second' });
    await resumed.return?.();

    expect(next).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not close the upstream again after natural completion', async () => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const { iterator, close } = controlledIterator(next);
    const resumed = resumeAfterFirst(iterator, { done: false, value: 'first' })[
      Symbol.asyncIterator
    ]();

    await resumed.next();
    await expect(resumed.next()).resolves.toEqual({ done: true, value: undefined });

    expect(close).not.toHaveBeenCalled();
  });

  it('closes the upstream once when reading a later chunk fails', async () => {
    const next = vi.fn(async () => {
      throw new Error('upstream stream failed');
    });
    const { iterator, close } = controlledIterator(next);
    const resumed = resumeAfterFirst(iterator, { done: false, value: 'first' })[
      Symbol.asyncIterator
    ]();

    await resumed.next();
    await expect(resumed.next()).rejects.toThrow('upstream stream failed');

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('resumeAfterFirst with streamSseAndSettle', () => {
  it('closes the upstream and settles once when the client aborts after the first chunk', async () => {
    settleCharge.mockClear();
    incrementSpendCounters.mockClear();
    logRequest.mockClear();

    let releaseNext!: (result: IteratorResult<string>) => void;
    const next = vi.fn(
      () => new Promise<IteratorResult<string>>((resolve) => {
        releaseNext = resolve;
      }),
    );
    const { iterator, close } = controlledIterator(next);
    const controller = new AbortController();
    const app = new Hono();
    app.get('/', (c) =>
      streamSseAndSettle(
        c,
        resumeAfterFirst(iterator, {
          done: false,
          value: JSON.stringify({ choices: [{ delta: { content: 'first' } }] }),
        }),
        {
          upstream: {
            id: 'upstream-1',
            upstream_id: 'upstream-1',
            upstream_model_id: 'model-1',
            provider: 'test',
            markup: 1,
            price_per_1k_input: 1,
            price_per_1k_output: 1,
            latency_p50_ms: 1,
            uptime: 1,
            ru_residency: false,
          },
          model: { slug: 'test/model', type: 'chat' },
          key: {
            id: 'key-1',
            org_id: 'org-1',
            policies: {},
            daily_usd_cap: null,
            cost_limit_monthly_rub: null,
          },
          requestId: 'request-1',
          settlementRequestId:
            'stl_11111111-2222-4333-8444-555555555555',
          byok: false,
        },
      ),
    );

    const response = await app.fetch(
      new Request('http://test/', { signal: controller.signal }),
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('first');

    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseNext({ done: false, value: JSON.stringify({ choices: [] }) });
    while (!(await reader.read()).done) {
      // Drain the local response so the stream callback and settlement finish.
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(settleCharge).toHaveBeenCalledTimes(1);
    expect(incrementSpendCounters).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledTimes(1);
  });
});
