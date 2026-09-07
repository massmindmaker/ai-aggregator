import { describe, expect, it } from 'vitest';
import { prepareStoredChatQuote } from '../billing/candidate-quote';
import type { UpstreamCandidate } from '../routing/engine';
import type { UpstreamAdapter } from '../upstreams/interface';

const adapter: UpstreamAdapter = { chat: async () => { throw Error('unused'); }, admittedChat: { contract: 'openrouter-pinned-provider-chat-v1', execute: async () => { throw Error('must not execute'); } } };
function candidate(n = 1): UpstreamCandidate {
  return { id: 'openrouter', upstream_id: 'openrouter', upstream_model_id: 'openai/gpt-4o-mini', provider: `provider-${n}`, price_per_1k_input: n, price_per_1k_output: n, markup: 999, latency_p50_ms: n, uptime: 1, ru_residency: false, priority: n,
    billing: { modelUpstreamId: `00000000-0000-4000-8000-00000000000${n}`, prices: { inputCentsPer1k: '0.123456789012345678', outputCentsPer1k: '0.5', markup: '1.25' } } };
}
function args(candidates = [candidate()]) { return { model: { slug: 'openai/gpt-4o-mini', type: 'chat' as const, candidates }, requestedMode: 'fastest' as const, policy: {}, defaultMaxOutputTokens: 4096, getAdapter: () => adapter }; }
function prepared(input: Parameters<typeof prepareStoredChatQuote>[0] = args()) { const result = prepareStoredChatQuote(input); if (result.status !== 'ready') throw Error(result.status); return result; }
describe('frozen eligible stored chat quote', () => {
  it.each([[undefined,4096],[10000,10000],[20000,16384]])('client cap %s becomes %s', (cap, expected) => {
    const result = prepared({ ...args(), ...(cap === undefined ? {} : { clientMaxTokens: cap }) });
    expect(result.candidates[0]!.maxOutputTokens).toBe(expected);
  });
  it('uses exact supplied DB rates and ceiling, never legacy numeric rates', () => {
    const result = prepared();
    // ((128000 - 4096) * 0.123456789012345678 + 4096 * 0.5) * 1.25, rounded up.
    expect(result.authorizedMaxCredits).toBe(21681n);
    expect(result.quoteSnapshot.authorizedMaxCredits).toBe('21681');
    expect(result.candidates[0]!.billing.prices.inputCentsPer1k).toBe('0.123456789012345678');
  });
  it('filters policy once; blocked/unreviewed candidates never reappear', () => {
    const a = candidate(1), b = candidate(2), c = candidate(3);
    c.upstream_model_id = 'alias';
    const result = prepared({ ...args([a,b,c]), policy: { blocked_providers: ['provider-1'] } });
    expect(result.candidates.map(c => c.billing.modelUpstreamId)).toEqual([b.billing!.modelUpstreamId]);
  });
  it('freezes detached candidate order, routing facts and financial snapshot', () => {
    const a = candidate(1), b = candidate(2), source = args([b,a]);
    const result = prepared(source);
    const snapshot = JSON.stringify(result.quoteSnapshot);
    a.provider = 'changed'; a.egress_proxy = 'changed'; a.billing = candidate(3).billing;
    source.model.candidates.reverse();
    expect(result.candidates.map(c => c.provider)).toEqual(['provider-1','provider-2']);
    expect(JSON.stringify(result.quoteSnapshot)).toBe(snapshot);
    for (const value of [result, result.candidates, result.candidates[0], result.candidates[0]!.billing, result.candidates[0]!.billing.prices, result.quoteSnapshot, result.quoteSnapshot.candidates]) expect(Object.isFrozen(value)).toBe(true);
  });
  it('authorizes the largest eligible frozen candidate maximum', () => {
    const expensive = candidate(2); expensive.billing = { ...expensive.billing!, prices: { inputCentsPer1k: '1', outputCentsPer1k: '2', markup: '2' } };
    const result = prepared(args([candidate(),expensive]));
    expect(result.authorizedMaxCredits).toBe(264192n);
  });
  it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('rejects invalid client cap %s as bad request', clientMaxTokens => {
    expect(prepareStoredChatQuote({ ...args(), clientMaxTokens }).status).toBe('bad_request');
  });
  it.each([0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('invalid default %s is unavailable', defaultMaxOutputTokens => {
    expect(prepareStoredChatQuote({ ...args(), defaultMaxOutputTokens }).status).toBe('unavailable');
  });
  it('uses configured default only for an omitted client cap', () => {
    expect(prepared({ ...args(), defaultMaxOutputTokens: 8192 }).candidates[0]!.maxOutputTokens).toBe(8192);
  });
  it('fails closed for no eligible pool, unavailable mechanics, or policy', () => {
    const c = candidate(); delete c.billing;
    const cases = [args([]), args([c]), { ...args(), getAdapter: () => { throw Error('no adapter'); } }, { ...args(), getAdapter: () => ({ ...adapter, admittedChat: undefined } as unknown as UpstreamAdapter) }, { ...args(), getAdapter: () => ({ ...adapter, admittedChat: { ...adapter.admittedChat!, contract: 'wrong' } } as unknown as UpstreamAdapter) }, { ...args(), policy: { forbid_non_ru: true } }, { ...args(), policy: { allowed_providers: ['other'] } }];
    for (const input of cases) expect(prepareStoredChatQuote(input).status).toBe('unavailable');
  });
  it.each(['-1','1e2','NaN','0'.repeat(40),'99999999999999999999999999999999999999'])('invalid/overflow money %s is unavailable', inputCentsPer1k => {
    const c = candidate(); c.billing = { ...c.billing!, prices: { ...c.billing!.prices, inputCentsPer1k } };
    expect(prepareStoredChatQuote(args([c])).status).toBe('unavailable');
  });
  it('zero maximum is unsupported', () => {
    const c = candidate(); c.billing = { ...c.billing!, prices: { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' } };
    expect(prepareStoredChatQuote(args([c])).status).toBe('unavailable');
  });
});
