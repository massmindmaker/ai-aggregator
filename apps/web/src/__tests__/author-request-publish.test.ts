import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocked = vi.hoisted(() => ({
  auth: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocked.auth }));
vi.mock('@/lib/db', () => ({
  db: { transaction: mocked.transaction },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?'), values,
  }),
}));

import { POST } from '../app/api/models/request-publish/route';

const authorId = '00000000-0000-4000-8000-000000000001';
const modelId = '00000000-0000-4000-8000-000000000002';
const versionId = '00000000-0000-4000-8000-000000000003';
const valid = {
  name: 'Example model',
  slug: 'example-model',
  description: 'A text model submitted for review.',
  endpointUrl: 'https://author.example.com/v1/chat/completions',
  authToken: 'private-author-token',
  authHeader: 'Authorization',
  hostedBy: 'author',
};
function request(body: unknown) {
  return new NextRequest('http://localhost/api/models/request-publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.auth.mockResolvedValue({ user: { id: authorId, email: 'author@example.test' } });
  mocked.execute
    .mockResolvedValueOnce({ rows: [{ id: modelId, slug: valid.slug }] })
    .mockResolvedValueOnce({ rows: [{ id: versionId }] })
    .mockResolvedValueOnce({ rows: [] });
  mocked.transaction.mockImplementation(async (run) => run({ execute: mocked.execute }));
  vi.stubEnv('AUTHOR_ENDPOINT_KEK', Buffer.alloc(32, 1).toString('base64'));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('author candidate submission HTTP boundary', () => {
  it('rejects missing server identity before reading or writing a secret', async () => {
    mocked.auth.mockResolvedValueOnce(null);
    expect((await POST(request(valid))).status).toBe(401);
    expect(mocked.transaction).not.toHaveBeenCalled();
  });

  it('rejects unsafe endpoint and missing encryption key before DB transaction', async () => {
    expect((await POST(request({ ...valid, endpointUrl: 'https://127.0.0.1/v1/chat/completions' }))).status).toBe(400);
    expect(mocked.transaction).not.toHaveBeenCalled();
    vi.stubEnv('AUTHOR_ENDPOINT_KEK', '');
    expect((await POST(request(valid))).status).toBe(503);
    expect(mocked.transaction).not.toHaveBeenCalled();
  });

  it('rejects a disguised JSON content type before storing anything', async () => {
    const request = new NextRequest('http://localhost/api/models/request-publish', {
      method: 'POST', headers: { 'content-type': 'application/jsonish' },
      body: JSON.stringify(valid),
    });
    expect((await POST(request)).status).toBe(400);
    expect(mocked.transaction).not.toHaveBeenCalled();
  });

  it('writes draft model, immutable version and audit in one transaction without plaintext token or client tier', async () => {
    const response = await POST(request({ ...valid, pricingHintPerRequestRub: 99 }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({
      id: modelId, slug: valid.slug, versionId, status: 'draft',
    });
    expect(result.data.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.data).not.toHaveProperty('tierPct');
    expect(mocked.transaction).toHaveBeenCalledTimes(1);
    expect(mocked.execute).toHaveBeenCalledTimes(3);
    const queries = mocked.execute.mock.calls.map(([query]) => query as {
      text: string; values: unknown[];
    });
    expect(queries[0]?.text).toContain('INSERT INTO models');
    expect(queries[1]?.text).toContain('INSERT INTO author_model_versions');
    expect(queries[2]?.text).toContain('INSERT INTO audit_log');
    expect(queries[0]?.values).toContain(authorId);
    expect(JSON.stringify(queries)).not.toContain(valid.authToken);
    expect(JSON.stringify(queries)).not.toContain('tier_pct');
    expect(queries[0]?.values).not.toContain(99);
  });

  it('returns a stable conflict for concurrent duplicate slug', async () => {
    mocked.transaction.mockRejectedValueOnce({ code: '23505' });
    const response = await POST(request(valid));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'SLUG_ALREADY_EXISTS' } });
  });
});
