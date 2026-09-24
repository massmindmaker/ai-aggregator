import { describe, expect, it } from 'vitest';
import {
  canonicalStoredCompletionsHttpIdentityV1,
  captureStoredCompletionsHttpIdentity,
  STORED_COMPLETIONS_HTTP_IDENTITY_BAD_REQUEST_CODE,
} from '../billing/stored-completions-http-identity';

const args = (body: unknown = { model: 'openai/gpt-4o-mini', prompt: '  hello  ' }) => ({
  body,
  idempotencyKey: 'same-key',
  declaredSessionId: 'Session.1',
});
const bad = (body: unknown) => {
  expect(() => captureStoredCompletionsHttpIdentity(args(body))).toThrow(
    STORED_COMPLETIONS_HTTP_IDENTITY_BAD_REQUEST_CODE,
  );
};

describe('stored completions HTTP identity', () => {
  it('preserves the scalar prompt and converts it to exactly one user message', () => {
    const value = captureStoredCompletionsHttpIdentity(args());
    expect(value).toMatchObject({
      routeKind: 'completions',
      billingMode: 'stored',
      requestedMode: null,
      declaredSessionId: 'Session.1',
      attemptBody: {
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: '  hello  ' }],
        stream: false,
      },
    });
    expect(Object.isFrozen(value.attemptBody.messages[0])).toBe(true);
  });

  it('uses the frozen ordered tuple and makes omitted stream equal explicit false', () => {
    expect(canonicalStoredCompletionsHttpIdentityV1({
      model: 'm', requestedMode: null, declaredSessionId: null,
      prompt: 'p', maxTokens: undefined,
    })).toBe('[1,"completions","stored","m",null,null,"p",["absent"],false]');
    const omitted = captureStoredCompletionsHttpIdentity(args({ model: 'm', prompt: 'p' }));
    const explicit = captureStoredCompletionsHttpIdentity(args({ model: 'm', prompt: 'p', stream: false }));
    const capped = captureStoredCompletionsHttpIdentity(args({ model: 'm', prompt: 'p', max_tokens: 1 }));
    expect(omitted.requestFingerprint).toBe(explicit.requestFingerprint);
    expect(capped.requestFingerprint).not.toBe(omitted.requestFingerprint);
  });

  it.each([
    { model: 'm', prompt: '' },
    { model: 'm', prompt: ['a'] },
    { model: 'm', prompt: [1, 2] },
    { model: 'm', prompt: '\ud800' },
    { model: 'm', prompt: 'p', stream: true },
    { model: 'm', prompt: 'p', max_tokens: 0 },
    { model: 'm', prompt: 'p', n: 1 },
    { model: 'm', prompt: 'p', temperature: 0 },
    { model: 'm', prompt: 'p', suffix: 'x' },
  ])('rejects unsupported or malformed body before admission: %j', bad);
});
