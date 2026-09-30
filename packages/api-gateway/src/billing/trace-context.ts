/**
 * AG-6 Task 4 — operator-facing trace context: ONE identifier in, the whole
 * tenant → run → request → charge chain out.
 *
 * SCOPE (deliberately minimal, see plan docs/superpowers/plans/2026-09-30-ag6-offcluster-restore.md
 * Task 4): this is NOT distributed tracing. No span ids, no propagation
 * context, no OTel/Jaeger/zipkin. Every identifier it reads already exists in
 * an applied migration; this module only READS. It adds no tables, no
 * functions, no migrations.
 *
 * The chain it stitches, and the applied migrations that own each link:
 *   - `gateway_http_requests`      (0069)  request identity, client-request id
 *   - `gateway_charge_admissions`  (0067)  the hold → dispatch → outcome → settle authority
 *   - `gateway_charge_admission_events` (0067) immutable per-step financial events
 *   - `gateway_charge_quota_*`     (0068)  durable quota context/reservations/events
 *   - `prediction_jobs`            (0081)  async media "run" (task_id ↔ billing_request_id)
 *   - `batch_items`                (0085)  durable batch items
 *   - `author_request_bindings` /
 *     `author_credit_ledger` /
 *     `author_charge_refunds` /
 *     `author_operator_resolutions` (0089, 0090) author-side ledger and dispute state
 *   - `gateway_transactions`       (0004)  the money ledger; settlement receipt is
 *                                        request_id = 'gw:' || billing_request_id
 *   - `audit_log`                  (0011)  operator actions on this request
 *
 * SAFETY: every statement is a tagged-template prepared statement with bound
 * parameters. The caller's identifier is NEVER spliced into SQL text — it is
 * classified in TypeScript and passed as a bound `$n`. Money is never touched:
 * there is no UPDATE/DELETE/INSERT here at all.
 */
import { sql as defaultSql, type SqlClient } from "../lib/db";
import { AiagError } from "../lib/errors";

/**
 * The admin authorization the module REQUIRES before it reads anything.
 *
 * A trace discloses an organization's balances, its api key ids, actor emails
 * and dispute details. It is a support tool, not a tenant API, so it is
 * fail-closed: no admin context, no trace. `orgId`, when present, narrows the
 * caller to a single organization (a support/admin console scoped to one
 * tenant); a mismatched org is a refusal, never an empty result.
 */
export type TraceAdminContext = Readonly<{
  actorId: string;
  orgId?: string | null;
}>;

export class TraceContextForbiddenError extends AiagError {
  constructor(message = "Trace context requires administrator scope") {
    super("TRACE_FORBIDDEN", 403, message);
  }
}

/** Identifier supplied by the operator. */
export type TraceIdentifierKind =
  | "billing_request_id"
  | "attempt_id"
  | "http_request"
  | "media_job"
  | "media_task_id"
  | "batch_item"
  | "author_binding"
  | "ledger_receipt"
  | "organization";

/** What the single identifier resolved to. */
export type TraceAnchor = Readonly<{
  kind: TraceIdentifierKind;
  /** The identifier the operator actually supplied, verbatim. Without it the
   *  anchor row itself is unreadable whenever billingRequestId is null — a
   *  non-gateway gateway_transactions row (topup/refund/expire/author-refund,
   *  request_id not 'gw:'-prefixed) or a pre-0081 prediction_jobs row keyed by
   *  task_id with a NULL billing_request_id (0081 made the column nullable).
   *  Both are reachable operator inputs; neither may lose its own row. */
  matchedId: string;
  /** Null when the anchor is NOT a request identity: an organization, or a
   *  gateway_transactions row whose request_id does not encode a billing id. */
  billingRequestId: string | null;
  orgId: string | null;
  taskId: string | null;
  attemptId: string | null;
  /** gateway_transactions.request_id as written by the settlement (0067) —
   *  'gw:' || billing_request_id — or null when the anchor is not a receipt. */
  ledgerRequestId: string | null;
}>;

export type TraceOrganization = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: string | null;
  subscriptionCredits: bigint;
  paygCredits: bigint;
  refundDebtCredits: bigint;
  subscriptionCreditsExpiresAt: string | null;
}>;

export type TraceAdmission = Readonly<{
  billingRequestId: string;
  orgId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  routeKind: string;
  billingMode: string;
  modelSlug: string;
  authorizedMaxCredits: bigint;
  heldSubscriptionCredits: bigint;
  heldPaygCredits: bigint;
  actualCostCredits: bigint | null;
  attemptId: string | null;
  upstreamId: string | null;
  outcomeKind: string | null;
  state: string;
  releasedSubscriptionCredits: bigint;
  releasedPaygCredits: bigint;
  debtRepaidCredits: bigint;
  expiredSubscriptionCredits: bigint;
  createdAt: string;
  dispatchedAt: string | null;
  outcomeRecordedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  reconcileAfter: string | null;
}>;

export type TraceAdmissionEvent = Readonly<{
  eventKey: string;
  eventKind: string;
  heldSubscriptionCredits: bigint;
  heldPaygCredits: bigint;
  usedSubscriptionCredits: bigint;
  usedPaygCredits: bigint;
  releasedSubscriptionCredits: bigint;
  releasedPaygCredits: bigint;
  debtRepaidCredits: bigint;
  expiredSubscriptionCredits: bigint;
  createdAt: string;
}>;

export type TraceQuotaContext = Readonly<{
  billingRequestId: string;
  quotaVersion: number;
  apiKeyId: string;
  declaredSessionId: string | null;
  supplierFormulaVersion: string;
  supplierAuthorizedMaxUsdMicro: bigint;
  supplierActualUsdMicro: bigint | null;
  admittedAt: string;
}>;

export type TraceQuotaReservation = Readonly<{
  bucketId: string;
  kind: string;
  reservedMax: bigint;
  actualAmount: bigint | null;
  state: string;
}>;

export type TraceQuotaEvent = Readonly<{
  kind: string;
  eventKind: string;
  bucketId: string;
  reservedDelta: bigint;
  settledDelta: bigint;
  releasedAmount: bigint;
  createdAt: string;
}>;

export type TraceHttpRequest = Readonly<{
  billingRequestId: string;
  apiKeyId: string;
  routeKind: string;
  billingMode: string;
  contractVersion: number;
  createdAt: string;
}>;

export type TraceHttpResult = Readonly<{
  billingRequestId: string;
  contractVersion: number;
  httpStatus: number;
  contentType: string;
  responseDigest: string;
  storedAt: string;
  payloadExpiredAt: string | null;
}>;

export type TraceHttpRejection = Readonly<{
  billingRequestId: string;
  rejectionCode: string;
  httpStatus: number;
  terminalAt: string;
}>;

export type TraceMediaJob = Readonly<{
  id: string;
  taskId: string;
  billingRequestId: string | null;
  routeKind: string | null;
  status: string;
  modelSlug: string;
  upstreamId: string;
  providerFamily: string | null;
  providerTaskId: string | null;
  /** 0081 added all three as NULL-able columns; a row that never reached quote
   *  has them NULL. That is a partial row, not a corrupt one — it must not 503
   *  the whole trace. */
  quotedRetailMicrocredits: bigint | null;
  quotedSupplierMicrocredits: bigint | null;
  deadlineAt: string | null;
  settledAt: string | null;
  errorMessage: string | null;
}>;

export type TraceAuthorBinding = Readonly<{
  billingRequestId: string;
  authorUserId: string;
  versionId: string;
  policyId: string;
  disputed: boolean;
  createdAt: string;
}>;

export type TraceAuthorLedgerEntry = Readonly<{
  id: string;
  kind: string;
  amountMicrocredits: bigint;
  availableAt: string;
  createdAt: string;
}>;

export type TraceAuthorRefund = Readonly<{
  refundId: string;
  totalMicrocredits: bigint;
  subscriptionMicrocredits: bigint;
  paygMicrocredits: bigint;
  expiredSubscriptionMicrocredits: bigint;
  debtRepaidMicrocredits: bigint;
  createdAt: string;
}>;

export type TraceAuthorResolution = Readonly<{
  id: string;
  attemptId: string;
  kind: string;
  createdAt: string;
}>;

export type TraceLedgerEntry = Readonly<{
  id: string;
  requestId: string | null;
  type: string;
  source: string;
  delta: bigint;
  createdAt: string;
}>;

export type TraceAuditEntry = Readonly<{
  id: string;
  actorEmail: string | null;
  action: string;
  details: unknown;
  createdAt: string;
}>;

/**
 * Purely derived from the rows above — no new authority, no new invariant. It
 * exists because "operator must resolve a billing dispute" reduces to: does the
 * money actually written to the ledger equal what the admission charged?
 *
 * `status` is discriminated, not a nullable boolean, because the three answers
 * an operator needs are genuinely different facts and `null` conflated two of
 * them into one "unknown":
 *   - `not_charged` — the admission charged zero, so NO api_usage row can exist
 *     (0067:589 only writes the receipt when _used_* > 0). "Nothing was taken"
 *     is a VERIFIED fact, not missing information.
 *   - `unknown`      — the chain does not say yet (no admission, cost not
 *     recorded, or settled but no ledger write visible). Genuinely unanswerable.
 *   - `balanced` / `unbalanced` — both sides are present and were compared.
 */
export type TraceReconciliationStatus =
  | "not_charged"
  | "balanced"
  | "unbalanced"
  | "unknown";

export type TraceReconciliation = Readonly<{
  actualCostCredits: bigint | null;
  ledgerDeltaCredits: bigint;
  ledgerUsageEntries: number;
  status: TraceReconciliationStatus;
  /** Convenience projection of `status`; null for `not_charged` and `unknown`,
   *  which are not "we compared and it did not add up". */
  balanced: boolean | null;
}>;

export type TraceContext = Readonly<{
  anchor: TraceAnchor;
  organization: TraceOrganization | null;
  admission: TraceAdmission | null;
  admissionEvents: readonly TraceAdmissionEvent[];
  quotaContext: TraceQuotaContext | null;
  quotaReservations: readonly TraceQuotaReservation[];
  quotaEvents: readonly TraceQuotaEvent[];
  httpRequest: TraceHttpRequest | null;
  httpResult: TraceHttpResult | null;
  httpRejection: TraceHttpRejection | null;
  mediaJob: TraceMediaJob | null;
  authorBinding: TraceAuthorBinding | null;
  authorLedger: readonly TraceAuthorLedgerEntry[];
  authorRefund: TraceAuthorRefund | null;
  authorResolution: TraceAuthorResolution | null;
  ledger: readonly TraceLedgerEntry[];
  auditLog: readonly TraceAuditEntry[];
  reconciliation: TraceReconciliation;
}>;

export class TraceContextInvalidError extends AiagError {
  constructor(message = "Trace identifier is not a recognized billing identifier") {
    super("TRACE_IDENTIFIER_INVALID", 400, message);
  }
}

export class TraceContextUnavailableError extends AiagError {
  constructor() {
    super("TRACE_CONTEXT_UNAVAILABLE", 503, "Trace context unavailable");
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID = /^task_[0-9a-f]{32}$/;

function unavailable(): never {
  throw new TraceContextUnavailableError();
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) unavailable();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") unavailable();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function money(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) unavailable();
  return BigInt(value);
}

function nullableMoney(value: unknown): bigint | null {
  return value === null ? null : money(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    unavailable();
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") unavailable();
  return value;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") unavailable();
  return value as Record<string, unknown>;
}

function single(rows: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rows) || rows.length > 1) unavailable();
  if (rows.length === 0) return null;
  return row(rows[0]);
}

function many(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) unavailable();
  return rows.map(row);
}

/**
 * Fail closed unless the caller presented a usable admin context. Pure, local,
 * and deliberately BEFORE any statement: an unauthorized caller must not be
 * able to distinguish "id unknown" from "id exists" by timing or by result.
 */
function assertTraceAdmin(admin: unknown): void {
  if (!admin || typeof admin !== "object")
    throw new TraceContextForbiddenError();
  const { actorId, orgId } = admin as TraceAdminContext;
  if (typeof actorId !== "string" || !UUID_V4.test(actorId))
    throw new TraceContextForbiddenError();
  if (orgId !== undefined && orgId !== null) {
    if (typeof orgId !== "string" || !UUID_V4.test(orgId))
      throw new TraceContextForbiddenError();
  }
}

/** Classify the operator's identifier before it ever reaches SQL. */
export type TraceIdentifier =
  | Readonly<{ kind: "uuid"; value: string }>
  | Readonly<{ kind: "task_id"; value: string }>;

export function classifyTraceIdentifier(identifier: string): TraceIdentifier {
  if (typeof identifier !== "string") throw new TraceContextInvalidError();
  const value = identifier.trim();
  if (UUID_V4.test(value)) return Object.freeze({ kind: "uuid", value });
  if (TASK_ID.test(value)) return Object.freeze({ kind: "task_id", value });
  throw new TraceContextInvalidError();
}

/**
 * Resolve one identifier to the request/org it belongs to. A uuid is ambiguous
 * across seven tables, so the lookup is a single UNION ALL over the tables that
 * actually carry a billing_request_id, with a deterministic priority so a
 * billing_request_id that also appears as somebody else's foreign key still
 * resolves to the request itself.
 */
export async function resolveTraceAnchor(
  identifier: string,
  client: SqlClient = defaultSql,
): Promise<TraceAnchor | null> {
  const classified = classifyTraceIdentifier(identifier);
  try {
    const rows =
      classified.kind === "uuid"
        ? await client`
            SELECT anchor_kind, billing_request_id::text, org_id::text, task_id::text,
                   attempt_id::text, ledger_request_id, priority
              FROM (
                SELECT 'http_request'::text AS anchor_kind, r.billing_request_id, r.org_id,
                       NULL::varchar AS task_id, NULL::uuid AS attempt_id,
                       NULL::varchar AS ledger_request_id, 1 AS priority
                  FROM gateway_http_requests r WHERE r.billing_request_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'billing_request_id', a.billing_request_id, a.org_id,
                       NULL::varchar, a.attempt_id, NULL::varchar, 2
                  FROM gateway_charge_admissions a WHERE a.billing_request_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'author_binding', b.billing_request_id, b.org_id,
                       NULL::varchar, NULL::uuid, NULL::varchar, 3
                  FROM author_request_bindings b WHERE b.billing_request_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'media_job', p.billing_request_id, p.org_id,
                       p.task_id, NULL::uuid, NULL::varchar, 4
                  FROM prediction_jobs p WHERE p.billing_request_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'batch_item', i.billing_request_id, b.org_id,
                       NULL::varchar, i.attempt_id, NULL::varchar, 5
                  FROM batch_items i JOIN batches b ON b.id = i.batch_id
                 WHERE i.billing_request_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'attempt_id', a.billing_request_id, a.org_id,
                       NULL::varchar, a.attempt_id, NULL::varchar, 6
                  FROM gateway_charge_admissions a WHERE a.attempt_id = ${classified.value}::uuid
                UNION ALL
                SELECT 'ledger_receipt', NULL::uuid, t.org_id,
                       NULL::varchar, NULL::uuid, t.request_id, 7
                  FROM gateway_transactions t WHERE t.id = ${classified.value}::uuid
                UNION ALL
                SELECT 'organization', NULL::uuid, o.id,
                       NULL::varchar, NULL::uuid, NULL::varchar, 8
                  FROM organizations o WHERE o.id = ${classified.value}::uuid
              ) anchors
             ORDER BY priority
             LIMIT 1`
        : await client`
            SELECT 'media_task_id'::text AS anchor_kind, p.billing_request_id::text,
                   p.org_id::text, p.task_id::text, NULL::text AS attempt_id,
                   NULL::text AS ledger_request_id, 1 AS priority
              FROM prediction_jobs p
             WHERE p.task_id = ${classified.value}::varchar
             ORDER BY p.created_at
             LIMIT 1`;

    const found = single(rows);
    if (found === null) return null;
    const kind = found.anchor_kind;
    if (
      kind !== "billing_request_id" &&
      kind !== "attempt_id" &&
      kind !== "http_request" &&
      kind !== "media_job" &&
      kind !== "media_task_id" &&
      kind !== "batch_item" &&
      kind !== "author_binding" &&
      kind !== "ledger_receipt" &&
      kind !== "organization"
    )
      unavailable();
    const billingRequestId =
      found.billing_request_id === null ? null : uuid(found.billing_request_id);
    const orgId = found.org_id === null ? null : uuid(found.org_id);
    const taskId = found.task_id === null ? null : text(found.task_id);
    const attemptId = found.attempt_id === null ? null : uuid(found.attempt_id);
    const ledgerRequestId = nullableText(found.ledger_request_id);
    // A settlement receipt carries the billing id only inside its request_id
    // ('gw:' || billing_request_id, 0067) — recover it rather than emit a trace
    // with no admission.
    const recovered =
      billingRequestId ?? (ledgerRequestId?.startsWith("gw:")
        ? uuid(ledgerRequestId.slice(3))
        : null);
    return Object.freeze({
      kind,
      matchedId: classified.value,
      billingRequestId: recovered,
      orgId,
      taskId,
      attemptId,
      ledgerRequestId,
    });
  } catch (error) {
    if (error instanceof AiagError) throw error;
    throw new TraceContextUnavailableError();
  }
}

function parseOrganization(value: unknown): TraceOrganization | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    id: uuid(r.id),
    slug: text(r.slug),
    name: text(r.name),
    status: nullableText(r.status),
    subscriptionCredits: money(r.subscription_credits),
    paygCredits: money(r.payg_credits),
    refundDebtCredits: money(r.refund_debt_credits),
    subscriptionCreditsExpiresAt: nullableText(
      r.subscription_credits_expires_at,
    ),
  });
}

function parseAdmission(value: unknown): TraceAdmission | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    orgId: uuid(r.org_id),
    apiKeyId: uuid(r.api_key_id),
    clientRequestId: nullableText(r.client_request_id),
    routeKind: text(r.route_kind),
    billingMode: text(r.billing_mode),
    modelSlug: text(r.model_slug),
    authorizedMaxCredits: money(r.authorized_max_credits),
    heldSubscriptionCredits: money(r.held_subscription_credits),
    heldPaygCredits: money(r.held_payg_credits),
    actualCostCredits: nullableMoney(r.actual_cost_credits),
    attemptId: r.attempt_id === null ? null : uuid(r.attempt_id),
    upstreamId: nullableText(r.upstream_id),
    outcomeKind: nullableText(r.outcome_kind),
    state: text(r.state),
    releasedSubscriptionCredits: money(r.released_subscription_credits),
    releasedPaygCredits: money(r.released_payg_credits),
    debtRepaidCredits: money(r.debt_repaid_credits),
    expiredSubscriptionCredits: money(r.expired_subscription_credits),
    createdAt: text(r.created_at),
    dispatchedAt: nullableText(r.dispatched_at),
    outcomeRecordedAt: nullableText(r.outcome_recorded_at),
    settledAt: nullableText(r.settled_at),
    cancelledAt: nullableText(r.cancelled_at),
    reconcileAfter: nullableText(r.reconcile_after),
  });
}

function parseAdmissionEvents(value: unknown): TraceAdmissionEvent[] {
  return many(value).map((r) =>
    Object.freeze({
      eventKey: text(r.event_key),
      eventKind: text(r.event_kind),
      heldSubscriptionCredits: money(r.held_subscription_credits),
      heldPaygCredits: money(r.held_payg_credits),
      usedSubscriptionCredits: money(r.used_subscription_credits),
      usedPaygCredits: money(r.used_payg_credits),
      releasedSubscriptionCredits: money(r.released_subscription_credits),
      releasedPaygCredits: money(r.released_payg_credits),
      debtRepaidCredits: money(r.debt_repaid_credits),
      expiredSubscriptionCredits: money(r.expired_subscription_credits),
      createdAt: text(r.created_at),
    }),
  );
}

function parseQuotaContext(value: unknown): TraceQuotaContext | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    quotaVersion: count(r.quota_version),
    apiKeyId: uuid(r.api_key_id),
    declaredSessionId: nullableText(r.declared_session_id),
    supplierFormulaVersion: text(r.supplier_formula_version),
    supplierAuthorizedMaxUsdMicro: money(r.supplier_authorized_max_usd_micro),
    supplierActualUsdMicro: nullableMoney(r.supplier_actual_usd_micro),
    admittedAt: text(r.admitted_at),
  });
}

function parseQuotaReservations(value: unknown): TraceQuotaReservation[] {
  return many(value).map((r) =>
    Object.freeze({
      bucketId: uuid(r.bucket_id),
      kind: text(r.kind),
      reservedMax: money(r.reserved_max),
      actualAmount: nullableMoney(r.actual_amount),
      state: text(r.state),
    }),
  );
}

function parseQuotaEvents(value: unknown): TraceQuotaEvent[] {
  return many(value).map((r) =>
    Object.freeze({
      kind: text(r.kind),
      eventKind: text(r.event_kind),
      bucketId: uuid(r.bucket_id),
      reservedDelta: money(r.reserved_delta),
      settledDelta: money(r.settled_delta),
      releasedAmount: money(r.released_amount),
      createdAt: text(r.created_at),
    }),
  );
}

function parseHttpRequest(value: unknown): TraceHttpRequest | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    apiKeyId: uuid(r.api_key_id),
    routeKind: text(r.route_kind),
    billingMode: text(r.billing_mode),
    contractVersion: count(r.contract_version),
    createdAt: text(r.created_at),
  });
}

function parseHttpResult(value: unknown): TraceHttpResult | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    contractVersion: count(r.contract_version),
    httpStatus: count(r.http_status),
    contentType: text(r.content_type),
    responseDigest: text(r.response_digest),
    storedAt: text(r.stored_at),
    payloadExpiredAt: nullableText(r.payload_expired_at),
  });
}

function parseHttpRejection(value: unknown): TraceHttpRejection | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    rejectionCode: text(r.rejection_code),
    httpStatus: count(r.http_status),
    terminalAt: text(r.terminal_at),
  });
}

function parseMediaJob(value: unknown): TraceMediaJob | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    id: uuid(r.id),
    taskId: text(r.task_id),
    billingRequestId:
      r.billing_request_id === null ? null : uuid(r.billing_request_id),
    routeKind: nullableText(r.route_kind),
    status: text(r.status),
    modelSlug: text(r.model_slug),
    upstreamId: text(r.upstream_id),
    providerFamily: nullableText(r.provider_family),
    providerTaskId: nullableText(r.provider_task_id),
    quotedRetailMicrocredits: nullableMoney(r.quoted_retail_microcredits),
    quotedSupplierMicrocredits: nullableMoney(r.quoted_supplier_microcredits),
    deadlineAt: nullableText(r.deadline_at),
    settledAt: nullableText(r.settled_at),
    errorMessage: nullableText(r.error_message),
  });
}

function parseAuthorBinding(value: unknown): TraceAuthorBinding | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    billingRequestId: uuid(r.billing_request_id),
    authorUserId: uuid(r.author_user_id),
    versionId: uuid(r.version_id),
    policyId: uuid(r.policy_id),
    disputed: flag(r.disputed),
    createdAt: text(r.created_at),
  });
}

function parseAuthorLedger(value: unknown): TraceAuthorLedgerEntry[] {
  return many(value).map((r) =>
    Object.freeze({
      id: uuid(r.id),
      kind: text(r.kind),
      amountMicrocredits: money(r.amount_microcredits),
      availableAt: text(r.available_at),
      createdAt: text(r.created_at),
    }),
  );
}

function parseAuthorRefund(value: unknown): TraceAuthorRefund | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    refundId: uuid(r.refund_id),
    totalMicrocredits: money(r.total_microcredits),
    subscriptionMicrocredits: money(r.subscription_microcredits),
    paygMicrocredits: money(r.payg_microcredits),
    expiredSubscriptionMicrocredits: money(r.expired_subscription_microcredits),
    debtRepaidMicrocredits: money(r.debt_repaid_microcredits),
    createdAt: text(r.created_at),
  });
}

function parseAuthorResolution(value: unknown): TraceAuthorResolution | null {
  const r = single(value);
  if (r === null) return null;
  return Object.freeze({
    id: uuid(r.id),
    attemptId: uuid(r.attempt_id),
    kind: text(r.kind),
    createdAt: text(r.created_at),
  });
}

function parseLedger(value: unknown): TraceLedgerEntry[] {
  return many(value).map((r) =>
    Object.freeze({
      id: uuid(r.id),
      requestId: nullableText(r.request_id),
      type: text(r.type),
      source: text(r.source),
      delta: money(r.delta),
      createdAt: text(r.created_at),
    }),
  );
}

function parseAudit(value: unknown): TraceAuditEntry[] {
  return many(value).map((r) =>
    Object.freeze({
      id: text(r.id),
      actorEmail: nullableText(r.actor_email),
      action: text(r.action),
      details: r.details ?? null,
      createdAt: text(r.created_at),
    }),
  );
}

/** Derived, read-only. See TraceReconciliation. */
export function reconcileTrace(
  admission: TraceAdmission | null,
  ledger: readonly TraceLedgerEntry[],
): TraceReconciliation {
  const usage = ledger.filter((entry) => entry.type === "api_usage");
  const delta = usage.reduce((sum, entry) => sum + entry.delta, 0n);
  const actual = admission === null ? null : admission.actualCostCredits;
  // A zero-cost admission is a positive statement, and per 0067:589 it writes
  // NO api_usage row at all — so an empty usage set under a zero charge is the
  // expected shape of a verified_no_charge, not missing data. Reporting it as
  // "unknown" sent operators hunting for a receipt that cannot exist.
  let status: TraceReconciliationStatus;
  if (actual === null) status = "unknown";
  else if (actual === 0n) {
    // Still refuse to claim balance if the ledger somehow holds usage against a
    // zero-cost admission — that is a real discrepancy, not a no-charge.
    if (usage.length === 0) status = "not_charged";
    else status = -delta === 0n ? "balanced" : "unbalanced";
  } else if (usage.length === 0) status = "unknown";
  else status = -delta === actual ? "balanced" : "unbalanced";
  return Object.freeze({
    actualCostCredits: actual,
    ledgerDeltaCredits: delta,
    ledgerUsageEntries: usage.length,
    status,
    balanced:
      status === "balanced" ? true : status === "unbalanced" ? false : null,
  });
}

async function readOrganization(
  orgId: string,
  client: SqlClient,
): Promise<TraceOrganization | null> {
  const rows = await client`
    SELECT id::text, slug, name, status,
           subscription_credits::text, payg_credits::text, refund_debt_credits::text,
           CASE WHEN subscription_credits_expires_at IS NULL THEN NULL
                ELSE to_char(subscription_credits_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS subscription_credits_expires_at
      FROM organizations
     WHERE id = ${orgId}::uuid`;
  return parseOrganization(rows);
}

async function readChargeChain(
  billingRequestId: string,
  client: SqlClient,
): Promise<{
  admission: TraceAdmission | null;
  admissionEvents: readonly TraceAdmissionEvent[];
  quotaContext: TraceQuotaContext | null;
  quotaReservations: readonly TraceQuotaReservation[];
  quotaEvents: readonly TraceQuotaEvent[];
}> {
  const admissionRows = await client`
    SELECT billing_request_id::text, org_id::text, api_key_id::text, client_request_id,
           route_kind, billing_mode, model_slug,
           authorized_max_credits::text, held_subscription_credits::text, held_payg_credits::text,
           actual_cost_credits::text, attempt_id::text, upstream_id, outcome_kind, state,
           released_subscription_credits::text, released_payg_credits::text,
           debt_repaid_credits::text, expired_subscription_credits::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dispatched_at,
           to_char(outcome_recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS outcome_recorded_at,
           to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS settled_at,
           to_char(cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cancelled_at,
           to_char(reconcile_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_after
      FROM gateway_charge_admissions
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const admission = parseAdmission(admissionRows);

  const eventRows = await client`
    SELECT event_key, event_kind,
           held_subscription_credits::text, held_payg_credits::text,
           used_subscription_credits::text, used_payg_credits::text,
           released_subscription_credits::text, released_payg_credits::text,
           debt_repaid_credits::text, expired_subscription_credits::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM gateway_charge_admission_events
     WHERE admission_id = ${billingRequestId}::uuid
     ORDER BY created_at, event_key`;

  const contextRows = await client`
    SELECT billing_request_id::text, quota_version, api_key_id::text, declared_session_id,
           supplier_formula_version,
           supplier_authorized_max_usd_micro::text, supplier_actual_usd_micro::text,
           to_char(admitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS admitted_at
      FROM gateway_charge_quota_contexts
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const quotaContext = parseQuotaContext(contextRows);

  const reservationRows = await client`
    SELECT bucket_id::text, kind, reserved_max::text, actual_amount::text, state
      FROM gateway_charge_quota_reservations
     WHERE billing_request_id = ${billingRequestId}::uuid
     ORDER BY kind, bucket_id`;

  const quotaEventRows = await client`
    SELECT kind, event_kind, bucket_id::text,
           reserved_delta::text, settled_delta::text, released_amount::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM gateway_charge_quota_events
     WHERE billing_request_id = ${billingRequestId}::uuid
     ORDER BY created_at, kind, event_kind`;

  return Object.freeze({
    admission,
    admissionEvents: Object.freeze(parseAdmissionEvents(eventRows)),
    quotaContext,
    quotaReservations: Object.freeze(parseQuotaReservations(reservationRows)),
    quotaEvents: Object.freeze(parseQuotaEvents(quotaEventRows)),
  });
}

async function readHttpChain(
  billingRequestId: string,
  client: SqlClient,
): Promise<{
  httpRequest: TraceHttpRequest | null;
  httpResult: TraceHttpResult | null;
  httpRejection: TraceHttpRejection | null;
}> {
  const requestRows = await client`
    SELECT billing_request_id::text, api_key_id::text, route_kind, billing_mode, contract_version,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM gateway_http_requests
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const resultRows = await client`
    SELECT billing_request_id::text, contract_version, http_status, content_type, response_digest,
           to_char(stored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
           CASE WHEN payload_expired_at IS NULL THEN NULL
                ELSE to_char(payload_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS payload_expired_at
      FROM gateway_http_results
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const rejectionRows = await client`
    SELECT billing_request_id::text, rejection_code, http_status,
           to_char(terminal_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS terminal_at
      FROM gateway_http_rejections
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  return Object.freeze({
    httpRequest: parseHttpRequest(requestRows),
    httpResult: parseHttpResult(resultRows),
    httpRejection: parseHttpRejection(rejectionRows),
  });
}

async function readMediaChain(
  billingRequestId: string,
  taskId: string | null,
  client: SqlClient,
): Promise<TraceMediaJob | null> {
  const rows = await client`
    SELECT id::text, task_id, billing_request_id::text, route_kind, status, model_slug, upstream_id,
           provider_family, provider_task_id,
           quoted_retail_microcredits::text, quoted_supplier_microcredits::text,
           to_char(deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at,
           CASE WHEN settled_at IS NULL THEN NULL
                ELSE to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS settled_at,
           error_message
      FROM prediction_jobs
     WHERE billing_request_id = ${billingRequestId}::uuid
        OR (${taskId}::varchar IS NOT NULL AND task_id = ${taskId}::varchar)
     ORDER BY created_at
     LIMIT 1`;
  return parseMediaJob(rows);
}

async function readAuthorChain(
  billingRequestId: string,
  client: SqlClient,
): Promise<{
  authorBinding: TraceAuthorBinding | null;
  authorLedger: readonly TraceAuthorLedgerEntry[];
  authorRefund: TraceAuthorRefund | null;
  authorResolution: TraceAuthorResolution | null;
}> {
  const bindingRows = await client`
    SELECT billing_request_id::text, author_user_id::text, version_id::text, policy_id::text,
           disputed,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM author_request_bindings
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const ledgerRows = await client`
    SELECT id::text, kind, amount_microcredits::text,
           to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS available_at,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM author_credit_ledger
     WHERE billing_request_id = ${billingRequestId}::uuid
     ORDER BY created_at, kind`;
  const refundRows = await client`
    SELECT refund_id::text, total_microcredits::text, subscription_microcredits::text,
           payg_microcredits::text, expired_subscription_microcredits::text,
           debt_repaid_microcredits::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM author_charge_refunds
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  const resolutionRows = await client`
    SELECT id::text, attempt_id::text, kind,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM author_operator_resolutions
     WHERE billing_request_id = ${billingRequestId}::uuid`;
  return Object.freeze({
    authorBinding: parseAuthorBinding(bindingRows),
    authorLedger: Object.freeze(parseAuthorLedger(ledgerRows)),
    authorRefund: parseAuthorRefund(refundRows),
    authorResolution: parseAuthorResolution(resolutionRows),
  });
}

async function readLedger(
  billingRequestId: string,
  client: SqlClient,
): Promise<TraceLedgerEntry[]> {
  // TWO statements, deliberately.
  //
  // (1) request_id forms. The settlement writes 'gw:'||billing_request_id
  // (0067:588) and the author refund path writes 'author-refund:'||billing
  // (0089:219-220). This half is an equality on request_id and rides
  // gateway_transactions_api_usage_uniq (0004:222) / gateway_transactions_
  // refund_uniq (0066:98). It must not be OR-ed with anything unindexable.
  const byRequestId = await client`
    SELECT id::text, request_id, type, source, delta::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM gateway_transactions
     WHERE request_id = ${"gw:" + billingRequestId}::varchar
        OR request_id = ${"author-refund:" + billingRequestId}::varchar
     ORDER BY created_at, id`;
  // (2) metadata forms. A jsonb ->> extraction has NO index on
  // gateway_transactions (nothing in 0004/0066/0072 indexes metadata), so this
  // half is a sequential scan. Kept as its own statement — and therefore its
  // own plan — so the seq scan cannot poison the indexable half above, and so
  // the cost is visible and droppable if the money ledger grows.
  const byMetadata = await client`
    SELECT id::text, request_id, type, source, delta::text,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM gateway_transactions
     WHERE metadata->>'billingRequestId' = ${billingRequestId}
        OR metadata->>'billing_request_id' = ${billingRequestId}
     ORDER BY created_at, id`;
  // A row can match both halves; the ledger entry is one row, so merge on id.
  const merged = new Map<string, TraceLedgerEntry>();
  for (const entry of [...parseLedger(byRequestId), ...parseLedger(byMetadata)])
    merged.set(entry.id, entry);
  return [...merged.values()].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );
}

async function readAuditLog(
  billingRequestId: string,
  client: SqlClient,
): Promise<TraceAuditEntry[]> {
  // resource_type is REQUIRED to make audit_log_resource_idx(resource_type,
  // resource_id) (0011:44, 0005:248) usable; filtering on resource_id alone
  // degrades to a scan of the whole audit table. Every author-side action on a
  // billing request is written with resource_type='gateway_request'
  // (0089:224, 0090:42/55/72), so this narrows nothing real away.
  const rows = await client`
    SELECT id::text, actor_email, action, details,
           to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM audit_log
     WHERE resource_type = 'gateway_request'
       AND resource_id = ${billingRequestId}::varchar
     ORDER BY created_at, id`;
  return parseAudit(rows);
}

/**
 * Read the anchor's OWN row for the anchors that are not a request identity.
 *
 * A null billingRequestId is not an excuse to return a bare organization
 * balance. Two reachable operator inputs land here and both would otherwise
 * lose the very row the operator asked about:
 *   (a) a gateway_transactions.id that is NOT a gateway settlement (topup,
 *       refund, expire, author-refund — 0089:219-221 writes those with a
 *       non-'gw:' request_id), so no billing id is recoverable from it;
 *   (b) a prediction_jobs.task_id whose billing_request_id is NULL, which is
 *       every pre-0081 media job (0081 added the column as NULL-able).
 */
async function readAnchorRow(
  anchor: TraceAnchor,
  client: SqlClient,
): Promise<{
  mediaJob: TraceMediaJob | null;
  ledger: readonly TraceLedgerEntry[];
}> {
  if (anchor.kind === "ledger_receipt") {
    const rows = await client`
      SELECT id::text, request_id, type, source, delta::text,
             to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM gateway_transactions
       WHERE id = ${anchor.matchedId}::uuid`;
    return { mediaJob: null, ledger: Object.freeze(parseLedger(rows)) };
  }
  if (anchor.kind === "media_task_id" || anchor.kind === "media_job") {
    // task_id is the identity the operator typed for a media_task_id anchor;
    // for a media_job anchor it is the matched job's own task_id. Either way it
    // is an indexed lookup (0081 unique on task_id), never a filter against a
    // nullable billing_request_id.
    const taskId = anchor.kind === "media_task_id" ? anchor.matchedId : anchor.taskId;
    if (taskId === null) return { mediaJob: null, ledger: Object.freeze([]) };
    const rows = await client`
      SELECT id::text, task_id, billing_request_id::text, route_kind, status, model_slug, upstream_id,
             provider_family, provider_task_id,
             quoted_retail_microcredits::text, quoted_supplier_microcredits::text,
             CASE WHEN deadline_at IS NULL THEN NULL
                  ELSE to_char(deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS deadline_at,
             CASE WHEN settled_at IS NULL THEN NULL
                  ELSE to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS settled_at,
             error_message
        FROM prediction_jobs
       WHERE task_id = ${taskId}::varchar
       ORDER BY created_at
       LIMIT 1`;
    return { mediaJob: parseMediaJob(rows), ledger: Object.freeze([]) };
  }
  // organization anchor: the org row IS the answer, there is no own-row to add.
  return { mediaJob: null, ledger: Object.freeze([]) };
}

function emptyTrace(anchor: TraceAnchor): TraceContext {
  return Object.freeze({
    anchor,
    organization: null,
    admission: null,
    admissionEvents: Object.freeze([]) as readonly TraceAdmissionEvent[],
    quotaContext: null,
    quotaReservations: Object.freeze([]) as readonly TraceQuotaReservation[],
    quotaEvents: Object.freeze([]) as readonly TraceQuotaEvent[],
    httpRequest: null,
    httpResult: null,
    httpRejection: null,
    mediaJob: null,
    authorBinding: null,
    authorLedger: Object.freeze([]) as readonly TraceAuthorLedgerEntry[],
    authorRefund: null,
    authorResolution: null,
    ledger: Object.freeze([]) as readonly TraceLedgerEntry[],
    auditLog: Object.freeze([]) as readonly TraceAuditEntry[],
    reconciliation: reconcileTrace(null, []),
  });
}

/**
 * Read the whole tenant → run → request → charge chain for ONE identifier.
 *
 * Returns null when the identifier matches nothing (the operator typed a
 * plausible but unknown id) and throws TraceContextInvalidError for a
 * syntactically impossible one. Every failure mode of the database itself is
 * TraceContextUnavailableError — an observability helper must never leak a raw
 * driver error to the operator, and must never half-answer.
 *
 * ADMIN ONLY. The trace discloses organization balances, api key ids, actor
 * emails and dispute details, so `admin` is a REQUIRED argument checked BEFORE
 * the first read: without an admin context nothing is read at all, and a
 * caller scoped to an org gets a refusal rather than another tenant's trace.
 */
export async function readTraceContext(
  identifier: string,
  admin: TraceAdminContext,
  client: SqlClient = defaultSql,
): Promise<TraceContext | null> {
  // Authorization precedes every read, including the anchor lookup. A missing
  // or malformed context must not even reveal whether the id exists.
  assertTraceAdmin(admin);

  const anchor = await resolveTraceAnchor(identifier, client);
  if (anchor === null) return null;
  const { billingRequestId, orgId } = anchor;
  // Org scoping is checked against the resolved anchor so a scoped admin
  // cannot probe another tenant by uuid and learn "it exists but is not yours"
  // from a difference between null and a trace.
  const scopeOrgId = admin.orgId ?? null;
  if (scopeOrgId !== null && orgId !== scopeOrgId)
    throw new TraceContextForbiddenError();

  try {
    const organization =
      orgId === null ? null : await readOrganization(orgId, client);
    if (billingRequestId === null) {
      // No request chain to walk, but the ANCHOR'S OWN row is still the answer
      // the operator asked for — read it rather than returning a bare balance.
      const own = await readAnchorRow(anchor, client);
      return Object.freeze({
        ...emptyTrace(anchor),
        organization,
        mediaJob: own.mediaJob,
        ledger: own.ledger,
        reconciliation: reconcileTrace(null, own.ledger),
      });
    }

    const charge = await readChargeChain(billingRequestId, client);
    const http = await readHttpChain(billingRequestId, client);
    const media = await readMediaChain(billingRequestId, anchor.taskId, client);
    const author = await readAuthorChain(billingRequestId, client);
    const ledger = await readLedger(billingRequestId, client);
    const auditLog = await readAuditLog(billingRequestId, client);

    return Object.freeze({
      anchor,
      organization,
      admission: charge.admission,
      admissionEvents: charge.admissionEvents,
      quotaContext: charge.quotaContext,
      quotaReservations: charge.quotaReservations,
      quotaEvents: charge.quotaEvents,
      httpRequest: http.httpRequest,
      httpResult: http.httpResult,
      httpRejection: http.httpRejection,
      mediaJob: media,
      authorBinding: author.authorBinding,
      authorLedger: author.authorLedger,
      authorRefund: author.authorRefund,
      authorResolution: author.authorResolution,
      ledger: Object.freeze(ledger),
      auditLog: Object.freeze(auditLog),
      reconciliation: reconcileTrace(charge.admission, ledger),
    });
  } catch (error) {
    if (error instanceof AiagError) throw error;
    throw new TraceContextUnavailableError();
  }
}
