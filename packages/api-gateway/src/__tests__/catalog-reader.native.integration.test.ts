import { describe, expect, it } from 'vitest';
import { createPgTestClient } from '../../../database/scripts/pg-test-client';
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from '../../../database/scripts/test-db-guard';
import type { AuthenticatedApiKey } from '../middleware/auth-plan04';
import type { SqlClient } from '../lib/db';

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === '1';

// Pure URL/identity validation runs before pg or any gateway runtime is loaded.
if (RUN_INTEGRATION) assertTestDatabaseEnvironment(process.env);

const key: AuthenticatedApiKey = {
  id: '31000000-0000-4000-8000-000000000001',
  org_id: '41000000-0000-4000-8000-000000000001',
  policies: {},
  rpm_limit: 1,
  batch_rpm_limit: 1,
  daily_usd_cap: null,
  model_whitelist: [],
  ru_residency_only: false,
};

describe.skipIf(!RUN_INTEGRATION)('native public catalog default reader', () => {
  it('executes the actual prepared lateral candidate query for a nonempty model page', async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guarded) => {
        const migration = await guarded.query<{ applied: boolean }>({
          text: `SELECT EXISTS (
                   SELECT 1
                     FROM public.schema_migrations
                    WHERE version = $1
                 ) AS applied`,
          values: ['migrations/0075_ton_reconciliation_json_null.sql'],
        });
        expect(migration.rows).toEqual([{ applied: true }]);

        const availableModels = await guarded.query<{ count: string }>({
          text: `SELECT count(*)::text AS count
                   FROM public.models
                  WHERE enabled = TRUE
                    AND status IN ('live', 'frozen')`,
          values: [],
        });
        expect(BigInt(availableModels.rows[0]!.count)).toBeGreaterThan(0n);

        // withGuardedTestDatabase has checked connected identity and marker;
        // only now may the production gateway singleton be constructed.
        let gatewaySql: SqlClient | undefined;
        try {
          const db = await import('../lib/db');
          gatewaySql = db.sql;
          const catalog = await import('../catalog/public-catalog');
          const marker = await gatewaySql`
            SELECT current_database() AS name, marker
              FROM public._aiag_test_database_marker
             WHERE singleton = TRUE
          `;
          expect(marker[0]).toEqual({
            name: 'ai_aggregator_test',
            marker: 'ai-aggregator:test-database:v1',
          });

          const response = await catalog.readPublicCatalog({
            key,
            limit: 1,
            cursor: null,
            runtime: catalog.capturePublicCatalogRuntime({
              executionMode: 'legacy',
              forceMock: true,
            }),
          });
          expect(response.data).toHaveLength(1);
        } finally {
          await gatewaySql?.end({ timeout: 5 });
        }
      },
    );
  }, 30_000);
});
