import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pg: vi.fn(() => ({ driver: 'pg' })), http: vi.fn(() => ({ driver: 'http' })), pool: vi.fn(), neon: vi.fn() }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: mocks.pg }));
vi.mock('drizzle-orm/neon-http', () => ({ drizzle: mocks.http }));
vi.mock('@neondatabase/serverless', () => ({ neon: mocks.neon }));
vi.mock('pg', () => ({ Pool: class { constructor(options: unknown) { mocks.pool(options); } } }));
import { createDb, createEdgeDb } from '../index';
beforeEach(() => vi.clearAllMocks());
describe('transaction-capable service database boundary', () => {
  it.each(['postgresql://user:secret@project.neon.tech/app?sslmode=verify-full', 'postgresql://user:secret@db.vercel-storage.com/app'])('uses real transaction-capable PG driver for %s', (url) => {
    expect(createDb(url)).toMatchObject({ driver: 'pg' });
    expect(mocks.pool).toHaveBeenCalledWith({ connectionString: url });
    expect(mocks.http).not.toHaveBeenCalled();
  });
  it('does not interpret provider text inside credentials as a driver selector', () => {
    const url = 'postgresql://user:neon.tech@127.0.0.1:15432/ai_aggregator_test';
    expect(createDb(url)).toMatchObject({ driver: 'pg' });
    expect(mocks.pool).toHaveBeenCalledWith({ connectionString: url, ssl: false });
  });
  it('retains the explicitly selected HTTP edge client separately', () => {
    expect(createEdgeDb('postgresql://user:secret@project.neon.tech/app')).toMatchObject({ driver: 'http' });
    expect(mocks.pool).not.toHaveBeenCalled();
  });
});
