import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/payments/providers', () => ({ getYooKassaClient: vi.fn() }));
import { POST } from '../app/api/subscriptions/webhook/[provider]/route';
import LeaderboardPage from '../app/(marketing)/contests/[slug]/leaderboard/page';

function hrefs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(hrefs);
  if (!isValidElement(node)) return [];
  const props = node.props as { href?: unknown; children?: unknown };
  return [...(typeof props.href === 'string' ? [props.href] : []), ...hrefs(props.children)];
}
describe('Next15 asynchronous route parameters', () => {
  it('preserves the moved Tinkoff webhook response after awaiting provider params', async () => {
    const response = await POST(new NextRequest('http://localhost/api/subscriptions/webhook/tinkoff', { method: 'POST' }),
      { params: Promise.resolve({ provider: 'tinkoff' }) });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'GONE' } });
  });
  it('uses the resolved slug in existing navigation rather than undefined', async () => {
    const tree = await LeaderboardPage({ params: Promise.resolve({ slug: 'review-fixture' }) });
    expect(hrefs(tree)).toContain('/contests/review-fixture');
    expect(hrefs(tree).some((href) => href.includes('undefined'))).toBe(false);
  });
});
