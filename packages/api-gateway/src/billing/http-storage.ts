import type postgres from "postgres";
import { sql, type SqlClient } from "../lib/db";
import { AiagError } from "../lib/errors";
import {
  parseAdmissionBigint,
  type GatewayChargeAdmissionResult,
} from "./admission-result";
import {
  assertGatewayOutcome,
  captureGatewayOutcome,
  jsonObject,
  queryAdmission,
  timestamp,
  unavailable,
  uuid,
  type RecordGatewayChargeOutcomeArgs,
} from "./admission-internal";
import {
  parseStoredHttpChatResponse,
  parseStoredHttpEmbeddingsResponse,
  type StoredHttpChatResponse,
  type StoredHttpEmbeddingsResponse,
} from "./http-storage-result";

export class HttpStorageUnavailableError extends AiagError {
  constructor() {
    super("HTTP_STORAGE_UNAVAILABLE", 503, "HTTP storage unavailable");
  }
}
export class HttpStorageConflictError extends AiagError {
  constructor() {
    super("HTTP_STORAGE_CONFLICT", 409, "HTTP storage conflict");
  }
}
export class HttpStorageAccessError extends AiagError {
  constructor() {
    super("HTTP_STORAGE_ACCESS_DENIED", 403, "HTTP storage access denied");
  }
}
export type GatewayHttpRouteKind = "chat" | "embeddings";
export type GatewayHttpIdentity<
  Route extends GatewayHttpRouteKind = GatewayHttpRouteKind,
> = Readonly<{
  orgId: string;
  apiKeyId: string;
  routeKind: Route;
  billingMode: "stored";
  contractVersion: 1;
  idempotencyKeyDigest: string;
  requestFingerprint: string;
}>;
export type GatewayHttpClaim<
  Route extends GatewayHttpRouteKind = GatewayHttpRouteKind,
> = GatewayHttpIdentity<Route> &
  Readonly<{ billingRequestId: string; createdAt: string; didClaim: boolean }>;
type StoredHttpResponseByRoute = Readonly<{
  chat: StoredHttpChatResponse;
  embeddings: StoredHttpEmbeddingsResponse;
}>;
export type GatewayHttpResult<
  Route extends GatewayHttpRouteKind = "chat",
> =
  | Readonly<{ contractVersion: 1; status: "not_found" }>
  | Readonly<{
      contractVersion: 1;
      status: "pending" | "unavailable";
      billingRequestId: string;
    }>
  | Readonly<{
      contractVersion: 1;
      status: "expired";
      billingRequestId: string;
      storedAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      contractVersion: 1;
      status: "ready";
      billingRequestId: string;
      httpStatus: 200;
      contentType: "application/json";
      response: StoredHttpResponseByRoute[Route];
      actualCostCredits: bigint;
      storedAt: string;
      expiresAt: string;
    }>;
export type RecordGatewayHttpOutcomeArgs<
  Route extends GatewayHttpRouteKind = "chat",
> = Omit<
  RecordGatewayChargeOutcomeArgs,
  "outcomeKind"
> &
  Readonly<{
    outcomeKind: "success";
    response: StoredHttpResponseByRoute[Route];
    idempotencyKeyDigest: string;
    requestFingerprint: string;
  }>;
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) unavailable();
  return value;
}
function dataObject(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    unavailable();
  for (const name of Object.getOwnPropertyNames(value)) {
    const d = Object.getOwnPropertyDescriptor(value, name)!;
    if (!d.enumerable || !("value" in d)) unavailable();
  }
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
  return Object.freeze({
    orgId: uuid(args.orgId),
    apiKeyId: uuid(args.apiKeyId),
    routeKind: args.routeKind,
    billingMode: "stored",
    contractVersion: 1,
    idempotencyKeyDigest: hash(args.idempotencyKeyDigest),
    requestFingerprint: hash(args.requestFingerprint),
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
function row(rows: unknown, fields: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) unavailable();
  const value = jsonObject(rows[0]);
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((f) => !Object.hasOwn(value, f))
  )
    unavailable();
  return value;
}
function mapped(error: unknown): AiagError {
  // Only fixed database classifications; no transport text, body, hashes or key details escape.
  if (
    error instanceof HttpStorageUnavailableError ||
    error instanceof HttpStorageConflictError ||
    error instanceof HttpStorageAccessError
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
  return new HttpStorageUnavailableError();
}
/**
 * Server-only. Default SqlClient autocommit is the execution-grant boundary.
 * Injected clients are trusted: a transaction claim must COMMIT before a caller grants execution.
 * UUID scope is not authentication; a future credential boundary must supply it. No provider is executed here.
 */
export async function claimGatewayHttpRequest<
  Route extends GatewayHttpRouteKind,
>(
  args: GatewayHttpIdentity<Route> & Readonly<{ billingRequestId: string }>,
  client: SqlClient = sql,
): Promise<GatewayHttpClaim<Route>> {
  try {
    const i = identity(args),
      billingRequestId = uuid(args.billingRequestId);
    const rows =
      await client`SELECT r.contract_version, r.org_id::text AS org_id, r.api_key_id::text AS api_key_id,
      r.billing_request_id::text AS billing_request_id, r.route_kind, r.billing_mode, r.idempotency_key_digest, r.request_fingerprint,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, r.did_claim
      FROM aiag_claim_gateway_http_request_v1(${i.orgId}::uuid, ${i.apiKeyId}::uuid, ${billingRequestId}::uuid,
      ${i.routeKind}::varchar, ${i.billingMode}::varchar, ${i.idempotencyKeyDigest}::text, ${i.requestFingerprint}::text, ${i.contractVersion}::smallint) r`;
    const r = row(rows, [
      "contract_version",
      "org_id",
      "api_key_id",
      "billing_request_id",
      "route_kind",
      "billing_mode",
      "idempotency_key_digest",
      "request_fingerprint",
      "created_at",
      "did_claim",
    ]);
    const returnedId = uuid(r.billing_request_id);
    if (
      r.contract_version !== 1 ||
      uuid(r.org_id) !== i.orgId ||
      uuid(r.api_key_id) !== i.apiKeyId ||
      r.route_kind !== i.routeKind ||
      r.billing_mode !== i.billingMode ||
      r.idempotency_key_digest !== i.idempotencyKeyDigest ||
      r.request_fingerprint !== i.requestFingerprint ||
      typeof r.did_claim !== "boolean" ||
      (r.did_claim && returnedId !== billingRequestId)
    )
      unavailable();
    return Object.freeze({
      ...i,
      billingRequestId: returnedId,
      createdAt: exactTimestamp(r.created_at),
      didClaim: r.did_claim,
    });
  } catch (error) {
    throw mapped(error);
  }
}
/** Reads durable facts without re-quoting or re-evaluating model/policy limits. */
export async function readGatewayHttpResult<
  Route extends GatewayHttpRouteKind,
>(
  args: GatewayHttpIdentity<Route>,
  client: SqlClient = sql,
): Promise<GatewayHttpResult<Route>> {
  try {
    const i = identity(args);
    const rows =
      await client`SELECT r.contract_version, r.status, r.billing_request_id::text AS billing_request_id,
      r.http_status, r.content_type, r.response_body, r.actual_cost_credits::text AS actual_cost_credits,
      to_char(r.stored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
      to_char(r.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
      FROM aiag_read_gateway_http_result_v1(${i.orgId}::uuid, ${i.apiKeyId}::uuid, ${i.routeKind}::varchar,
      ${i.billingMode}::varchar, ${i.idempotencyKeyDigest}::text, ${i.requestFingerprint}::text, ${i.contractVersion}::smallint) r`;
    return parseGatewayHttpResultRows(rows, i.routeKind);
  } catch (error) {
    throw mapped(error);
  }
}
/** Strict v1 projection parser shared by the additive v2 reader. */
export function parseGatewayHttpResultRows(
  rows: unknown,
): GatewayHttpResult<"chat">;
export function parseGatewayHttpResultRows<Route extends GatewayHttpRouteKind>(
  rows: unknown,
  expectedRoute: Route,
): GatewayHttpResult<Route>;
export function parseGatewayHttpResultRows(
  rows: unknown,
  expectedRoute: GatewayHttpRouteKind = "chat",
): GatewayHttpResult<GatewayHttpRouteKind> {
    const r = row(rows, [
      "contract_version",
      "status",
      "billing_request_id",
      "http_status",
      "content_type",
      "response_body",
      "actual_cost_credits",
      "stored_at",
      "expires_at",
    ]);
    if (r.contract_version !== 1) unavailable();
    const base = { contractVersion: 1 as const };
    const requireNull = (names: string[]) => {
      if (names.some((n) => r[n] !== null)) unavailable();
    };
    if (r.status === "not_found") {
      requireNull([
        "billing_request_id",
        "http_status",
        "content_type",
        "response_body",
        "actual_cost_credits",
        "stored_at",
        "expires_at",
      ]);
      return Object.freeze({ ...base, status: "not_found" });
    }
    const billingRequestId = uuid(r.billing_request_id);
    if (r.status === "pending" || r.status === "unavailable") {
      requireNull([
        "http_status",
        "content_type",
        "response_body",
        "actual_cost_credits",
        "stored_at",
        "expires_at",
      ]);
      return Object.freeze({ ...base, status: r.status, billingRequestId });
    }
    const storedAt = exactTimestamp(r.stored_at),
      expiresAt = exactTimestamp(r.expires_at);
    if (expiresAt <= storedAt) unavailable();
    if (r.status === "expired") {
      requireNull([
        "http_status",
        "content_type",
        "response_body",
        "actual_cost_credits",
      ]);
      return Object.freeze({
        ...base,
        status: "expired",
        billingRequestId,
        storedAt,
        expiresAt,
      });
    }
    if (
      r.status !== "ready" ||
      r.http_status !== 200 ||
      r.content_type !== "application/json"
    )
      unavailable();
    return Object.freeze({
      ...base,
      status: "ready",
      billingRequestId,
      httpStatus: 200,
      contentType: "application/json",
      response:
        expectedRoute === "chat"
          ? parseStoredHttpChatResponse(r.response_body)
          : parseStoredHttpEmbeddingsResponse(r.response_body),
      actualCostCredits: parseAdmissionBigint(r.actual_cost_credits),
      storedAt,
      expiresAt,
    });
}
export async function recordGatewayHttpOutcome<
  Route extends GatewayHttpRouteKind,
>(
  args: RecordGatewayHttpOutcomeArgs<Route>,
  client: SqlClient = sql,
): Promise<GatewayChargeAdmissionResult> {
  try {
    dataObject(args);
    const captured = captureGatewayOutcome(args);
    const { before, actualCostCredits, usageSnapshot, outcomeKind } = captured;
    if (
      !["chat", "embeddings"].includes(before.routeKind) ||
      before.billingMode !== "stored" ||
      outcomeKind !== "success"
    )
      unavailable();
    const digest = hash(args.idempotencyKeyDigest),
      fingerprint = hash(args.requestFingerprint);
    const response =
      before.routeKind === "chat"
        ? parseStoredHttpChatResponse(args.response)
        : parseStoredHttpEmbeddingsResponse(args.response);
    const call = client<
      postgres.Row[]
    >`SELECT * FROM aiag_record_gateway_http_outcome_v1(
      ${before.orgId}::uuid, ${before.apiKeyId}::uuid, ${before.billingRequestId}::uuid, ${digest}::text, ${fingerprint}::text,
      ${actualCostCredits.toString()}::bigint, ${JSON.stringify(usageSnapshot)}::text::jsonb, ${outcomeKind}::varchar,
      ${JSON.stringify(response)}::text::jsonb, ${1}::smallint)`;
    const result = await queryAdmission(client, "outcome", call);
    assertGatewayOutcome(captured, result);
    return result;
  } catch (error) {
    throw mapped(error);
  }
}
export async function expireGatewayHttpResult(
  args: Readonly<{ orgId: string; billingRequestId: string }>,
  client: SqlClient = sql,
): Promise<boolean> {
  try {
    dataObject(args);
    const orgId = uuid(args.orgId),
      billingRequestId = uuid(args.billingRequestId);
    const r = row(
      await client`SELECT aiag_expire_gateway_http_result_v1(${orgId}::uuid, ${billingRequestId}::uuid) AS did_expire`,
      ["did_expire"],
    );
    if (typeof r.did_expire !== "boolean") unavailable();
    return r.did_expire;
  } catch (error) {
    throw mapped(error);
  }
}
