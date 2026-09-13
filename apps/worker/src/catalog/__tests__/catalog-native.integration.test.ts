/**
 * WEB-007 native integration: fixture-backed catalog → real guarded PostgreSQL
 * → suite-owned model_catalog_drafts rows.
 *
 * This test never starts the cron or contacts models.dev. The checked-in
 * fixture is cloned in memory with a run UUID, so only the clone keys may be
 * created, read, updated, or deleted in the shared guarded test database.
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

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../tests/fixtures/modelsdev-sample.json',
);

type CatalogPayload = Record<string, { models: Record<string, unknown> }>;
type CatalogSync = typeof import('../sync-cron.js')['runCatalogSyncOnce'];
type CatalogSyncDeps = Parameters<CatalogSync>[0];
type DbLike = ReturnType<typeof import('@aiag/database')['createDb']>;
type ClosablePool = { end(): Promise<void> };
type OwnedPair = { providerSlug: string; modelSlug: string; raw: unknown };

function cloneFixtureWithOwnedKeys(payload: CatalogPayload, runId: string) {
  const cloned: CatalogPayload = {};
  const pairs: OwnedPair[] = [];

  for (const [providerSlug, provider] of Object.entries(payload)) {
    const ownedProviderSlug = `${providerSlug}__${runId}`;
    if (ownedProviderSlug.length > 64) throw new Error('owned provider slug exceeds column limit');

    const models: Record<string, unknown> = {};
    for (const [modelSlug, raw] of Object.entries(provider.models)) {
      const ownedModelSlug = `${modelSlug}__${runId}`;
      if (ownedModelSlug.length > 256) throw new Error('owned model slug exceeds column limit');
      models[ownedModelSlug] = raw;
      pairs.push({ providerSlug: ownedProviderSlug, modelSlug: ownedModelSlug, raw });
    }
    cloned[ownedProviderSlug] = { ...provider, models };
  }

  return { cloned, pairs };
}

describe.skipIf(!enabled)('WEB-007 fixture catalog → database (native)', () => {
  const runId = crypto.randomUUID();
  const foreignProviderSlug = `foreign-sentinel__${runId}`;
  const foreignModelSlug = `foreign-model__${runId}`;
  const foreignRaw = { owner: 'foreign-sentinel', runId };
  const foreignNormalized = {
    price_usd_per_1m_input: null,
    price_usd_per_1m_output: null,
    context_window: null,
    input_modalities: [],
    output_modalities: [],
  };

  let verify: TestDatabaseClient | undefined;
  let pool: ClosablePool | undefined;
  let sync: CatalogSync | undefined;
  let deps: CatalogSyncDeps | undefined;
  let fetchFixture: typeof fetch;
  let pairs: OwnedPair[] = [];
  let providerSlugs: string[] = [];

  async function closeOwnedResources() {
    const errors: unknown[] = [];
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      } finally {
        pool = undefined;
      }
    }
    if (verify) {
      try {
        await verify.end();
      } catch (error) {
        errors.push(error);
      } finally {
        verify = undefined;
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'catalog native resource close failed');
  }

  async function deleteOwnedRows() {
    if (!verify || pairs.length === 0) return;
    await verify.query({
      text: `DELETE FROM model_catalog_drafts AS draft
             WHERE EXISTS (
               SELECT 1
               FROM unnest($1::text[], $2::text[]) AS owned(provider_slug, model_slug)
               WHERE draft.provider_slug = owned.provider_slug
                 AND draft.model_slug = owned.model_slug
             )`,
      values: [
        pairs.map((pair) => pair.providerSlug),
        pairs.map((pair) => pair.modelSlug),
      ],
    });
    await verify.query({
      text: 'DELETE FROM model_catalog_drafts WHERE provider_slug = $1 AND model_slug = $2',
      values: [foreignProviderSlug, foreignModelSlug],
    });
  }

  async function assertOwnedRowsRemoved() {
    if (!verify || pairs.length === 0) return;
    const owned = await verify.query<{ n: string }>({
      text: `SELECT count(*)::text AS n FROM model_catalog_drafts AS draft
             WHERE EXISTS (
               SELECT 1
               FROM unnest($1::text[], $2::text[]) AS owned(provider_slug, model_slug)
               WHERE draft.provider_slug = owned.provider_slug
                 AND draft.model_slug = owned.model_slug
             )`,
      values: [
        pairs.map((pair) => pair.providerSlug),
        pairs.map((pair) => pair.modelSlug),
      ],
    });
    expect(owned.rows[0]?.n).toBe('0');

    const foreign = await verify.query<{ n: string }>({
      text: `SELECT count(*)::text AS n FROM model_catalog_drafts
             WHERE provider_slug = $1 AND model_slug = $2`,
      values: [foreignProviderSlug, foreignModelSlug],
    });
    expect(foreign.rows[0]?.n).toBe('0');
  }

  beforeAll(async () => {
    try {
      await withGuardedTestDatabase(
        process.env,
        { clientFactory: createPgTestClient },
        async (guarded) => {
          // Identity and the existing marker passed before this callback. Verify
          // the already-migrated draft schema before importing app/database code.
          const draftTable = await guarded.query<{ table_name: string | null }>({
            text: "SELECT to_regclass('public.model_catalog_drafts')::text AS table_name",
            values: [],
          });
          expect(draftTable.rows[0]?.table_name).toBe('model_catalog_drafts');
          const columns = await guarded.query<{ column_name: string }>({
            text: `SELECT column_name
                   FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'model_catalog_drafts'
                     AND column_name = ANY($1::text[])`,
            values: [['provider_slug', 'model_slug', 'raw', 'normalized', 'status']],
          });
          expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
            'model_slug',
            'normalized',
            'provider_slug',
            'raw',
            'status',
          ]);
          const uniqueKey = await guarded.query<{ definition: string }>({
            text: `SELECT pg_get_constraintdef(c.oid) AS definition
                   FROM pg_constraint AS c
                   JOIN pg_class AS relation ON relation.oid = c.conrelid
                   JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                   WHERE namespace.nspname = 'public' AND relation.relname = 'model_catalog_drafts'
                     AND c.contype = 'u'`,
            values: [],
          });
          expect(uniqueKey.rows.some((row) => row.definition.includes('(provider_slug, model_slug)')))
            .toBe(true);

          // Production database/app modules are intentionally imported only now.
          const database = await import('@aiag/database');
          const catalog = await import('../sync-cron.js');
          const db: DbLike = database.createDb(process.env.TEST_DATABASE_URL!);
          pool = (db as unknown as { $client: ClosablePool }).$client;
          sync = catalog.runCatalogSyncOnce;
          deps = {
            db: db as unknown as CatalogSyncDeps['db'],
            sql: database.sql as CatalogSyncDeps['sql'],
          };

          const identity = await db.execute(
            database.sql`SELECT current_database() AS database_name
                         FROM public._aiag_test_database_marker WHERE singleton = TRUE`,
          );
          const identityRows = (identity as { rows?: Array<{ database_name?: unknown }> }).rows;
          expect(identityRows?.[0]?.database_name).toBe('ai_aggregator_test');

          verify = await createPgTestClient(process.env.TEST_DATABASE_URL!);
          await verify.connect();

          const original = JSON.parse(await readFile(FIXTURE, 'utf8')) as CatalogPayload;
          const fixtureProviders = Object.keys(original);
          const fixtureModels = fixtureProviders.flatMap((providerSlug) =>
            Object.keys(original[providerSlug]!.models),
          );
          expect(fixtureProviders).toHaveLength(8);
          expect(fixtureModels).toHaveLength(38);

          const owned = cloneFixtureWithOwnedKeys(original, runId);
          pairs = owned.pairs;
          providerSlugs = [...new Set(pairs.map((pair) => pair.providerSlug))];
          expect(providerSlugs).toHaveLength(8);
          expect(pairs).toHaveLength(38);

          fetchFixture = (async () =>
            new Response(JSON.stringify(owned.cloned), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })) as typeof fetch;

          await verify.query({
            text: `INSERT INTO model_catalog_drafts
                     (provider_slug, model_slug, raw, normalized, status)
                   VALUES ($1, $2, $3::jsonb, $4::jsonb, 'rejected')`,
            values: [
              foreignProviderSlug,
              foreignModelSlug,
              JSON.stringify(foreignRaw),
              JSON.stringify(foreignNormalized),
            ],
          });
        },
      );
    } catch (error) {
      try {
        await deleteOwnedRows();
      } finally {
        await closeOwnedResources();
      }
      throw error;
    }
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      await deleteOwnedRows();
      await assertOwnedRowsRemoved();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await closeOwnedResources();
    } catch (error) {
      if (cleanupError) throw new AggregateError([cleanupError, error], 'catalog native cleanup failed');
      throw error;
    }
    if (cleanupError) throw cleanupError;
  });

  it('clones 8 providers and 38 models, preserves payload, and leaves foreign rows untouched', async () => {
    expect(sync).toBeDefined();
    expect(deps).toBeDefined();
    const result = await sync!({ ...deps!, fetchImpl: fetchFixture });
    expect(result).toEqual({ providersSeen: 8, draftsUpserted: 38 });

    const ownedRows = await verify!.query<{
      provider_slug: string;
      model_slug: string;
      raw: unknown;
      status: string;
    }>({
      text: `SELECT provider_slug, model_slug, raw, status
             FROM model_catalog_drafts
             WHERE provider_slug = ANY($1::text[])
             ORDER BY provider_slug, model_slug`,
      values: [providerSlugs],
    });
    expect(ownedRows.rows).toHaveLength(38);
    for (const row of ownedRows.rows) {
      expect(row.status).toBe('draft');
      expect(pairs.find(
        (pair) => pair.providerSlug === row.provider_slug && pair.modelSlug === row.model_slug,
      )?.raw).toEqual(row.raw);
    }

    const foreign = await verify!.query<{ raw: unknown; normalized: unknown; status: string }>({
      text: `SELECT raw, normalized, status FROM model_catalog_drafts
             WHERE provider_slug = $1 AND model_slug = $2`,
      values: [foreignProviderSlug, foreignModelSlug],
    });
    expect(foreign.rows).toEqual([
      { raw: foreignRaw, normalized: foreignNormalized, status: 'rejected' },
    ]);
  });

  it('is idempotent and preserves owned applied and rejected statuses', async () => {
    const first = pairs[0]!;
    const second = pairs[1]!;
    await verify!.query({
      text: `UPDATE model_catalog_drafts SET status = 'applied'
             WHERE provider_slug = $1 AND model_slug = $2`,
      values: [first.providerSlug, first.modelSlug],
    });
    await verify!.query({
      text: `UPDATE model_catalog_drafts SET status = 'rejected'
             WHERE provider_slug = $1 AND model_slug = $2`,
      values: [second.providerSlug, second.modelSlug],
    });

    const result = await sync!({ ...deps!, fetchImpl: fetchFixture });
    expect(result).toEqual({ providersSeen: 8, draftsUpserted: 38 });

    const ownedRows = await verify!.query<{ provider_slug: string; model_slug: string; status: string }>({
      text: `SELECT provider_slug, model_slug, status FROM model_catalog_drafts
             WHERE provider_slug = ANY($1::text[])`,
      values: [providerSlugs],
    });
    expect(ownedRows.rows).toHaveLength(38);
    expect(ownedRows.rows.filter((row) => row.status === 'applied')).toHaveLength(1);
    expect(ownedRows.rows.filter((row) => row.status === 'rejected')).toHaveLength(1);
  });
});
