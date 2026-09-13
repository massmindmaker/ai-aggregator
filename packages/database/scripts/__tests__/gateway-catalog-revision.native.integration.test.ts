import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { discoverNativeMigrations } from "../native-migrate";
import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const MUTATED_ENV_KEYS = [
  "AIAG_ADMIN_KEY",
  "AIAG_ADMIN_RATE_LIMIT",
  "LOG_LEVEL",
] as const;
type MutatedEnvKey = (typeof MUTATED_ENV_KEYS)[number];
type EnvironmentSnapshot = Record<
  MutatedEnvKey,
  { present: boolean; value: string | undefined }
>;

// This pure loopback/identity check runs before createPgTestClient can import pg
// or any gateway module can construct its postgres.js client.
if (RUN_INTEGRATION) assertTestDatabaseEnvironment(process.env);

function snapshotEnvironment(
  env: Record<string, string | undefined>,
): EnvironmentSnapshot {
  return Object.fromEntries(
    MUTATED_ENV_KEYS.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(env, key),
        value: env[key],
      },
    ]),
  ) as EnvironmentSnapshot;
}

function restoreEnvironment(
  env: Record<string, string | undefined>,
  snapshot: EnvironmentSnapshot,
) {
  for (const key of MUTATED_ENV_KEYS) {
    const saved = snapshot[key];
    if (saved.present) env[key] = saved.value;
    else delete env[key];
  }
}

async function closeBothPreservingFirstError(
  closeGateway: (() => Promise<void>) | undefined,
  closeDatabase: (() => Promise<void>) | undefined,
) {
  let firstError: unknown;
  for (const close of [closeGateway, closeDatabase]) {
    if (!close) continue;
    try {
      await close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

type OwnedRows = {
  adminModelSlugs: string[];
  candidates: string[];
  drafts: string[];
  keys: string[];
  models: string[];
  orgs: string[];
  transactions: string[];
  upstreams: string[];
  users: string[];
};

function ownedRows(): OwnedRows {
  return {
    adminModelSlugs: [],
    candidates: [],
    drafts: [],
    keys: [],
    models: [],
    orgs: [],
    transactions: [],
    upstreams: [],
    users: [],
  };
}

describe.skipIf(!RUN_INTEGRATION)("native gateway catalog revision", () => {
  let client: TestDatabaseClient;
  let closeClient: (() => Promise<void>) | undefined;
  let closeGatewaySql: (() => Promise<void>) | undefined;
  let adminFetch:
    | ((request: Request) => Response | Promise<Response>)
    | undefined;
  let foreignUpstream: { id: string; row: string } | undefined;
  let environmentBeforeSuite: EnvironmentSnapshot | undefined;
  let owned = ownedRows();

  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => client.query<Row>({ text, values });

  async function revision(): Promise<bigint> {
    const result = await query<{ revision: string }>(
      "SELECT aiag_read_gateway_catalog_revision_v1()::text AS revision",
    );
    expect(result.rows).toHaveLength(1);
    return BigInt(result.rows[0].revision);
  }

  async function expectAdvance(
    operation: () => Promise<unknown>,
    amount = 1n,
  ): Promise<void> {
    const before = await revision();
    await operation();
    expect(await revision()).toBe(before + amount);
  }

  async function insertUpstream(): Promise<string> {
    const id = `catalog-${randomUUID()}`;
    owned.upstreams.push(id);
    await query(
      `INSERT INTO upstreams
         (id, provider, ru_residency, enabled, latency_p50_ms, uptime, base_url, metadata)
       VALUES ($1, $2, FALSE, TRUE, 321, 0.9876, $3, '{}'::jsonb)`,
      [id, `provider-${randomUUID()}`, "https://catalog.invalid/v1"],
    );
    return id;
  }

  async function insertModel(): Promise<{ id: string; slug: string }> {
    const id = randomUUID();
    const slug = `catalog-${randomUUID()}`;
    owned.models.push(id);
    await query(
      `INSERT INTO models (id, slug, type, enabled, status)
       VALUES ($1::uuid, $2, 'chat', TRUE, 'live')`,
      [id, slug],
    );
    return { id, slug };
  }

  async function insertCandidate(modelId: string, upstreamId: string) {
    const id = randomUUID();
    owned.candidates.push(id);
    await query(
      `INSERT INTO model_upstreams
         (id, model_id, upstream_id, upstream_model_id,
          price_per_1k_input, price_per_1k_output, markup,
          enabled, priority, egress_proxy)
       VALUES ($1::uuid, $2::uuid, $3, $4, 0.015, 0.060, 1.8,
               TRUE, 100, NULL)`,
      [id, modelId, upstreamId, `binding-${randomUUID()}`],
    );
    return id;
  }

  async function createDraft(input: {
    upstreamId: string;
    modelSlug: string;
    inputPrice?: number;
  }) {
    const upstream = await query<{ provider: string }>(
      "SELECT provider FROM upstreams WHERE id=$1",
      [input.upstreamId],
    );
    const id = randomUUID();
    owned.drafts.push(id);
    await query(
      `INSERT INTO model_catalog_drafts
         (id, provider_slug, model_slug, raw, normalized, status)
       VALUES ($1::uuid, $2, $3, '{}'::jsonb, $4::jsonb, 'draft')`,
      [
        id,
        upstream.rows[0].provider,
        input.modelSlug,
        JSON.stringify({
          price_usd_per_1m_input: input.inputPrice ?? 0.15,
          price_usd_per_1m_output: 0.6,
          context_window: 8192,
          input_modalities: ["text"],
          output_modalities: ["text"],
        }),
      ],
    );
    return id;
  }

  async function applyDraft(id: string) {
    if (!adminFetch) throw new Error("admin route was not initialized");
    return adminFetch(
      new Request("http://catalog.test/api/admin/catalog/apply", {
        method: "POST",
        headers: {
          authorization: "Bearer catalog-native-admin-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids: [id] }),
      }),
    );
  }

  async function discoverAppliedAdminRows(
    modelSlug: string,
    upstreamId: string,
    candidateLookup?: () => Promise<{ rows: Array<{ id: string }> }>,
  ) {
    const modelRows = await query<{ id: string }>(
      "SELECT id::text AS id FROM models WHERE slug=$1",
      [modelSlug],
    );
    for (const row of modelRows.rows) {
      if (!owned.models.includes(row.id)) owned.models.push(row.id);
    }

    // Model UUID ownership is durable in memory before this next await can
    // fail. The exact slug remains a second recovery identity for cleanup.
    const candidateRows = candidateLookup
      ? await candidateLookup()
      : await query<{ id: string }>(
          `SELECT mu.id::text AS id
             FROM model_upstreams mu
             JOIN models m ON m.id=mu.model_id
            WHERE m.slug=$1 AND mu.upstream_id=$2`,
          [modelSlug, upstreamId],
        );
    for (const row of candidateRows.rows) {
      if (!owned.candidates.includes(row.id)) owned.candidates.push(row.id);
    }
  }

  async function openAdditionalGuardedClient() {
    let additional!: TestDatabaseClient;
    let close!: () => Promise<void>;
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guarded) => {
        additional = guarded;
        const originalEnd = guarded.end.bind(guarded);
        guarded.end = async () => undefined;
        close = async () => {
          await originalEnd();
        };
      },
    );
    return { client: additional, close };
  }

  async function waitForLock(pid: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await query<{ waiting: boolean }>(
        `SELECT wait_event_type = 'Lock' AS waiting
           FROM pg_stat_activity
          WHERE pid=$1`,
        [pid],
      );
      if (state.rows[0]?.waiting) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("concurrent catalog revision mutation did not wait");
  }

  async function deleteOwned(text: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    await query(text, [ids]);
  }

  async function cleanupOwnedRows() {
    const current = owned;
    let firstError: unknown;
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    if (current.adminModelSlugs.length > 0) {
      await attempt(async () => {
        const recovered = await query<{ id: string }>(
          "SELECT id::text AS id FROM models WHERE slug=ANY($1::text[])",
          [current.adminModelSlugs],
        );
        for (const row of recovered.rows) {
          if (!current.models.includes(row.id)) current.models.push(row.id);
        }
      });
    }

    await attempt(() =>
      deleteOwned(
        "DELETE FROM model_catalog_drafts WHERE id=ANY($1::uuid[])",
        current.drafts,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM model_upstreams WHERE id=ANY($1::uuid[])",
        current.candidates,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM models WHERE id=ANY($1::uuid[])",
        current.models,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM upstreams WHERE id=ANY($1::text[])",
        current.upstreams,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM gateway_transactions WHERE id=ANY($1::uuid[])",
        current.transactions,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM gateway_api_keys WHERE id=ANY($1::uuid[])",
        current.keys,
      ),
    );
    await attempt(() =>
      deleteOwned(
        "DELETE FROM organizations WHERE id=ANY($1::uuid[])",
        current.orgs,
      ),
    );
    await attempt(() =>
      deleteOwned("DELETE FROM users WHERE id=ANY($1::uuid[])", current.users),
    );

    if (firstError) throw firstError;
    owned = ownedRows();
  }

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guarded) => {
        client = guarded;
        const originalEnd = guarded.end.bind(guarded);
        guarded.end = async () => undefined;
        closeClient = async () => {
          await originalEnd();
        };

        // withGuardedTestDatabase has verified both the connected identity and
        // the marker before this suite imports the real admin route.
        const sentinel = await guarded.query<{ id: string; row: string }>({
          text: `SELECT id, to_jsonb(u)::text AS row
                   FROM upstreams u
                  ORDER BY id
                  LIMIT 1`,
          values: [],
        });
        foreignUpstream = sentinel.rows[0];
        expect(foreignUpstream).toBeDefined();

        environmentBeforeSuite = snapshotEnvironment(process.env);
        process.env.AIAG_ADMIN_KEY = "catalog-native-admin-key";
        process.env.AIAG_ADMIN_RATE_LIMIT = "off";
        process.env.LOG_LEVEL = "silent";

        const [{ Hono }, { adminCatalog }, { applyAiagErrorHandler }, db] =
          await Promise.all([
            import("hono"),
            import("../../../api-gateway/src/routes/admin/catalog"),
            import("../../../api-gateway/src/lib/errors"),
            import("../../../api-gateway/src/lib/db"),
          ]);
        const app = new Hono();
        applyAiagErrorHandler(app);
        app.route("/api/admin/catalog", adminCatalog);
        adminFetch = (request) => app.fetch(request);
        closeGatewaySql = async () => {
          await db.sql.end({ timeout: 5 });
        };
      },
    );
  });

  afterEach(async () => {
    if (!client) return;
    await cleanupOwnedRows();
  });

  afterAll(async () => {
    let firstError: unknown;
    try {
      if (client) await cleanupOwnedRows();
      if (client && foreignUpstream) {
        const sentinel = await query<{ row: string }>(
          "SELECT to_jsonb(u)::text AS row FROM upstreams u WHERE id=$1",
          [foreignUpstream.id],
        );
        expect(sentinel.rows).toEqual([{ row: foreignUpstream.row }]);
      }
    } catch (error) {
      firstError = error;
    } finally {
      if (environmentBeforeSuite)
        restoreEnvironment(process.env, environmentBeforeSuite);
      try {
        await closeBothPreservingFirstError(closeGatewaySql, closeClient);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  });

  it("registers exactly one guarded singleton and statement transition triggers", async () => {
    const migrations = await discoverNativeMigrations();
    expect(
      migrations.filter(({ version }) =>
        version.endsWith("/0073_gateway_catalog_revision.sql"),
      ),
    ).toHaveLength(1);
    expect(migrations.at(-1)?.version).toBe(
      "migrations/0073_gateway_catalog_revision.sql",
    );

    const singleton = await query<{ singleton: boolean; revision: string }>(
      `SELECT singleton, revision::text AS revision
         FROM gateway_catalog_revisions`,
    );
    expect(singleton.rows).toHaveLength(1);
    expect(singleton.rows[0].singleton).toBe(true);
    expect(BigInt(singleton.rows[0].revision)).toBeGreaterThan(0n);

    const triggers = await query<{
      name: string;
      statement_level: boolean;
    }>(
      `SELECT tgname AS name, (tgtype & 1) = 0 AS statement_level
         FROM pg_trigger
        WHERE tgrelid = ANY(ARRAY[
                'models'::regclass,
                'model_upstreams'::regclass,
                'upstreams'::regclass
              ])
          AND NOT tgisinternal
          AND tgname LIKE 'gateway_catalog_%'
        ORDER BY tgname`,
    );
    expect(triggers.rows).toHaveLength(9);
    expect(triggers.rows.every(({ statement_level }) => statement_level)).toBe(
      true,
    );

    const bumpAcl = await query<{ public_execute: boolean }>(
      `SELECT has_function_privilege(
                'public',
                'aiag_bump_gateway_catalog_revision_v1()',
                'EXECUTE'
              ) AS public_execute`,
    );
    expect(bumpAcl.rows[0].public_execute).toBe(false);
  });

  it("bumps exactly once for every relevant statement and for deletions", async () => {
    let upstreamId = "";
    await expectAdvance(async () => {
      upstreamId = await insertUpstream();
    });
    let model!: { id: string; slug: string };
    await expectAdvance(async () => {
      model = await insertModel();
    });
    let candidateId = "";
    await expectAdvance(async () => {
      candidateId = await insertCandidate(model.id, upstreamId);
    });

    const relevantUpdates: Array<() => Promise<unknown>> = [
      () =>
        query(
          "UPDATE model_upstreams SET price_per_1k_input=0.025 WHERE id=$1::uuid",
          [candidateId],
        ),
      () =>
        query(
          "UPDATE model_upstreams SET price_per_1k_output=0.075 WHERE id=$1::uuid",
          [candidateId],
        ),
      () =>
        query("UPDATE model_upstreams SET markup=1.9 WHERE id=$1::uuid", [
          candidateId,
        ]),
      () =>
        query(
          "UPDATE model_upstreams SET upstream_model_id=$2 WHERE id=$1::uuid",
          [candidateId, `binding-${randomUUID()}`],
        ),
      () =>
        query("UPDATE model_upstreams SET enabled=FALSE WHERE id=$1::uuid", [
          candidateId,
        ]),
      () =>
        query("UPDATE model_upstreams SET priority=7 WHERE id=$1::uuid", [
          candidateId,
        ]),
      () =>
        query("UPDATE model_upstreams SET egress_proxy=$2 WHERE id=$1::uuid", [
          candidateId,
          "http://catalog.invalid:3128",
        ]),
      () =>
        query("UPDATE models SET slug=$2 WHERE id=$1::uuid", [
          model.id,
          `${model.slug}-changed`,
        ]),
      () =>
        query("UPDATE models SET type='completion' WHERE id=$1::uuid", [
          model.id,
        ]),
      () =>
        query("UPDATE models SET status='frozen' WHERE id=$1::uuid", [
          model.id,
        ]),
      () =>
        query("UPDATE models SET enabled=FALSE WHERE id=$1::uuid", [model.id]),
      () =>
        query("UPDATE upstreams SET provider=$2 WHERE id=$1", [
          upstreamId,
          `provider-${randomUUID()}`,
        ]),
      () =>
        query("UPDATE upstreams SET ru_residency=TRUE WHERE id=$1", [
          upstreamId,
        ]),
      () =>
        query("UPDATE upstreams SET enabled=FALSE WHERE id=$1", [upstreamId]),
      () =>
        query("UPDATE upstreams SET latency_p50_ms=123 WHERE id=$1", [
          upstreamId,
        ]),
      () =>
        query("UPDATE upstreams SET uptime=0.9000 WHERE id=$1", [upstreamId]),
      () =>
        query("UPDATE upstreams SET base_url=$2 WHERE id=$1", [
          upstreamId,
          "https://catalog-changed.invalid/v1",
        ]),
    ];
    for (const update of relevantUpdates) await expectAdvance(update);

    await expectAdvance(() =>
      query("DELETE FROM model_upstreams WHERE id=$1::uuid", [candidateId]),
    );
    owned.candidates = owned.candidates.filter((id) => id !== candidateId);
    await expectAdvance(() =>
      query("DELETE FROM models WHERE id=$1::uuid", [model.id]),
    );
    owned.models = owned.models.filter((id) => id !== model.id);
    await expectAdvance(() =>
      query("DELETE FROM upstreams WHERE id=$1", [upstreamId]),
    );
    owned.upstreams = owned.upstreams.filter((id) => id !== upstreamId);
  });

  it("bumps once for a multi-row statement and not for no-op or zero-row statements", async () => {
    const first = randomUUID();
    const second = randomUUID();
    owned.models.push(first, second);
    await expectAdvance(() =>
      query(
        `INSERT INTO models (id, slug, type, enabled, status)
         VALUES ($1::uuid, $2, 'chat', TRUE, 'live'),
                ($3::uuid, $4, 'chat', TRUE, 'live')`,
        [first, `catalog-${randomUUID()}`, second, `catalog-${randomUUID()}`],
      ),
    );

    const beforeNoop = await revision();
    await query("UPDATE models SET slug=slug WHERE id=ANY($1::uuid[])", [
      [first, second],
    ]);
    await query("UPDATE models SET enabled=FALSE WHERE id=$1::uuid", [
      randomUUID(),
    ]);
    await query("DELETE FROM models WHERE id=$1::uuid", [randomUUID()]);
    expect(await revision()).toBe(beforeNoop);

    await expectAdvance(() =>
      query("UPDATE models SET status='frozen' WHERE id=ANY($1::uuid[])", [
        [first, second],
      ]),
    );
    await expectAdvance(() =>
      query("DELETE FROM models WHERE id=ANY($1::uuid[])", [[first, second]]),
    );
    owned.models = [];
  });

  it("rolls the trigger bump back with the surrounding mutation", async () => {
    const model = await insertModel();
    const before = await revision();

    await query("BEGIN");
    try {
      await query("UPDATE models SET status='frozen' WHERE id=$1::uuid", [
        model.id,
      ]);
      expect(await revision()).toBe(before + 1n);
    } finally {
      await query("ROLLBACK");
    }

    expect(await revision()).toBe(before);
    const state = await query<{ status: string }>(
      "SELECT status FROM models WHERE id=$1::uuid",
      [model.id],
    );
    expect(state.rows).toEqual([{ status: "live" }]);
  });

  it("serializes concurrent statement bumps without rejecting either mutation", async () => {
    const first = await insertModel();
    const second = await insertModel();
    const before = await revision();
    const additional = await openAdditionalGuardedClient();
    const pid = await additional.client.query<{ pid: number }>({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    });
    let pending: Promise<unknown> | undefined;
    let committed = false;

    try {
      await query("BEGIN");
      await query("UPDATE models SET status='frozen' WHERE id=$1::uuid", [
        first.id,
      ]);
      pending = additional.client.query({
        text: "UPDATE models SET status='frozen' WHERE id=$1::uuid",
        values: [second.id],
      });
      await waitForLock(pid.rows[0].pid);
      await query("COMMIT");
      committed = true;
      await pending;
      expect(await revision()).toBe(before + 2n);
    } finally {
      if (!committed) await query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined);
      await additional.close();
    }
  });

  it("fails catalog reads and mutations on missing, duplicate, corrupt or overflow state", async () => {
    const model = await insertModel();
    const stableRevision = await revision();

    await query("BEGIN");
    try {
      await query("DELETE FROM gateway_catalog_revisions");
      await expect(revision()).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    await query("BEGIN");
    try {
      await query("DELETE FROM gateway_catalog_revisions");
      await expect(
        query("UPDATE models SET status='frozen' WHERE id=$1::uuid", [
          model.id,
        ]),
      ).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    await query("BEGIN");
    try {
      await query(
        `ALTER TABLE gateway_catalog_revisions
           DROP CONSTRAINT gateway_catalog_revisions_pkey,
           DROP CONSTRAINT gateway_catalog_revisions_singleton_true,
           DROP CONSTRAINT gateway_catalog_revisions_revision_positive`,
      );
      await query(
        "INSERT INTO gateway_catalog_revisions(singleton,revision) VALUES(FALSE,2)",
      );
      await expect(revision()).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    await query("BEGIN");
    try {
      await query(
        `ALTER TABLE gateway_catalog_revisions
           DROP CONSTRAINT gateway_catalog_revisions_revision_positive`,
      );
      await query("UPDATE gateway_catalog_revisions SET revision=0");
      await expect(revision()).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    await query("BEGIN");
    try {
      await query(
        `ALTER TABLE gateway_catalog_revisions
           DROP CONSTRAINT gateway_catalog_revisions_revision_positive`,
      );
      await query(
        "UPDATE gateway_catalog_revisions SET revision=9223372036854775807",
      );
      await expect(revision()).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    await query("BEGIN");
    try {
      await query(
        `ALTER TABLE gateway_catalog_revisions
           DROP CONSTRAINT gateway_catalog_revisions_revision_positive`,
      );
      await query(
        "UPDATE gateway_catalog_revisions SET revision=9223372036854775807",
      );
      await expect(
        query("UPDATE models SET enabled=FALSE WHERE id=$1::uuid", [model.id]),
      ).rejects.toThrow("CATALOG_REVISION_INVALID");
    } finally {
      await query("ROLLBACK");
    }

    expect(await revision()).toBe(stableRevision);
    const state = await query<{ status: string; enabled: boolean }>(
      "SELECT status,enabled FROM models WHERE id=$1::uuid",
      [model.id],
    );
    expect(state.rows).toEqual([{ status: "live", enabled: true }]);
  });

  it("uses the real admin apply transaction as the sole revision owner", async () => {
    const source = await readFile(
      resolve("packages/api-gateway/src/routes/admin/catalog.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /gateway_catalog_revisions|aiag_bump_gateway_catalog_revision/,
    );

    const upstreamId = await insertUpstream();
    const modelSlug = `catalog-admin-${randomUUID()}`;
    owned.adminModelSlugs.push(modelSlug);
    const draftId = await createDraft({ upstreamId, modelSlug });

    const beforeApply = await revision();
    const applyResponse = await applyDraft(draftId);
    await discoverAppliedAdminRows(modelSlug, upstreamId);

    expect(applyResponse.status).toBe(200);
    expect(await revision()).toBe(beforeApply + 2n);
    const applied = await query<{
      model_count: string;
      candidate_count: string;
      status: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM models WHERE slug=$1) AS model_count,
         (SELECT count(*)::text
            FROM model_upstreams mu
            JOIN models m ON m.id=mu.model_id
           WHERE m.slug=$1 AND mu.upstream_id=$2) AS candidate_count,
         (SELECT status FROM model_catalog_drafts WHERE id=$3::uuid) AS status`,
      [modelSlug, upstreamId, draftId],
    );
    expect(applied.rows[0]).toEqual({
      model_count: "1",
      candidate_count: "1",
      status: "applied",
    });
    await query(
      "UPDATE model_catalog_drafts SET status='draft' WHERE id=$1::uuid",
      [draftId],
    );
    const beforeConflict = await revision();
    expect((await applyDraft(draftId)).status).toBe(200);
    expect(await revision()).toBe(beforeConflict);

    const beforeAlreadyApplied = await revision();
    expect((await applyDraft(draftId)).status).toBe(200);
    expect(await revision()).toBe(beforeAlreadyApplied);

    const rollbackSlug = `catalog-rollback-${randomUUID()}`;
    owned.adminModelSlugs.push(rollbackSlug);
    const rollbackDraft = await createDraft({
      upstreamId,
      modelSlug: rollbackSlug,
      inputPrice: 1e300,
    });
    const beforeRollback = await revision();
    expect((await applyDraft(rollbackDraft)).status).toBe(200);
    expect(await revision()).toBe(beforeRollback);
    expect(
      (
        await query<{ count: string }>(
          "SELECT count(*)::text AS count FROM models WHERE slug=$1",
          [rollbackSlug],
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await query<{ status: string }>(
          "SELECT status FROM model_catalog_drafts WHERE id=$1::uuid",
          [rollbackDraft],
        )
      ).rows[0].status,
    ).toBe("draft");
  });

  it("cleans a partial admin discovery failure and restores every process boundary", async () => {
    if (!foreignUpstream) throw new Error("foreign sentinel is unavailable");
    const sentinelBefore = foreignUpstream;
    const upstreamId = await insertUpstream();
    const modelSlug = `catalog-partial-${randomUUID()}`;
    owned.adminModelSlugs.push(modelSlug);
    const draftId = await createDraft({ upstreamId, modelSlug });
    expect((await applyDraft(draftId)).status).toBe(200);

    const inducedDiscoveryFailure = new Error(
      "induced candidate lookup failure",
    );
    await expect(
      discoverAppliedAdminRows(modelSlug, upstreamId, async () => {
        throw inducedDiscoveryFailure;
      }),
    ).rejects.toBe(inducedDiscoveryFailure);
    expect(owned.models).toHaveLength(1);

    await cleanupOwnedRows();
    const residue = await query<{
      candidates: string;
      drafts: string;
      models: string;
      upstreams: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM model_upstreams WHERE upstream_id=$2) AS candidates,
         (SELECT count(*)::text FROM model_catalog_drafts WHERE id=$3::uuid) AS drafts,
         (SELECT count(*)::text FROM models WHERE slug=$1) AS models,
         (SELECT count(*)::text FROM upstreams WHERE id=$2) AS upstreams`,
      [modelSlug, upstreamId, draftId],
    );
    expect(residue.rows[0]).toEqual({
      candidates: "0",
      drafts: "0",
      models: "0",
      upstreams: "0",
    });
    const sentinelAfter = await query<{ row: string }>(
      "SELECT to_jsonb(u)::text AS row FROM upstreams u WHERE id=$1",
      [sentinelBefore.id],
    );
    expect(sentinelAfter.rows).toEqual([{ row: sentinelBefore.row }]);

    const suiteEnvironment = snapshotEnvironment(process.env);
    try {
      process.env.AIAG_ADMIN_KEY = "existing-admin";
      delete process.env.AIAG_ADMIN_RATE_LIMIT;
      process.env.LOG_LEVEL = "debug";
      const expected = snapshotEnvironment(process.env);
      process.env.AIAG_ADMIN_KEY = "mutated-admin";
      process.env.AIAG_ADMIN_RATE_LIMIT = "mutated-rate";
      delete process.env.LOG_LEVEL;
      restoreEnvironment(process.env, expected);
      expect(snapshotEnvironment(process.env)).toEqual(expected);
    } finally {
      restoreEnvironment(process.env, suiteEnvironment);
    }

    const firstCloseFailure = new Error("induced gateway close failure");
    const closeCalls: string[] = [];
    await expect(
      closeBothPreservingFirstError(
        async () => {
          closeCalls.push("gateway");
          throw firstCloseFailure;
        },
        async () => {
          closeCalls.push("database");
        },
      ),
    ).rejects.toBe(firstCloseFailure);
    expect(closeCalls).toEqual(["gateway", "database"]);
  });

  it("does not bump for real key telemetry or ledger mutations", async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const keyId = randomUUID();
    const transactionId = randomUUID();
    owned.users.push(userId);
    owned.orgs.push(orgId);
    owned.keys.push(keyId);
    owned.transactions.push(transactionId);

    const before = await revision();
    await query("INSERT INTO users(id,email) VALUES($1::uuid,$2)", [
      userId,
      `catalog-${userId}@example.test`,
    ]);
    await query(
      `INSERT INTO organizations(id,slug,name,owner_id)
       VALUES($1::uuid,$2,'Catalog revision fixture',$3::uuid)`,
      [orgId, `catalog-${orgId}`, userId],
    );
    await query(
      `INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix)
       VALUES($1::uuid,$2::uuid,'Catalog revision key',$3,$4)`,
      [
        keyId,
        orgId,
        randomUUID().replaceAll("-", ""),
        `cat_${keyId.slice(0, 12)}`,
      ],
    );
    await query(
      `INSERT INTO gateway_transactions
         (id,org_id,request_id,type,source,delta,metadata)
       VALUES($1::uuid,$2::uuid,$3,'refill','worker',1,'{}'::jsonb)`,
      [transactionId, orgId, `catalog-${randomUUID()}`],
    );
    expect(await revision()).toBe(before);

    await query(
      "UPDATE gateway_api_keys SET last_used_at=clock_timestamp() WHERE id=$1::uuid",
      [keyId],
    );
    await query(
      `UPDATE gateway_transactions
          SET metadata=jsonb_build_object('catalog_revision_probe',TRUE)
        WHERE id=$1::uuid`,
      [transactionId],
    );
    expect(await revision()).toBe(before);
  });
});
