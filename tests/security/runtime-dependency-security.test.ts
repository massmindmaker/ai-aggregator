import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getToken } from 'next-auth/jwt';

function installed(name: string): string {
  return JSON.parse(readFileSync(resolve('node_modules', name, 'package.json'), 'utf8')).version;
}

describe('patched dependency security contracts', () => {
  it('keeps maintained Next/Auth/ORM/test-runner releases installed', () => {
    expect(installed('next')).toMatch(/^15\.5\.(?:2[6-9]|[3-9]\d|\d{3,})$/);
    expect(installed('next-auth')).toBe('5.0.0-beta.32');
    expect(installed('drizzle-orm')).toBe('0.45.3');
    expect(installed('vitest')).toBe('4.1.11');
  });
  it('escapes quotes within dynamic SQL identifiers', () => {
    const query = new PgDialect().sqlToQuery(sql`select ${sql.identifier('model"name')}`);
    expect(query.sql).toBe('select "model""name"');
    expect(query.params).toEqual([]);
  });
  it('treats malformed Bearer encoding as unauthenticated rather than throwing', async () => {
    const req = new Request('https://app.example.test/', { headers: { authorization: 'Bearer %' } });
    await expect(getToken({ req, secret: 'synthetic-test-secret', salt: 'authjs.session-token' })).resolves.toBeNull();
  });
});
