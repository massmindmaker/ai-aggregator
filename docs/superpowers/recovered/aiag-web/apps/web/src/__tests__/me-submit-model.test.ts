/**
 * Tests for /api/me/submit-model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const INSERTED: unknown[] = [];
vi.mock('@/lib/db', () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => ({
        returning: () => {
          INSERTED.push(v);
          return Promise.resolve([
            {
              id: `s_${INSERTED.length}`,
              slug: (v as { slug?: string }).slug || 'x',
              status: 'pending',
              createdAt: new Date(),
            },
          ]);
        },
      }),
    }),
  },
}));

vi.mock('@aiag/database/schema', () => ({
  modelSubmissions: {
    id: 'id',
    slug: 'slug',
    status: 'status',
    createdAt: 'createdAt',
  },
}));

import { auth } from '@/auth';
import { POST } from '@/app/api/me/submit-model/route';

const mockedAuth = auth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedAuth.mockReset();
  INSERTED.length = 0;
});

function jreq(body: unknown) {
  return new Request('http://localhost/api/me/submit-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

const validBody = {
  name: 'My Model 7B',
  slug: 'my-model-7b',
  modality: 'chat',
  description: 'A long enough description for validation purposes.',
  outboundKind: 'cloud-api',
  upstreamUrl: 'https://api.example.com/v1',
};

describe('POST /api/me/submit-model', () => {
  it('rejects unauthenticated', async () => {
    mockedAuth.mockResolvedValue(null);
    const res = await POST(jreq(validBody));
    expect(res.status).toBe(401);
  });

  it('rejects bad slug', async () => {
    mockedAuth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST(jreq({ ...validBody, slug: 'NOT good!' }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('validation_failed');
  });

  it('rejects too-short description', async () => {
    mockedAuth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST(jreq({ ...validBody, description: 'too short' }));
    expect(res.status).toBe(400);
  });

  it('requires upstreamUrl when outboundKind=cloud-api', async () => {
    mockedAuth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST(
      jreq({ ...validBody, upstreamUrl: undefined }),
    );
    expect(res.status).toBe(400);
  });

  it('accepts valid payload and returns 201', async () => {
    mockedAuth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST(jreq(validBody));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.submission.status).toBe('pending');
    expect(INSERTED).toHaveLength(1);
  });
});
