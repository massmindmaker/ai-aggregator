import { z } from "zod";
import { db, sql } from "@/lib/db";
import { authorRows, AuthorOperationError } from "./service";
export const authorOperatorSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recover") }).strict(),
  z.object({ action: z.literal("refund") }).strict(),
  z
    .object({
      action: z.literal("no_charge"),
      attemptId: z.string().uuid(),
      evidenceReference: z.string().trim().min(3).max(1024),
    })
    .strict(),
  z
    .object({
      action: z.literal("dispute"),
      disputed: z.boolean(),
      reason: z.string().trim().min(3).max(1024),
    })
    .strict(),
]);
export type AuthorOperatorAction = z.infer<typeof authorOperatorSchema>;
export async function operateAuthorRequest(
  billingId: string,
  actorId: string,
  action: AuthorOperatorAction,
) {
  let result: unknown;
  switch (action.action) {
    case "recover":
      result = await db.execute(
        sql`SELECT * FROM aiag_recover_author_settlement(${billingId}::uuid,${actorId}::uuid)`,
      );
      break;
    case "refund":
      result = await db.execute(
        sql`SELECT billing_request_id::text,refund_id::text,total_microcredits::text,subscription_microcredits::text,payg_microcredits::text,expired_subscription_microcredits::text,debt_repaid_microcredits::text FROM aiag_refund_author_request(${billingId}::uuid,${actorId}::uuid)`,
      );
      break;
    case "no_charge":
      result = await db.execute(
        sql`SELECT * FROM aiag_resolve_author_no_charge(${billingId}::uuid,${action.attemptId}::uuid,${actorId}::uuid,${action.evidenceReference})`,
      );
      break;
    case "dispute":
      result = await db.execute(
        sql`SELECT * FROM aiag_set_author_dispute(${billingId}::uuid,${actorId}::uuid,${action.disputed},${action.reason})`,
      );
      break;
  }
  const record = authorRows<Record<string, unknown>>(result)[0];
  if (!record)
    throw new AuthorOperationError("AUTHOR_OPERATION_UNAVAILABLE", 503);
  return record;
}
export interface AuthorOperatorRow {
  billing_request_id: string;
  model_id: string;
  model_slug: string;
  version_no: number;
  state: string | null;
  attempt_id: string | null;
  price_microcredits: string;
  actual_cost_credits: string | null;
  author_microcredits: string;
  refunded: boolean;
  no_charge: boolean;
  disputed: boolean;
  reconcile_after: string | null;
  created_at: string;
}
export async function listAuthorOperatorRequests() {
  return authorRows<AuthorOperatorRow>(
    await db.execute(sql`SELECT b.billing_request_id::text,b.model_id::text,m.slug AS model_slug,v.version_no,a.state,a.attempt_id::text,
  b.author_quote->>'priceMicrocredits' AS price_microcredits,a.actual_cost_credits::text,b.author_quote->>'authorMicrocredits' AS author_microcredits,
  EXISTS(SELECT 1 FROM author_charge_refunds r WHERE r.billing_request_id=b.billing_request_id) AS refunded,
  EXISTS(SELECT 1 FROM author_operator_resolutions r WHERE r.billing_request_id=b.billing_request_id AND a.state='settled' AND a.actual_cost_credits=0 AND a.outcome_kind='verified_no_charge') AS no_charge,
  b.disputed,a.reconcile_after::text,b.created_at::text
  FROM author_request_bindings b JOIN models m ON m.id=b.model_id JOIN author_model_versions v ON v.id=b.version_id
  LEFT JOIN gateway_charge_admissions a USING(billing_request_id) ORDER BY b.created_at DESC LIMIT 100`),
  );
}
