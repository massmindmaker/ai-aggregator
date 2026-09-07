import type postgres from "postgres";
import { sql as defaultSql, type SqlClient } from "../lib/db";
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

function unavailable(): never {
  throw new AdmissionUnavailableError();
}

function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    unavailable();
  return value;
}

function nullableBounded(value: unknown, max: number): string | null {
  return value === null ? null : bounded(value, max);
}

function exactAmount(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== "bigint") unavailable();
  try {
    return parseAdmissionBigint(value.toString(), "amount", allowZero);
  } catch {
    unavailable();
  }
}

function jsonObject(value: unknown): JsonObject {
  try {
    return parseAdmissionJsonObject(value);
  } catch {
    unavailable();
  }
}

function uuid(value: unknown): string {
  try {
    return normalizeAdmissionUuid(value);
  } catch {
    unavailable();
  }
}

function timestamp(value: unknown): string {
  try {
    return normalizeAdmissionTimestamp(value);
  } catch {
    unavailable();
  }
}

function mapAdmissionError(
  error: unknown,
  operation: AdmissionOperation,
): AiagError {
  if (error instanceof AiagError) return error;
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

function admissionProjection(client: SqlClient): SqlFragment {
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

async function queryAdmission(
  client: SqlClient,
  operation: AdmissionOperation,
  functionCall: SqlFragment,
): Promise<GatewayChargeAdmissionResult> {
  try {
    const rows = await client<Record<string, unknown>[]>`
      WITH admission AS (${functionCall})
      SELECT ${admissionProjection(client)}
      FROM admission
    `;
    if (rows.length !== 1) unavailable();
    return parseGatewayChargeAdmissionResult(rows[0]);
  } catch (error) {
    throw mapAdmissionError(error, operation);
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

function assertPriorFacts(
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

function requireParsedAnchor(
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

export async function admitGatewayCharge(
  args: AdmitGatewayChargeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  if (!args || typeof args !== "object") unavailable();
  const orgId = uuid(args.orgId);
  const billingRequestId = uuid(args.billingRequestId);
  const apiKeyId = uuid(args.apiKeyId);
  const clientRequestId = nullableBounded(args.clientRequestId, 255);
  const routeKind = bounded(args.routeKind, 32);
  if (args.billingMode !== "stored" && args.billingMode !== "byok_fee")
    unavailable();
  const modelSlug = bounded(args.modelSlug, 128);
  const authorizedMaxCredits = exactAmount(args.authorizedMaxCredits, false);
  const quoteSnapshot = jsonObject(args.quoteSnapshot);
  const preDispatchDeadlineAt = timestamp(args.preDispatchDeadlineAt);

  const functionCall = client<postgres.Row[]>`
    SELECT * FROM aiag_admit_gateway_charge(
      ${orgId}::uuid,
      ${billingRequestId}::uuid,
      ${apiKeyId}::uuid,
      ${clientRequestId}::varchar,
      ${routeKind}::varchar,
      ${args.billingMode}::varchar,
      ${modelSlug}::varchar,
      ${authorizedMaxCredits.toString()}::bigint,
      ${JSON.stringify(quoteSnapshot)}::jsonb,
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
    result.billingMode !== args.billingMode ||
    result.modelSlug !== modelSlug ||
    result.authorizedMaxCredits !== authorizedMaxCredits ||
    !admissionJsonObjectsEqual(result.quoteSnapshot, quoteSnapshot) ||
    result.preDispatchDeadlineAt !== preDispatchDeadlineAt ||
    (result.didTransition && result.state !== "held")
  )
    unavailable();
  return result;
}

export async function markGatewayChargeDispatched(
  args: MarkGatewayChargeDispatchedArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayDispatchResult> {
  if (!args || typeof args !== "object") unavailable();
  const before = requireParsedAnchor(args.admission);
  if (
    !["held", "dispatched", "outcome_recorded", "settled"].includes(
      before.state,
    )
  )
    unavailable();
  const attemptId = uuid(args.attemptId);
  const upstreamId = bounded(args.upstreamId, 64);
  const pricingSnapshot = jsonObject(args.pricingSnapshot);
  if (
    before.attemptId !== null &&
    (before.attemptId !== attemptId ||
      before.upstreamId !== upstreamId ||
      before.pricingSnapshot === null ||
      !admissionJsonObjectsEqual(before.pricingSnapshot, pricingSnapshot))
  )
    unavailable();

  const functionCall = client<postgres.Row[]>`
    SELECT * FROM aiag_mark_gateway_charge_dispatched(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid,
      ${attemptId}::uuid,
      ${upstreamId}::varchar,
      ${JSON.stringify(pricingSnapshot)}::jsonb
    )
  `;
  const result = await queryAdmission(client, "dispatch", functionCall);
  assertPriorFacts(before, result);
  if (
    result.attemptId !== attemptId ||
    result.upstreamId !== upstreamId ||
    result.pricingSnapshot === null ||
    !admissionJsonObjectsEqual(result.pricingSnapshot, pricingSnapshot)
  )
    unavailable();
  if (result.didTransition) {
    if (result.state !== "dispatched") unavailable();
    return Object.freeze({ kind: "dispatch_granted", admission: result });
  }
  if (!["dispatched", "outcome_recorded", "settled"].includes(result.state))
    unavailable();
  return Object.freeze({ kind: "replay", admission: result });
}

export async function recordGatewayChargeOutcome(
  args: RecordGatewayChargeOutcomeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
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

  const functionCall = client<postgres.Row[]>`
    SELECT * FROM aiag_record_gateway_charge_outcome(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid,
      ${actualCostCredits.toString()}::bigint,
      ${JSON.stringify(usageSnapshot)}::jsonb,
      ${outcomeKind}::varchar
    )
  `;
  const result = await queryAdmission(client, "outcome", functionCall);
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
      ? result.state !== "outcome_recorded"
      : !["outcome_recorded", "settled"].includes(result.state)
  )
    unavailable();
  return result;
}

export async function settleAdmittedGatewayCharge(
  args: SettleAdmittedGatewayChargeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  if (!args || typeof args !== "object") unavailable();
  const before = requireParsedAnchor(args.admission);
  if (
    !["outcome_recorded", "settled"].includes(before.state) ||
    before.actualCostCredits === null
  )
    unavailable();
  const functionCall = client<postgres.Row[]>`
    SELECT * FROM aiag_settle_admitted_gateway_charge(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid
    )
  `;
  const result = await queryAdmission(client, "settle", functionCall);
  assertPriorFacts(before, result);
  if (
    result.state !== "settled" ||
    result.actualCostCredits !== before.actualCostCredits ||
    (before.state === "settled" && result.didTransition)
  )
    unavailable();
  return result;
}

export async function cancelUndispatchedGatewayCharge(
  args: CancelUndispatchedGatewayChargeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  if (!args || typeof args !== "object") unavailable();
  const before = requireParsedAnchor(args.admission);
  if (!["held", "cancelled"].includes(before.state)) unavailable();
  const functionCall = client<postgres.Row[]>`
    SELECT * FROM aiag_cancel_undispatched_gateway_charge(
      ${before.orgId}::uuid,
      ${before.billingRequestId}::uuid
    )
  `;
  const result = await queryAdmission(client, "cancel", functionCall);
  assertPriorFacts(before, result);
  if (
    result.state !== "cancelled" ||
    (before.state === "cancelled" && result.didTransition)
  )
    unavailable();
  return result;
}
