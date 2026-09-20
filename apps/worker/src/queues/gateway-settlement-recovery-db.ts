import { Pool, type QueryResult } from "pg";

import {
  parseGatewaySettlementRecoveryDatabaseUrl,
  type CanonicalRecoveryTimestamp,
  type CanonicalRecoveryUuid,
  type GatewaySettlementRecoveryAck,
  type GatewaySettlementRecoveryDb,
  type GatewaySettlementRecoveryHint,
  type GatewaySettlementRecoveryPosition,
  type GatewaySettlementRecoveryRoute,
  type GatewaySettlementRecoverySelectorPage,
} from "./gateway-settlement-recovery.js";

export const CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL = `
WITH cutoff AS (
  SELECT clock_timestamp() AS cycle_due_before
)
SELECT
  to_char(cutoff.cycle_due_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cycle_due_before,
  to_char(candidate.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS upper_reconcile_at,
  candidate.billing_request_id::text AS upper_billing_id
FROM cutoff
CROSS JOIN LATERAL (
  SELECT admission.reconcile_after, admission.billing_request_id
  FROM gateway_charge_admissions AS admission
  JOIN gateway_http_requests AS request
    ON request.org_id = admission.org_id
   AND request.api_key_id = admission.api_key_id
   AND request.billing_request_id = admission.billing_request_id
  JOIN gateway_http_results AS http_result
    ON http_result.org_id = admission.org_id
   AND http_result.api_key_id = admission.api_key_id
   AND http_result.billing_request_id = admission.billing_request_id
  JOIN gateway_charge_quota_contexts AS quota
    ON quota.org_id = admission.org_id
   AND quota.api_key_id = admission.api_key_id
   AND quota.billing_request_id = admission.billing_request_id
  WHERE admission.state = 'outcome_recorded'
    AND admission.outcome_kind = 'success'
    AND admission.route_kind = ANY($1::varchar[])
    AND admission.billing_mode = 'stored'
    AND admission.reconcile_after IS NOT NULL
    AND admission.reconcile_after <= cutoff.cycle_due_before
    AND admission.outcome_recorded_at IS NOT NULL
    AND admission.outcome_recorded_at <= cutoff.cycle_due_before
    AND request.contract_version = 1
    AND request.route_kind = admission.route_kind
    AND request.billing_mode = 'stored'
    AND http_result.contract_version = 1
    AND http_result.http_status = 200
    AND http_result.content_type = 'application/json'
    AND quota.quota_version = 2
    AND NOT EXISTS (
      SELECT 1
      FROM gateway_http_rejections AS rejection
      WHERE rejection.org_id = admission.org_id
        AND rejection.api_key_id = admission.api_key_id
        AND rejection.billing_request_id = admission.billing_request_id
    )
  ORDER BY admission.reconcile_after DESC, admission.billing_request_id DESC
  LIMIT 1
) AS candidate;
`;

export const SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL = `
SELECT
  admission.org_id::text AS org_id,
  admission.api_key_id::text AS api_key_id,
  admission.billing_request_id::text AS billing_request_id,
  to_char(admission.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_at
FROM gateway_charge_admissions AS admission
JOIN gateway_http_requests AS request
  ON request.org_id = admission.org_id
 AND request.api_key_id = admission.api_key_id
 AND request.billing_request_id = admission.billing_request_id
JOIN gateway_http_results AS http_result
  ON http_result.org_id = admission.org_id
 AND http_result.api_key_id = admission.api_key_id
 AND http_result.billing_request_id = admission.billing_request_id
JOIN gateway_charge_quota_contexts AS quota
  ON quota.org_id = admission.org_id
 AND quota.api_key_id = admission.api_key_id
 AND quota.billing_request_id = admission.billing_request_id
WHERE admission.state = 'outcome_recorded'
  AND admission.outcome_kind = 'success'
  AND admission.route_kind = ANY($1::varchar[])
  AND admission.billing_mode = 'stored'
  AND admission.reconcile_after IS NOT NULL
  AND admission.reconcile_after <= $2::timestamptz
  AND admission.outcome_recorded_at IS NOT NULL
  AND admission.outcome_recorded_at <= $2::timestamptz
  AND request.contract_version = 1
  AND request.route_kind = admission.route_kind
  AND request.billing_mode = 'stored'
  AND http_result.contract_version = 1
  AND http_result.http_status = 200
  AND http_result.content_type = 'application/json'
  AND quota.quota_version = 2
  AND NOT EXISTS (
    SELECT 1
    FROM gateway_http_rejections AS rejection
    WHERE rejection.org_id = admission.org_id
      AND rejection.api_key_id = admission.api_key_id
      AND rejection.billing_request_id = admission.billing_request_id
  )
  AND (
    $3::timestamptz IS NULL
    OR (
      $4::uuid IS NOT NULL
      AND (admission.reconcile_after, admission.billing_request_id)
        > ($3::timestamptz, $4::uuid)
    )
  )
  AND (admission.reconcile_after, admission.billing_request_id)
    <= ($5::timestamptz, $6::uuid)
ORDER BY admission.reconcile_after ASC, admission.billing_request_id ASC
LIMIT $7::integer;
`;

export const RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL = `
SELECT
  recovered.org_id::text AS org_id,
  recovered.api_key_id::text AS api_key_id,
  recovered.billing_request_id::text AS billing_request_id,
  recovered.state::text AS state,
  recovered.route_kind::text AS route_kind,
  recovered.billing_mode::text AS billing_mode,
  recovered.outcome_kind::text AS outcome_kind
FROM aiag_recover_gateway_http_settlement_v1(
  $1::uuid,
  $2::uuid,
  $3::uuid
) AS recovered;
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function canonicalUuid(value: unknown): CanonicalRecoveryUuid | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function canonicalTimestamp(value: unknown): CanonicalRecoveryTimestamp | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  return value;
}

function parseCapture(result: QueryResult<Record<string, unknown>>): Readonly<{
  cycleDueBefore: CanonicalRecoveryTimestamp;
  upper: GatewaySettlementRecoveryPosition;
}> | null {
  if (result.rowCount !== result.rows.length || result.rows.length > 1) {
    throw new Error("invalid gateway settlement recovery capture result");
  }
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!isPlainRecord(row) || !hasExactKeys(row, ["cycle_due_before", "upper_reconcile_at", "upper_billing_id"])) {
    throw new Error("invalid gateway settlement recovery capture result");
  }
  const cycleDueBefore = canonicalTimestamp(row.cycle_due_before);
  const reconcileAt = canonicalTimestamp(row.upper_reconcile_at);
  const billingRequestId = canonicalUuid(row.upper_billing_id);
  if (cycleDueBefore === null || reconcileAt === null || billingRequestId === null || reconcileAt > cycleDueBefore) {
    throw new Error("invalid gateway settlement recovery capture result");
  }
  return { cycleDueBefore, upper: { reconcileAt, billingRequestId } };
}

function parsePage(result: QueryResult<Record<string, unknown>>): GatewaySettlementRecoverySelectorPage {
  if (result.rowCount !== result.rows.length || result.rows.length > 20) {
    throw new Error("invalid gateway settlement recovery page result");
  }
  const hints: GatewaySettlementRecoveryHint[] = [];
  for (const row of result.rows) {
    if (!isPlainRecord(row) || !hasExactKeys(row, ["org_id", "api_key_id", "billing_request_id", "reconcile_at"])) {
      throw new Error("invalid gateway settlement recovery page result");
    }
    const orgId = canonicalUuid(row.org_id);
    const apiKeyId = canonicalUuid(row.api_key_id);
    const billingRequestId = canonicalUuid(row.billing_request_id);
    const reconcileAt = canonicalTimestamp(row.reconcile_at);
    if (orgId === null || apiKeyId === null || billingRequestId === null || reconcileAt === null) {
      throw new Error("invalid gateway settlement recovery page result");
    }
    hints.push({ orgId, apiKeyId, billingRequestId, reconcileAt });
  }
  return { hints };
}

function parseAcknowledgement(result: QueryResult<Record<string, unknown>>): GatewaySettlementRecoveryAck {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new Error("invalid gateway settlement recovery acknowledgement");
  }
  const row = result.rows[0];
  if (!isPlainRecord(row) || !hasExactKeys(row, [
    "org_id", "api_key_id", "billing_request_id", "state", "route_kind", "billing_mode", "outcome_kind",
  ])) {
    throw new Error("invalid gateway settlement recovery acknowledgement");
  }
  const orgId = canonicalUuid(row.org_id);
  const apiKeyId = canonicalUuid(row.api_key_id);
  const billingRequestId = canonicalUuid(row.billing_request_id);
  if (orgId === null || apiKeyId === null || billingRequestId === null || row.state !== "settled"
    || (row.route_kind !== "chat" && row.route_kind !== "embeddings")
    || row.billing_mode !== "stored" || row.outcome_kind !== "success") {
    throw new Error("invalid gateway settlement recovery acknowledgement");
  }
  return { orgId, apiKeyId, billingRequestId, state: "settled", routeKind: row.route_kind, billingMode: "stored", outcomeKind: "success" };
}

export function createGatewaySettlementRecoveryDb(
  databaseUrl: string,
  options: Readonly<{ allowedRoutes?: readonly GatewaySettlementRecoveryRoute[] }> = {},
): GatewaySettlementRecoveryDb {
  parseGatewaySettlementRecoveryDatabaseUrl(databaseUrl);
  const allowedRoutes = [...(options.allowedRoutes ?? ["chat"])] as GatewaySettlementRecoveryRoute[];
  if (
    allowedRoutes.length < 1 ||
    allowedRoutes.length > 2 ||
    allowedRoutes.some((route) => route !== "chat" && route !== "embeddings") ||
    new Set(allowedRoutes).size !== allowedRoutes.length
  ) {
    throw new Error("invalid gateway settlement recovery routes");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
    query_timeout: 9_000,
    options: "-c statement_timeout=8000",
  });
  let closing = false;
  let activeQuery: Promise<unknown> | null = null;
  let closePromise: Promise<void> | null = null;

  function query<T>(text: string, values: unknown[], parse: (result: QueryResult<Record<string, unknown>>) => T): Promise<T> {
    if (closing) return Promise.reject(new Error("gateway settlement recovery database is closing"));
    if (activeQuery !== null) return Promise.reject(new Error("gateway settlement recovery database query already active"));
    const operation = (async () => parse(await pool.query<Record<string, unknown>>({ text, values })))();
    activeQuery = operation;
    void operation.then(
      () => { if (activeQuery === operation) activeQuery = null; },
      () => { if (activeQuery === operation) activeQuery = null; },
    );
    return operation;
  }

  return {
    captureCycle() {
      return query(CAPTURE_GATEWAY_SETTLEMENT_RECOVERY_CYCLE_SQL, [allowedRoutes], parseCapture);
    },
    selectPage(input) {
      return query(SELECT_GATEWAY_SETTLEMENT_RECOVERY_PAGE_SQL, [
        allowedRoutes,
        input.cycleDueBefore,
        input.after?.reconcileAt ?? null,
        input.after?.billingRequestId ?? null,
        input.upper.reconcileAt,
        input.upper.billingRequestId,
        input.limit,
      ], parsePage);
    },
    recover(hint) {
      return query(RECOVER_GATEWAY_HTTP_SETTLEMENT_SQL, [
        hint.orgId,
        hint.apiKeyId,
        hint.billingRequestId,
      ], parseAcknowledgement);
    },
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closing = true;
      const current = activeQuery;
      closePromise = (current ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => pool.end())
        .then(() => undefined);
      return closePromise;
    },
  };
}
