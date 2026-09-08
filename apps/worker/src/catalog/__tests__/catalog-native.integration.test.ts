/**
 * WEB-007 native integration: real models.dev payload → transform → real
 * PostgreSQL (guarded local test DB) → model_catalog_drafts.
 *
 * Runs only with RUN_NATIVE_DB_INTEGRATION=1; the guard enforces the dedicated
 * test database (127.0.0.1:15432/ai_aggregator_test, marker-checked), mirroring
 * packages/api-gateway/src/__tests__/quota-executor-bridge.native.integration.test.ts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgTestClient } from '../../../../../packages/database/scripts/pg-test-client';
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from '../../../../../packages/database/scripts/test-db-guard';
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from '../../../../../packages/database/scripts/native-migrate';
import { runCatalogSyncOnce } from '../sync-cron.js';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../tests/fixtures/modelsdev-sample.json',
);

type DbLike = ReturnType<typeof import('@aiag/database')['createDb']>;
let db: DbLike | undefined;

describe.skipIf(!enabled)('WEB-007 models.dev catalog → database (native)', () => {
  let client: TestDatabaseClient;
  // Long-lived assertion client: the guard client closes with its callback.
  let verify: TestDatabaseClient;
  let db: DbLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sql: any;
  let fixturePayload: unknown;
  let fixtureRows: number;
  let fixtureProviders: number;
  let fetchFixture: typeof fetch;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { bootstrapMarker: true, clientFactory: createPgTestClient },
      async (guarded) => {
        client = guarded;
        const migrations = await discoverNativeMigrations();

        // Native migration idempotency on this real DB: second run must skip all.
        const first = await runNativeMigrations(client, migrations);
        expect(first.applied.length + first.skipped.length).toBe(migrations.length);
        const second = await runNativeMigrations(client, migrations);
        expect(second.skipped).toHaveLength(migrations.length);

        const mod = await import('@aiag/database');
        sql = mod.sql;
        db = mod.createDb(process.env.TEST_DATABASE_URL!);

        // Production-driver identity readback against the guarded marker row.
        const identity = await db.execute(
          sql`SELECT current_database() AS name FROM public._aiag_test_database_marker WHERE singleton = TRUE`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = ((identity as any).rows ?? []) as Array<{ name: string }>;
        expect(rows[0]?.name).toBe('ai_aggregator_test');

        // Long-lived client for test-body assertions (same guarded identity).
        verify = await createPgTestClient(process.env.TEST_DATABASE_URL!);
        await verify.connect();

        fixturePayload = JSON.parse(await readFile(FIXTURE, 'utf8')) as unknown;
        const provs = Object.keys(fixturePayload as Record<string, unknown>);
        fixtureProviders = provs.length;
        fixtureRows = provs.reduce(
          (acc, p) =>
            acc +
            Object.keys(
              (fixturePayload as Record<string, { models?: Record<string, unknown> }>)[p]
                .models ?? {},
            ).length,
          0,
        );
        expect(fixtureProviders).toBeGreaterThan(0);
        expect(fixtureRows).toBeGreaterThan(0);

        fetchFixture = (async () =>
          new Response(JSON.stringify(fixturePayload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch;

        await verify.query({ text: 'DELETE FROM model_catalog_drafts', values: [] });
      },
    );
  });

  afterAll(async () => {
    if (!db) return;
    const pool = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    if (pool?.end) await pool.end();
  });

  it('syncs the real fixture end-to-end into model_catalog_drafts', async () => {
    const res = await runCatalogSyncOnce({ db: db as never, sql, fetchImpl: fetchFixture });
    expect(res.providersSeen).toBe(fixtureProviders);
    expect(res.draftsUpserted).toBe(fixtureRows);

    const total = await verify.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM model_catalog_drafts',
      values: [],
    });
    expect(total.rows[0]?.n).toBe(String(fixtureRows));

    const openai = await verify.query<{
      model_slug: string;
      status: string;
      normalized: { context_window: number | null };
    }>({
      text: `SELECT model_slug, status, normalized
             FROM model_catalog_drafts
             WHERE provider_slug = 'openai'`,
      values: [],
    });
    expect(openai.rows).toHaveLength(
      Object.keys(
        (fixturePayload as Record<string, { models: Record<string, unknown> }>).openai.models,
      ).length,
    );
    for (const row of openai.rows) expect(row.status).toBe('draft');
  });

  it('re-running the identical sync is idempotent (no duplicates)', async () => {
    const res2 = await runCatalogSyncOnce({ db: db as never, sql, fetchImpl: fetchFixture });
    expect(res2.draftsUpserted).toBe(fixtureRows);
    const total = await verify.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM model_catalog_drafts',
      values: [],
    });
    expect(total.rows[0]?.n).toBe(String(fixtureRows));
  });

  it('never resets an applied row back to draft (CASE guard on real DB)', async () => {
    const picked = await verify.query<{ model_slug: string }>({
      text: `SELECT model_slug FROM model_catalog_drafts
             WHERE provider_slug = 'openai' ORDER BY model_slug LIMIT 1`,
      values: [],
    });
    const slug = picked.rows[0]!.model_slug;
    await verify.query({
      text: `UPDATE model_catalog_drafts SET status = 'applied'
             WHERE provider_slug = 'openai' AND model_slug = $1`,
      values: [slug],
    });

    await runCatalogSyncOnce({ db: db as never, sql, fetchImpl: fetchFixture });

    const after = await verify.query<{ status: string }>({
      text: `SELECT status FROM model_catalog_drafts
             WHERE provider_slug = 'openai' AND model_slug = $1`,
      values: [slug],
    });
    expect(after.rows[0]?.status).toBe('applied');
  });
});
