import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeCatalogCursor, parseCatalogResponseV1 } from '@aiag/shared/catalog-contract';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase, type TestDatabaseClient } from '../../../database/scripts/test-db-guard';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);

/** Native SQL + real route/auth boundary. Auth uses its supported resolver seam.
 * This is not full server/Redis, a paid invocation, or real AM acceptance.
 * Only UUID-owned test rows are mutated; no migration or shared reset is used.
 */
describe.skipIf(!enabled)('native catalog seek pagination and revision invalidation', () => {
  beforeAll(() => {
    vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', 'legacy');
    vi.stubEnv('AIAG_FORCE_MOCK', '1');
  });
  afterAll(() => { vi.unstubAllEnvs(); });

  type Fixture = {
    client: TestDatabaseClient;
    ids: string[];
    slugs: string[];
    prefix: string;
    key: AuthenticatedApiKey;
    fetch(cursor?: string): Promise<Response>;
    anchor(): Promise<string>;
  };

  async function native(work: (fixture: Fixture) => Promise<void>): Promise<void> {
    await withGuardedTestDatabase(process.env, { clientFactory: createPgTestClient }, async (client) => {
      // Production SQL is constructed only after URL + connected marker checks.
      vi.resetModules();
      const db = await import('../lib/db');
      const auth = await import('../middleware/auth-plan04');
      const { catalogRoute } = await import('../routes/v1/catalog');
      const { catalogHttpBoundary } = await import('../catalog/http-contract');
      const prefix = `catalog-native-${randomUUID()}`;
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const slugs = ids.map((_, i) => `${prefix}-${i + 1}`);
      const key: AuthenticatedApiKey = {
        id: randomUUID(), org_id: randomUUID(), policies: {},
        rpm_limit: 100, daily_usd_cap: null, batch_rpm_limit: 1,
        model_whitelist: [], ru_residency_only: false,
      };
      const bearer = `sk_aiag_test_${randomUUID().replaceAll('-', '')}`;
      auth.setApiKeyResolver(async (value) => value === bearer ? key : null);
      const app = new Hono();
      app.use('/v1/catalog', catalogHttpBoundary);
      app.use('/v1/catalog', auth.requireApiKey);
      app.route('/v1/catalog', catalogRoute);
      const fetch = async (cursor?: string): Promise<Response> => app.request(
        `/v1/catalog?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      const failures: unknown[] = [];
      try {
        for (let i = 0; i < ids.length; i++) {
          await client.query({
            text: "INSERT INTO models (id, slug, type, enabled, status) VALUES ($1::uuid, $2, 'chat', TRUE, 'live')",
            values: [ids[i], slugs[i]],
          });
        }
        await work({
          client, ids, slugs, prefix, key, fetch,
          async anchor() {
            const response = await fetch();
            expect(response.status).toBe(200);
            const page = parseCatalogResponseV1(await response.json());
            // A valid seek anchor isolates our slug range without mutating seeds.
            return encodeCatalogCursor({
              schemaVersion: 1, catalogRevision: page.catalogRevision,
              after: { slug: `${prefix}-0`, modelId: randomUUID() },
            });
          },
        });
      } catch (error) {
        failures.push(error);
      } finally {
        auth.setApiKeyResolver(null);
        for (const cleanup of [
          () => client.query({ text: 'DELETE FROM models WHERE id = ANY($1::uuid[])', values: [ids] }),
          async () => {
            const remaining = await client.query({ text: 'SELECT id FROM models WHERE id = ANY($1::uuid[])', values: [ids] });
            expect(remaining.rows).toEqual([]);
          },
          () => db.sql.end({ timeout: 5 }),
        ]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'native catalog verification and cleanup failed');
    });
  }

  it('seeks three owned pages in stable order without duplicates or invented capabilities', async () => {
    await native(async (f) => {
      let cursor = await f.anchor();
      const seen: string[] = [];
      let revision: string | undefined;
      for (const id of f.ids) {
        const response = await f.fetch(cursor);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const page = parseCatalogResponseV1(await response.json());
        expect(page.data).toHaveLength(1);
        expect(page.data[0]!.model.id).toBe(id);
        expect(page.data[0]!.availability.state).toBe('unavailable');
        expect(page.data[0]!.pricing).toBeNull();
        if (revision) expect(page.catalogRevision).toBe(revision);
        revision = page.catalogRevision;
        seen.push(page.data[0]!.model.id);
        if (seen.length < f.ids.length) {
          expect(page.page.nextCursor).not.toBeNull();
          cursor = page.page.nextCursor!;
        }
      }
      expect(new Set(seen).size).toBe(3);
    });
  }, 30_000);

  it('rejects a cursor after a real registry mutation and exposes the fresh frozen state', async () => {
    await native(async (f) => {
      const cursor = await f.anchor();
      await f.client.query({ text: "UPDATE models SET status = 'frozen' WHERE id = $1::uuid", values: [f.ids[0]] });
      const stale = await f.fetch(cursor);
      expect(stale.status).toBe(409);
      expect(stale.headers.get('cache-control')).toBe('private, no-store');
      expect(await stale.json()).toEqual({ error: { code: 'CATALOG_REVISION_CHANGED', message: 'Catalog changed; restart pagination' } });
      const fresh = await f.fetch(await f.anchor());
      const page = parseCatalogResponseV1(await fresh.json());
      expect(page.data[0]!.model.id).toBe(f.ids[0]);
      expect(page.data[0]!.availability.reason).toBe('model_frozen');
    });
  }, 30_000);

  it('rejects a cursor after fresh key policy changes without changing registry rows', async () => {
    await native(async (f) => {
      const cursor = await f.anchor();
      f.key.model_whitelist = [f.slugs[1]!];
      const response = await f.fetch(cursor);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: 'CATALOG_REVISION_CHANGED', message: 'Catalog changed; restart pagination' } });
      expect((await f.fetch(await f.anchor())).status).toBe(200);
    });
  }, 30_000);
});
