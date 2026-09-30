import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/payments/providers', () => ({ getYooKassaClient: vi.fn() }));
import { POST } from '../app/api/subscriptions/webhook/[provider]/route';

describe('Next15 asynchronous route parameters', () => {
  it('preserves the moved Tinkoff webhook response after awaiting provider params', async () => {
    const response = await POST(new NextRequest('http://localhost/api/subscriptions/webhook/tinkoff', { method: 'POST' }),
      { params: Promise.resolve({ provider: 'tinkoff' }) });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'GONE' } });
  });
});
