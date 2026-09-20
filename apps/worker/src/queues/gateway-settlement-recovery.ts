export type CanonicalRecoveryUuid = string;
export type CanonicalRecoveryTimestamp = string;

export type GatewaySettlementRecoveryMode =
  | "disabled"
  | "stored_chat_v1"
  | "stored_chat_embeddings_v1";
export type GatewaySettlementRecoveryRoute = "chat" | "embeddings";
export type GatewaySettlementRecoveryTickClassification =
  | "complete"
  | "partial_unconfirmed"
  | "selection_unavailable"
  | "stopped";

export type GatewaySettlementRecoveryPosition = Readonly<{
  reconcileAt: CanonicalRecoveryTimestamp;
  billingRequestId: CanonicalRecoveryUuid;
}>;

export type GatewaySettlementRecoveryCycle = Readonly<{
  cycleDueBefore: CanonicalRecoveryTimestamp;
  after: GatewaySettlementRecoveryPosition | null;
  upper: GatewaySettlementRecoveryPosition;
}>;

export type GatewaySettlementRecoveryHint = GatewaySettlementRecoveryPosition & Readonly<{
  orgId: CanonicalRecoveryUuid;
  apiKeyId: CanonicalRecoveryUuid;
}>;

export type GatewaySettlementRecoverySelectorPage = Readonly<{
  hints: readonly GatewaySettlementRecoveryHint[];
}>;

export type GatewaySettlementRecoveryAck = Readonly<{
  orgId: CanonicalRecoveryUuid;
  apiKeyId: CanonicalRecoveryUuid;
  billingRequestId: CanonicalRecoveryUuid;
  state: "settled";
  routeKind: GatewaySettlementRecoveryRoute;
  billingMode: "stored";
  outcomeKind: "success";
}>;

export type GatewaySettlementRecoveryTickResult = Readonly<{
  classification: GatewaySettlementRecoveryTickClassification;
  selected: number;
  attempted: number;
  settled: number;
  unconfirmed: number;
  deferred: number;
  cursor: GatewaySettlementRecoveryCycle | null;
}>;

export interface GatewaySettlementRecoveryDb {
  captureCycle(): Promise<Readonly<{
    cycleDueBefore: CanonicalRecoveryTimestamp;
    upper: GatewaySettlementRecoveryPosition;
  }> | null>;
  selectPage(input: Readonly<{
    cycleDueBefore: CanonicalRecoveryTimestamp;
    after: GatewaySettlementRecoveryPosition | null;
    upper: GatewaySettlementRecoveryPosition;
    limit: 20;
  }>): Promise<GatewaySettlementRecoverySelectorPage>;
  recover(hint: GatewaySettlementRecoveryHint): Promise<GatewaySettlementRecoveryAck>;
  close(): Promise<void>;
}

export interface GatewaySettlementRecoveryLoop {
  runTick(isStopping: () => boolean): Promise<GatewaySettlementRecoveryTickResult>;
  getCursor(): GatewaySettlementRecoveryCycle | null;
}

export interface GatewaySettlementRecoveryScheduler {
  setTimeout(callback: () => void, delayMs: 60_000): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GatewaySettlementRecoveryHandle {
  close(): Promise<void>;
}

const INVALID_DATABASE_URL = "invalid gateway settlement recovery database URL";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;
const FORBIDDEN_DATABASE_URL_KEYS = new Set([
  "statement_timeout",
  "query_timeout",
  "connect_timeout",
  "options",
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys.slice().sort()[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalUuid(value: unknown): CanonicalRecoveryUuid | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function canonicalTimestamp(value: unknown): CanonicalRecoveryTimestamp | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  const leapYear = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (numericYear < 1 || numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > daysInMonth[numericMonth - 1]
    || numericHour > 23 || numericMinute > 59 || numericSecond > 59) return null;
  return value;
}

function compareCanonicalUuid(left: CanonicalRecoveryUuid, right: CanonicalRecoveryUuid): number {
  const leftBytes = left.replaceAll("-", "");
  const rightBytes = right.replaceAll("-", "");
  for (let index = 0; index < leftBytes.length; index += 2) {
    const difference = Number.parseInt(leftBytes.slice(index, index + 2), 16) - Number.parseInt(rightBytes.slice(index, index + 2), 16);
    if (difference !== 0) return difference;
  }
  return 0;
}

function comparePosition(left: GatewaySettlementRecoveryPosition, right: GatewaySettlementRecoveryPosition): number {
  if (left.reconcileAt < right.reconcileAt) return -1;
  if (left.reconcileAt > right.reconcileAt) return 1;
  return compareCanonicalUuid(left.billingRequestId, right.billingRequestId);
}

function copyPosition(position: GatewaySettlementRecoveryPosition): GatewaySettlementRecoveryPosition {
  return { reconcileAt: position.reconcileAt, billingRequestId: position.billingRequestId };
}

function copyCycle(cycle: GatewaySettlementRecoveryCycle | null): GatewaySettlementRecoveryCycle | null {
  return cycle === null ? null : {
    cycleDueBefore: cycle.cycleDueBefore,
    after: cycle.after === null ? null : copyPosition(cycle.after),
    upper: copyPosition(cycle.upper),
  };
}

function parsePosition(value: unknown): GatewaySettlementRecoveryPosition | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["reconcileAt", "billingRequestId"])) return null;
  const reconcileAt = canonicalTimestamp(value.reconcileAt);
  const billingRequestId = canonicalUuid(value.billingRequestId);
  return reconcileAt === null || billingRequestId === null ? null : { reconcileAt, billingRequestId };
}

function parseHint(value: unknown): GatewaySettlementRecoveryHint | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["orgId", "apiKeyId", "billingRequestId", "reconcileAt"])) return null;
  const orgId = canonicalUuid(value.orgId);
  const apiKeyId = canonicalUuid(value.apiKeyId);
  const billingRequestId = canonicalUuid(value.billingRequestId);
  const reconcileAt = canonicalTimestamp(value.reconcileAt);
  return orgId === null || apiKeyId === null || billingRequestId === null || reconcileAt === null
    ? null
    : { orgId, apiKeyId, billingRequestId, reconcileAt };
}

function validAck(value: unknown, hint: GatewaySettlementRecoveryHint): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ["orgId", "apiKeyId", "billingRequestId", "state", "routeKind", "billingMode", "outcomeKind"])
    && canonicalUuid(value.orgId) === hint.orgId && canonicalUuid(value.apiKeyId) === hint.apiKeyId && canonicalUuid(value.billingRequestId) === hint.billingRequestId
    && value.state === "settled" && (value.routeKind === "chat" || value.routeKind === "embeddings")
    && value.billingMode === "stored" && value.outcomeKind === "success";
}

function result(
  classification: GatewaySettlementRecoveryTickClassification,
  selected: number,
  attempted: number,
  settled: number,
  unconfirmed: number,
  deferred: number,
  cursor: GatewaySettlementRecoveryCycle | null,
): GatewaySettlementRecoveryTickResult {
  return { classification, selected, attempted, settled, unconfirmed, deferred, cursor: copyCycle(cursor) };
}

export function parseGatewaySettlementRecoveryMode(raw: string | undefined): GatewaySettlementRecoveryMode {
  if (raw === undefined || raw === "disabled") return "disabled";
  if (raw === "stored_chat_v1") return "stored_chat_v1";
  if (raw === "stored_chat_embeddings_v1") return "stored_chat_embeddings_v1";
  throw new Error("invalid gateway settlement recovery mode");
}

export function parseGatewaySettlementRecoveryDatabaseUrl(raw: string): string {
  try {
    if (raw.length === 0 || raw.trim() !== raw) throw new Error();
    const parsed = new URL(raw);
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || parsed.hostname.length === 0 || parsed.pathname.length === 0 || parsed.pathname === "/" || parsed.hash.length !== 0) throw new Error();
    for (const key of parsed.searchParams.keys()) {
      if (FORBIDDEN_DATABASE_URL_KEYS.has(key.toLowerCase())) throw new Error();
    }
    return raw;
  } catch {
    throw new Error(INVALID_DATABASE_URL);
  }
}

export function createGatewaySettlementRecoveryLoop(db: GatewaySettlementRecoveryDb): GatewaySettlementRecoveryLoop {
  let cursor: GatewaySettlementRecoveryCycle | null = null;

  async function runTick(isStopping: () => boolean): Promise<GatewaySettlementRecoveryTickResult> {
    if (isStopping()) return result("stopped", 0, 0, 0, 0, 0, cursor);

    if (cursor === null) {
      let captured: Awaited<ReturnType<GatewaySettlementRecoveryDb["captureCycle"]>>;
      try {
        captured = await db.captureCycle();
      } catch {
        return result("selection_unavailable", 0, 0, 0, 0, 0, cursor);
      }
      if (captured === null) return result("complete", 0, 0, 0, 0, 0, null);
      if (!isPlainRecord(captured) || !hasExactKeys(captured, ["cycleDueBefore", "upper"])) return result("selection_unavailable", 0, 0, 0, 0, 0, null);
      const cycleDueBefore = canonicalTimestamp(captured.cycleDueBefore);
      const upper = parsePosition(captured.upper);
      if (cycleDueBefore === null || upper === null || upper.reconcileAt > cycleDueBefore) return result("selection_unavailable", 0, 0, 0, 0, 0, null);
      cursor = { cycleDueBefore, after: null, upper };
    }

    if (isStopping()) return result("stopped", 0, 0, 0, 0, 0, cursor);
    const cycle = cursor;
    let page: GatewaySettlementRecoverySelectorPage;
    try {
      page = await db.selectPage({ cycleDueBefore: cycle.cycleDueBefore, after: copyCycle(cycle)?.after ?? null, upper: copyPosition(cycle.upper), limit: 20 });
    } catch {
      return result("selection_unavailable", 0, 0, 0, 0, 0, cursor);
    }

    if (!isPlainRecord(page) || !hasExactKeys(page, ["hints"]) || !Array.isArray(page.hints) || page.hints.length > 20) {
      return result("selection_unavailable", 0, 0, 0, 0, 0, cursor);
    }
    const hints: GatewaySettlementRecoveryHint[] = [];
    const triples = new Set<string>();
    let previous = cycle.after;
    for (const rawHint of page.hints) {
      const item = parseHint(rawHint);
      if (item === null || item.reconcileAt > cycle.cycleDueBefore || comparePosition(item, cycle.upper) > 0 || (previous !== null && comparePosition(item, previous) <= 0)) {
        return result("selection_unavailable", 0, 0, 0, 0, 0, cursor);
      }
      const triple = `${item.orgId}/${item.apiKeyId}/${item.billingRequestId}`;
      if (triples.has(triple)) return result("selection_unavailable", 0, 0, 0, 0, 0, cursor);
      triples.add(triple);
      hints.push(item);
      previous = item;
    }

    if (hints.length === 0) {
      cursor = null;
      return result("complete", 0, 0, 0, 0, 0, null);
    }

    let attempted = 0;
    let settled = 0;
    let unconfirmed = 0;
    let deferred = 0;
    for (let index = 0; index < hints.length; index += 1) {
      if (isStopping()) {
        deferred = hints.length - index;
        break;
      }
      const item = hints[index];
      attempted += 1;
      try {
        const acknowledgement = await db.recover(item);
        if (validAck(acknowledgement, item)) settled += 1;
        else unconfirmed += 1;
      } catch {
        unconfirmed += 1;
      }
      cursor = { ...cycle, after: copyPosition(item), upper: copyPosition(cycle.upper) };
    }

    if (deferred === 0 && (hints.length < 20 || (cursor?.after !== null && comparePosition(cursor.after, cycle.upper) === 0))) cursor = null;
    const classification: GatewaySettlementRecoveryTickClassification = deferred > 0
      ? "stopped"
      : unconfirmed > 0 ? "partial_unconfirmed" : "complete";
    return result(classification, hints.length, attempted, settled, unconfirmed, deferred, cursor);
  }

  return { runTick, getCursor: () => copyCycle(cursor) };
}

export function startGatewaySettlementRecovery(input: Readonly<{
  db: GatewaySettlementRecoveryDb;
  scheduler: GatewaySettlementRecoveryScheduler;
  onTick: (result: GatewaySettlementRecoveryTickResult) => void;
}>): GatewaySettlementRecoveryHandle {
  const loop = createGatewaySettlementRecoveryLoop(input.db);
  let stopping = false;
  let timer: unknown;
  let hasTimer = false;
  let activeTick: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;

  const beginTick = (): void => {
    if (stopping || activeTick !== null) return;
    activeTick = (async () => {
      try {
        const tick = await loop.runTick(() => stopping);
        try { input.onTick(tick); } catch { /* callback failures have no recovery boundary */ }
        if (!stopping) {
          timer = input.scheduler.setTimeout(() => {
            hasTimer = false;
            timer = undefined;
            beginTick();
          }, 60_000);
          hasTimer = true;
        }
      } finally {
        activeTick = null;
      }
    })();
  };

  beginTick();
  return {
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      stopping = true;
      if (hasTimer) {
        input.scheduler.clearTimeout(timer);
        hasTimer = false;
        timer = undefined;
      }
      closePromise = (async () => {
        if (activeTick !== null) await activeTick;
        await input.db.close();
      })();
      return closePromise;
    },
  };
}
