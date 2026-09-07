export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type GatewayBillingMode = "stored" | "byok_fee";
export type GatewayChargeAdmissionState =
  | "held"
  | "dispatched"
  | "outcome_recorded"
  | "settled"
  | "cancelled";

/** UTC RFC 3339 with exactly six fractional digits (PostgreSQL microseconds). */
export type AdmissionTimestamp = string;

export type GatewayChargeAdmissionResult = Readonly<{
  billingRequestId: string;
  orgId: string;
  apiKeyId: string;
  clientRequestId: string | null;
  routeKind: string;
  billingMode: GatewayBillingMode;
  modelSlug: string;
  authorizedMaxCredits: bigint;
  heldSubscriptionCredits: bigint;
  heldPaygCredits: bigint;
  capturedSubscriptionExpiresAt: AdmissionTimestamp | null;
  quoteSnapshot: JsonObject;
  attemptId: string | null;
  upstreamId: string | null;
  pricingSnapshot: JsonObject | null;
  actualCostCredits: bigint | null;
  usageSnapshot: JsonObject | null;
  outcomeKind: string | null;
  state: GatewayChargeAdmissionState;
  preDispatchDeadlineAt: AdmissionTimestamp;
  createdAt: AdmissionTimestamp;
  dispatchedAt: AdmissionTimestamp | null;
  outcomeRecordedAt: AdmissionTimestamp | null;
  settledAt: AdmissionTimestamp | null;
  cancelledAt: AdmissionTimestamp | null;
  reconcileAfter: AdmissionTimestamp | null;
  releasedSubscriptionCredits: bigint;
  releasedPaygCredits: bigint;
  debtRepaidCredits: bigint;
  expiredSubscriptionCredits: bigint;
  didTransition: boolean;
}>;

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function fail(field: string): never {
  throw new Error(`Invalid gateway admission field: ${field}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("row");
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, name: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, name)) fail(name);
  return row[name];
}

export function normalizeAdmissionUuid(value: unknown, name = "uuid"): string {
  if (typeof value !== "string" || !UUID.test(value)) fail(name);
  return value.toLowerCase();
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    fail(name);
  return value;
}

function nullableBoundedString(
  value: unknown,
  name: string,
  max: number,
): string | null {
  return value === null ? null : boundedString(value, name, max);
}

export function parseAdmissionBigint(
  value: unknown,
  name = "amount",
  allowZero = true,
): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail(name);
  const parsed = BigInt(value);
  if (parsed > PG_BIGINT_MAX || (!allowZero && parsed === 0n)) fail(name);
  return parsed;
}

/**
 * Normalizes an RFC 3339 timestamp with an explicit timezone to UTC while
 * retaining all six PostgreSQL fractional digits. It never round-trips the
 * fraction through Date, which would truncate distinct microseconds.
 */
export function normalizeAdmissionTimestamp(
  value: unknown,
  name = "timestamp",
): AdmissionTimestamp {
  if (typeof value !== "string") fail(name);
  const match = TIMESTAMP.exec(value);
  if (!match) fail(name);
  const [, y, mo, d, h, mi, s, fraction = "", zone, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    fail(name);

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  )
    fail(name);

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(oh);
    const offsetMinute = Number(om);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    )
      fail(name);
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
  }
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) fail(name);
  return `${utc.toISOString().slice(0, 19)}.${fraction.padEnd(6, "0")}Z`;
}

function nullableTimestamp(
  value: unknown,
  name: string,
): AdmissionTimestamp | null {
  return value === null ? null : normalizeAdmissionTimestamp(value, name);
}

function cloneJsonValue(
  value: unknown,
  name: string,
  stack: Set<object>,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(name);
    return value;
  }
  if (typeof value !== "object") fail(name);
  if (stack.has(value)) fail(name);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      )
        fail(name);
      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor)) fail(name);
        clone.push(cloneJsonValue(descriptor.value, name, stack));
      }
      return Object.freeze(clone);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(name);
    if (Object.getOwnPropertySymbols(value).length !== 0) fail(name);
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== Object.keys(value).length) fail(name);
    const clone: Record<string, JsonValue> = {};
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) fail(name);
      Object.defineProperty(clone, key, {
        value: cloneJsonValue(descriptor.value, name, stack),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(clone);
  } finally {
    stack.delete(value);
  }
}

export function parseAdmissionJsonObject(
  value: unknown,
  name = "snapshot",
): JsonObject {
  const clone = cloneJsonValue(value, name, new Set());
  if (clone === null || typeof clone !== "object" || Array.isArray(clone))
    fail(name);
  return clone as JsonObject;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

export function admissionJsonObjectsEqual(
  left: JsonObject,
  right: JsonObject,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareTimestamp(
  left: AdmissionTimestamp,
  right: AdmissionTimestamp,
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireNull(values: Array<[string, unknown]>): void {
  for (const [name, value] of values) if (value !== null) fail(name);
}

function requirePresent(values: Array<[string, unknown]>): void {
  for (const [name, value] of values) if (value === null) fail(name);
}

export function parseGatewayChargeAdmissionResult(
  rowValue: unknown,
): GatewayChargeAdmissionResult {
  const row = asRecord(rowValue);
  const stateValue = field(row, "state");
  if (
    ![
      "held",
      "dispatched",
      "outcome_recorded",
      "settled",
      "cancelled",
    ].includes(stateValue as string)
  )
    fail("state");
  const billingModeValue = field(row, "billing_mode");
  if (billingModeValue !== "stored" && billingModeValue !== "byok_fee")
    fail("billing_mode");

  const result: GatewayChargeAdmissionResult = {
    billingRequestId: normalizeAdmissionUuid(
      field(row, "billing_request_id"),
      "billing_request_id",
    ),
    orgId: normalizeAdmissionUuid(field(row, "org_id"), "org_id"),
    apiKeyId: normalizeAdmissionUuid(field(row, "api_key_id"), "api_key_id"),
    clientRequestId: nullableBoundedString(
      field(row, "client_request_id"),
      "client_request_id",
      255,
    ),
    routeKind: boundedString(field(row, "route_kind"), "route_kind", 32),
    billingMode: billingModeValue,
    modelSlug: boundedString(field(row, "model_slug"), "model_slug", 128),
    authorizedMaxCredits: parseAdmissionBigint(
      field(row, "authorized_max_credits"),
      "authorized_max_credits",
      false,
    ),
    heldSubscriptionCredits: parseAdmissionBigint(
      field(row, "held_subscription_credits"),
      "held_subscription_credits",
    ),
    heldPaygCredits: parseAdmissionBigint(
      field(row, "held_payg_credits"),
      "held_payg_credits",
    ),
    capturedSubscriptionExpiresAt: nullableTimestamp(
      field(row, "captured_subscription_expires_at"),
      "captured_subscription_expires_at",
    ),
    quoteSnapshot: parseAdmissionJsonObject(
      field(row, "quote_snapshot"),
      "quote_snapshot",
    ),
    attemptId:
      field(row, "attempt_id") === null
        ? null
        : normalizeAdmissionUuid(field(row, "attempt_id"), "attempt_id"),
    upstreamId: nullableBoundedString(
      field(row, "upstream_id"),
      "upstream_id",
      64,
    ),
    pricingSnapshot:
      field(row, "pricing_snapshot") === null
        ? null
        : parseAdmissionJsonObject(
            field(row, "pricing_snapshot"),
            "pricing_snapshot",
          ),
    actualCostCredits:
      field(row, "actual_cost_credits") === null
        ? null
        : parseAdmissionBigint(
            field(row, "actual_cost_credits"),
            "actual_cost_credits",
          ),
    usageSnapshot:
      field(row, "usage_snapshot") === null
        ? null
        : parseAdmissionJsonObject(
            field(row, "usage_snapshot"),
            "usage_snapshot",
          ),
    outcomeKind: nullableBoundedString(
      field(row, "outcome_kind"),
      "outcome_kind",
      32,
    ),
    state: stateValue as GatewayChargeAdmissionState,
    preDispatchDeadlineAt: normalizeAdmissionTimestamp(
      field(row, "pre_dispatch_deadline_at"),
      "pre_dispatch_deadline_at",
    ),
    createdAt: normalizeAdmissionTimestamp(
      field(row, "created_at"),
      "created_at",
    ),
    dispatchedAt: nullableTimestamp(
      field(row, "dispatched_at"),
      "dispatched_at",
    ),
    outcomeRecordedAt: nullableTimestamp(
      field(row, "outcome_recorded_at"),
      "outcome_recorded_at",
    ),
    settledAt: nullableTimestamp(field(row, "settled_at"), "settled_at"),
    cancelledAt: nullableTimestamp(field(row, "cancelled_at"), "cancelled_at"),
    reconcileAfter: nullableTimestamp(
      field(row, "reconcile_after"),
      "reconcile_after",
    ),
    releasedSubscriptionCredits: parseAdmissionBigint(
      field(row, "released_subscription_credits"),
      "released_subscription_credits",
    ),
    releasedPaygCredits: parseAdmissionBigint(
      field(row, "released_payg_credits"),
      "released_payg_credits",
    ),
    debtRepaidCredits: parseAdmissionBigint(
      field(row, "debt_repaid_credits"),
      "debt_repaid_credits",
    ),
    expiredSubscriptionCredits: parseAdmissionBigint(
      field(row, "expired_subscription_credits"),
      "expired_subscription_credits",
    ),
    didTransition: (() => {
      const value = field(row, "did_transition");
      if (typeof value !== "boolean") fail("did_transition");
      return value;
    })(),
  };

  if (
    result.heldSubscriptionCredits + result.heldPaygCredits !==
    result.authorizedMaxCredits
  )
    fail("held_credits");
  if (result.actualCostCredits !== null) {
    if (result.actualCostCredits > result.authorizedMaxCredits)
      fail("actual_cost_credits");
    if (
      result.actualCostCredits === 0n &&
      result.outcomeKind !== "success" &&
      result.outcomeKind !== "verified_no_charge"
    )
      fail("outcome_kind");
  }
  if (
    result.releasedSubscriptionCredits + result.expiredSubscriptionCredits >
    result.heldSubscriptionCredits
  )
    fail("released_subscription_credits");
  if (
    result.releasedPaygCredits + result.debtRepaidCredits >
    result.heldPaygCredits
  )
    fail("released_payg_credits");
  if (compareTimestamp(result.preDispatchDeadlineAt, result.createdAt) < 0)
    fail("pre_dispatch_deadline_at");
  if (
    result.dispatchedAt !== null &&
    (compareTimestamp(result.dispatchedAt, result.createdAt) < 0 ||
      compareTimestamp(result.dispatchedAt, result.preDispatchDeadlineAt) >= 0)
  )
    fail("dispatched_at");
  if (
    result.outcomeRecordedAt !== null &&
    (result.dispatchedAt === null ||
      compareTimestamp(result.outcomeRecordedAt, result.dispatchedAt) < 0)
  )
    fail("outcome_recorded_at");
  if (
    result.settledAt !== null &&
    (result.outcomeRecordedAt === null ||
      compareTimestamp(result.settledAt, result.outcomeRecordedAt) < 0)
  )
    fail("settled_at");
  if (
    result.cancelledAt !== null &&
    compareTimestamp(result.cancelledAt, result.createdAt) < 0
  )
    fail("cancelled_at");

  const dispatchFacts: Array<[string, unknown]> = [
    ["attempt_id", result.attemptId],
    ["upstream_id", result.upstreamId],
    ["pricing_snapshot", result.pricingSnapshot],
    ["dispatched_at", result.dispatchedAt],
  ];
  const outcomeFacts: Array<[string, unknown]> = [
    ["actual_cost_credits", result.actualCostCredits],
    ["usage_snapshot", result.usageSnapshot],
    ["outcome_kind", result.outcomeKind],
    ["outcome_recorded_at", result.outcomeRecordedAt],
  ];
  const releasesAreZero =
    result.releasedSubscriptionCredits === 0n &&
    result.releasedPaygCredits === 0n &&
    result.debtRepaidCredits === 0n &&
    result.expiredSubscriptionCredits === 0n;

  if (result.state === "held") {
    requireNull([
      ...dispatchFacts,
      ...outcomeFacts,
      ["settled_at", result.settledAt],
      ["cancelled_at", result.cancelledAt],
      ["reconcile_after", result.reconcileAfter],
    ]);
    if (!releasesAreZero) fail("released_credits");
  } else if (result.state === "dispatched") {
    requirePresent(dispatchFacts);
    requireNull([
      ...outcomeFacts,
      ["settled_at", result.settledAt],
      ["cancelled_at", result.cancelledAt],
    ]);
    if (result.reconcileAfter === null || !releasesAreZero)
      fail("reconcile_after");
  } else if (result.state === "outcome_recorded") {
    requirePresent([...dispatchFacts, ...outcomeFacts]);
    requireNull([
      ["settled_at", result.settledAt],
      ["cancelled_at", result.cancelledAt],
    ]);
    if (result.reconcileAfter === null || !releasesAreZero)
      fail("reconcile_after");
  } else if (result.state === "settled") {
    requirePresent([
      ...dispatchFacts,
      ...outcomeFacts,
      ["settled_at", result.settledAt],
    ]);
    requireNull([
      ["cancelled_at", result.cancelledAt],
      ["reconcile_after", result.reconcileAfter],
    ]);
  } else {
    requireNull([
      ...dispatchFacts,
      ...outcomeFacts,
      ["settled_at", result.settledAt],
      ["reconcile_after", result.reconcileAfter],
    ]);
    if (result.cancelledAt === null) fail("cancelled_at");
  }

  return Object.freeze(result);
}
