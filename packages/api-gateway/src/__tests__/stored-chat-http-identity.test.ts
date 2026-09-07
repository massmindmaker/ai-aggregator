import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalStoredChatHttpIdentityV1,
  captureStoredChatHttpIdentity,
  STORED_CHAT_HTTP_IDENTITY_BAD_REQUEST_CODE,
} from '../billing/stored-chat-http-identity';

const model = 'openai/gpt-4o-mini';
const request = (patch: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'private prompt' }],
  ...patch,
});
const args = (patch: Record<string, unknown> = {}) => ({
  body: request(),
  idempotencyKey: 'key.Original:1',
  declaredSessionId: null,
  ...patch,
});

function badRequest(thunk: () => unknown) {
  expect(thunk).toThrow(STORED_CHAT_HTTP_IDENTITY_BAD_REQUEST_CODE);
}

describe('stored chat HTTP identity', () => {
  it('captures only detached, frozen supported request identity', () => {
    const source = request({
      aiag_mode: 'auto',
      stream: false,
      max_tokens: 42,
    });
    const identity = captureStoredChatHttpIdentity(args({ body: source }));

    expect(identity).toMatchObject({
      contractVersion: 1,
      routeKind: 'chat',
      billingMode: 'stored',
      requestedMode: 'auto',
      declaredSessionId: null,
      attemptBody: {
        model,
        messages: [{ role: 'user', content: 'private prompt' }],
        stream: false,
        max_tokens: 42,
      },
    });
    expect(identity.idempotencyKeyDigest).toBe(
      createHash('sha256').update('key.Original:1', 'utf8').digest('hex'),
    );
    expect(identity.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.attemptBody)).toBe(true);
    expect(Object.isFrozen(identity.attemptBody.messages)).toBe(true);
    expect(Object.isFrozen(identity.attemptBody.messages[0])).toBe(true);
    expect('aiag_mode' in identity.attemptBody).toBe(false);

    source.messages[0]!.content = 'changed';
    (source as Record<string, unknown>).max_tokens = 1;
    expect(identity.attemptBody.messages[0]!.content).toBe('private prompt');
    expect(identity.attemptBody.max_tokens).toBe(42);
  });

  it('uses stable canonical v1 bytes and digest fixture', () => {
    const canonical = canonicalStoredChatHttpIdentityV1({
      model,
      requestedMode: 'auto',
      declaredSessionId: 'SID.1',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: ' hello ' },
      ],
      maxTokens: 42,
    });
    expect(canonical).toBe(
      '[1,"chat","stored","openai/gpt-4o-mini","auto","SID.1",[["system","rules"],["user"," hello "]],["present",42],false]',
    );
    expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(
      '4bff1c460d5c56147673df0925c0d9e094c86980d6633dec49bd6cca65b214b3',
    );
  });

  it('normalizes JSON key order and stream omission/false', () => {
    const first = captureStoredChatHttpIdentity(
      args({ body: request({ aiag_mode: 'fastest' }) }),
    );
    const second = captureStoredChatHttpIdentity(
      args({
        body: {
          messages: [{ content: 'private prompt', role: 'user' }],
          stream: false,
          aiag_mode: 'fastest',
          model,
        },
      }),
    );
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
  });

  it.each([
    ['model', request({ model: 'other/model' })],
    ['mode', request({ aiag_mode: 'auto' })],
    ['SID', request()],
    ['message order', request({ messages: [{ role: 'assistant', content: 'private prompt' }] })],
    ['message whitespace', request({ messages: [{ role: 'user', content: 'private prompt ' }] })],
    ['max presence', request({ max_tokens: 1 })],
    ['max value', request({ max_tokens: 2 })],
  ])('changes fingerprint for semantic %s', (_name, body) => {
    const base = captureStoredChatHttpIdentity(args());
    const changed = captureStoredChatHttpIdentity(
      args({
        body,
        declaredSessionId: _name === 'SID' ? 'SID.1' : null,
      }),
    );
    expect(changed.requestFingerprint).not.toBe(base.requestFingerprint);
  });

  it('keeps absent mode distinct from explicit auto and key separate from fingerprint', () => {
    const absent = captureStoredChatHttpIdentity(args());
    const automatic = captureStoredChatHttpIdentity(
      args({ body: request({ aiag_mode: 'auto' }) }),
    );
    const changedKey = captureStoredChatHttpIdentity(
      args({ idempotencyKey: 'key.Original:2' }),
    );
    expect(absent.requestedMode).toBeNull();
    expect(automatic.requestedMode).toBe('auto');
    expect(automatic.requestFingerprint).not.toBe(absent.requestFingerprint);
    expect(changedKey.idempotencyKeyDigest).not.toBe(absent.idempotencyKeyDigest);
    expect(changedKey.requestFingerprint).toBe(absent.requestFingerprint);
  });

  it.each([
    undefined,
    null,
    '',
    'a b',
    'a\n',
    'ключ',
    'x'.repeat(129),
    1,
  ])('rejects invalid exact idempotency key %#', (idempotencyKey) =>
    badRequest(() => captureStoredChatHttpIdentity(args({ idempotencyKey }))),
  );

  it.each([undefined, '', ' ', 'ключ', 'x'.repeat(129), 1])(
    'rejects invalid declared SID %#',
    (declaredSessionId) =>
      badRequest(() =>
        captureStoredChatHttpIdentity(args({ declaredSessionId })),
      ),
  );

  it.each([
    request({ aiag_mode: null }),
    request({ aiag_mode: 'invalid' }),
    request({ stream: true }),
    request({ tools: [] }),
    request({ media: [] }),
    request({ byokKey: 'secret' }),
    request({ billingRequestId: 'spoofed' }),
    request({ max_tokens: NaN }),
    Object.assign(Object.create({ inherited: true }), request()),
  ])('rejects unsupported or unsafe body %#', (body) =>
    badRequest(() => captureStoredChatHttpIdentity(args({ body }))),
  );

  it('rejects accessors without invoking their getters', () => {
    const body = request();
    let invoked = false;
    Object.defineProperty(body, 'aiag_mode', {
      enumerable: true,
      get: () => {
        invoked = true;
        throw Error('must not run');
      },
    });
    badRequest(() => captureStoredChatHttpIdentity(args({ body })));
    expect(invoked).toBe(false);
  });
});
