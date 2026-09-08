import type postgres from "postgres";
import type { SqlClient } from "../lib/db";
import { AiagError, errors } from "../lib/errors";
import {
  admissionJsonObjectsEqual,
  normalizeAdmissionTimestamp,
  normalizeAdmissionUuid,
  parseAdmissionBigint,
  parseAdmissionJsonObject,
  parseGatewayChargeAdmissionResult,
  type GatewayBillingMode,
  type GatewayChargeAdmissionResult,
  type JsonObject,
} from "./admission-result";

export class AdmissionUnavailableError extends AiagError {
  constructor() {
    super("ADMISSION_UNAVAILABLE", 503, "Admission service unavailable");
    this.name = "AdmissionUnavailableError";
  }
}

export class AdmissionConflictError extends AiagError {
  constructor() {
    super("ADMISSION_CONFLICT", 409, "Admission conflict");
    this.name = "AdmissionConflictError";
  }
}

export class AdmissionDeadlineExpiredError extends AdmissionConflictError {
  constructor() {
    super();
    this.code = "ADMISSION_DEADLINE_EXPIRED";
    this.message = "Admission deadline expired";
    this.name = "AdmissionDeadlineExpiredError";
  }
}

export type AdmitGatewayChargeArgs = Readonly<{
  orgId: string;
  billingRequestId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  routeKind: string;
  billingMode: GatewayBillingMode;
  modelSlug: string;
  authorizedMaxCredits: bigint;
  quoteSnapshot: JsonObject;
  preDispatchDeadlineAt: string;
}>;

export type MarkGatewayChargeDispatchedArgs = Readonly<{
  admission: GatewayChargeAdmissionResult;
  attemptId: string;
  upstreamId: string;
  pricingSnapshot: JsonObject;
}>;

export type GatewayDispatchResult =
  | Readonly<{
      kind: "dispatch_granted";
      admission: GatewayChargeAdmissionResult;
    }>
  | Readonly<{ kind: "replay"; admission: GatewayChargeAdmissionResult }>;

export type RecordGatewayChargeOutcomeArgs = Readonly<{
  admission: GatewayChargeAdmissionResult;
  actualCostCredits: bigint;
  usageSnapshot: JsonObject;
  outcomeKind: string;
}>;

export type SettleAdmittedGatewayChargeArgs = Readonly<{
  admission: GatewayChargeAdmissionResult;
}>;

export type CancelUndispatchedGatewayChargeArgs = Readonly<{
  admission: GatewayChargeAdmissionResult;
}>;

type AdmissionOperation =
  | "admit"
  | "dispatch"
  | "outcome"
  | "settle"
  | "cancel";
type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

export function unavailable(): never {
  throw new AdmissionUnavailableError();
}

export function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    unavailable();
  return value;
}

export function nullableBounded(value: unknown, max: number): string | null {
  return value === null ? null : bounded(value, max);
}

export function exactAmount(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== "bigint") unavailable();
  try {
    return parseAdmissionBigint(value.toString(), "amount", allowZero);
  } catch {
    unavailable();
  }
}

export function jsonObject(value: unknown): JsonObject {
  try {
    return parseAdmissionJsonObject(value);
  } catch {
    unavailable();
  }
}

export function uuid(value: unknown): string {
  try {
    return normalizeAdmissionUuid(value);
  } catch {
    unavailable();
  }
}

export function timestamp(value: unknown): string {
  try {
    return normalizeAdmissionTimestamp(value);
  } catch {
    unavailable();
  }
}

function mapTransportError(
  error: unknown,
  operation: AdmissionOperation,
): AiagError {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : undefined;

  if (
    message === "ADMISSION_DEADLINE_EXPIRED" &&
    ((operation === "admit" && code === "P0001") ||
      (operation === "dispatch" && code === "P0005"))
  )
    return new AdmissionDeadlineExpiredError();
  if (code === "P0003") return errors.paymentRequired();
  if (code === "P0004") return new AdmissionUnavailableError();
  if (code === "P0005") return new AdmissionConflictError();
  return new AdmissionUnavailableError();
}

export function admissionProjection(client: SqlClient): SqlFragment {
  return client<postgres.Row[]>`
    admission.billing_request_id::text AS billing_request_id,
    admission.org_id::text AS org_id,
    admission.api_key_id::text AS api_key_id,
    admission.client_request_id AS client_request_id,
    admission.route_kind AS route_kind,
    admission.billing_mode AS billing_mode,
    admission.model_slug AS model_slug,
    admission.authorized_max_credits::text AS authorized_max_credits,
    admission.held_subscription_credits::text AS held_subscription_credits,
    admission.held_payg_credits::text AS held_payg_credits,
    to_char(admission.captured_subscription_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_subscription_expires_at,
    admission.quote_snapshot AS quote_snapshot,
    admission.attempt_id::text AS attempt_id,
    admission.upstream_id AS upstream_id,
    admission.pricing_snapshot AS pricing_snapshot,
    admission.actual_cost_credits::text AS actual_cost_credits,
    admission.usage_snapshot AS usage_snapshot,
    admission.outcome_kind AS outcome_kind,
    admission.state AS state,
    to_char(admission.pre_dispatch_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS pre_dispatch_deadline_at,
    to_char(admission.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(admission.dispatched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dispatched_at,
    to_char(admission.outcome_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS outcome_recorded_at,
    to_char(admission.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
    to_char(admission.cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cancelled_at,
    to_char(admission.reconcile_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_after,
    admission.released_subscription_credits::text AS released_subscription_credits,
    admission.released_payg_credits::text AS released_payg_credits,
    admission.debt_repaid_credits::text AS debt_repaid_credits,
    admission.expired_subscription_credits::text AS expired_subscription_credits,
    admission.did_transition AS did_transition
  `;
}

export async function queryAdmission(
  client: SqlClient,
  operation: AdmissionOperation,
  functionCall: SqlFragment,
): Promise<GatewayChargeAdmissionResult> {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await client<Record<string, unknown>[]>`
      WITH admission AS (${functionCall})
      SELECT ${admissionProjection(client)}
      FROM admission
    `;
  } catch (error) {
    throw mapTransportError(error, operation);
  }
  if (rows.length !== 1) unavailable();
  try {
    // The query projects exactly 31 columns; reject transport/schema drift before parsing.
    if (Object.keys(rows[0] ?? {}).length !== 31) unavailable();
    return parseGatewayChargeAdmissionResult(rows[0]);
  } catch {
    unavailable();
  }
}

function sameNullableJson(
  left: JsonObject | null,
  right: JsonObject | null,
): boolean {
  return left === null || right === null
    ? left === right
    : admissionJsonObjectsEqual(left, right);
}

function assertBaseIdentity(
  before: GatewayChargeAdmissionResult,
  after: GatewayChargeAdmissionResult,
): void {
  if (
    before.billingRequestId !== after.billingRequestId ||
    before.orgId !== after.orgId ||
    before.apiKeyId !== after.apiKeyId ||
    before.clientRequestId !== after.clientRequestId ||
    before.routeKind !== after.routeKind ||
    before.billingMode !== after.billingMode ||
    before.modelSlug !== after.modelSlug ||
    before.authorizedMaxCredits !== after.authorizedMaxCredits ||
    before.heldSubscriptionCredits !== after.heldSubscriptionCredits ||
    before.heldPaygCredits !== after.heldPaygCredits ||
    before.capturedSubscriptionExpiresAt !==
      after.capturedSubscriptionExpiresAt ||
    !admissionJsonObjectsEqual(before.quoteSnapshot, after.quoteSnapshot) ||
    before.preDispatchDeadlineAt !== after.preDispatchDeadlineAt ||
    before.createdAt !== after.createdAt
  )
    unavailable();
}

export function assertPriorFacts(
  before: GatewayChargeAdmissionResult,
  after: GatewayChargeAdmissionResult,
): void {
  assertBaseIdentity(before, after);
  if (
    before.attemptId !== null &&
    (before.attemptId !== after.attemptId ||
      before.upstreamId !== after.upstreamId ||
      !sameNullableJson(before.pricingSnapshot, after.pricingSnapshot) ||
      before.dispatchedAt !== after.dispatchedAt)
  )
    unavailable();
  if (
    before.actualCostCredits !== null &&
    (before.actualCostCredits !== after.actualCostCredits ||
      before.outcomeKind !== after.outcomeKind ||
      !sameNullableJson(before.usageSnapshot, after.usageSnapshot) ||
      before.outcomeRecordedAt !== after.outcomeRecordedAt)
  )
    unavailable();
  if (
    before.state === "settled" &&
    (after.state !== "settled" ||
      before.settledAt !== after.settledAt ||
      before.releasedSubscriptionCredits !==
        after.releasedSubscriptionCredits ||
      before.releasedPaygCredits !== after.releasedPaygCredits ||
      before.debtRepaidCredits !== after.debtRepaidCredits ||
      before.expiredSubscriptionCredits !== after.expiredSubscriptionCredits)
  )
    unavailable();
  if (
    before.state === "cancelled" &&
    (after.state !== "cancelled" ||
      before.cancelledAt !== after.cancelledAt ||
      before.releasedSubscriptionCredits !==
        after.releasedSubscriptionCredits ||
      before.releasedPaygCredits !== after.releasedPaygCredits ||
      before.debtRepaidCredits !== after.debtRepaidCredits ||
      before.expiredSubscriptionCredits !== after.expiredSubscriptionCredits)
  )
    unavailable();
}

export function requireParsedAnchor(
  admission: GatewayChargeAdmissionResult,
): GatewayChargeAdmissionResult {
  if (
    !admission ||
    typeof admission !== "object" ||
    !Object.isFrozen(admission)
  )
    unavailable();
  uuid(admission.billingRequestId);
  uuid(admission.orgId);
  uuid(admission.apiKeyId);
  exactAmount(admission.authorizedMaxCredits, false);
  timestamp(admission.preDispatchDeadlineAt);
  timestamp(admission.createdAt);
  jsonObject(admission.quoteSnapshot);
  return admission;
}

/** JSON strings bind as text first: postgres.js otherwise JSON-encodes them again for OID 3802. */
export async function admitGatewayChargeInternal(
  args: AdmitGatewayChargeArgs,
  client: SqlClient,
  quota?: Readonly<{
    declaredSessionId: string | null;
    supplierQuoteSnapshot: JsonObject;
  }>,
): Promise<GatewayChargeAdmissionResult> {
  if (!args || typeof args !== "object") unavailable();
  const orgId = uuid(args.orgId);
  const billingRequestId = uuid(args.billingRequestId);
  const apiKeyId = uuid(args.apiKeyId);
  const clientRequestId = nullableBounded(args.clientRequestId, 255);
  const routeKind = bounded(args.routeKind, 32);
  if (args.billingMode !== "stored" && args.billingMode !== "byok_fee")
    unavailable();
  const billingMode = args.billingMode;
  const modelSlug = bounded(args.modelSlug, 128);
  const authorizedMaxCredits = exactAmount(args.authorizedMaxCredits, false);
  const quoteSnapshot = jsonObject(args.quoteSnapshot);
  const preDispatchDeadlineAt = timestamp(args.preDispatchDeadlineAt);

  const functionCall = quota
    ? client<postgres.Row[]>`
    SELECT * FROM aiag_admit_gateway_charge_v2(
      ${orgId}::uuid,
      ${billingRequestId}::uuid,
      ${apiKeyId}::uuid,
      ${clientRequestId}::varchar,
      ${routeKind}::varchar,
      ${billingMode}::varchar,
      ${modelSlug}::varchar,
      ${authorizedMaxCredits.toString()}::bigint,
      ${JSON.stringify(quoteSnapshot)}::text::jsonb,
      ${preDispatchDeadlineAt}::timestamptz,
      ${quota.declaredSessionId}::varchar,
      ${JSON.stringify(quota.supplierQuoteSnapshot)}::text::jsonb
    )
  `
    : client<postgres.Row[]>`
    SELECT * FROM aiag_admit_gateway_charge(
      ${orgId}::uuid,
      ${billingRequestId}::uuid,
      ${apiKeyId}::uuid,
      ${clientRequestId}::varchar,
      ${routeKind}::varchar,
      ${billingMode}::varchar,
      ${modelSlug}::varchar,
      ${authorizedMaxCredits.toString()}::bigint,
      ${JSON.stringify(quoteSnapshot)}::text::jsonb,
      ${preDispatchDeadlineAt}::timestamptz
    )
  `;
  const result = await queryAdmission(client, "admit", functionCall);
  if (
    result.orgId !== orgId ||
    result.billingRequestId !== billingRequestId ||
    result.apiKeyId !== apiKeyId ||
    result.clientRequestId !== clientRequestId ||
    result.routeKind !== routeKind ||
    result.billingMode !== billingMode ||
    result.modelSlug !== modelSlug ||
    result.authorizedMaxCredits !== authorizedMaxCredits ||
    !admissionJsonObjectsEqual(result.quoteSnapshot, quoteSnapshot) ||
    result.preDispatchDeadlineAt !== preDispatchDeadlineAt ||
    (result.didTransition && result.state !== "held")
  )
    unavailable();
  return result;
}

export function captureGatewayOutcome(args: RecordGatewayChargeOutcomeArgs) {
  if (!args || typeof args !== "object") unavailable();
  const before = requireParsedAnchor(args.admission);
  if (!["dispatched", "outcome_recorded", "settled"].includes(before.state))
    unavailable();
  const actualCostCredits = exactAmount(args.actualCostCredits, true);
  if (actualCostCredits > before.authorizedMaxCredits) unavailable();
  const usageSnapshot = jsonObject(args.usageSnapshot);
  const outcomeKind = bounded(args.outcomeKind, 32);
  if (
    actualCostCredits === 0n &&
    outcomeKind !== "success" &&
    outcomeKind !== "verified_no_charge"
  )
    unavailable();
  if (
    before.actualCostCredits !== null &&
    (before.actualCostCredits !== actualCostCredits ||
      before.outcomeKind !== outcomeKind ||
      before.usageSnapshot === null ||
      !admissionJsonObjectsEqual(before.usageSnapshot, usageSnapshot))
  )
    unavailable();

  return Object.freeze({
    before,
    actualCostCredits,
    usageSnapshot,
    outcomeKind,
  });
}

export function assertGatewayOutcome(
  captured: ReturnType<typeof captureGatewayOutcome>,
  result: GatewayChargeAdmissionResult,
): void {
  const { before, actualCostCredits, usageSnapshot, outcomeKind } = captured;
  assertPriorFacts(before, result);
  if (
    result.actualCostCredits !== actualCostCredits ||
    result.outcomeKind !== outcomeKind ||
    result.usageSnapshot === null ||
    !admissionJsonObjectsEqual(result.usageSnapshot, usageSnapshot)
  )
    unavailable();
  if (
    result.didTransition
      ? before.state !== "dispatched" || result.state !== "outcome_recorded"
      : !["outcome_recorded", "settled"].includes(result.state)
  )
    unavailable();
}

export async function recordGatewayChargeOutcomeInternal(
  args: RecordGatewayChargeOutcomeArgs,
  client: SqlClient,
  quota = false,
): Promise<GatewayChargeAdmissionResult> {
  const captured = captureGatewayOutcome(args);
  const { before, actualCostCredits, usageSnapshot, outcomeKind } = captured;

  const functionCall = quota
    ? client<postgres.Row[]>`
    SELECT * FROM aiag_record_gateway_charge_outcome_v2(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid,
      ${actualCostCredits.toString()}::bigint,
      ${JSON.stringify(usageSnapshot)}::text::jsonb,
      ${outcomeKind}::varchar
    )
  `
    : client<postgres.Row[]>`
    SELECT * FROM aiag_record_gateway_charge_outcome(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid,
      ${actualCostCredits.toString()}::bigint,
      ${JSON.stringify(usageSnapshot)}::text::jsonb,
      ${outcomeKind}::varchar
    )
  `;
  const result = await queryAdmission(client, "outcome", functionCall);
  assertGatewayOutcome(captured, result);
  return result;
}

/** Exact case-sensitive ASCII identity. No trim, folding or implicit missing SID. */
export function captureDeclaredSessionId(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[^A-Za-z0-9._:-]/.test(value)
  )
    unavailable();
  return value;
}
