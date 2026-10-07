import { describe, expect, it, vi } from 'vitest';
import { crosscheckMasterchainRoot, fetchTonapiMasterchainInfo, type MasterchainInfoSnapshot } from '../ton-evidence-crosscheck';

const rootA = 'a'.repeat(64);
const rootB = 'b'.repeat(64);
const snap = (seqno: number, rootHashHex: string): MasterchainInfoSnapshot => ({ seqno, rootHashHex });

describe('masterchain root crosscheck', () => {
  it('accepts identical snapshots', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(100, rootA))).toEqual({ ok: true });
  });

  it('compares roots case-insensitively and ignores a 0x prefix', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(102, `0x${rootA.toUpperCase()}`))).toEqual({ ok: true });
  });

  it('accepts indexers up to 5 masterchain blocks apart on the same root', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(105, rootA))).toEqual({ ok: true });
    expect(crosscheckMasterchainRoot(snap(105, rootA), snap(100, rootA))).toEqual({ ok: true });
  });

  it('reports seqno_lag with both seqnos once the gap exceeds 5 blocks', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(106, rootB))).toEqual({
      ok: false, kind: 'seqno_lag', primarySeqno: 100, secondarySeqno: 106,
    });
    expect(crosscheckMasterchainRoot(snap(200, rootA), snap(100, rootB))).toEqual({
      ok: false, kind: 'seqno_lag', primarySeqno: 200, secondarySeqno: 100,
    });
  });

  it('reports root_mismatch when seqno is close but roots differ', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(100, rootB))).toEqual({
      ok: false, kind: 'root_mismatch', primarySeqno: 100, secondarySeqno: 100,
    });
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(103, rootB))).toEqual({
      ok: false, kind: 'root_mismatch', primarySeqno: 100, secondarySeqno: 103,
    });
  });

  it('treats a non-hex root as a mismatch instead of crashing', () => {
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(100, 'zz-not-a-root'))).toEqual({
      ok: false, kind: 'root_mismatch', primarySeqno: 100, secondarySeqno: 100,
    });
    expect(crosscheckMasterchainRoot(snap(100, ''), snap(100, ''))).toEqual({
      ok: false, kind: 'root_mismatch', primarySeqno: 100, secondarySeqno: 100,
    });
  });

  it('prioritizes seqno_lag even when the roots coincide (clock/index drift)', () => {
    // Same root implies the same block, so a >5 seqno gap means one side is
    // reporting stale metadata: retry later rather than trust either head.
    expect(crosscheckMasterchainRoot(snap(100, rootA), snap(120, rootA))).toEqual({
      ok: false, kind: 'seqno_lag', primarySeqno: 100, secondarySeqno: 120,
    });
  });
});

describe('tonapi masterchain fetch', () => {
  const respond = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });
  const okBody = (seqno: number, rootHash: string) =>
    respond(JSON.stringify({ last: { seqno, root_hash: rootHash, file_hash: 'c'.repeat(64) } }));

  it('maps {last:{seqno,root_hash}} to a normalized snapshot', async () => {
    const fetchFn = vi.fn(async () => okBody(424_242, rootA));
    await expect(fetchTonapiMasterchainInfo({ fetchFn })).resolves.toEqual({ seqno: 424_242, rootHashHex: rootA });
    expect(fetchFn).toHaveBeenCalledWith('https://tonapi.io/v2/blockchain/masterchain', expect.objectContaining({ method: 'GET' }));
  });

  it('normalizes uppercase and 0x-prefixed TonAPI roots', async () => {
    await expect(fetchTonapiMasterchainInfo({ fetchFn: vi.fn(async () => okBody(1, rootA.toUpperCase())) }))
      .resolves.toEqual({ seqno: 1, rootHashHex: rootA });
    await expect(fetchTonapiMasterchainInfo({ fetchFn: vi.fn(async () => okBody(1, `0x${rootA}`)) }))
      .resolves.toEqual({ seqno: 1, rootHashHex: rootA });
  });

  it('throws a typed error on upstream HTTP failure', async () => {
    await expect(fetchTonapiMasterchainInfo({ fetchFn: vi.fn(async () => respond('boom', 500)) }))
      .rejects.toThrow('TONAPI_HTTP_500');
  });

  it('throws a typed error on a non-JSON body', async () => {
    await expect(fetchTonapiMasterchainInfo({ fetchFn: vi.fn(async () => respond('<html>gateway</html>')) }))
      .rejects.toThrow('TONAPI_BAD_PAYLOAD');
  });

  it.each([
    '{"last":null}',
    '{"unexpected":{}}',
    '{"last":{"seqno":"123","root_hash":"' + rootA + '"}}',
    '{"last":{"seqno":1.5,"root_hash":"' + rootA + '"}}',
    '{"last":{"seqno":-1,"root_hash":"' + rootA + '"}}',
    '{"last":{"seqno":1,"root_hash":"xyz"}}',
    '{"last":{"seqno":1,"root_hash":"' + rootA.slice(0, 63) + '"}}',
    '{"last":{"seqno":1}}',
  ])('rejects malformed payload %j', async (body) => {
    await expect(fetchTonapiMasterchainInfo({ fetchFn: vi.fn(async () => respond(body)) }))
      .rejects.toThrow('TONAPI_BAD_PAYLOAD');
  });

  it('propagates network errors untouched for the caller to decide', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetchTonapiMasterchainInfo({ fetchFn })).rejects.toThrow('ECONNRESET');
  });
});
