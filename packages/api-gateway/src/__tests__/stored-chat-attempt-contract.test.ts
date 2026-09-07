import { describe, expect, it } from 'vitest';
import {
  parseStoredChatBody,
  captureStoredChatEvidence,
  validateStoredChatIdentity,
} from '../billing/stored-chat-attempt-contract';
import { prepareStoredChatQuote } from '../billing/candidate-quote';

const slug = 'openai/gpt-4o-mini';
const body = () => ({
  model: slug,
  messages: [{ role: 'user', content: 'private prompt' }],
});
const identity = () => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  apiKeyId: '00000000-0000-4000-8000-000000000002',
  clientRequestId: 'trace',
  declaredSessionId: null,
  preDispatchDeadlineAt: '2026-09-08T00:00:00Z',
  cachingDiscount: '0.123456789012345678',
});
describe('stored plaintext detached contract', () => {
  it('detaches and freezes messages', () => {
    const source = body();
    const parsed = parseStoredChatBody(source, slug);
    source.messages[0]!.content = 'changed';
    expect(parsed.messages[0]!.content).toBe('private prompt');
    expect(Object.isFrozen(parsed.messages[0])).toBe(true);
    expect(Object.isFrozen(parsed.messages)).toBe(true);
  });
  it.each([
    {},
    { stream: true },
    { model: 'alias' },
    { tools: [] },
    { temperature: 0 },
    { byokKey: 'secret' },
    { billingRequestId: 'injected' },
    { messages: [] },
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: [] }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'x', name: 'x' }] },
  ])('rejects unsupported body %j', (patch) => {
    const input = Object.keys(patch).length ? { ...body(), ...patch } : {};
    expect(() => parseStoredChatBody(input, slug)).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '5'])(
    'rejects cap %s',
    (max_tokens) =>
      expect(() =>
        parseStoredChatBody({ ...body(), max_tokens }, slug),
      ).toThrow(),
  );
  it.each([undefined, 10000, 20000])(
    'accepts omitted/explicit/cappable %s',
    (cap) => {
      expect(
        parseStoredChatBody(
          {
            ...body(),
            stream: false,
            ...(cap === undefined ? {} : { max_tokens: cap }),
          },
          slug,
        ).maxTokens,
      ).toBe(cap);
    },
  );
  it('rejects accessors and nonplain objects without invoking getters', () => {
    const input = body();
    Object.defineProperty(input, 'stream', {
      enumerable: true,
      get: () => {
        throw Error('getter');
      },
    });
    expect(() => parseStoredChatBody(input, slug)).toThrow();
    expect(() => parseStoredChatBody(new Date(), slug)).toThrow();
  });
  it.each(['0', '1', '0.123456789012345678'])(
    'retains exact cache policy %s',
    (cachingDiscount) =>
      expect(
        validateStoredChatIdentity({ ...identity(), cachingDiscount })
          .cachingDiscount,
      ).toBe(cachingDiscount),
  );
  it.each([
    '-1',
    '1.1',
    '1e-1',
    '01',
    '.5',
    ' 0.5',
    '0.1234567890123456789',
    0.5,
  ])('rejects cache policy %s', (cachingDiscount) =>
    expect(() =>
      validateStoredChatIdentity({ ...identity(), cachingDiscount } as never),
    ).toThrow(),
  );
  it.each([
    { orgId: 'bad' },
    { apiKeyId: '' },
    { clientRequestId: '' },
    { clientRequestId: 'x'.repeat(256) },
    { preDispatchDeadlineAt: '2026-02-30T00:00:00Z' },
  ])('rejects identity %j', (patch) =>
    expect(() =>
      validateStoredChatIdentity({ ...identity(), ...patch }),
    ).toThrow(),
  );
});

function chosen() {
  const quote = prepareStoredChatQuote({
    model: {
      slug,
      type: 'chat',
      candidates: [
        {
          id: 'openrouter',
          upstream_id: 'openrouter',
          upstream_model_id: slug,
          provider: 'openai',
          price_per_1k_input: 1,
          price_per_1k_output: 1,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: identity().orgId,
            prices: {
              inputCentsPer1k: '100000000000',
              outputCentsPer1k: '100000000000',
              markup: '1.000000000000000001',
            },
          },
        },
      ],
    },
    requestedMode: 'fastest',
    policy: {},
    defaultMaxOutputTokens: 4096,
    getAdapter: () => ({
      chat: async () => {
        throw Error();
      },
      admittedChat: {
        contract: 'openrouter-pinned-provider-chat-v1',
        execute: async () => {
          throw Error();
        },
      },
    }),
  });
  if (quote.status !== 'ready') throw Error();
  return quote.candidates[0]!;
}
function completion() {
  return {
    response: {
      id: 'gen-1',
      object: 'chat.completion' as const,
      created: 1,
      model: slug,
      choices: [
        {
          index: 0,
          message: { role: 'assistant' as const, content: 'private answer' },
          finish_reason: 'stop' as const,
        },
      ],
      usage: {
        prompt_tokens: 100000,
        completion_tokens: 2,
        total_tokens: 100002,
      },
    },
    usage: {
      promptTokens: 100000,
      completionTokens: 2,
      totalTokens: 100002,
      cachedInputTokens: 50000,
    },
  };
}
const evidence = (value = completion(), discount = '0.5') =>
  captureStoredChatEvidence(
    value,
    chosen(),
    discount,
    identity().orgId,
    identity().apiKeyId,
  );
describe('bounded exact completion evidence', () => {
  it('charges above 2^53 with exact whole-cost cache policy once', () => {
    const result = evidence();
    expect(result.actualCostCredits).toBe(7500150000000000n);
    expect(evidence(completion(), '1').actualCostCredits).toBe(
      10000200000000000n,
    );
    expect(JSON.stringify(result.usageSnapshot)).not.toMatch(/private|answer/);
  });
  it('detaches response and evidence before persistence await', () => {
    const input = completion();
    const captured = evidence(input);
    input.usage.promptTokens = 0;
    input.response.usage.total_tokens = 0;
    input.response.choices[0]!.message.content = 'changed';
    expect(captured.response.usage.total_tokens).toBe(100002);
    expect(captured.response.choices[0]!.message.content).toBe(
      'private answer',
    );
    expect(Object.isFrozen(captured.response.usage)).toBe(true);
  });
  it.each([
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'cachedInputTokens',
  ])('rejects invalid %s', (field) => {
    for (const invalid of [
      -1,
      NaN,
      Infinity,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '2',
      undefined,
    ]) {
      const input = completion();
      (input.usage as Record<string, unknown>)[field] = invalid;
      expect(() => evidence(input)).toThrow();
    }
  });
  it.each([
    { cachedInputTokens: 100001 },
    { totalTokens: 1 },
    { promptTokens: 128000, totalTokens: 128002 },
    { completionTokens: 4097, totalTokens: 104097 },
  ])('rejects inconsistent/over-cap usage %j', (patch) => {
    const input = completion();
    Object.assign(input.usage, patch);
    input.response.usage = {
      prompt_tokens: input.usage.promptTokens,
      completion_tokens: input.usage.completionTokens,
      total_tokens: input.usage.totalTokens,
    };
    expect(() => evidence(input)).toThrow();
  });
  it('rejects forged public usage and unsafe metadata', () => {
    const input = completion();
    input.response.usage.total_tokens = 1;
    expect(() => evidence(input)).toThrow();
    const unsafe = completion();
    unsafe.response.id = 'secret\nerror';
    expect(() => evidence(unsafe)).toThrow();
  });
  it('allows zero actual as success evidence', () => {
    const input = completion();
    input.usage.cachedInputTokens = input.usage.promptTokens;
    expect(evidence(input, '0').actualCostCredits).toBe(0n);
  });
  it('enforces the chosen monetary maximum independently of a larger pool', () => {
    expect(() =>
      captureStoredChatEvidence(
        completion(),
        { ...chosen(), maxCredits: 1n },
        '1',
        identity().orgId,
        identity().apiKeyId,
      ),
    ).toThrow();
  });
  it('rejects a safe individual pair with unsafe sum and missing evidence', () => {
    const input = completion();
    input.usage.promptTokens = Number.MAX_SAFE_INTEGER;
    input.usage.completionTokens = 1;
    expect(() => evidence(input)).toThrow();
    expect(() => evidence({} as never)).toThrow();
  });
});
