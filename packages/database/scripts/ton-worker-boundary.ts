import { closeOwnedPgClient } from "./owned-pg-cleanup";
/** Local role-deployment rehearsal. Never runs from application startup or against production. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "pg";
import type { TestDatabaseClient } from "./test-db-guard";
export type TonBoundaryClient = Pick<TestDatabaseClient, "query">;
export interface TonBoundaryRoles {
  web: string;
  api: string;
  worker: string;
  owner: string;
}
const names = ["web", "api", "worker", "owner"] as const;
const protectedTables = [
  "ton_invoices",
  "ton_chain_events",
  "ton_invoice_event_decisions",
  "ton_chain_observations",
  "ton_reconciliation_cursors",
  "gateway_transactions",
  "organizations",
  "payments",
];
const triggerManifest = [
  ["ton_invoices", "ton_invoice_guard", "aiag_ton_invoice_guard_v1", 31, false],
  [
    "ton_chain_events",
    "ton_event_immutable",
    "aiag_ton_event_immutable_v1",
    27,
    false,
  ],
  [
    "ton_invoice_event_decisions",
    "ton_decision_immutable",
    "aiag_ton_decision_immutable_v1",
    27,
    false,
  ],
  [
    "gateway_transactions",
    "ton_receipt_immutable",
    "aiag_ton_receipt_immutable_v1",
    27,
    false,
  ],
  [
    "ton_invoices",
    "ton_invoice_consistent",
    "aiag_ton_settlement_consistent_v1",
    21,
    true,
  ],
  [
    "ton_invoice_event_decisions",
    "ton_decision_consistent",
    "aiag_ton_settlement_consistent_v1",
    5,
    true,
  ],
  [
    "gateway_transactions",
    "ton_receipt_consistent",
    "aiag_ton_settlement_consistent_v1",
    5,
    true,
  ],
] as const;
const ownerFunctions = [
  "aiag_settle_ton_invoice_v1",
  "aiag_ton_credit_v1",
  "aiag_ton_keys_v1",
  "aiag_ton_text_v1",
  "aiag_ton_asset_v1",
  "aiag_ton_time_v1",
  "aiag_ton_atomic_v1",
  "aiag_ton_receipt_json_v1",
  "aiag_ton_invoice_guard_v1",
  "aiag_ton_settlement_consistent_v1",
  "aiag_ton_receipt_immutable_v1",
  "aiag_ton_event_immutable_v1",
  "aiag_ton_decision_immutable_v1",
];
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function fail(code: string): never {
  throw Error(code);
}
export function parseTonBoundaryRoles(value: unknown): TonBoundaryRoles {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("TON_BOUNDARY_ROLES_INVALID");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some(
      (k) =>
        typeof k !== "string" || !names.includes(k as (typeof names)[number]),
    )
  )
    fail("TON_BOUNDARY_ROLES_INVALID");
  const result = {} as TonBoundaryRoles;
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (
      !d ||
      !("value" in d) ||
      !d.enumerable ||
      typeof d.value !== "string" ||
      d.value.length > 63 ||
      d.value.trim() !== d.value ||
      !/^[a-z][a-z0-9_]*$/.test(d.value) ||
      d.value.startsWith("pg_")
    )
      fail("TON_BOUNDARY_ROLES_INVALID");
    result[name] = d.value;
  }
  if (new Set(Object.values(result)).size !== 4)
    fail("TON_BOUNDARY_ROLES_INVALID");
  return result;
}
interface CoreFunction {
  name: string;
  signature: string;
  hash: string;
  language: string;
  volatility: string;
  result: string;
}
async function sourceManifest(): Promise<CoreFunction[]> {
  const source = await readFile(
    new URL("../src/functions/ton-invoice-core.sql", import.meta.url),
    "utf8",
  );
  const matches = [
    ...source.matchAll(
      /CREATE FUNCTION ([a-z0-9_]+)\(([^)]*)\) RETURNS ([A-Z]+) LANGUAGE (SQL|plpgsql)([\s\S]*?) AS \$\$([\s\S]*?)\$\$;/g,
    ),
  ];
  if (matches.length !== 18) fail("TON_BOUNDARY_SOURCE_INVALID");
  return matches.map(([, name, args, output, language, attributes, body]) => {
    const types = args
      ? args.split(",").map((arg) =>
          arg
            .trim()
            .replace(/ DEFAULT .*/i, "")
            .split(/\s+/)
            .slice(1)
            .join(" ")
            .toLowerCase(),
        )
      : [];
    if (
      types.some(
        (t) =>
          ![
            "uuid",
            "jsonb",
            "ton_invoices",
            "text",
            "text[]",
            "integer",
            "boolean",
          ].includes(t),
      )
    )
      fail("TON_BOUNDARY_SOURCE_INVALID");
    return {
      name,
      signature:
        "public." +
        name +
        "(" +
        types
          .map((t) => (t === "ton_invoices" ? "public.ton_invoices" : t))
          .join(",") +
        ")",
      hash: digest(body),
      language: language.toLowerCase(),
      volatility: attributes.includes("IMMUTABLE")
        ? "i"
        : attributes.includes("STABLE")
          ? "s"
          : "v",
      result: output.toLowerCase(),
    };
  });
}
/** Private helper: only the freshly connected client owned below reaches this function. */
async function installOnOwnedClient(
  client: TonBoundaryClient,
  value: unknown,
): Promise<{
  schemaVersion: 1;
  kind: "installed_local_boundary";
  workerRole: string;
  ownerRole: string;
  sourceDigest: string;
  runtimeSettlementAllowed: false;
}> {
  const roles = parseTonBoundaryRoles(value),
    all = Object.values(roles),
    manifest = await sourceManifest();
  const query = async <R extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => (await client.query<R>({ text, values })).rows;
  const identity = (
    await query<{
      database: string;
      port: number;
      host: string;
      session_role: string;
      current_role: string;
      superuser: boolean;
    }>(`SELECT current_database() AS database,inet_server_port() AS port,pg_catalog.host(inet_server_addr()) AS host,session_user::text AS session_role,current_user::text AS current_role,
  (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser`)
  )[0];
  if (
    !identity ||
    identity.port !== 15432 ||
    identity.host !== "127.0.0.1" ||
    !/^aiag_author_http_[a-f0-9]{32}$/.test(identity.database) ||
    !identity.superuser ||
    identity.session_role !== identity.current_role
  )
    fail("TON_BOUNDARY_LOCAL_IDENTITY_REQUIRED");
  let begun = false;
  try {
    await query("BEGIN");
    begun = true;
    await query("SET LOCAL statement_timeout='10s'");
    await query("SET LOCAL lock_timeout='2s'");
    await query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    await query("SET LOCAL search_path=pg_catalog");
    const observedRoles = await query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname::text,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,
      [all],
    );
    if (
      observedRoles.length !== 4 ||
      observedRoles.some(
        (r) =>
          r.rolcanlogin === (r.rolname === roles.owner) ||
          r.rolsuper ||
          r.rolcreatedb ||
          r.rolcreaterole ||
          r.rolreplication ||
          r.rolbypassrls,
      )
    )
      fail("TON_BOUNDARY_ROLE_STATE_UNSAFE");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE r.rolname=ANY($1::text[]) OR g.rolname=ANY($1::text[]) LIMIT 1`,
          [all],
        )
      ).length
    )
      fail("TON_BOUNDARY_MEMBERSHIP_UNSAFE");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='aiag_ton_worker'`,
        )
      ).length
    )
      fail("TON_BOUNDARY_ALREADY_EXISTS");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=ANY($1::text[]) AND pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE') UNION ALL
   SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_namespace n WHERE r.rolname=ANY($1::text[]) AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') LIMIT 1`,
          [all],
        )
      ).length
    )
      fail("TON_BOUNDARY_SCHEMA_UNSAFE");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE r.rolname=ANY($1::text[]) AND n.nspname='public' AND c.relkind IN('r','p','v','f','m') AND
   (c.relowner=r.oid OR (c.relname=ANY($2::text[]) AND (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))) LIMIT 1`,
          [all, protectedTables],
        )
      ).length
    )
      fail("TON_BOUNDARY_DIRECT_WRITE_UNSAFE");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_catalog.pg_roles r
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND r.rolname=ANY($1::text[]) AND
    (p.proowner=r.oid OR (p.prosecdef AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) OR (p.proname='aiag_settle_ton_invoice_v1' AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'))) LIMIT 1`,
          [all],
        )
      ).length
    )
      fail("TON_BOUNDARY_FUNCTION_AUTHORITY_UNSAFE");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
   WHERE (a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]))) AND a.privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES','CREATE','EXECUTE') LIMIT 1`,
          [all],
        )
      ).length
    )
      fail("TON_BOUNDARY_DEFAULT_ACL_UNSAFE");
    for (const fn of manifest) {
      const row = (
        await query<{
          name: string;
          source: string;
          lang: string;
          definer: boolean;
          leakproof: boolean;
          kind: string;
          volatility: string;
          parallel: string;
          result: string;
          config: string[];
          owner: string;
        }>(
          `SELECT p.proname::text AS name,p.prosrc AS source,l.lanname::text AS lang,p.prosecdef AS definer,p.proleakproof AS leakproof,p.prokind::text AS kind,p.provolatile::text AS volatility,p.proparallel::text AS parallel,
    p.prorettype::regtype::text AS result,p.proconfig AS config,pg_catalog.pg_get_userbyid(p.proowner) AS owner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid=pg_catalog.to_regprocedure($1)`,
          [fn.signature],
        )
      )[0];
      if (
        !row ||
        row.name !== fn.name ||
        digest(row.source) !== fn.hash ||
        row.lang !== fn.language ||
        row.definer ||
        row.leakproof ||
        row.kind !== "f" ||
        row.volatility !== fn.volatility ||
        row.parallel !== "u" ||
        row.result !== fn.result ||
        JSON.stringify(row.config) !==
          JSON.stringify(["search_path=pg_catalog, public, pg_temp"]) ||
        all.includes(row.owner)
      )
        fail("TON_BOUNDARY_CORE_DRIFT");
    }
    const triggerRows = await query<{
      table_name: string;
      name: string;
      function_name: string;
      function_schema: string;
      type: number;
      enabled: string;
      deferrable: boolean;
      initially_deferred: boolean;
      args: string;
      columns: string;
      condition: boolean;
    }>(
      `SELECT c.relname::text AS table_name,t.tgname::text AS name,p.proname::text AS function_name,pn.nspname::text AS function_schema,t.tgtype::int AS type,t.tgenabled::text AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred,encode(t.tgargs,'hex') AS args,t.tgattr::text AS columns,t.tgqual IS NOT NULL AS condition
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,
      [protectedTables],
    );
    const writtenTables = [
      "ton_invoices",
      "ton_chain_events",
      "ton_invoice_event_decisions",
      "gateway_transactions",
      "organizations",
    ];
    if (
      triggerRows.filter((r) => writtenTables.includes(r.table_name)).length !==
      triggerManifest.length
    )
      fail("TON_BOUNDARY_TRIGGER_DRIFT");
    for (const [table, name, fn, type, deferred] of triggerManifest) {
      const row = triggerRows.find(
        (r) => r.table_name === table && r.name === name,
      );
      if (
        !row ||
        row.function_name !== fn ||
        row.function_schema !== "public" ||
        row.type !== type ||
        row.enabled !== "O" ||
        row.deferrable !== deferred ||
        row.initially_deferred !== deferred ||
        row.args !== "" ||
        row.columns !== "" ||
        row.condition
      )
        fail("TON_BOUNDARY_TRIGGER_DRIFT");
    }
    const requiredRelations = [...protectedTables, "users"];
    const relations = await query<{
      name: string;
      kind: string;
      rls: boolean;
      forced: boolean;
      owner: string;
    }>(
      `SELECT c.relname::text AS name,c.relkind::text AS kind,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,pg_catalog.pg_get_userbyid(c.relowner) AS owner
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
      [requiredRelations],
    );
    if (
      requiredRelations.some((name) => {
        const r = relations.find((row) => row.name === name);
        return (
          !r ||
          !["r", "p"].includes(r.kind) ||
          r.rls ||
          r.forced ||
          all.includes(r.owner)
        );
      })
    )
      fail("TON_BOUNDARY_RELATION_DRIFT");
    if (
      (
        await query(
          `SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) LIMIT 1`,
          [requiredRelations],
        )
      ).length
    )
      fail("TON_BOUNDARY_RELATION_DRIFT");
    // All names below have a strict lowercase identifier grammar; no values become executable SQL.
    const owner = '"' + roles.owner + '"',
      worker = '"' + roles.worker + '"';
    await query("CREATE SCHEMA aiag_ton_worker");
    await query("REVOKE ALL ON SCHEMA aiag_ton_worker FROM PUBLIC");
    await query(
      "GRANT USAGE ON SCHEMA public,aiag_ton_worker TO " + owner + "," + worker,
    );
    await query(
      "GRANT SELECT ON public.users,public.organizations,public.payments,public.ton_invoices,public.ton_chain_events,public.ton_invoice_event_decisions,public.gateway_transactions TO " +
        owner,
    );
    await query(
      "GRANT INSERT ON public.ton_chain_events,public.ton_invoice_event_decisions,public.gateway_transactions TO " +
        owner,
    );
    // SELECT FOR UPDATE requires UPDATE privilege; immutable event trigger still rejects actual updates.
    await query(
      "GRANT UPDATE(created_at) ON public.ton_chain_events TO " + owner,
    );
    await query(
      "GRANT UPDATE(status,review_reason,settled_event_id,receipt_id,updated_at,settled_at) ON public.ton_invoices TO " +
        owner,
    );
    await query(
      "GRANT UPDATE(payg_credits,updated_at) ON public.organizations TO " +
        owner,
    );
    for (const fn of manifest.filter((f) => ownerFunctions.includes(f.name)))
      await query("GRANT EXECUTE ON FUNCTION " + fn.signature + " TO " + owner);
    // Deferred consistency checks execute at COMMIT under the caller, with read-only helper authority.
    await query(
      "GRANT SELECT ON public.ton_invoices,public.ton_invoice_event_decisions,public.gateway_transactions TO " +
        worker,
    );
    await query(
      "GRANT EXECUTE ON FUNCTION public.aiag_ton_atomic_v1(jsonb,boolean,boolean),public.aiag_ton_text_v1(jsonb,text,integer) TO " +
        worker,
    );
    const body = `BEGIN
 IF SESSION_USER::text <> '${roles.worker}' THEN RAISE EXCEPTION 'TON_SETTLEMENT_SESSION_REQUIRED' USING ERRCODE='42501'; END IF;
 IF _invoice IS NULL OR _credit IS NULL OR pg_catalog.octet_length(_credit::text)>32768 THEN RAISE EXCEPTION 'TON_SETTLEMENT_INPUT_INVALID'; END IF;
 IF _credit->>'network' IS DISTINCT FROM 'tvm:-3' OR _credit->'asset'->>'kind' IS DISTINCT FROM 'native' OR _credit->'asset'->'decimals' IS DISTINCT FROM '9'::jsonb THEN RAISE EXCEPTION 'TON_SETTLEMENT_ASSET_UNSUPPORTED'; END IF;
 RETURN public.aiag_settle_ton_invoice_v1(_invoice,_credit);
END`;
    await query(
      "CREATE FUNCTION aiag_ton_worker.settle_invoice_v1(_invoice uuid,_credit jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $aiag$" +
        body +
        "$aiag$",
    );
    await query(
      "REVOKE ALL ON FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) FROM PUBLIC",
    );
    await query(
      "ALTER FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) OWNER TO " +
        owner,
    );
    await query(
      "GRANT EXECUTE ON FUNCTION aiag_ton_worker.settle_invoice_v1(uuid,jsonb) TO " +
        worker,
    );
    await query("COMMIT");
    begun = false;
    return {
      schemaVersion: 1,
      kind: "installed_local_boundary",
      workerRole: roles.worker,
      ownerRole: roles.owner,
      sourceDigest: digest(JSON.stringify(manifest)),
      runtimeSettlementAllowed: false,
    };
  } catch (error) {
    if (begun) await query("ROLLBACK").catch(() => {});
    if (error instanceof Error && /^TON_BOUNDARY_[A-Z_]+$/.test(error.message))
      throw error;
    fail("TON_BOUNDARY_INSTALL_FAILED");
  }
}

/** Owns a NEW connection, never accepts a caller transaction, and refuses all non-fixture destinations. */
export async function installTonWorkerBoundary(
  connectionString: string,
  value: unknown,
) {
  const roles = parseTonBoundaryRoles(value);
  try {
    if (
      process.env.AIAG_TEST_DATABASE !== "1" ||
      typeof connectionString !== "string" ||
      connectionString.length > 8192 ||
      connectionString.trim() !== connectionString
    )
      throw Error();
    const url = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "15432" ||
      !/^\/aiag_author_http_[a-f0-9]{32}$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      !url.username
    )
      throw Error();
  } catch {
    fail("TON_BOUNDARY_LOCAL_IDENTITY_REQUIRED");
  }
  const client = new Client({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 12000,
    options:
      "-c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000",
  });
  let result: Awaited<ReturnType<typeof installOnOwnedClient>> | undefined;
  let failure: Error | undefined;
  let clean = false;
  try {
    await client.connect();
    result = await installOnOwnedClient(
      {
        query: async <Row extends Record<string, unknown>>(config: {
          text: string;
          values?: readonly unknown[];
        }) => {
          const r = await client.query<Row>(config.text, [
            ...(config.values ?? []),
          ]);
          return { rows: r.rows, rowCount: r.rowCount };
        },
      },
      roles,
    );
  } catch (error) {
    failure =
      error instanceof Error && /^TON_BOUNDARY_[A-Z_]+$/.test(error.message)
        ? error
        : Error("TON_BOUNDARY_INSTALL_FAILED");
  } finally {
    clean = await closeOwnedPgClient(client);
  }
  if (!clean) throw Error("TON_BOUNDARY_CLOSE_UNCONFIRMED");
  if (failure) throw failure;
  if (!result) throw Error("TON_BOUNDARY_INSTALL_FAILED");
  return result;
}
