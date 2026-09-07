import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  fetch: undefined as ((request: Request) => Promise<Response>) | undefined,
  transport: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({
  serve: vi.fn((options: { fetch: (request: Request) => Promise<Response> }) => {
    harness.fetch = options.fetch;
    return { close: vi.fn() };
  }),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn(
      (
        _hostname: string,
        _options: { all: true },
        callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
      ) => callback(null, [{ address: '203.0.113.10', family: 4 }]),
    ),
  };
});

vi.mock('../proxy/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proxy/index')>();
  return {
    ...actual,
    fetchViaProxy: harness.transport,
  };
});

describe('canonical Node gateway startup egress wiring', () => {
  beforeEach(async () => {
    vi.resetModules();
    harness.fetch = undefined;
    harness.transport.mockReset();
    harness.transport.mockResolvedValue(new Response('provider-ok', { status: 200 }));
    process.env.NODE_ENV = 'test';
    process.env.AIAG_ADMIN_KEY = 'test-admin-key';
    process.env.AIAG_ADMIN_RATE_LIMIT = 'off';

    const { unregisterEgressExecutor } = await import('@aiag/shared/server');
    unregisterEgressExecutor();
  });

  afterEach(async () => {
    const { unregisterEgressExecutor } = await import('@aiag/shared/server');
    unregisterEgressExecutor();
    delete process.env.AIAG_ADMIN_KEY;
    delete process.env.AIAG_ADMIN_RATE_LIMIT;
  });

  it('registers the vetted transport when the real server-node entry is imported', async () => {
    await import('../server-node');
    expect(harness.fetch).toBeTypeOf('function');

    const response = await harness.fetch!(
      new Request(
        'http://gateway.test/api/admin/proxy/test?url=https%3A%2F%2Fprovider.example%2Fv1&proxy=http%3A%2F%2Fproxy.test%3A3128',
        { headers: { authorization: 'Bearer test-admin-key' } },
      ),
    );

    expect(response.status).toBe(200);
    expect(harness.transport).toHaveBeenCalledOnce();
    expect(harness.transport).toHaveBeenCalledWith(
      'https://provider.example/v1',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
      'http://proxy.test:3128',
      { connectAddr: '203.0.113.10' },
    );
  });

  it('rejects a blocked destination before the registered transport', async () => {
    await import('../server-node');

    const response = await harness.fetch!(
      new Request(
        'http://gateway.test/api/admin/proxy/test?url=http%3A%2F%2F169.254.169.254%2Fmeta&proxy=http%3A%2F%2Fproxy.test%3A3128',
        { headers: { authorization: 'Bearer test-admin-key' } },
      ),
    );

    expect(response.status).toBe(400);
    expect(harness.transport).not.toHaveBeenCalled();
  });
});
