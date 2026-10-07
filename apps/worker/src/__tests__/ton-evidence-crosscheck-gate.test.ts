import { describe, expect, it, vi } from 'vitest';
import type { NormalizedTonEvidence } from '../ton-payment-evidence.js';
import { buildTonapiCrosscheckGate } from '../ton-evidence-crosscheck-gate.js';

const rootA = 'a'.repeat(64);
const rootB = 'b'.repeat(64);

const tonapiResponse = (seqno: number, rootHash: string, status = 200) =>
  new Response(JSON.stringify({ last: { seqno, root_hash: rootHash, file_hash: 'c'.repeat(64) } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const evidenceWithHead = (seqno: number, rootHash: string) =>
  ({ latestIndexedMasterchain: { seqno, rootHash, fileHash: 'd'.repeat(64) } }) as unknown as NormalizedTonEvidence;

describe('tonapi crosscheck gate (plan task 1.3)', () => {
  it('agrees when both indexers report the same masterchain root', async () => {
    const gate = buildTonapiCrosscheckGate({ fetchFn: vi.fn(async () => tonapiResponse(4242, rootA)) });
    await expect(gate(evidenceWithHead(4242, rootA), new AbortController().signal))
      .resolves.toEqual({ kind: 'agree' });
  });

  it('maps a >5 block gap to lag (retry, never a fork claim)', async () => {
    const gate = buildTonapiCrosscheckGate({ fetchFn: vi.fn(async () => tonapiResponse(4248, rootB)) });
    await expect(gate(evidenceWithHead(4242, rootA), new AbortController().signal))
      .resolves.toEqual({ kind: 'lag' });
  });

  it('maps a close-seqno root divergence to mismatch', async () => {
    const gate = buildTonapiCrosscheckGate({ fetchFn: vi.fn(async () => tonapiResponse(4243, rootB)) });
    await expect(gate(evidenceWithHead(4242, rootA), new AbortController().signal))
      .resolves.toEqual({ kind: 'mismatch' });
  });

  it('degrades open (unavailable) on any secondary failure', async () => {
    for (const fetchFn of [
      vi.fn(async () => tonapiResponse(1, rootA, 500)),
      vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
      vi.fn(async () => { throw new Error('ECONNRESET'); }),
    ]) {
      const gate = buildTonapiCrosscheckGate({ fetchFn });
      await expect(gate(evidenceWithHead(1, rootA), new AbortController().signal))
        .resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('targets only the TonAPI v2 masterchain endpoint', async () => {
    const fetchFn = vi.fn(async () => tonapiResponse(10, rootA));
    const gate = buildTonapiCrosscheckGate({ fetchFn });
    await gate(evidenceWithHead(10, rootA), new AbortController().signal);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://tonapi.io/v2/blockchain/masterchain',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
