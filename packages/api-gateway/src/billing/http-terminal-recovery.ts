import type postgres from "postgres";
import { sql, type SqlClient } from "../lib/db";
import {
  admissionProjection,
  bounded,
  captureDeclaredSessionId,
  exactAmount,
  jsonObject,
  nullableBounded,
  timestamp,
  unavailable,
  uuid,
} from "./admission-internal";
import {
  admissionJsonObjectsEqual,
  parseGatewayChargeAdmissionResult,
  type GatewayChargeAdmissionResult,
} from "./admission-result";
import type { AdmitGatewayChargeV2Args } from "./quota-admission";
import {
  HttpStorageAccessError,
  HttpStorageConflictError,
  HttpStorageUnavailableError,
  parseGatewayHttpResultRows,
  type GatewayHttpIdentity,
  type GatewayHttpResult,
  type GatewayHttpRouteKind,
} from "./http-storage";

const rejections = Object.freeze({
  PAYMENT_REQUIRED: [402, "Payment required", "billing_error"],
  QUOTA_EXCEEDED: [429, "Spending quota exceeded", "billing_error"],
  ADMISSION_DEADLINE_EXPIRED: [
    409,
    "Admission deadline expired",
    "request_error",
  ],
  SESSION_REQUIRED: [400, "Session identifier required", "request_error"],
  REFUND_BLOCKED: [402, "Billing admission blocked", "billing_error"],
  REQUEST_NOT_STARTED: [409, "Request not started", "request_error"],
} as const);
export type HttpRejectionCode = keyof typeof rejections;
export type HttpTerminalRejection = Readonly<{
  kind: "rejected";
  billingRequestId: string;
  code: HttpRejectionCode;
  httpStatus: 400 | 402 | 409 | 429;
  response: Readonly<{
    error: Readonly<{
      code: HttpRejectionCode;
      message: string;
      type: "billing_error" | "request_error";
    }>;
  }>;
  terminalAt: string;
  didTransition: boolean;
}>;
export type HttpAdmissionResult =
  | Readonly<{ kind: "admitted"; admission: GatewayChargeAdmissionResult }>
  | HttpTerminalRejection;
export type HttpResultV2<
  Route extends GatewayHttpRouteKind = "chat",
> =
  | GatewayHttpResult<Route>
  | Readonly<{
      contractVersion: 1;
      status: "rejected";
      billingRequestId: string;
      code: HttpRejectionCode;
      httpStatus: HttpTerminalRejection["httpStatus"];
      contentType: "application/json";
      response: HttpTerminalRejection["response"];
      storedAt: string;
    }>;

function dataObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    unavailable();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!d.enumerable || !("value" in d)) unavailable();
}
function identity<Route extends GatewayHttpRouteKind>(
  args: GatewayHttpIdentity<Route>,
): GatewayHttpIdentity<Route> {
  dataObject(args);
  if (
    !["chat", "embeddings"].includes(args.routeKind) ||
    args.billingMode !== "stored" ||
    args.contractVersion !== 1
  )
    unavailable();
  for (const h of [args.idempotencyKeyDigest, args.requestFingerprint])
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) unavailable();
  return Object.freeze({
    orgId: uuid(args.orgId),
    apiKeyId: uuid(args.apiKeyId),
    routeKind: args.routeKind,
    billingMode: "stored",
    contractVersion: 1,
    idempotencyKeyDigest: args.idempotencyKeyDigest,
    requestFingerprint: args.requestFingerprint,
  });
}
function exactTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) ||
    timestamp(value) !== value
  )
    unavailable();
  return value;
}
function row(rows: unknown, fields: number) {
  if (!Array.isArray(rows) || rows.length !== 1) unavailable();
  const r = jsonObject(rows[0]);
  if (Object.keys(r).length !== fields) unavailable();
  return r;
}
function mapped(error: unknown): Error {
  if (
    error instanceof HttpStorageAccessError ||
    error instanceof HttpStorageConflictError ||
    error instanceof HttpStorageUnavailableError
  )
    return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (
    code === "P0005" &&
    error instanceof Error &&
    error.message === "HTTP_ACCESS_DENIED"
  )
    return new HttpStorageAccessError();
  if (code === "P0005" || code === "ADMISSION_CONFLICT")
    return new HttpStorageConflictError();
  // Raw P0003, timeout, malformed rows and lost ACK are never a terminal business rejection.
  return new HttpStorageUnavailableError();
}
export function isHttpRejectionCode(
  value: unknown,
): value is HttpRejectionCode {
  return typeof value === "string" && Object.hasOwn(rejections, value);
}
function rejection(code: unknown, status: unknown, body: unknown) {
  if (!isHttpRejectionCode(code)) unavailable();
  const [httpStatus, message, type] = rejections[code];
  const response = Object.freeze({
    error: Object.freeze({ code, message, type }),
  });
  if (
    status !== httpStatus ||
    !admissionJsonObjectsEqual(jsonObject(body), response)
  )
    unavailable();
  return { code, httpStatus, response };
}
const terminalFields = [
  "terminal_org_id",
  "terminal_api_key_id",
  "terminal_billing_request_id",
  "terminal_status",
  "terminal_rejection_code",
  "terminal_http_status",
  "terminal_response_body",
  "terminal_at",
  "terminal_did_transition",
] as const;
async function terminalQuery(
  client: SqlClient,
  call: postgres.PendingQuery<postgres.Row[]>,
  i: Readonly<{ orgId: string; apiKeyId: string; billingRequestId: string }>,
): Promise<HttpAdmissionResult> {
  // Materialized once; flatten the nested composite using the accepted text-money projection.
  const rows =
    await client`WITH terminal AS MATERIALIZED (${call}), admission AS (SELECT (terminal.admission).* FROM terminal)
    SELECT terminal.org_id::text AS terminal_org_id,terminal.api_key_id::text AS terminal_api_key_id,
    terminal.billing_request_id::text AS terminal_billing_request_id,terminal.status AS terminal_status,
    terminal.rejection_code AS terminal_rejection_code,terminal.http_status AS terminal_http_status,
    terminal.response_body AS terminal_response_body,to_char(terminal.terminal_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS terminal_at,
    terminal.did_transition AS terminal_did_transition,${admissionProjection(client)} FROM terminal CROSS JOIN admission`;
  const r = row(rows, 40);
  if (
    terminalFields.some((f) => !Object.hasOwn(r, f)) ||
    uuid(r.terminal_org_id) !== i.orgId ||
    uuid(r.terminal_api_key_id) !== i.apiKeyId ||
    uuid(r.terminal_billing_request_id) !== i.billingRequestId ||
    typeof r.terminal_did_transition !== "boolean"
  )
    unavailable();
  const a = { ...r };
  for (const f of terminalFields) delete a[f];
  if (r.terminal_status === "rejected") {
    if (Object.values(a).some((v) => v !== null)) unavailable();
    // Require the same31 column names as an admission row, including nulls on this branch.
    const names = [
      "billing_request_id",
      "org_id",
      "api_key_id",
      "client_request_id",
      "route_kind",
      "billing_mode",
      "model_slug",
      "authorized_max_credits",
      "held_subscription_credits",
      "held_payg_credits",
      "captured_subscription_expires_at",
      "quote_snapshot",
      "attempt_id",
      "upstream_id",
      "pricing_snapshot",
      "actual_cost_credits",
      "usage_snapshot",
      "outcome_kind",
      "state",
      "pre_dispatch_deadline_at",
      "created_at",
      "dispatched_at",
      "outcome_recorded_at",
      "settled_at",
      "cancelled_at",
      "reconcile_after",
      "released_subscription_credits",
      "released_payg_credits",
      "debt_repaid_credits",
      "expired_subscription_credits",
      "did_transition",
    ];
    if (names.some((n) => !Object.hasOwn(a, n))) unavailable();
    return Object.freeze({
      kind: "rejected",
      billingRequestId: i.billingRequestId,
      ...rejection(
        r.terminal_rejection_code,
        r.terminal_http_status,
        r.terminal_response_body,
      ),
      terminalAt: exactTimestamp(r.terminal_at),
      didTransition: r.terminal_did_transition,
    });
  }
  if (
    r.terminal_status !== "admitted" ||
    [
      "terminal_rejection_code",
      "terminal_http_status",
      "terminal_response_body",
      "terminal_at",
    ].some((n) => r[n] !== null)
  )
    unavailable();
  const admission = parseGatewayChargeAdmissionResult(a);
  if (
    admission.orgId !== i.orgId ||
    admission.apiKeyId !== i.apiKeyId ||
    admission.billingRequestId !== i.billingRequestId ||
    admission.didTransition !== r.terminal_did_transition
  )
    unavailable();
  return Object.freeze({ kind: "admitted", admission });
}

/** Server-only; default autocommit ACK is the grant boundary. Transaction clients must COMMIT first. */
export async function admitGatewayHttpCharge<
  Route extends GatewayHttpRouteKind,
>(
  args: GatewayHttpIdentity<Route> & AdmitGatewayChargeV2Args,
  client: SqlClient = sql,
): Promise<HttpAdmissionResult> {
  try {
    const i = identity(args),
      billingRequestId = uuid(args.billingRequestId),
      clientRequestId = nullableBounded(args.clientRequestId, 255),
      modelSlug = bounded(args.modelSlug, 128),
      authorizedMaxCredits = exactAmount(args.authorizedMaxCredits, false),
      quoteSnapshot = jsonObject(args.quoteSnapshot),
      preDispatchDeadlineAt = timestamp(args.preDispatchDeadlineAt),
      sid = captureDeclaredSessionId(args.declaredSessionId),
      supplier = jsonObject(args.supplierQuoteSnapshot);
    const result = await terminalQuery(
      client,
      client`SELECT * FROM aiag_admit_gateway_http_charge_v1(${i.orgId}::uuid,${billingRequestId}::uuid,${i.apiKeyId}::uuid,
      ${clientRequestId}::varchar,${i.routeKind}::varchar,${i.billingMode}::varchar,${modelSlug}::varchar,${authorizedMaxCredits.toString()}::bigint,
      ${JSON.stringify(quoteSnapshot)}::text::jsonb,${preDispatchDeadlineAt}::timestamptz,${sid}::varchar,${JSON.stringify(supplier)}::text::jsonb,
      ${i.idempotencyKeyDigest}::text,${i.requestFingerprint}::text,${i.contractVersion}::smallint)`,
      { ...i, billingRequestId },
    );
    if (result.kind === "admitted") {
      const a = result.admission;
      if (
        a.clientRequestId !== clientRequestId ||
        a.routeKind !== i.routeKind ||
        a.billingMode !== i.billingMode ||
        a.modelSlug !== modelSlug ||
        a.authorizedMaxCredits !== authorizedMaxCredits ||
        !admissionJsonObjectsEqual(a.quoteSnapshot, quoteSnapshot) ||
        a.preDispatchDeadlineAt !== preDispatchDeadlineAt ||
        (a.didTransition && a.state !== "held")
      )
        unavailable();
    }
    return result;
  } catch (error) {
    throw mapped(error);
  }
}
/** Only the known pre-invocation abort path may call this; no recovery/timeout caller. */
export async function rejectUnstartedGatewayHttpRequest(
  args: GatewayHttpIdentity & Readonly<{ billingRequestId: string }>,
  client: SqlClient = sql,
): Promise<HttpTerminalRejection> {
  try {
    const i = identity(args),
      billingRequestId = uuid(args.billingRequestId);
    const result = await terminalQuery(
      client,
      client`SELECT * FROM aiag_reject_unstarted_gateway_http_request_v1(${i.orgId}::uuid,${i.apiKeyId}::uuid,${billingRequestId}::uuid,
      ${i.routeKind}::varchar,${i.billingMode}::varchar,${i.idempotencyKeyDigest}::text,${i.requestFingerprint}::text,${i.contractVersion}::smallint)`,
      { ...i, billingRequestId },
    );
    if (result.kind !== "rejected") unavailable();
    return result;
  } catch (error) {
    throw mapped(error);
  }
}
export async function readGatewayHttpResultV2<
  Route extends GatewayHttpRouteKind,
>(
  args: GatewayHttpIdentity<Route>,
  client: SqlClient = sql,
): Promise<HttpResultV2<Route>> {
  try {
    const i = identity(args);
    const rows =
      await client`SELECT r.contract_version,r.status,r.billing_request_id::text AS billing_request_id,r.http_status,r.content_type,r.response_body,
      r.actual_cost_credits::text AS actual_cost_credits,to_char(r.stored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
      to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,r.rejection_code
      FROM aiag_read_gateway_http_result_v2(${i.orgId}::uuid,${i.apiKeyId}::uuid,${i.routeKind}::varchar,${i.billingMode}::varchar,${i.idempotencyKeyDigest}::text,${i.requestFingerprint}::text,${i.contractVersion}::smallint) r`;
    const r = row(rows, 10);
    if (r.status === "rejected") {
      if (
        r.contract_version !== 1 ||
        r.content_type !== "application/json" ||
        r.actual_cost_credits !== null ||
        r.expires_at !== null
      )
        unavailable();
      return Object.freeze({
        contractVersion: 1,
        status: "rejected",
        billingRequestId: uuid(r.billing_request_id),
        ...rejection(r.rejection_code, r.http_status, r.response_body),
        contentType: "application/json",
        storedAt: exactTimestamp(r.stored_at),
      });
    }
    if (r.rejection_code !== null) unavailable();
    const old = { ...r };
    delete old.rejection_code;
    return parseGatewayHttpResultRows([old], i.routeKind);
  } catch (error) {
    throw mapped(error);
  }
}
/** Trusted owner accounting; key may be revoked. Never an execution/resume factory. */
export async function recoverGatewayHttpSettlement(
  args: Readonly<{
    orgId: string;
    apiKeyId: string;
    billingRequestId: string;
    routeKind?: GatewayHttpRouteKind;
  }>,
  client: SqlClient = sql,
): Promise<GatewayChargeAdmissionResult> {
  try {
    dataObject(args);
    const orgId = uuid(args.orgId),
      apiKeyId = uuid(args.apiKeyId),
      billingRequestId = uuid(args.billingRequestId);
    // Preserve raw HTTP access classification; the legacy query helper maps every P0005 to admission conflict.
    const rows = await client`WITH admission AS (SELECT * FROM aiag_recover_gateway_http_settlement_v1(${orgId}::uuid,${apiKeyId}::uuid,${billingRequestId}::uuid))
      SELECT ${admissionProjection(client)} FROM admission`;
    const a = parseGatewayChargeAdmissionResult(row(rows, 31));
    if (
      a.orgId !== orgId ||
      a.apiKeyId !== apiKeyId ||
      a.billingRequestId !== billingRequestId ||
      a.state !== "settled" ||
      !["chat", "embeddings"].includes(a.routeKind) ||
      (args.routeKind !== undefined && a.routeKind !== args.routeKind) ||
      a.billingMode !== "stored" ||
      a.outcomeKind !== "success"
    )
      unavailable();
    return a;
  } catch (error) {
    throw mapped(error);
  }
}
