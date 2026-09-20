import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCatalogCursor, parseCatalogResponseV1, type CatalogAvailableItemV1 } from '@aiag/shared/catalog-contract';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from '../../../database/scripts/test-db-guard';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import { owner, runtime, slug, type Owner, type Runtime } from './stored-chat-mounted.native.fixture';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);

const receipt = 'x-aiag-charged-microcredits';
async function response(
  result: Response,
): Promise<{ status: number; headers: Record<string, string>; body: { error?: { code: string } } }> {
  return {
    status: result.status,
    headers: Object.fromEntries(result.headers),
    body: (await result.json()) as { error?: { code: string } },
  };
}

type Fixture = {
  client: TestDatabaseClient;
  insertModels(count: number): Promise<Array<{ id: string; slug: string }>>;
  insertCandidates(modelId: string, count: number, nanLast?: boolean): Promise<void>;
  anchor(): Promise<string>;
  fetch(limit: number, cursor: string): Promise<Response>;
};

describe.skipIf(!enabled)('native mounted catalog raw reader bounds', () => {
  beforeAll(() => {
    vi.stubEnv('GATEWAY_HTTP_EXECUTION_MODE', 'legacy');
    vi.stubEnv('AIAG_FORCE_MOCK', '1');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  async function native(work: (fixture: Fixture) => Promise<void>): Promise<void> {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (client) => {
        vi.resetModules();
        const db = await import('../lib/db');
        const auth = await import('../middleware/auth-plan04');
        const { catalogRoute } = await import('../routes/v1/catalog');
        const { catalogHttpBoundary } = await import('../catalog/http-contract');
        const short = randomUUID().replaceAll('-', '').slice(0, 12);
        const prefix = 'zzzzzz-catalog-bound-' + short;
        const modelIds: string[] = [];
        const upstreamIds: string[] = [];
        let modelCounter = 0;
        let upstreamCounter = 0;

        const existing = await client.query<{ count: string }>({
          text: 'SELECT count(*)::text AS count FROM models WHERE slug >= $1',
          values: [prefix],
        });
        expect(existing.rows).toEqual([{ count: '0' }]);

        const key: AuthenticatedApiKey = {
          id: randomUUID(),
          org_id: randomUUID(),
          policies: {},
          rpm_limit: 1000,
          daily_usd_cap: null,
          batch_rpm_limit: 1,
          model_whitelist: [],
          ru_residency_only: false,
        };
        const bearer = 'sk_aiag_test_' + randomUUID().replaceAll('-', '');
        auth.setApiKeyResolver(async (value) => (value === bearer ? key : null));
        const app = new Hono();
        app.use('/v1/catalog', catalogHttpBoundary);
        app.use('/v1/catalog', auth.requireApiKey);
        app.route('/v1/catalog', catalogRoute);

        const insertModels = async (count: number) => {
          const rows = Array.from({ length: count }, () => {
            modelCounter++;
            return {
              id: randomUUID(),
              slug: prefix + '-' + String(modelCounter).padStart(4, '0'),
            };
          });
          modelIds.push(...rows.map((row) => row.id));
          await client.query({
            text: "INSERT INTO models (id, slug, type, enabled, status) SELECT x.id::uuid, x.slug, 'chat', TRUE, 'live' FROM unnest($1::uuid[], $2::text[]) AS x(id, slug)",
            values: [rows.map((row) => row.id), rows.map((row) => row.slug)],
          });
          return rows;
        };

        const insertCandidates = async (modelId: string, count: number, nanLast = false) => {
          const candidateIds: string[] = [];
          const ownedUpstreams: string[] = [];
          const upstreamModels: string[] = [];
          const inputPrices: string[] = [];
          for (let index = 0; index < count; index++) {
            upstreamCounter++;
            candidateIds.push(randomUUID());
            ownedUpstreams.push('cb-' + short + '-' + upstreamCounter);
            upstreamModels.push('fixture/model-' + upstreamCounter);
            inputPrices.push(nanLast && index === count - 1 ? 'NaN' : '0.015');
          }
          upstreamIds.push(...ownedUpstreams);
          await client.query({
            text: "INSERT INTO upstreams (id, provider, ru_residency, enabled, latency_p50_ms, uptime, base_url, metadata) SELECT x.id, 'catalog-bound-fixture', FALSE, TRUE, 10, 0.9999, NULL, '{}'::jsonb FROM unnest($1::text[]) AS x(id)",
            values: [ownedUpstreams],
          });
          await client.query({
            text: "INSERT INTO model_upstreams (id, model_id, upstream_id, upstream_model_id, price_per_1k_input, price_per_1k_output, markup, enabled, priority) SELECT x.id::uuid, $1::uuid, x.upstream_id, x.upstream_model_id, x.input_price::numeric, 0.060, 1.8, TRUE, 100 FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS x(id, upstream_id, upstream_model_id, input_price)",
            values: [modelId, candidateIds, ownedUpstreams, upstreamModels, inputPrices],
          });
        };

        const anchor = async () => {
          const response = await app.request('/v1/catalog?limit=1', {
            headers: { authorization: 'Bearer ' + bearer },
          });
          expect(response.status).toBe(200);
          const page = parseCatalogResponseV1(await response.json());
          return encodeCatalogCursor({
            schemaVersion: 1,
            catalogRevision: page.catalogRevision,
            after: { slug: prefix, modelId: randomUUID() },
          });
        };

        const fetch = async (limit: number, cursor: string): Promise<Response> =>
          app.request('/v1/catalog?limit=' + limit + '&cursor=' + encodeURIComponent(cursor), {
            headers: { authorization: 'Bearer ' + bearer },
          });

        const failures: unknown[] = [];
        try {
          await work({ client, insertModels, insertCandidates, anchor, fetch });
        } catch (error) {
          failures.push(error);
        } finally {
          auth.setApiKeyResolver(null);
          for (const cleanup of [
            () => client.query({ text: 'DELETE FROM models WHERE id = ANY($1::uuid[])', values: [modelIds] }),
            () => client.query({ text: 'DELETE FROM upstreams WHERE id = ANY($1::text[])', values: [upstreamIds] }),
            async () => {
              const residual = await client.query<{ models: string; upstreams: string }>({
                text: 'SELECT (SELECT count(*)::text FROM models WHERE id = ANY($1::uuid[])) AS models, (SELECT count(*)::text FROM upstreams WHERE id = ANY($2::text[])) AS upstreams',
                values: [modelIds, upstreamIds],
              });
              expect(residual.rows).toEqual([{ models: '0', upstreams: '0' }]);
            },
            () => db.sql.end({ timeout: 5 }),
          ]) {
            try {
              await cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'native catalog raw-bound verification or cleanup failed');
      },
    );
  }

  const expectCatalogUnavailable = async (response: Response) => {
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({
      error: { code: 'CATALOG_UNAVAILABLE', message: 'Catalog unavailable' },
    });
  };

  it('accepts 16 raw candidates and rejects row 17 before malformed projection', async () => {
    await native(async (f) => {
      const [model] = await f.insertModels(1);
      await f.insertCandidates(model!.id, 16);
      const accepted = await f.fetch(1, await f.anchor());
      expect(accepted.status).toBe(200);
      const page = parseCatalogResponseV1(await accepted.json());
      expect(page.data).toHaveLength(1);
      expect(page.data[0]!.model.id).toBe(model!.id);
      await f.insertCandidates(model!.id, 1, true);
      await expectCatalogUnavailable(await f.fetch(1, await f.anchor()));
    });
  }, 30_000);

  it('accepts exactly 512 page candidates and rejects raw page row 513', async () => {
    await native(async (f) => {
      const models = await f.insertModels(32);
      for (const model of models) await f.insertCandidates(model.id, 16);
      const accepted = await f.fetch(32, await f.anchor());
      expect(accepted.status).toBe(200);
      const page = parseCatalogResponseV1(await accepted.json());
      expect(page.data).toHaveLength(32);
      const [extra] = await f.insertModels(1);
      await f.insertCandidates(extra!.id, 1);
      await expectCatalogUnavailable(await f.fetch(32, await f.anchor()));
    });
  }, 60_000);

  it('rejects a huge single-model fan-out instead of truncating it to 16', async () => {
    await native(async (f) => {
      const [model] = await f.insertModels(1);
      await f.insertCandidates(model!.id, 64);
      await expectCatalogUnavailable(await f.fetch(1, await f.anchor()));
    });
  }, 30_000);
});


describe.skipIf(!enabled)('native mounted catalog lifecycle and readiness', () => {
  let r: Runtime;
  let f: Owner;

  beforeAll(async () => {
    vi.resetModules();
    r = await runtime();
  }, 30_000);

  beforeEach(async () => {
    f = await owner(r);
    r.provider.mockClear();
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    delete process.env.AIAG_FORCE_MOCK;
    for (const cleanup of [() => f.cleanup(), () => r.restoreCatalog()]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(failures, 'catalog lifecycle cleanup failed');
    }
  });

  afterAll(async () => {
    await r.close();
  });

  async function catalog() {
    const response = await r.app.fetch(
      new Request('http://native.test/v1/catalog?limit=100', {
        headers: { authorization: 'Bearer ' + f.token },
      }),
    );
    expect(response.status).toBe(200);
    const page = parseCatalogResponseV1(await response.json());
    const item = page.data.find((entry) => entry.model.slug === slug);
    if (!item) throw new Error('reviewed native catalog model missing');
    return { page, item };
  }

  function available(
    result: Awaited<ReturnType<typeof catalog>>,
  ): CatalogAvailableItemV1 {
    expect(result.item.availability.state).toBe('available');
    if (
      result.item.availability.state !== 'available' ||
      result.item.deployment === null ||
      result.item.invocation === null ||
      result.item.pricing === null
    ) {
      throw new Error('expected reviewed native catalog model to be available');
    }
    return result.item as CatalogAvailableItemV1;
  }

  it('keeps price-only identity stable and changes execution/deployment revisions truthfully', async () => {
    const beforeResult = await catalog();
    const before = available(beforeResult);
    const originalId = before.deployment.id;

    await r.mutateCatalog((db) =>
      db.unsafe(
        'UPDATE model_upstreams SET price_per_1k_input = price_per_1k_input + 0.001 WHERE id = $1::uuid',
        [originalId],
      ),
    );
    const priceResult = await catalog();
    const price = available(priceResult);
    expect(price.model.id).toBe(before.model.id);
    expect(price.deployment.id).toBe(originalId);
    expect(price.deployment.configurationRevision).toBe(
      before.deployment.configurationRevision,
    );
    expect(price.pricing.revision).not.toBe(before.pricing.revision);
    expect(price.pricing.rates.input.amount).not.toBe(
      before.pricing.rates.input.amount,
    );
    expect(priceResult.page.catalogRevision).not.toBe(
      beforeResult.page.catalogRevision,
    );

    await r.mutateCatalog((db) =>
      db.unsafe(
        "UPDATE upstreams SET ru_residency = NOT ru_residency WHERE id = 'openrouter'",
      ),
    );
    const configResult = await catalog();
    const config = available(configResult);
    expect(config.deployment.id).toBe(originalId);
    expect(config.deployment.configurationRevision).not.toBe(
      price.deployment.configurationRevision,
    );

    // Actual delete/reinsert lifecycle: capture the canonical seed row whole
    // and restore it after any captured verification failure.
    const canonicalRows = await r.client`SELECT to_jsonb(mu)::text AS row FROM model_upstreams mu WHERE mu.id = ${originalId}::uuid`;
    const canonicalRow = JSON.parse(String(canonicalRows[0]!.row)) as Record<
      string,
      unknown
    >;
    const recreatedId = randomUUID();
    let verificationFailure: unknown;
    try {
      await r.mutateCatalog(async (db) => {
        await db.unsafe('DELETE FROM model_upstreams WHERE id = $1::uuid', [
          originalId,
        ]);
        await db.unsafe(
          'INSERT INTO model_upstreams SELECT * FROM jsonb_populate_record(NULL::model_upstreams, ($1::text)::jsonb)',
          [JSON.stringify({ ...canonicalRow, id: recreatedId })],
        );
      });
      const recreatedResult = await catalog();
      const recreated = available(recreatedResult);
      expect(recreated.deployment.id).toBe(recreatedId);
      expect(recreated.model.id).toBe(before.model.id);
      expect(recreated.deployment.configurationRevision).not.toBe(
        config.deployment.configurationRevision,
      );
      expect(recreated.model.artifact).toEqual({
        attestation: 'unattested',
        version: null,
        digest: null,
      });
      expect(r.provider).not.toHaveBeenCalled();
    } catch (error) {
      verificationFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      await r.mutateCatalog(async (db) => {
        await db.unsafe(
          'DELETE FROM model_upstreams WHERE id = $1::uuid AND id <> $2::uuid',
          [recreatedId, originalId],
        );
        const restored = await db.unsafe(
          'SELECT to_jsonb(mu)::text AS row FROM model_upstreams mu WHERE mu.id = $1::uuid',
          [originalId],
        );
        if (restored.length === 0) {
          await db.unsafe(
            'INSERT INTO model_upstreams SELECT * FROM jsonb_populate_record(NULL::model_upstreams, ($1::text)::jsonb)',
            [JSON.stringify(canonicalRow)],
          );
        }
      });
    } catch (error) {
      cleanupFailure = error;
    }
    const failures = [verificationFailure, cleanupFailure].filter(
      (failure) => failure != null,
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'deployment lifecycle verification and seed restoration failed',
      );
  }, 30_000);

  it('projects frozen state and missing configured mechanics without provider execution', async () => {
    await r.mutateCatalog((db) =>
      db.unsafe("UPDATE models SET status = 'frozen' WHERE slug = $1", [slug]),
    );
    const frozen = await catalog();
    expect(frozen.item.availability).toMatchObject({
      state: 'unavailable',
      reason: 'model_frozen',
      liveUpstreamHealthChecked: false,
    });
    expect(frozen.item.deployment).toBeNull();
    expect(frozen.item.pricing).toBeNull();

    await r.restoreCatalog();
    const readyResult = await catalog();
    available(readyResult);

    const priorForceMock = process.env.AIAG_FORCE_MOCK;
    try {
      process.env.AIAG_FORCE_MOCK = '1';
      const unavailable = await catalog();
      expect(unavailable.item.availability).toMatchObject({
        state: 'unavailable',
        reason: 'service_configuration_unavailable',
        liveUpstreamHealthChecked: false,
      });
      expect(unavailable.item.deployment).toBeNull();
      expect(unavailable.item.pricing).toBeNull();
      expect(unavailable.page.catalogRevision).not.toBe(
        readyResult.page.catalogRevision,
      );
    } finally {
      if (priorForceMock === undefined) delete process.env.AIAG_FORCE_MOCK;
      else process.env.AIAG_FORCE_MOCK = priorForceMock;
    }
    expect(r.provider).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects a cursor built before a readiness configuration change with 409', async () => {
    const readyResult = await catalog();
    const ready = available(readyResult);
    const cursor = encodeCatalogCursor({
      schemaVersion: 1,
      catalogRevision: readyResult.page.catalogRevision,
      after: { slug: 'openai/gpt-4o-min', modelId: randomUUID() },
    });
    expect(r.provider).not.toHaveBeenCalled();

    let stale: Response | undefined;
    const priorForceMock = process.env.AIAG_FORCE_MOCK;
    try {
      process.env.AIAG_FORCE_MOCK = '1';
      stale = await r.app.fetch(
        new Request(
          'http://native.test/v1/catalog?limit=100&cursor=' +
            encodeURIComponent(cursor),
          { headers: { authorization: 'Bearer ' + f.token } },
        ),
      );
    } finally {
      if (priorForceMock === undefined) delete process.env.AIAG_FORCE_MOCK;
      else process.env.AIAG_FORCE_MOCK = priorForceMock;
    }
    if (!stale) throw new Error('stale-cursor request produced no response');
    expect(stale.status).toBe(409);
    expect(stale.headers.get('cache-control')).toBe('private, no-store');
    expect(await stale.json()).toEqual({
      error: { code: 'CATALOG_REVISION_CHANGED', message: 'Catalog changed; restart pagination' },
    });

    const restored = await catalog();
    const restoredItem = available(restored);
    expect(restored.page.catalogRevision).toBe(readyResult.page.catalogRevision);
    expect(restoredItem.deployment?.id).toBe(ready.deployment?.id);
    expect(r.provider).not.toHaveBeenCalled();
  }, 30_000);

  it('treats catalog as advisory: POST after a price change quotes the fresh price while old snapshots stay immutable', async () => {
    const earlierId = randomUUID();
    const earlier = await response(await f.post(earlierId));
    expect(earlier.status).toBe(200);
    const earlierReceipt = earlier.headers[receipt]!;
    const earlierBillingId = earlier.headers['x-aiag-billing-request-id']!;
    const before = await f.facts();
    expect(before.mapping).toHaveLength(1);
    expect(before.admission).toHaveLength(1);
    expect(before.admission[0]?.state).toBe('settled');
    expect(before.result).toHaveLength(1);
    expect(before.ledger).toHaveLength(1);

    const originalPrices = {
      inputCentsPer1k: '0.0150000000',
      outputCentsPer1k: '0.0600000000',
      markup: '1.8000',
    };
    expect(earlierReceipt).toBe('4');
    expect(String(before.admission[0]?.actual_cost_credits)).toBe('4');
    expect(String(before.ledger[0]?.delta)).toBe('-4');
    expect(before.admission[0]?.quote_snapshot).toMatchObject({
      version: 1,
      actualChargePolicy: { cachingDiscount: '0.5' },
      tokenQuote: { candidates: [{ prices: originalPrices }] },
    });
    expect(before.admission[0]?.pricing_snapshot).toMatchObject({
      prices: originalPrices,
      actualChargePolicy: { cachingDiscount: '0.5' },
    });
    expect(before.admission[0]?.usage_snapshot).toMatchObject({
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 50,
      },
    });

    const beforeGet = await f.facts();
    const preflightResult = await catalog();
    const preflight = available(preflightResult);
    expect(Number(preflight.pricing.rates.input.amount)).toBe(0.027);
    expect(Number(preflight.pricing.rates.output.amount)).toBe(0.108);
    // Advisory GET creates no financial rows and calls no provider.
    expect(await f.facts()).toEqual(beforeGet);
    expect(r.provider).toHaveBeenCalledTimes(1);

    const deploymentId = preflight.deployment.id;
    await r.mutateCatalog(async (db) => {
      await db.unsafe(
        'UPDATE model_upstreams SET price_per_1k_output = 0.60 WHERE id = $1::uuid',
        [deploymentId],
      );
    });
    const mutatedResult = await catalog();
    const mutated = available(mutatedResult);
    expect(mutated.pricing.revision).not.toBe(preflight.pricing.revision);
    expect(mutatedResult.page.catalogRevision).not.toBe(
      preflightResult.page.catalogRevision,
    );
    expect(Number(mutated.pricing.rates.output.amount)).toBe(1.08);
    expect(await f.facts()).toEqual(beforeGet);
    expect(r.provider).toHaveBeenCalledTimes(1);

    const changedPrices = {
      ...originalPrices,
      outputCentsPer1k: '0.6000000000',
    };
    const fresh = await response(await f.post(randomUUID()));
    expect(fresh.status).toBe(200);
    const freshBillingId = fresh.headers['x-aiag-billing-request-id']!;
    expect(freshBillingId).not.toBe(earlierBillingId);
    expect(fresh.headers[receipt]).toBe('18');
    expect(fresh.headers['x-aiag-charged-usd-micro']).toBe('180');

    const after = await f.facts();
    expect(after.mapping).toHaveLength(2);
    expect(after.admission).toHaveLength(2);
    expect(after.result).toHaveLength(2);
    expect(after.ledger).toHaveLength(2);
    const freshAdmission = after.admission.find(
      (row) => String(row.billing_request_id) === freshBillingId,
    );
    const freshLedger = after.ledger.find(
      (row) => String(row.request_id) === 'gw:' + freshBillingId,
    );
    expect(String(freshAdmission?.actual_cost_credits)).toBe('18');
    expect(String(freshLedger?.delta)).toBe('-18');
    expect(freshAdmission?.quote_snapshot).toMatchObject({
      version: 1,
      actualChargePolicy: { cachingDiscount: '0.5' },
      tokenQuote: { candidates: [{ prices: changedPrices }] },
    });
    expect(freshAdmission?.pricing_snapshot).toMatchObject({
      prices: changedPrices,
      actualChargePolicy: { cachingDiscount: '0.5' },
    });
    expect(freshAdmission?.usage_snapshot).toMatchObject({
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 50,
      },
    });
    // Earlier admission/result/ledger/mapping rows stay byte-equivalent.
    expect(
      after.admission.filter(
        (row) => String(row.billing_request_id) === earlierBillingId,
      ),
    ).toEqual(before.admission);
    expect(
      after.result.filter(
        (row) => String(row.billing_request_id) === earlierBillingId,
      ),
    ).toEqual(before.result);
    expect(
      after.mapping.filter(
        (row) => String(row.billing_request_id) === earlierBillingId,
      ),
    ).toEqual(before.mapping);
    expect(
      after.ledger.filter(
        (row) => String(row.request_id) === 'gw:' + earlierBillingId,
      ),
    ).toEqual(before.ledger);

    // Replaying the earlier request key returns the stored receipt/body
    // without another provider call or a new financial row.
    const replay = await response(await f.post(earlierId));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(earlier.body);
    expect(replay.headers[receipt]).toBe(earlierReceipt);
    expect(replay.headers['x-aiag-billing-request-id']).toBe(earlierBillingId);
    expect(await f.facts()).toEqual(after);
    expect(r.provider).toHaveBeenCalledTimes(2);
  }, 60_000);
});
