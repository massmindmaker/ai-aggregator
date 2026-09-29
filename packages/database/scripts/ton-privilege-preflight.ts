/** Read-only privilege inventory. Never grants access or authorizes runtime settlement. */
import type { TestDatabaseClient } from "./test-db-guard";
export type TonPrivilegeReader = Pick<TestDatabaseClient, "query">;
export interface TonRuntimeRoles {
  web: string;
  api: string;
  worker: string;
}
export interface TonPrivilegeFinding {
  code: string;
  severity: "blocker" | "review";
  role?: string;
  object?: string;
}
export interface TonPrivilegeReport {
  schemaVersion: 1;
  status: "blocked" | "review_required";
  runtimeSettlementAllowed: false;
  roles: TonRuntimeRoles | null;
  database: string | null;
  auditRole: string | null;
  serverVersion: number | null;
  findings: TonPrivilegeFinding[];
}
const protectedTables = [
  "ton_invoices",
  "ton_chain_events",
  "ton_invoice_event_decisions",
  "ton_chain_observations",
  "ton_reconciliation_cursors",
  "gateway_transactions",
  "organizations",
  "payments",
] as const;
const triggerManifest = [
  ["ton_invoices", "ton_invoice_guard", "aiag_ton_invoice_guard_v1"],
  ["ton_chain_events", "ton_event_immutable", "aiag_ton_event_immutable_v1"],
  [
    "ton_invoice_event_decisions",
    "ton_decision_immutable",
    "aiag_ton_decision_immutable_v1",
  ],
  [
    "gateway_transactions",
    "ton_receipt_immutable",
    "aiag_ton_receipt_immutable_v1",
  ],
  [
    "ton_invoices",
    "ton_invoice_consistent",
    "aiag_ton_settlement_consistent_v1",
  ],
  [
    "ton_invoice_event_decisions",
    "ton_decision_consistent",
    "aiag_ton_settlement_consistent_v1",
  ],
  [
    "gateway_transactions",
    "ton_receipt_consistent",
    "aiag_ton_settlement_consistent_v1",
  ],
] as const;
function blank(): TonPrivilegeReport {
  return {
    schemaVersion: 1,
    status: "blocked",
    runtimeSettlementAllowed: false,
    roles: null,
    database: null,
    auditRole: null,
    serverVersion: null,
    findings: [],
  };
}
export function parseTonAuditRoles(value: TonRuntimeRoles): TonRuntimeRoles {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw Error("invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some((k) => !["web", "api", "worker"].includes(String(k)))
  )
    throw Error("invalid");
  const result = {} as TonRuntimeRoles;
  for (const name of ["web", "api", "worker"] as const) {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (
      !field ||
      !("value" in field) ||
      typeof field.value !== "string" ||
      field.value.length > 63 ||
      !/^[a-z][a-z0-9_]*$/.test(field.value)
    )
      throw Error("invalid");
    result[name] = field.value;
  }
  return result;
}
function finish(report: TonPrivilegeReport): TonPrivilegeReport {
  report.findings = [
    ...new Map(report.findings.map((f) => [JSON.stringify(f), f])).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  report.status = report.findings.some((f) => f.severity === "blocker")
    ? "blocked"
    : "review_required";
  return report;
}
const reachable = `WITH runtime AS (
 SELECT role.oid,role.rolname,CASE role.rolname WHEN $1 THEN 'web' WHEN $2 THEN 'api' ELSE 'worker' END AS purpose
 FROM pg_catalog.pg_roles role WHERE role.rolname=ANY(ARRAY[$1,$2,$3]::text[])
), settable AS (
 SELECT original.rolname AS runtime_name,original.purpose,r.oid FROM runtime original CROSS JOIN pg_catalog.pg_roles r
 WHERE r.oid=original.oid OR pg_catalog.pg_has_role(original.oid,r.oid,'SET')
), effective AS (
 SELECT DISTINCT s.runtime_name,s.purpose,r.oid,r.rolname FROM settable s CROSS JOIN pg_catalog.pg_roles r
 WHERE r.oid=s.oid OR pg_catalog.pg_has_role(s.oid,r.oid,'USAGE')
)`;

/** Uses catalog SELECTs only. Caller owns connection and transaction; see withTonPrivilegeSnapshot. */
export async function inspectTonPrivileges(
  client: TonPrivilegeReader,
  input: TonRuntimeRoles,
): Promise<TonPrivilegeReport> {
  const report = blank();
  const add = (
    code: string,
    role?: string,
    object?: string,
    severity: "blocker" | "review" = "blocker",
  ) =>
    report.findings.push({
      code,
      severity,
      ...(role ? { role } : {}),
      ...(object ? { object } : {}),
    });
  let roles: TonRuntimeRoles;
  try {
    roles = parseTonAuditRoles(input);
    report.roles = roles;
  } catch {
    add("INVALID_ROLE_CONTRACT");
    return finish(report);
  }
  const parameters = [roles.web, roles.api, roles.worker];
  if (new Set(parameters).size !== 3) {
    add("SHARED_RUNTIME_ROLE");
    return finish(report);
  }
  async function rows<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = parameters,
  ): Promise<T[]> {
    const r = await client.query<T>({ text, values });
    if (!Array.isArray(r.rows) || r.rows.length > 5000)
      throw Error("catalog_limit");
    return r.rows;
  }
  try {
    const meta = (
      await rows<{ database: string; audit_role: string; version: number }>(
        `SELECT current_database()::text AS database,session_user::text AS audit_role,current_setting('server_version_num')::integer AS version`,
        [],
      )
    )[0];
    if (
      !meta ||
      typeof meta.database !== "string" ||
      typeof meta.audit_role !== "string" ||
      !Number.isInteger(meta.version)
    )
      throw Error("metadata");
    report.database = meta.database;
    report.auditRole = meta.audit_role;
    report.serverVersion = meta.version;
    if (meta.version < 160000) {
      add("POSTGRES_VERSION_UNSUPPORTED");
      return finish(report);
    }
    const declared = await rows<{ rolname: string; rolcanlogin: boolean }>(
      `SELECT rolname::text,rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=ANY(ARRAY[$1,$2,$3]::text[])`,
    );
    for (const role of parameters) {
      const found = declared.find((r) => r.rolname === role);
      if (!found) add("ROLE_MISSING", role);
      else if (!found.rolcanlogin) add("RUNTIME_ROLE_CANNOT_LOGIN", role);
    }
    if (declared.length !== 3) return finish(report);
    const elevated = await rows<{
      runtime_name: string;
      rolname: string;
      purpose: string;
    }>(
      reachable +
        `
   SELECT e.runtime_name::text,e.rolname::text,e.purpose FROM effective e JOIN pg_catalog.pg_roles r USING(oid)
   WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls`,
    );
    for (const r of elevated)
      add(
        r.purpose === "worker"
          ? "ELEVATED_WORKER_ROLE"
          : "ELEVATED_APPLICATION_ROLE",
        r.runtime_name,
        r.rolname,
      );
    const escalations = await rows<{ runtime_name: string; rolname: string }>(
      reachable +
        `
   SELECT e.runtime_name::text,r.rolname::text FROM effective e CROSS JOIN pg_catalog.pg_roles r
   WHERE e.purpose<>'worker' AND r.oid<>e.oid AND pg_catalog.pg_has_role(e.oid,r.oid,'MEMBER WITH ADMIN OPTION')`,
    );
    for (const r of escalations)
      add("APPLICATION_ROLE_ADMIN_OPTION", r.runtime_name, r.rolname);
    const schemas = await rows<{ runtime_name: string; schema_name: string }>(
      reachable +
        `
   SELECT DISTINCT e.runtime_name::text,n.nspname::text AS schema_name FROM effective e CROSS JOIN pg_catalog.pg_namespace n
   WHERE e.purpose<>'worker' AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
    AND pg_catalog.has_schema_privilege(e.oid,n.oid,'CREATE')`,
    );
    for (const r of schemas)
      add("APPLICATION_SCHEMA_CREATE", r.runtime_name, r.schema_name);
    const databases = await rows<{ runtime_name: string }>(
      reachable +
        `
   SELECT DISTINCT e.runtime_name::text FROM effective e WHERE e.purpose<>'worker'
    AND pg_catalog.has_database_privilege(e.oid,current_database(),'CREATE')`,
    );
    for (const r of databases)
      add("APPLICATION_DATABASE_CREATE", r.runtime_name, meta.database);
    const tables = await rows<{ name: string; kind: string; rls: boolean }>(
      `SELECT c.relname::text AS name,c.relkind::text AS kind,c.relrowsecurity AS rls
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
      [protectedTables],
    );
    for (const name of protectedTables) {
      const found = tables.find((t) => t.name === name);
      if (!found || found.kind !== "r")
        add("PROTECTED_TABLE_MISSING", undefined, name);
      else if (found.rls) add("UNREVIEWED_ROW_SECURITY", undefined, name);
    }
    const writes = await rows<{ runtime_name: string; object_name: string }>(
      reachable +
        `
   SELECT DISTINCT e.runtime_name::text,c.relname::text AS object_name FROM effective e CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE e.purpose<>'worker' AND n.nspname='public' AND c.relname=ANY($4::text[]) AND c.relkind IN('r','p') AND
    (pg_catalog.has_table_privilege(e.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR pg_catalog.has_any_column_privilege(e.oid,c.oid,'INSERT,UPDATE,REFERENCES'))`,
      [...parameters, protectedTables],
    );
    for (const r of writes)
      add("APPLICATION_PROTECTED_WRITE", r.runtime_name, r.object_name);
    const functions = await rows<{
      signature: string;
      definer: boolean;
      settings: string[] | null;
      oid: string;
    }>(
      `SELECT p.oid::regprocedure::text AS signature,p.prosecdef AS definer,p.proconfig AS settings,p.oid::text AS oid
   FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('public.aiag_settle_ton_invoice_v1(uuid,jsonb)')`,
      [],
    );
    const settlement = functions[0];
    if (!settlement) add("SETTLEMENT_FUNCTION_MISSING");
    else {
      if (
        settlement.definer ||
        !settlement.settings?.includes(
          "search_path=pg_catalog, public, pg_temp",
        )
      )
        add("SETTLEMENT_CONTRACT_CHANGED", undefined, settlement.signature);
      const access = await rows<{
        runtime_name: string;
        purpose: string;
        can_execute: boolean;
      }>(
        reachable +
          `
    SELECT DISTINCT e.runtime_name::text,e.purpose,pg_catalog.has_function_privilege(e.oid,$4::oid,'EXECUTE') AS can_execute FROM effective e`,
        [...parameters, settlement.oid],
      );
      for (const r of access)
        if (r.purpose !== "worker" && r.can_execute)
          add(
            "APPLICATION_SETTLEMENT_EXECUTE",
            r.runtime_name,
            settlement.signature,
          );
      if (!access.some((r) => r.purpose === "worker" && r.can_execute))
        add(
          "WORKER_SETTLEMENT_UNAVAILABLE",
          roles.worker,
          settlement.signature,
        );
    }
    const definers = await rows<{ runtime_name: string; signature: string }>(
      reachable +
        `
   SELECT DISTINCT e.runtime_name::text,p.oid::regprocedure::text AS signature FROM effective e CROSS JOIN pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE e.purpose<>'worker' AND p.prosecdef AND n.nspname NOT IN('pg_catalog','information_schema') AND pg_catalog.has_function_privilege(e.oid,p.oid,'EXECUTE')`,
    );
    for (const r of definers)
      add("UNREVIEWED_DEFINER", r.runtime_name, r.signature);
    const defaults = await rows<{ runtime_name: string; object_name: string }>(
      reachable +
        `
   SELECT DISTINCT e.runtime_name::text,pg_catalog.pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'*')||':'||d.defaclobjtype::text||':'||a.privilege_type AS object_name
   FROM effective e CROSS JOIN pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
   WHERE e.purpose<>'worker' AND (a.grantee=0 OR a.grantee=e.oid) AND
    ((d.defaclobjtype='r' AND a.privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) OR (d.defaclobjtype='f' AND a.privilege_type='EXECUTE') OR (d.defaclobjtype='n' AND a.privilege_type='CREATE'))`,
    );
    for (const r of defaults)
      add("APPLICATION_DEFAULT_GRANT", r.runtime_name, r.object_name);
    const triggers = await rows<{
      table_name: string;
      name: string;
      enabled: string;
      definer: boolean;
      function_name: string;
      function_schema: string;
      argument_count: number;
    }>(
      `SELECT c.relname::text AS table_name,t.tgname::text AS name,t.tgenabled::text AS enabled,p.prosecdef AS definer,p.proname::text AS function_name,fn.nspname::text AS function_schema,p.pronargs::int AS argument_count
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
   WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,
      [protectedTables],
    );
    for (const [table, name, functionName] of triggerManifest) {
      const found = triggers.find(
        (t) => t.table_name === table && t.name === name,
      );
      if (
        !found ||
        !["O", "A"].includes(found.enabled) ||
        found.definer ||
        found.function_schema !== "public" ||
        found.function_name !== functionName ||
        found.argument_count !== 0
      )
        add("PROTECTION_TRIGGER_MISSING", undefined, table + "." + name);
    }
    const workerTables = await rows<{
      name: string;
      kind: string;
      readable: boolean;
      insertable: boolean;
      updatable: boolean;
    }>(
      `SELECT c.relname::text AS name,c.relkind::text AS kind,pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') AS readable,
   pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT') AS insertable,pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE') AS updatable
   FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE r.rolname=$1 AND n.nspname='public' AND c.relname=ANY($2::text[])`,
      [
        roles.worker,
        [
          "users",
          "organizations",
          "payments",
          "ton_invoices",
          "ton_chain_events",
          "ton_invoice_event_decisions",
          "gateway_transactions",
        ],
      ],
    );
    for (const name of [
      "users",
      "organizations",
      "payments",
      "ton_invoices",
      "ton_chain_events",
      "ton_invoice_event_decisions",
      "gateway_transactions",
    ]) {
      if (!workerTables.some((row) => row.name === name))
        add("WORKER_INVOKER_RIGHTS_MISSING", roles.worker, name);
    }
    for (const row of workerTables) {
      if (
        row.kind !== "r" ||
        !row.readable ||
        ([
          "ton_chain_events",
          "ton_invoice_event_decisions",
          "gateway_transactions",
        ].includes(row.name) &&
          !row.insertable) ||
        (["ton_invoices", "organizations"].includes(row.name) && !row.updatable)
      )
        add("WORKER_INVOKER_RIGHTS_MISSING", roles.worker, row.name);
    }
    const helpers = await rows<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   JOIN pg_catalog.pg_roles r ON r.rolname=$1 WHERE n.nspname='public' AND p.proname LIKE 'aiag_ton_%' AND NOT pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')`,
      [roles.worker],
    );
    for (const row of helpers)
      add("WORKER_INVOKER_RIGHTS_MISSING", roles.worker, row.name);
    add("DEPLOYED_IDENTITY_NOT_PROVEN", undefined, undefined, "review");
    add(
      "TRANSITIVE_CODE_AND_NEW_GRANTS_REQUIRE_REVIEW",
      undefined,
      undefined,
      "review",
    );
  } catch {
    add("CATALOG_INSPECTION_FAILED");
  }
  return finish(report);
}

/** Exclusive connection only; closes its own snapshot even on failed catalog inspection. */
export async function withTonPrivilegeSnapshot(
  client: TonPrivilegeReader,
  roles: TonRuntimeRoles,
): Promise<TonPrivilegeReport> {
  let report = blank();
  try {
    await client.query({
      text: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    });
    await client.query({ text: "SET LOCAL statement_timeout='5s'" });
    await client.query({ text: "SET LOCAL lock_timeout='1s'" });
    await client.query({
      text: "SET LOCAL idle_in_transaction_session_timeout='10s'",
    });
    await client.query({ text: "SET LOCAL search_path=pg_catalog" });
    report = await inspectTonPrivileges(client, roles);
  } catch {
    report.findings.push({
      code: "AUDIT_SNAPSHOT_FAILED",
      severity: "blocker",
    });
  } finally {
    try {
      await client.query({ text: "ROLLBACK" });
    } catch {
      report.findings.push({
        code: "AUDIT_SNAPSHOT_CLOSE_FAILED",
        severity: "blocker",
      });
    }
  }
  return finish(report);
}
