/**
 * Secondary-source masterchain crosscheck gate for the TON reconciler
 * (plan AG-TON-L task 1.3). Active only when the worker env explicitly asks
 * for it (`TON_EVIDENCE_CROSSCHECK=1`); the mainnet preset is expected to
 * enable it by default once Phase 3 wires presets into the bootstrap.
 *
 * Degrade policy: any secondary failure maps to 'unavailable' and the caller
 * keeps the primary decision (defense in depth, not a hard dependency). A
 * >5-block lag is 'lag' (retry via finality_pending); a close-seqno root
 * divergence is 'mismatch' (never trust either head).
 */
import type { safeFetch } from '@aiag/shared/server';
import {
  crosscheckMasterchainRoot,
  fetchTonapiMasterchainInfo,
} from '@aiag/shared/server';
import type { NormalizedTonEvidence } from './ton-payment-evidence.js';

export type TonCrosscheckOutcome =
  | { kind: 'agree' }
  | { kind: 'lag' }
  | { kind: 'mismatch' }
  | { kind: 'unavailable' };

export type TonCrosscheckFn = (
  evidence: NormalizedTonEvidence,
  signal: AbortSignal,
) => Promise<TonCrosscheckOutcome>;

export interface TonCrosscheckGateDeps {
  /** Test seam: production defaults to the SSRF-hardened safeFetch boundary. */
  fetchFn?: typeof safeFetch;
}

export function buildTonapiCrosscheckGate(deps: TonCrosscheckGateDeps = {}): TonCrosscheckFn {
  return async (evidence) => {
    try {
      const secondary = await fetchTonapiMasterchainInfo(deps);
      const verdict = crosscheckMasterchainRoot(
        {
          seqno: evidence.latestIndexedMasterchain.seqno,
          rootHashHex: evidence.latestIndexedMasterchain.rootHash,
        },
        secondary,
      );
      if (verdict.ok) return { kind: 'agree' };
      return verdict.kind === 'seqno_lag' ? { kind: 'lag' } : { kind: 'mismatch' };
    } catch {
      return { kind: 'unavailable' };
    }
  };
}
