/**
 * Per-upstream circuit breaker (native egress integration T3).
 *
 * Own implementation INSPIRED BY OmniRoute src/shared/utils/circuitBreaker.ts
 * (MIT, Copyright (c) diegosouzapw) — simplified to the state machine the
 * plan fixes: closed → open → half_open → closed/open with exponential
 * reopen backoff. Not a port: OmniRoute tracks per-name class instances with
 * DEGRADED states and a domainState KV layer; this one keys on upstream_id,
 * lives in a single in-memory Map and persists through Postgres so an OPEN
 * circuit survives a gateway restart.
 *
 * State machine (per upstream_id):
 *   closed     — normal traffic.
 *   open       — short-circuited until opened_until elapses:
 *                  · transient errors  — after TRANSIENT_THRESHOLD failures,
 *                    base cooldown 30s;
 *                  · any rate_limit / quota_exhausted (classify.ts kind) —
 *                    immediately, kind-specific cooldown
 *                    (rate_limit 30s, quota_exhausted 1h);
 *                every RE-open multiplies that kind's cooldown ×2 (cap ×16).
 *   half_open  — entered once opened_until has elapsed; exactly ONE probe
 *                request is allowed. Success → closed (counters reset).
 *                Failure → open again with doubled cooldown.
 *
 * Persistence is lazy and best-effort: rows appear only after the first
 * incident, load happens on the first touch of an upstream after process
 * start, and DB errors never break request handling (breaker falls back to
 * its in-memory view).
 */
import { sql } from '../lib/db';
import { logger } from '../lib/logger';
import { classify429FromError, type FailureKind } from './classify';

export type BreakerVerdict = 'allow' | 'skip' | 'half-open-probe';

/** Consecutive transient failures before the circuit opens. */
export const TRANSIENT_THRESHOLD = 5;

/** Base cooldown per failure kind (ms), applied when the circuit opens. */
export const BASE_COOLDOWN_MS: Record<FailureKind, number> = {
  transient: 30_000,
  rate_limit: 30_000,
  quota_exhausted: 3_600_000,
};

/** Max cumulative multiplier over the base cooldown across repeated opens. */
export const BACKOFF_CAP = 16;

type BreakerState = 'closed' | 'open' | 'half_open';

type Entry = {
  state: BreakerState;
  failures: number;
  lastFailureAtMs: number | null;
  openedUntilMs: number | null;
  /** Completed open→(probe fail)→open cycles since the last clean close. */
  openCycles: number;
  /** Whether the single half_open probe was already handed out. */
  probeTaken: boolean;
};

function freshEntry(): Entry {
  return {
    state: 'closed',
    failures: 0,
    lastFailureAtMs: null,
    openedUntilMs: null,
    openCycles: 0,
    probeTaken: false,
  };
}

const mem = new Map<string, Entry>();
const loadAttempted = new Set<string>();

function asDate(value: unknown): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Return the in-memory entry for `upstreamId`, hydrating it from Postgres on
 * first touch (so an OPEN circuit set by a previous process keeps skipping
 * traffic). Never throws — a broken DB degrades to memory-only operation.
 */
function persistEnabled(): boolean {
  return process.env.AIAG_BREAKER_PERSIST !== 'off';
}

async function ensureLoaded(upstreamId: string): Promise<Entry> {
  if (loadAttempted.has(upstreamId)) {
    return mem.get(upstreamId) ?? mem.set(upstreamId, freshEntry()).get(upstreamId)!;
  }
  if (!persistEnabled()) {
    mem.set(upstreamId, mem.get(upstreamId) ?? freshEntry());
    return mem.get(upstreamId)!;
  }
  loadAttempted.add(upstreamId);
  const entry = freshEntry();
  // Reserve the slot synchronously so concurrent callers share one entry.
  mem.set(upstreamId, entry);
  try {
    const rows = (await sql`
      SELECT state, failures, last_failure_at, opened_until
        FROM circuit_breakers
       WHERE upstream_id = ${upstreamId}
       LIMIT 1
    `) as Array<{
      state: string;
      failures: number | string;
      last_failure_at: Date | string | null;
      opened_until: Date | string | null;
    }>;
    const row = rows[0];
    if (
      row &&
      mem.get(upstreamId) === entry &&
      entry.state === 'closed' &&
      entry.failures === 0 &&
      (row.state === 'open' || row.state === 'half_open')
    ) {
      entry.state = row.state;
      entry.failures = Number(row.failures ?? 0);
      entry.lastFailureAtMs = asDate(row.last_failure_at);
      entry.openedUntilMs = asDate(row.opened_until);
    }
  } catch (err) {
    logger.warn({ err: String(err), upstreamId }, 'breaker_load_failed');
  }
  return entry;
}

/** Upsert the current entry. Best-effort — persistence must not break traffic. */
async function persist(upstreamId: string, e: Entry): Promise<void> {
  if (!persistEnabled()) return;
  try {
    await sql`
      INSERT INTO circuit_breakers
        (upstream_id, state, failures, last_failure_at, opened_until)
      VALUES (
        ${upstreamId},
        ${e.state},
        ${e.failures},
        ${e.lastFailureAtMs == null ? null : new Date(e.lastFailureAtMs).toISOString()},
        ${e.openedUntilMs == null ? null : new Date(e.openedUntilMs).toISOString()}
      )
      ON CONFLICT (upstream_id) DO UPDATE SET
        state           = EXCLUDED.state,
        failures        = EXCLUDED.failures,
        last_failure_at = EXCLUDED.last_failure_at,
        opened_until    = EXCLUDED.opened_until
    `;
  } catch (err) {
    logger.warn({ err: String(err), upstreamId }, 'breaker_persist_failed');
  }
}

/**
 * Gate ONE attempt against `upstreamId`.
 *   'allow'            — closed, go ahead.
 *   'skip'             — open (cooldown not elapsed) or probe already taken:
 *                        try another candidate.
 *   'half-open-probe'  — cooldown elapsed; THIS caller owns the one probe.
 */
export async function check(upstreamId: string): Promise<BreakerVerdict> {
  const e = await ensureLoaded(upstreamId);

  if (e.state === 'open') {
    if (e.openedUntilMs !== null && Date.now() >= e.openedUntilMs) {
      e.state = 'half_open';
      e.probeTaken = false;
      await persist(upstreamId, e);
    } else {
      return 'skip';
    }
  }

  if (e.state === 'half_open') {
    if (e.probeTaken) return 'skip';
    e.probeTaken = true;
    return 'half-open-probe';
  }

  return 'allow';
}

/** A probe/served attempt succeeded: close the circuit and reset counters. */
export async function recordSuccess(upstreamId: string): Promise<void> {
  const e = await ensureLoaded(upstreamId);
  const hadIncident =
    e.state !== 'closed' || e.failures > 0 || e.openedUntilMs !== null || e.probeTaken;
  e.state = 'closed';
  e.failures = 0;
  e.lastFailureAtMs = null;
  e.openedUntilMs = null;
  e.openCycles = 0;
  e.probeTaken = false;
  // Healthy upstreams generate zero writes: only touch the DB when there was
  // something to clear.
  if (hadIncident) await persist(upstreamId, e);
}

/**
 * A classified failure happened on `upstreamId`. The error is classified via
 * classify429FromError (unclassifiable ⇒ transient): rate_limit /
 * quota_exhausted open immediately with their kind cooldown; transient
 * failures accumulate toward TRANSIENT_THRESHOLD. Re-opens double the
 * effective cooldown (cap ×BACKOFF_CAP). Returns the resulting state for
 * observability/tests.
 */
export async function recordFailure(
  upstreamId: string,
  error: unknown
): Promise<{ state: BreakerState; openedUntilMs: number | null }> {
  const e = await ensureLoaded(upstreamId);
  const kind: FailureKind = classify429FromError(error) ?? 'transient';

  e.failures += 1;
  e.lastFailureAtMs = Date.now();
  e.probeTaken = false;

  const immediateOpen = kind !== 'transient';
  const thresholdOpen = kind === 'transient' && e.failures >= TRANSIENT_THRESHOLD;
  if (immediateOpen || thresholdOpen) {
    // First open of a cycle uses the base cooldown; each re-open doubles it.
    const multiplier = Math.min(2 ** e.openCycles, BACKOFF_CAP);
    e.openCycles += 1;
    e.state = 'open';
    e.openedUntilMs = Date.now() + BASE_COOLDOWN_MS[kind] * multiplier;
  }
  await persist(upstreamId, e);
  return { state: e.state, openedUntilMs: e.openedUntilMs };
}

/* ── Test seams (not part of the public contract) ───────────────────────── */

/** Wipe all in-memory state between tests. */
export function __resetBreakerForTests(): void {
  mem.clear();
  loadAttempted.clear();
}

/** Read-only snapshot of one entry (undefined when untouched). */
export function __entryForTests(
  upstreamId: string
): { state: BreakerState; failures: number; openedUntilMs: number | null } | undefined {
  const e = mem.get(upstreamId);
  if (!e) return undefined;
  return { state: e.state, failures: e.failures, openedUntilMs: e.openedUntilMs };
}

/**
 * Forge `opened_until` (the plan's "подделанный opened_until" test seam):
 * pass a past timestamp to force half_open on the next check().
 */
export function __setOpenedUntilForTests(upstreamId: string, ms: number | null): void {
  const e = mem.get(upstreamId);
  if (e) e.openedUntilMs = ms;
}
