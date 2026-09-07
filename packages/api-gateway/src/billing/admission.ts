import type postgres from "postgres";
import { sql as defaultSql, type SqlClient } from "../lib/db";
import {
  admissionJsonObjectsEqual,
  type GatewayChargeAdmissionResult,
} from "./admission-result";
import {
  admitGatewayChargeInternal,
  recordGatewayChargeOutcomeInternal,
  unavailable,
  requireParsedAnchor,
  uuid,
  bounded,
  jsonObject,
  queryAdmission,
  assertPriorFacts,
  type AdmitGatewayChargeArgs,
  type RecordGatewayChargeOutcomeArgs,
  type MarkGatewayChargeDispatchedArgs,
  type GatewayDispatchResult,
  type SettleAdmittedGatewayChargeArgs,
  type CancelUndispatchedGatewayChargeArgs,
} from "./admission-internal";
export {
  AdmissionUnavailableError,
  AdmissionConflictError,
  AdmissionDeadlineExpiredError,
} from "./admission-internal";
export type {
  AdmitGatewayChargeArgs,
  RecordGatewayChargeOutcomeArgs,
  MarkGatewayChargeDispatchedArgs,
  GatewayDispatchResult,
  SettleAdmittedGatewayChargeArgs,
  CancelUndispatchedGatewayChargeArgs,
} from "./admission-internal";

export async function admitGatewayCharge(
  args: AdmitGatewayChargeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  return admitGatewayChargeInternal(args, client);
}
export async function recordGatewayChargeOutcome(
  args: RecordGatewayChargeOutcomeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  return recordGatewayChargeOutcomeInternal(args, client);
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
      ${JSON.stringify(pricingSnapshot)}::text::jsonb
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
    if (before.state !== "held" || result.state !== "dispatched") unavailable();
    return Object.freeze({ kind: "dispatch_granted", admission: result });
  }
  if (!["dispatched", "outcome_recorded", "settled"].includes(result.state))
    unavailable();
  return Object.freeze({ kind: "replay", admission: result });
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
