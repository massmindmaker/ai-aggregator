import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discoverNativeMigrations,
  prepareMigrationSql,
  runNativeMigrations,
} from "../native-migrate";
import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type QueryConfig,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

function functionDefinitions(source: string): Map<string, string> {
  return new Map([...source.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)\([\s\S]*?\$\$;/g)].map(match => [match[1], match[0]]));
}

function assertLatestFunctionMirror(mirror: string, migrations: readonly string[]) {
  const latest = new Map<string, string>();
  for (const migration of migrations) for (const [name, definition] of functionDefinitions(migration)) latest.set(name, definition);
  const current = functionDefinitions(mirror);
  expect(current.size).toBeGreaterThan(0);
  expect([...current.keys()]).toEqual([...mirror.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)\(/g)].map(match => match[1]));
  for (const [name, definition] of current) expect(definition, `latest applied definition of ${name}`).toBe(latest.get(name));
}

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

describe.skipIf(!RUN_INTEGRATION)("native PostgreSQL baseline", () => {
  let client: TestDatabaseClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guardedClient) => {
        client = guardedClient;
        close = async () => undefined;

        const migrations = await discoverNativeMigrations();
        const before = await guardedClient.query<{
          version: string;
          checksum: string;
          applied_at: Date;
        }>({
          text: `
            SELECT version, checksum, applied_at
            FROM public.schema_migrations
            ORDER BY version
          `,
          values: [],
        });
        expect(before.rows).toHaveLength(migrations.length);
        expect(
          before.rows.some(
            ({ version }) =>
              version === "migrations/0066_topup_refund_clawback.sql",
          ),
        ).toBe(true);
        expect(
          before.rows.some(
            ({ version }) =>
              version === "migrations/0071_gateway_http_recovery_validation.sql",
          ),
        ).toBe(true);

        const rerun = await runNativeMigrations(guardedClient, migrations);
        expect(rerun.applied).toEqual([]);
        expect(rerun.skipped).toHaveLength(migrations.length);

        const after = await guardedClient.query<{
          version: string;
          checksum: string;
          applied_at: Date;
        }>({
          text: `
            SELECT version, checksum, applied_at
            FROM public.schema_migrations
            ORDER BY version
          `,
          values: [],
        });
        expect(after.rows).toEqual(before.rows);

        const originalEnd = guardedClient.end.bind(guardedClient);
        guardedClient.end = async () => undefined;
        close = async () => {
          await originalEnd();
        };
      },
    );
  });

  afterAll(async () => {
    await close?.();
  });

  it("contains the complete registration and money-path schema", async () => {
    const result = await client.query<{
      users: string | null;
      organizations: string | null;
      transactions: string | null;
      admissions: string | null;
      admission_events: string | null;
      settle_function: string | null;
      admit_function: string | null;
      dispatch_function: string | null;
      table_count: string;
    }>({
      text: `
        SELECT
          to_regclass($1)::text AS users,
          to_regclass($2)::text AS organizations,
          to_regclass($3)::text AS transactions,
          to_regprocedure($4)::text AS settle_function,
          to_regclass($5)::text AS admissions,
          to_regclass($6)::text AS admission_events,
          to_regprocedure($7)::text AS admit_function,
          to_regprocedure($8)::text AS dispatch_function,
          (SELECT COUNT(*)::text
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE') AS table_count
      `,
      values: [
        "public.users",
        "public.organizations",
        "public.gateway_transactions",
        "public.aiag_settle_charge_credits(uuid,character varying,bigint,jsonb)",
        "public.gateway_charge_admissions",
        "public.gateway_charge_admission_events",
        "public.aiag_admit_gateway_charge(uuid,uuid,uuid,character varying,character varying,character varying,character varying,bigint,jsonb,timestamp with time zone)",
        "public.aiag_mark_gateway_charge_dispatched(uuid,uuid,uuid,character varying,jsonb)",
      ],
    });

    expect(result.rows[0]).toMatchObject({
      users: "users",
      organizations: "organizations",
      transactions: "gateway_transactions",
      admissions: "gateway_charge_admissions",
      admission_events: "gateway_charge_admission_events",
    });
    expect(result.rows[0].settle_function).toContain(
      "aiag_settle_charge_credits",
    );
    expect(result.rows[0].admit_function).toContain(
      "aiag_admit_gateway_charge",
    );
    expect(result.rows[0].dispatch_function).toContain(
      "aiag_mark_gateway_charge_dispatched",
    );
    // 0073 adds catalog revisions; 0074 adds observations and reconciliation cursors.
    expect(Number(result.rows[0].table_count)).toBe(113);
  });

  it("verifies TON immutable schema, invoker entrypoints and exact mirror", async () => {
    const migration = await readFile(
      resolve("packages/database/migrations/0072_ton_invoice_core.sql"),
      "utf8",
    );
    const mirror = await readFile(
      resolve("packages/database/src/functions/ton-invoice-core.sql"),
      "utf8",
    );
    expect(migration).toContain(mirror.trim());
    for (const table of [
      "ton_invoices",
      "ton_chain_events",
      "ton_invoice_event_decisions",
    ]) {
      const result = await client.query({
        text: "SELECT to_regclass($1)::text AS name",
        values: [table],
      });
      expect(result.rows[0]?.name).toBe(table);
    }
    const expected = [...mirror.matchAll(/CREATE FUNCTION (\w+)\([^]*? AS \$\$([^]*?)\$\$;/g)];
    expect(expected).toHaveLength(18);
    const applied = await client.query<{ name: string; definition: string; invoker: boolean; public_execute: boolean; config: string[] }>({
      text: "SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition,NOT p.prosecdef AS invoker,p.proconfig AS config,EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname",
      values: [expected.map((match) => match[1])],
    });
    expect(applied.rows).toHaveLength(18);
    for (const match of expected) {
      const row = applied.rows.find((entry) => entry.name === match[1]);
      expect(row).toMatchObject({ invoker: true, public_execute: false, config: ["search_path=pg_catalog, public, pg_temp"] });
      expect(row?.definition.split("$function$")[1]?.trim()).toBe(match[2].trim());
    }
    const triggers = await client.query<{ name: string; enabled: string }>({
      text: "SELECT tgname AS name,tgenabled AS enabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname",
      values: [
        [
          "ton_invoice_guard",
          "ton_event_immutable",
          "ton_decision_immutable",
          "ton_receipt_immutable",
          "ton_invoice_consistent",
          "ton_decision_consistent",
          "ton_receipt_consistent",
        ],
      ],
    });
    expect(triggers.rows).toHaveLength(7);
    expect(triggers.rows.every((row) => row.enabled === "O")).toBe(true);
    const frozen = await readFile(
      resolve(
        "packages/database/migrations/0071_gateway_http_recovery_validation.sql",
      ),
    );
    expect(createHash("sha256").update(frozen).digest("hex")).toBe(
      "f2fe7fffa30cc03b79712c92b09a7c932ec7af6f84a6abfe759d201dd2eff173",
    );
  });

  it("keeps the gateway admission function mirror exact", async () => {
    const migration = await readFile(
      resolve(
        "packages/database/migrations/0068_gateway_durable_spending_quotas.sql",
      ),
      "utf8",
    );
    const mirror = await readFile(
      resolve("packages/database/src/functions/gateway-charge-admission.sql"),
      "utf8",
    );
    const terminalMigration = await readFile(resolve("packages/database/migrations/0070_gateway_http_terminal_recovery.sql"), "utf8");
    // Only the admission core is replaced in0070; latest wins, not any historical match.
    assertLatestFunctionMirror(mirror, [migration, terminalMigration]);
    const quotaMirror = await readFile(
      resolve(
        "packages/database/src/functions/gateway-durable-spending-quotas.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(quotaMirror.trim());
  });

  it("keeps HTTP storage mirror, immutable 0068, explicit old projections and all 76 migrations", async () => {
    const migration = await readFile(resolve("packages/database/migrations/0069_gateway_http_storage.sql"), "utf8");
    const mirror = await readFile(resolve("packages/database/src/functions/gateway-http-storage.sql"), "utf8");
    expect(migration).toContain(mirror.trim());
    const previous = await readFile(resolve("packages/database/migrations/0068_gateway_durable_spending_quotas.sql"));
    expect(createHash("sha256").update(previous).digest("hex")).toBe("b6ddc2382f92f45c0fcc51f8c8e46027faabf76de457009cb884844ddbb612a6");
    expect(await discoverNativeMigrations()).toHaveLength(76);
    const types = await client.query<{ name: string; fields: string[] }>({ text: `
      SELECT t.typname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS fields FROM pg_type t
      JOIN pg_attribute a ON a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped
      WHERE t.typname=ANY($1::text[]) GROUP BY t.typname ORDER BY t.typname`,
      values: [["gateway_http_claim_result_v1", "gateway_http_read_result_v1"]] });
    expect(types.rows).toEqual([
      { name: "gateway_http_claim_result_v1", fields: ["contract_version","org_id","api_key_id","billing_request_id","route_kind","billing_mode","idempotency_key_digest","request_fingerprint","created_at","did_claim"] },
      { name: "gateway_http_read_result_v1", fields: ["contract_version","status","billing_request_id","http_status","content_type","response_body","actual_cost_credits","stored_at","expires_at"] }
    ]);
    const tables = await client.query({ text: "SELECT to_regclass($1)::text AS requests,to_regclass($2)::text AS results", values: ["gateway_http_requests", "gateway_http_results"] });
    expect(tables.rows[0]).toEqual({ requests: "gateway_http_requests", results: "gateway_http_results" });
  });

  it("keeps terminal mirror, frozen0069 and exact new SQL projections", async () => {
    const migration = await readFile(resolve("packages/database/migrations/0070_gateway_http_terminal_recovery.sql"), "utf8");
    const mirror = await readFile(resolve("packages/database/src/functions/gateway-http-terminal-recovery.sql"), "utf8");
    const validationMigration = await readFile(resolve("packages/database/migrations/0071_gateway_http_recovery_validation.sql"), "utf8");
    assertLatestFunctionMirror(mirror, [migration, validationMigration]);
    expect(createHash("sha256").update(migration).digest("hex")).toBe("b38ebb05871648feed2085526b89cdfced8e69328c645b4b0f6a944c664a6efa");
    const previous = await readFile(resolve("packages/database/migrations/0069_gateway_http_storage.sql"));
    expect(createHash("sha256").update(previous).digest("hex")).toBe("f6649670ea6aee06c0e3d79b92a0e4db355e99551815a74287a0f4bb784c22a2");
    const types = await client.query({text: `SELECT t.typname AS name,array_agg(a.attname::text ORDER BY a.attnum) AS fields FROM pg_type t
      JOIN pg_attribute a ON a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped
      WHERE t.typname=ANY($1::text[]) GROUP BY t.typname ORDER BY t.typname`,values:[["gateway_http_admit_result_v1","gateway_http_read_result_v2"]]});
    expect(types.rows).toEqual([
      {name:"gateway_http_admit_result_v1",fields:["org_id","api_key_id","billing_request_id","status","admission","rejection_code","http_status","response_body","terminal_at","did_transition"]},
      {name:"gateway_http_read_result_v2",fields:["contract_version","status","billing_request_id","http_status","content_type","response_body","actual_cost_credits","stored_at","expires_at","rejection_code"]},
    ]);
    expect((await client.query({text:"SELECT to_regclass('gateway_http_rejections')::text AS name",values:[]})).rows[0].name).toBe("gateway_http_rejections");
  });

  it("rejects stale mirrors even when their bodies exist in earlier applied migrations", async () => {
    const paths = ["migrations/0068_gateway_durable_spending_quotas.sql", "migrations/0070_gateway_http_terminal_recovery.sql", "migrations/0071_gateway_http_recovery_validation.sql", "src/functions/gateway-charge-admission.sql", "src/functions/gateway-http-terminal-recovery.sql"];
    const [quota, terminal, validation, admissionMirror, terminalMirror] = await Promise.all(paths.map(path => readFile(resolve("packages/database", path), "utf8")));
    const admissionName = "aiag_admit_gateway_charge_impl", recoveryName = "aiag_recover_gateway_http_settlement_v1";
    const oldAdmission = functionDefinitions(quota).get(admissionName)!, currentAdmission = functionDefinitions(admissionMirror).get(admissionName)!;
    const oldRecovery = functionDefinitions(terminal).get(recoveryName)!, currentRecovery = functionDefinitions(terminalMirror).get(recoveryName)!;
    expect(oldAdmission).not.toBe(currentAdmission); expect(oldRecovery).not.toBe(currentRecovery);
    // Callback keeps literal SQL $$ delimiters; a replacement string would interpret $$ as $.
    expect(() => assertLatestFunctionMirror(admissionMirror.replace(currentAdmission, () => oldAdmission), [quota, terminal])).toThrow();
    expect(() => assertLatestFunctionMirror(terminalMirror.replace(currentRecovery, () => oldRecovery), [terminal, validation])).toThrow();
  });

  it("keeps immutable 0067 checksum, v2 signatures and six durable quota tables", async () => {
    const historical = await readFile(
      resolve(
        "packages/database/migrations/0067_gateway_charge_admissions.sql",
      ),
    );
    expect(createHash("sha256").update(historical).digest("hex")).toBe(
      "c13bba2c2c6cd8443790ec7587bfd42860ac0a79de10c3edea856f978737b7e3",
    );
    const tables = [
      "gateway_quota_org_policies",
      "gateway_quota_key_policies",
      "gateway_quota_buckets",
      "gateway_charge_quota_contexts",
      "gateway_charge_quota_reservations",
      "gateway_charge_quota_events",
    ];
    const result = await client.query<{ name: string | null }>({
      text: "SELECT to_regclass(name)::text name FROM unnest($1::text[]) name",
      values: [tables],
    });
    expect(result.rows.map((row) => row.name)).toEqual(tables);
    const functions = await client.query<{
      admit: string | null;
      outcome: string | null;
    }>({
      text: "SELECT to_regprocedure($1)::text admit, to_regprocedure($2)::text outcome",
      values: [
        "aiag_admit_gateway_charge_v2(uuid,uuid,uuid,character varying,character varying,character varying,character varying,bigint,jsonb,timestamp with time zone,character varying,jsonb)",
        "aiag_record_gateway_charge_outcome_v2(uuid,uuid,bigint,jsonb,character varying)",
      ],
    });
    expect(functions.rows[0].admit).toContain("aiag_admit_gateway_charge_v2");
    expect(functions.rows[0].outcome).toContain(
      "aiag_record_gateway_charge_outcome_v2",
    );
    const schema = await import("../../src/schema/gateway");
    for (const column of [
      schema.gatewayQuotaOrgPolicies.dailySupplierUsdMicroLimitV2,
      schema.gatewayQuotaKeyPolicies.sessionMicrocreditsLimitV2,
      schema.gatewayQuotaBuckets.reservedAmount,
      schema.gatewayQuotaBuckets.settledAmount,
      schema.gatewayChargeQuotaContexts.supplierAuthorizedMaxUsdMicro,
      schema.gatewayChargeQuotaContexts.supplierActualUsdMicro,
      schema.gatewayChargeQuotaReservations.limitSnapshot,
      schema.gatewayChargeQuotaReservations.reservedMax,
      schema.gatewayChargeQuotaReservations.actualAmount,
      schema.gatewayChargeQuotaEvents.reservedDelta,
      schema.gatewayChargeQuotaEvents.settledDelta,
      schema.gatewayChargeQuotaEvents.releasedAmount,
    ]) {
      expect(column.getSQLType()).toBe("bigint");
      expect(column.mapFromDriverValue("9007199254740993")).toBe(
        9007199254740993n,
      );
    }
  });

  it("contains the additive refund admission guard without changing legacy settlement", async () => {
    const result = await client.query<{
      refund_debt_credits: string;
      refund_claim_id: string;
      refund_provider_key: string;
      refund_dispatched_at: string;
      active_claim_index: string | null;
      refund_receipt_index: string | null;
      admission_guard: string | null;
      admission_guard_definition: string;
      settlement_definition: string;
    }>({
      text: `
        SELECT
          (SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'organizations'
              AND column_name = 'refund_debt_credits') AS refund_debt_credits,
          (SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payments'
              AND column_name = 'refund_claim_id') AS refund_claim_id,
          (SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payments'
              AND column_name = 'refund_provider_key') AS refund_provider_key,
          (SELECT data_type
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payments'
              AND column_name = 'refund_dispatched_at') AS refund_dispatched_at,
          to_regclass('public.payments_active_topup_refund_claim_idx')::text AS active_claim_index,
          to_regclass('public.gateway_transactions_refund_uniq')::text AS refund_receipt_index,
          to_regprocedure(
            'public.aiag_assert_refund_admission_allowed(uuid)'
          )::text AS admission_guard,
          pg_get_functiondef(
            'public.aiag_assert_refund_admission_allowed(uuid)'::regprocedure
          ) AS admission_guard_definition,
          pg_get_functiondef(
            'public.aiag_settle_charge_credits(uuid,character varying,bigint,jsonb)'::regprocedure
          ) AS settlement_definition
      `,
      values: [],
    });

    expect(result.rows[0]).toMatchObject({
      refund_debt_credits: "bigint",
      refund_claim_id: "uuid",
      refund_provider_key: "character varying",
      refund_dispatched_at: "timestamp with time zone",
      active_claim_index: "payments_active_topup_refund_claim_idx",
      refund_receipt_index: "gateway_transactions_refund_uniq",
      admission_guard: "aiag_assert_refund_admission_allowed(uuid)",
    });
    expect(result.rows[0].admission_guard_definition).toContain(
      "REFUND_BLOCKED",
    );
    expect(result.rows[0].settlement_definition).not.toContain(
      "REFUND_BLOCKED",
    );
    expect(result.rows[0].settlement_definition).not.toContain(
      "refund_debt_credits",
    );
  });

  it("keeps both legacy actor_id and compatible actor_email audit indexes", async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      {
        text: `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
        ORDER BY indexname
      `,
        values: [["audit_log_actor_email_idx", "audit_log_actor_idx"]],
      },
    );

    expect(indexes.rows).toHaveLength(2);
    expect(
      indexes.rows.find(({ indexname }) => indexname === "audit_log_actor_idx")
        ?.indexdef,
    ).toMatch(/\(actor_id\)/);
    expect(
      indexes.rows.find(
        ({ indexname }) => indexname === "audit_log_actor_email_idx",
      )?.indexdef,
    ).toMatch(/\(actor_email\)/);
  });

  it("0005 accepts user-only and author-only payouts but rejects neither", async () => {
    const migrations = await discoverNativeMigrations();
    const migration = migrations.find(
      ({ version }) => version === "migrations/0005_contests.sql",
    );
    const prepared = prepareMigrationSql(migration!);
    const compatibilityCheck = prepared.text.indexOf("table_name = 'payouts'");
    const adapterStart = prepared.text.lastIndexOf(
      "DO $$ BEGIN",
      compatibilityCheck,
    );
    const adapterEnd = prepared.text.indexOf("END $$;", adapterStart);
    expect(compatibilityCheck).toBeGreaterThanOrEqual(0);
    expect(adapterStart).toBeGreaterThanOrEqual(0);
    expect(adapterEnd).toBeGreaterThan(adapterStart);
    const adapter = prepared.text.slice(
      adapterStart,
      adapterEnd + "END $$;".length,
    );

    await client.query({ text: "BEGIN", values: [] });
    try {
      const canonical = await client.query<{
        author_id: string | null;
        user_id: string | null;
      }>({
        text: `
          SELECT
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payouts'
              AND column_name = 'author_id'
          ) AS author_id,
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payouts'
              AND column_name = 'user_id'
          ) AS user_id
        `,
        values: [],
      });
      expect(canonical.rows[0]).toEqual({
        author_id: null,
        user_id: "user_id",
      });

      await client.query({ text: adapter, values: [] });
      const withoutLegacyColumn = await client.query<{
        index_name: string | null;
      }>({
        text: "SELECT to_regclass($1)::text AS index_name",
        values: ["public.payouts_author_idx"],
      });
      expect(withoutLegacyColumn.rows[0].index_name).toBeNull();

      await client.query({ text: "SAVEPOINT author_only", values: [] });
      await client.query({
        text: `
          ALTER TABLE public.payouts DROP COLUMN user_id CASCADE;
          ALTER TABLE public.payouts ADD COLUMN author_id UUID
        `,
        values: [],
      });
      await client.query({ text: adapter, values: [] });
      const legacy = await client.query<{ indexdef: string }>({
        text: `
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = $1
        `,
        values: ["payouts_author_idx"],
      });
      expect(legacy.rows[0].indexdef).toMatch(/\(author_id\)/);
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }

    const beforeLedger = await client.query<{
      checksum: string;
      effective_checksum: string;
      applied_at: Date;
    }>({
      text: `
        SELECT checksum, effective_checksum, applied_at
        FROM public.schema_migrations
        WHERE version = $1
      `,
      values: ["migrations/0005_contests.sql"],
    });
    const migratorQueries: QueryConfig[] = [];
    const migrationClient: TestDatabaseClient = {
      async connect() {},
      async end() {},
      async query<
        Row extends Record<string, unknown> = Record<string, unknown>,
      >(config: QueryConfig) {
        migratorQueries.push(config);
        // Present 0005 as pending so the real migrator exercises the adapter;
        // every SQL statement and the surrounding rollback still hit PostgreSQL.
        if (
          config.text.includes("SELECT version, checksum, effective_checksum")
        ) {
          return { rows: [] as Row[], rowCount: 0 };
        }
        return client.query<Row>(config);
      },
    };

    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query({
        text: "ALTER TABLE public.payouts DROP COLUMN user_id CASCADE",
        values: [],
      });
      await expect(
        runNativeMigrations(migrationClient, [
          {
            version: "migrations/0005_contests.sql",
            filename: "0005_contests.sql",
            sql: "CREATE INDEX IF NOT EXISTS payouts_author_idx ON payouts(author_id);",
            checksum: "0005-neither-column-probe",
          },
        ]),
      ).rejects.toThrow(/unsupported payouts schema/i);
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }

    expect(
      migratorQueries.some(({ text }) =>
        text.includes("INSERT INTO public.schema_migrations"),
      ),
    ).toBe(false);
    const restored = await client.query<{
      user_id: string | null;
      ledger_count: string;
      checksum: string;
      effective_checksum: string;
      applied_at: Date;
    }>({
      text: `
        SELECT
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'payouts'
              AND column_name = 'user_id'
          ) AS user_id,
          COUNT(*)::text AS ledger_count,
          MIN(checksum) AS checksum,
          MIN(effective_checksum) AS effective_checksum,
          MIN(applied_at) AS applied_at
        FROM public.schema_migrations
        WHERE version = $1
      `,
      values: ["migrations/0005_contests.sql"],
    });
    expect(restored.rows[0]).toEqual({
      user_id: "user_id",
      ledger_count: "1",
      ...beforeLedger.rows[0],
    });
  });

  it("0011 compatibility upgrades an early audit table and rolls back on a later error", async () => {
    const migrations = await discoverNativeMigrations();
    const migration = migrations.find(
      ({ version }) => version === "migrations/0011_admin.sql",
    );
    expect(migration).toBeDefined();
    const prepared = prepareMigrationSql(migration!);
    const historicalStart = prepared.text.indexOf(
      "CREATE TABLE IF NOT EXISTS audit_log",
    );
    const prelude = prepared.text.slice(0, historicalStart);

    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query({
        text: `
          ALTER TABLE public.audit_log
            DROP COLUMN actor_email CASCADE,
            DROP COLUMN details,
            DROP COLUMN ip_address
        `,
        values: [],
      });
      await client.query({
        text: "SAVEPOINT before_compatibility",
        values: [],
      });

      await client.query(prepared);
      const upgraded = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>({
        text: `
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'audit_log'
            AND column_name = ANY($1::text[])
          ORDER BY column_name
        `,
        values: [["actor_email", "details", "ip_address"]],
      });
      expect(upgraded.rows).toEqual([
        {
          column_name: "actor_email",
          data_type: "character varying",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "details",
          data_type: "jsonb",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "ip_address",
          data_type: "character varying",
          is_nullable: "YES",
          column_default: null,
        },
      ]);

      await client.query({
        text: "ROLLBACK TO SAVEPOINT before_compatibility",
        values: [],
      });
      const early = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'audit_log'
            AND column_name = ANY($1::text[])
        `,
        values: [["actor_email", "details", "ip_address"]],
      });
      expect(early.rows[0].count).toBe("0");

      await client.query({ text: "SAVEPOINT before_failure", values: [] });
      await expect(
        client.query({ text: `${prelude}\nSELECT 1 / 0`, values: [] }),
      ).rejects.toThrow();
      await client.query({
        text: "ROLLBACK TO SAVEPOINT before_failure",
        values: [],
      });
      const afterFailure = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'audit_log'
            AND column_name = ANY($1::text[])
        `,
        values: [["actor_email", "details", "ip_address"]],
      });
      expect(afterFailure.rows[0].count).toBe("0");
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("0011 compatibility is additive on an already complete audit table", async () => {
    const migrations = await discoverNativeMigrations();
    const migration = migrations.find(
      ({ version }) => version === "migrations/0011_admin.sql",
    );
    const prepared = prepareMigrationSql(migration!);
    const readColumns = () =>
      client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>({
        text: `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'audit_log'
          ORDER BY ordinal_position
        `,
        values: [],
      });
    const before = await readColumns();

    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query(prepared);
      const after = await readColumns();
      expect(after.rows).toEqual(before.rows);
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("rolls back DDL and the ledger row when a migration fails after DDL", async () => {
    const probeVersion = "test/rollback-after-ddl.sql";
    await expect(
      runNativeMigrations(client, [
        {
          version: probeVersion,
          filename: "rollback-after-ddl.sql",
          sql: `
            CREATE TABLE public._aiag_rollback_probe (id INTEGER PRIMARY KEY);
            SELECT 1 / 0;
          `,
          checksum: "rollback-probe-v1",
        },
      ]),
    ).rejects.toThrow();

    const result = await client.query<{
      table_name: string | null;
      ledger_rows: string;
    }>({
      text: `
        SELECT
          to_regclass($1)::text AS table_name,
          (SELECT COUNT(*)::text
             FROM public.schema_migrations
            WHERE version = $2) AS ledger_rows
      `,
      values: ["public._aiag_rollback_probe", probeVersion],
    });
    expect(result.rows[0]).toEqual({ table_name: null, ledger_rows: "0" });
  });

  it("settles subscription then payg atomically and is idempotent", async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const email = `native-money-${userId}@example.test`;
    const requestId = `native-money-${randomUUID()}`;

    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query({
        text: "INSERT INTO public.users (id, email, name) VALUES ($1::uuid, $2, $3)",
        values: [userId, email, "Native money fixture"],
      });
      await client.query({
        text: `
          INSERT INTO public.organizations (
            id, slug, name, owner_id, subscription_credits, payg_credits
          ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::bigint, $6::bigint)
        `,
        values: [
          orgId,
          `native-money-${orgId}`,
          "Native money org",
          userId,
          7,
          11,
        ],
      });

      const first = await client.query<{
        sub_portion: string;
        payg_portion: string;
        new_sub: string;
        new_payg: string;
        idempotent: boolean;
      }>({
        text: `
          SELECT * FROM public.aiag_settle_charge_credits(
            $1::uuid, $2::varchar, $3::bigint, $4::jsonb
          )
        `,
        values: [
          orgId,
          requestId,
          10,
          JSON.stringify({ scenario: "native-baseline" }),
        ],
      });
      expect(first.rows[0]).toEqual({
        sub_portion: "7",
        payg_portion: "3",
        new_sub: "0",
        new_payg: "8",
        idempotent: false,
      });

      const replay = await client.query<{
        sub_portion: string;
        payg_portion: string;
        new_sub: string;
        new_payg: string;
        idempotent: boolean;
      }>({
        text: `
          SELECT * FROM public.aiag_settle_charge_credits(
            $1::uuid, $2::varchar, $3::bigint, $4::jsonb
          )
        `,
        values: [orgId, requestId, 10, JSON.stringify({ scenario: "replay" })],
      });
      expect(replay.rows[0]).toEqual({
        sub_portion: "7",
        payg_portion: "3",
        new_sub: "0",
        new_payg: "8",
        idempotent: true,
      });

      const ledger = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM public.gateway_transactions
          WHERE org_id = $1::uuid AND request_id = $2
        `,
        values: [orgId, requestId],
      });
      expect(ledger.rows[0].count).toBe("2");
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("insufficient funds leaves the organization and ledger unchanged", async () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const requestId = `native-insufficient-${randomUUID()}`;

    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query({
        text: "INSERT INTO public.users (id, email) VALUES ($1::uuid, $2)",
        values: [userId, `native-insufficient-${userId}@example.test`],
      });
      await client.query({
        text: `
          INSERT INTO public.organizations (
            id, slug, name, owner_id, subscription_credits, payg_credits
          ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::bigint, $6::bigint)
        `,
        values: [
          orgId,
          `native-insufficient-${orgId}`,
          "Insufficient fixture",
          userId,
          2,
          1,
        ],
      });
      await client.query({ text: "SAVEPOINT before_settle", values: [] });

      await expect(
        client.query({
          text: `
            SELECT * FROM public.aiag_settle_charge_credits(
              $1::uuid, $2::varchar, $3::bigint, $4::jsonb
            )
          `,
          values: [orgId, requestId, 10, "{}"],
        }),
      ).rejects.toMatchObject({ code: "P0003" });
      await client.query({
        text: "ROLLBACK TO SAVEPOINT before_settle",
        values: [],
      });

      const result = await client.query<{
        subscription_credits: string;
        payg_credits: string;
        ledger_rows: string;
      }>({
        text: `
          SELECT subscription_credits::text,
                 payg_credits::text,
                 (SELECT COUNT(*)::text
                    FROM public.gateway_transactions
                   WHERE org_id = $1::uuid AND request_id = $2) AS ledger_rows
          FROM public.organizations
          WHERE id = $1::uuid
        `,
        values: [orgId, requestId],
      });
      expect(result.rows[0]).toEqual({
        subscription_credits: "2",
        payg_credits: "1",
        ledger_rows: "0",
      });
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });
});
