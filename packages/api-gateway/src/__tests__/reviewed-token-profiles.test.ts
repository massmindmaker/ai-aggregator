import { describe, expect, it } from 'vitest';
import { findReviewedChatProfile, reviewedChatProfiles } from '../billing/reviewed-token-profiles';

const identity = { modelSlug: 'openai/gpt-4o-mini', modelType: 'chat', upstreamId: 'openrouter', upstreamModelId: 'openai/gpt-4o-mini', adapterKey: 'openrouter' };
describe('reviewed profiles', () => {
  it('binds only the exact five-part tuple', () => {
    expect(findReviewedChatProfile(identity)?.profileId).toBe('openrouter-openai-gpt-4o-mini-chat-v1');
    for (const key of Object.keys(identity)) expect(findReviewedChatProfile({ ...identity, [key]: 'alias' })).toBeNull();
    expect(findReviewedChatProfile({ provider: 'openrouter' } as unknown as typeof identity)).toBeNull();
  });
  it('freezes server-owned limits, policy and evidence without tariffs', () => {
    const p = reviewedChatProfiles[0]!;
    expect(p.contextWindowTokens).toBe(128000);
    expect(p.maxOutputTokens).toBe(16384);
    expect(p.endpointPolicy).toEqual({ only: ['openai'], allowFallbacks: false, requireParameters: true });
    for (const value of [reviewedChatProfiles, p, p.endpointPolicy, p.endpointPolicy.only, p.evidence, p.evidence[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/inputCentsPer1k|outputCentsPer1k|markup/);
  });
});
