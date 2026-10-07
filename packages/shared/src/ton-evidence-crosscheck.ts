/**
 * Independent masterchain head crosscheck for TON payment evidence.
 * Two indexers (primary toncenter head.last — hex root after base64 decode,
 * see worker ton-payment-provider.ts — and secondary TonAPI v2) must agree on
 * the masterchain root before reconciliation trusts a finality decision.
 * Pure comparison plus one hardened TonAPI fetcher; no persistence.
 */
import { safeFetch } from './safe-fetch';

export interface MasterchainInfoSnapshot {
  seqno: number;
  /** Lowercase hex, no 0x prefix (matches toncenter base64→hex normalization). */
  rootHashHex: string;
}

export type MasterchainCrosscheck =
  | { ok: true }
  | { ok: false; kind: 'root_mismatch' | 'seqno_lag'; primarySeqno: number; secondarySeqno: number };

const ROOT_HASH_HEX = /^(?:0x)?([0-9a-f]+)$/i;
const TONAPI_MASTERCHAIN_URL = 'https://tonapi.io/v2/blockchain/masterchain';
/** Masterchain blocks arrive roughly every ~5s; >5 apart means an indexer is behind. */
const MAX_SEQNO_LAG = 5;

function normalizeRootHash(value: string): string {
  const match = typeof value === 'string' ? ROOT_HASH_HEX.exec(value.trim()) : null;
  return match ? match[1]!.toLowerCase() : '';
}

/**
 * Seqno divergence wins over root comparison: while indexers are catching up
 * the roots are expected to differ, so a >5 block gap is reported as 'seqno_lag'
 * (retry later), never as a root fork. Close seqno with different roots is a
 * genuine fork signal ('root_mismatch').
 */
export function crosscheckMasterchainRoot(
  primary: MasterchainInfoSnapshot,
  secondary: MasterchainInfoSnapshot,
): MasterchainCrosscheck {
  if (Math.abs(primary.seqno - secondary.seqno) > MAX_SEQNO_LAG) {
    return { ok: false, kind: 'seqno_lag', primarySeqno: primary.seqno, secondarySeqno: secondary.seqno };
  }
  const primaryRoot = normalizeRootHash(primary.rootHashHex);
  const sameRoot = primaryRoot.length > 0 && primaryRoot === normalizeRootHash(secondary.rootHashHex);
  return sameRoot
    ? { ok: true }
    : { ok: false, kind: 'root_mismatch', primarySeqno: primary.seqno, secondarySeqno: secondary.seqno };
}

export interface TonapiMasterchainDeps {
  /** Test seam: production defaults to the SSRF-hardened safeFetch boundary. */
  fetchFn?: typeof safeFetch;
}

/**
 * Fetches TonAPI v2 /v2/blockchain/masterchain and maps {last:{seqno,root_hash}}
 * to a snapshot. Network errors propagate untouched — the caller decides whether
 * crosscheck degrades or aborts. HTTP and payload failures throw typed errors.
 */
export async function fetchTonapiMasterchainInfo(deps?: TonapiMasterchainDeps): Promise<MasterchainInfoSnapshot> {
  const fetchFn = deps?.fetchFn ?? safeFetch;
  const response = await fetchFn(TONAPI_MASTERCHAIN_URL, { method: 'GET' });
  if (!response.ok) throw new Error(`TONAPI_HTTP_${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('TONAPI_BAD_PAYLOAD');
  }
  const last = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)['last'] : null;
  const record = last && typeof last === 'object' && !Array.isArray(last) ? (last as Record<string, unknown>) : null;
  const seqno = record?.['seqno'];
  const rootHash = record?.['root_hash'];
  if (!Number.isSafeInteger(seqno) || (seqno as number) < 0
    || typeof rootHash !== 'string' || !/^(?:0x)?[0-9a-f]{64}$/i.test(rootHash)) {
    throw new Error('TONAPI_BAD_PAYLOAD');
  }
  return { seqno: seqno as number, rootHashHex: rootHash.toLowerCase().replace(/^0x/, '') };
}
