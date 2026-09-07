import { sql as defaultSql, type SqlClient } from "../lib/db";
import type {
  GatewayChargeAdmissionResult,
  JsonObject,
} from "./admission-result";
import {
  admitGatewayChargeInternal,
  recordGatewayChargeOutcomeInternal,
  captureDeclaredSessionId,
  jsonObject,
  unavailable,
  type AdmitGatewayChargeArgs,
  type RecordGatewayChargeOutcomeArgs,
} from "./admission-internal";

export type AdmitGatewayChargeV2Args = Readonly<
  Omit<AdmitGatewayChargeArgs, "billingMode"> & {
    billingMode: "stored";
    declaredSessionId: string | null;
    supplierQuoteSnapshot: JsonObject;
  }
>;

/** The 31-field result has no v2 echo; SQL owns SID/supplier replay identity. */
export async function admitGatewayChargeV2(
  args: AdmitGatewayChargeV2Args,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  if (!args || typeof args !== "object" || args.billingMode !== "stored")
    unavailable();
  const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
  const supplierQuoteSnapshot = jsonObject(args.supplierQuoteSnapshot);
  return admitGatewayChargeInternal(args, client, {
    declaredSessionId,
    supplierQuoteSnapshot,
  });
}

export async function recordGatewayChargeOutcomeV2(
  args: RecordGatewayChargeOutcomeArgs,
  client: SqlClient = defaultSql,
): Promise<GatewayChargeAdmissionResult> {
  return recordGatewayChargeOutcomeInternal(args, client, true);
}
