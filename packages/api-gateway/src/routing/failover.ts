/**
 * Ordered-candidate execution with circuit breaking (native egress
 * integration T3).
 *
 * `executeWithFailover` runs an upstream attempt over an ORDERED candidate
 * list (preferred first — see orderCandidates): before every try the breaker
 * gates the candidate (open → skip), a success settles the winner and is
 * returned with its actual UpstreamCandidate so billing/log always reflect
 * who really served the request; a classified failure is recorded in the
 * breaker and the next candidate is tried; after MAX_FAILOVER_ATTEMPTS (or
 * exhausted candidates) a brand-neutral 502 AiagError is thrown.
 *
 * BYOK requests must behave exactly as before this module existed: routes
 * pass `{ useBreaker: false, wrapErrors: false }` with a single-candidate
 * list, which degenerates to a plain passthrough (raw adapter errors keep
 * propagating untouched).
 */
import { errors } from '../lib/errors';
import { NEUTRAL_MESSAGES } from '../lib/client-errors';
import { logger } from '../lib/logger';
import {
  check,
  recordFailure,
  recordSuccess,
  type BreakerVerdict,
} from '../failover/breaker';
import type { UpstreamCandidate } from './engine';

/** Hard cap on real upstream attempts per request (breaker skips are free). */
export const MAX_FAILOVER_ATTEMPTS = 3;

export type FailoverOpts = {
  /** Gate each attempt through the circuit breaker (default true). */
  useBreaker?: boolean;
  /** Wrap total failure into the neutral 502 AiagError (default true). */
  wrapErrors?: boolean;
};

export type FailoverResult<T> = {
  resp: T;
  /** The candidate that actually served the request — settle/log THIS one. */
  usedUpstream: UpstreamCandidate;
};

/**
 * Preferred-first ordering for the failover loop: the mode/policy winner
 * stays first; remaining resolver candidates follow in resolver (priority)
 * order, deduped by upstream_id.
 */
export function orderCandidates(
  all: UpstreamCandidate[],
  preferred: UpstreamCandidate
): UpstreamCandidate[] {
  return [preferred, ...all.filter((c) => c.upstream_id !== preferred.upstream_id)];
}

/**
 * Neutral 502 thrown when no candidate could serve the request. Never names
 * the upstream (SECURITY.md white-label rule).
 */
function allUpstreamsFailed(): Error {
  return errors.upstreamError(NEUTRAL_MESSAGES.providerError);
}

export async function executeWithFailover<T>(
  candidates: UpstreamCandidate[],
  attempt: (u: UpstreamCandidate) => Promise<T>,
  opts: FailoverOpts = {}
): Promise<FailoverResult<T>> {
  const { useBreaker = true, wrapErrors = true } = opts;

  if (candidates.length === 0) throw allUpstreamsFailed();

  // Legacy passthrough (BYOK): single candidate, no breaker, raw errors.
  if (!useBreaker && !wrapErrors) {
    const u = candidates[0]!;
    return { resp: await attempt(u), usedUpstream: u };
  }

  let attempts = 0;
  for (const u of candidates) {
    if (attempts >= MAX_FAILOVER_ATTEMPTS) break;

    let verdict: BreakerVerdict = 'allow';
    if (useBreaker) verdict = await check(u.upstream_id);
    if (verdict === 'skip') continue; // breaker skip costs no attempt budget

    attempts += 1;
    try {
      const resp = await attempt(u);
      if (useBreaker) await recordSuccess(u.upstream_id);
      return { resp, usedUpstream: u };
    } catch (err) {
      logger.warn(
        { err: String(err), upstreamId: u.upstream_id },
        'failover_attempt_failed'
      );
      if (useBreaker) await recordFailure(u.upstream_id, err);
    }
  }

  throw allUpstreamsFailed();
}
