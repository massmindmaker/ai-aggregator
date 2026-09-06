/**
 * Plan 01 Task 7 — POST /api/auth/register must:
 *   1. Reject when required consents (processing/transborder) are missing.
 *   2. Persist all 3 consent flags + timestamp + IP + UA into the users table.
 *
 * Integration test: verifies the guarded local native Postgres target before
 * importing the route handler, then calls it with a NextRequest. After each
 * successful insert the test row is cleaned up so the test is rerunnable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { loadApiRegisterTestModules } from './api-register-test-loader';

const RUN_DB_INTEGRATION =
  process.env.AIAG_TEST_DATABASE === '1' &&
  process.env.RUN_NATIVE_DB_INTEGRATION === '1';
const d = RUN_DB_INTEGRATION ? describe : describe.skip;

d('POST /api/auth/register — 152-fz consents', () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let db: typeof import('@/lib/db').db;
  let users: typeof import('@aiag/database/schema').users;
  let eq: typeof import('@aiag/database').eq;
  let initialized = false;

  const TEST_EMAIL_1 = `test-consent-missing-${Date.now()}@example.com`;
  const TEST_EMAIL_2 = `test-consent-ok-${Date.now()}@example.com`;

  beforeAll(async () => {
    ({ POST, db, users, eq } = await loadApiRegisterTestModules(process.env));
    initialized = true;
  });

  afterAll(async () => {
    if (!initialized) return;
    await db.delete(users).where(eq(users.email, TEST_EMAIL_2.toLowerCase()));
  });

  function buildReq(body: unknown): NextRequest {
    return new NextRequest('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.42',
        'user-agent': 'vitest-integration/1.0',
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects with 400 when processing consent is missing', async () => {
    const res = await POST(
      buildReq({
        name: 'Test User',
        email: TEST_EMAIL_1,
        password: 'StrongPass1',
        consentProcessing: false,
        consentTransborder: true,
        consentMarketing: false,
      })
    );
    expect(res.status).toBe(400);
  });

  it('persists user with all 3 consent fields + timestamp + IP + UA', async () => {
    const res = await POST(
      buildReq({
        name: 'Consent User',
        email: TEST_EMAIL_2,
        password: 'StrongPass1',
        consentProcessing: true,
        consentTransborder: true,
        consentMarketing: true,
      })
    );
    expect(res.status).toBe(201);

    const row = await db.query.users.findFirst({
      where: eq(users.email, TEST_EMAIL_2.toLowerCase()),
    });
    expect(row).toBeDefined();
    expect(row!.consentProcessing).toBe(true);
    expect(row!.consentTransborder).toBe(true);
    expect(row!.consentMarketing).toBe(true);
    expect(row!.consentTimestamp).toBeInstanceOf(Date);
    expect(row!.consentIpAddress).toBe('203.0.113.42');
    expect(row!.consentUserAgent).toBe('vitest-integration/1.0');
  });
});
