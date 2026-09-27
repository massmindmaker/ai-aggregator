import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  captureStoredBatchHttpIdentity,
  STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE,
} from '../billing/stored-batch-http-identity';
import {
  captureStoredBatchHttpRequest,
  STORED_BATCH_REQUEST_BODY_LIMIT_BYTES,
  StoredBatchHttpContractError,
} from '../billing/stored-batch-http-contract';
import {
  captureStoredChatHttpIdentity,
  normalizeStoredChatBodyV1,
} from '../billing/stored-chat-http-identity';
import {
  captureStoredEmbeddingsHttpIdentity,
  normalizeStoredEmbeddingsBodyV1,
} from '../billing/stored-embeddings-http-identity';
import {
  captureStoredCompletionsHttpIdentity,
  normalizeStoredCompletionsBodyV1,
} from '../billing/stored-completions-http-identity';

const chatBody = (content = 'hello') => ({
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content }],
  max_tokens: 42,
});
const embeddingsBody = (input: unknown = 'alpha') => ({
  model: 'openai/text-embedding-3-small',
  input,
});
const completionsBody = (prompt = 'prompt') => ({
  model: 'openai/gpt-4o-mini',
  prompt,
  max_tokens: 42,
});
const batchBody = (
  type: 'chat' | 'embeddings' | 'completions' = 'chat',
  bodies: unknown[] = [chatBody()],
) => ({
  type,
  requests: bodies.map((body, index) => ({ custom_id: `item.${index + 1}`, body })),
});
const capture = (
  body: unknown = batchBody(),
  patch: Partial<Parameters<typeof captureStoredBatchHttpIdentity>[0]> = {},
) => captureStoredBatchHttpIdentity({
  body,
  idempotencyKey: 'Batch.Key:1',
  declaredSessionId: null,
  byokKeyPresent: false,
  ...patch,
});

function bad(thunk: () => unknown) {
  expect(thunk).toThrow(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
}

describe('stored batch HTTP identity', () => {
  it('captures an ordered frozen chat batch with contract v5 and separate key digest', () => {
    const identity = capture(batchBody('chat', [chatBody('a'), chatBody('b')]), {
      declaredSessionId: 'SID.1',
    });
    expect(identity).toMatchObject({
      contractVersion: 5,
      routeKind: 'batch',
      billingMode: 'stored',
      batchType: 'chat',
      declaredSessionId: 'SID.1',
      items: [
        { index: 0, customId: 'item.1', routeKind: 'chat' },
        { index: 1, customId: 'item.2', routeKind: 'chat' },
      ],
    });
    expect(identity.idempotencyKeyDigest).toBe(
      createHash('sha256').update('Batch.Key:1', 'utf8').digest('hex'),
    );
    expect(identity.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.items.every((item) => /^[a-f0-9]{64}$/.test(item.requestFingerprint))).toBe(true);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.items)).toBe(true);
    expect(Object.isFrozen(identity.items[0]!.attemptBody)).toBe(true);
  });

  it('binds item order, body and declared session into the parent fingerprint', () => {
    const first = capture(batchBody('chat', [chatBody('a'), chatBody('b')]));
    const reordered = capture(batchBody('chat', [chatBody('b'), chatBody('a')]));
    const changed = capture(batchBody('chat', [chatBody('a'), chatBody('c')]));
    const session = capture(batchBody('chat', [chatBody('a'), chatBody('b')]), {
      declaredSessionId: 'SID.1',
    });
    expect(new Set([
      first.requestFingerprint,
      reordered.requestFingerprint,
      changed.requestFingerprint,
      session.requestFingerprint,
    ]).size).toBe(4);
  });

  it('normalizes batch item bodies exactly like the direct identities', () => {
    const chat = chatBody();
    const embedding = embeddingsBody(' alpha ');
    const completion = completionsBody('  prompt  ');

    const normalizedChat = normalizeStoredChatBodyV1(chat);
    const directChat = captureStoredChatHttpIdentity({
      body: chat, idempotencyKey: 'direct', declaredSessionId: null,
    });
    expect(normalizedChat).toEqual({
      attemptBody: directChat.attemptBody,
      requestedMode: directChat.requestedMode,
    });

    const normalizedEmbedding = normalizeStoredEmbeddingsBodyV1(embedding);
    const directEmbedding = captureStoredEmbeddingsHttpIdentity({
      body: embedding, idempotencyKey: 'direct', declaredSessionId: null,
    });
    expect(normalizedEmbedding).toEqual({
      attemptBody: directEmbedding.attemptBody,
      requestedMode: directEmbedding.requestedMode,
    });

    const normalizedCompletion = normalizeStoredCompletionsBodyV1(completion);
    const directCompletion = captureStoredCompletionsHttpIdentity({
      body: completion, idempotencyKey: 'direct', declaredSessionId: null,
    });
    expect(normalizedCompletion).toEqual({
      attemptBody: directCompletion.attemptBody,
      requestedMode: directCompletion.requestedMode,
    });
  });

  it('normalizes embeddings scalar/defaults and completions stream omission inside batch identity', () => {
    const implicitEmbedding = capture(batchBody('embeddings', [embeddingsBody('alpha')]));
    const explicitEmbedding = capture(batchBody('embeddings', [{
      ...embeddingsBody(['alpha']), encoding_format: 'float', dimensions: 1536,
    }]));
    expect(explicitEmbedding.requestFingerprint).toBe(implicitEmbedding.requestFingerprint);

    const implicitCompletion = capture(batchBody('completions', [completionsBody()]));
    const explicitCompletion = capture(batchBody('completions', [{ ...completionsBody(), stream: false }]));
    expect(explicitCompletion.requestFingerprint).toBe(implicitCompletion.requestFingerprint);
  });

  it.each([
    [{ type: 'chat', requests: [], extra: true }, 'unknown top-level key'],
    [{ type: 'image', requests: [{ custom_id: 'a', body: chatBody() }] }, 'unsupported type'],
    [{ type: 'chat', requests: [] }, 'empty requests'],
    [{ type: 'chat', requests: Array.from({ length: 101 }, (_, i) => ({ custom_id: `i${i}`, body: chatBody() })) }, '101 items'],
    [{ type: 'chat', requests: [{ custom_id: 'a', body: chatBody(), extra: true }] }, 'unknown item key'],
    [{ type: 'chat', requests: [{ custom_id: '', body: chatBody() }] }, 'empty custom id'],
    [{ type: 'chat', requests: [{ custom_id: 'has space', body: chatBody() }] }, 'unsafe custom id'],
    [{ type: 'chat', requests: [{ custom_id: 'x'.repeat(129), body: chatBody() }] }, 'long custom id'],
    [{ type: 'chat', requests: [
      { custom_id: 'dup', body: chatBody('a') },
      { custom_id: 'dup', body: chatBody('b') },
    ] }, 'duplicate custom id'],
    [{ type: 'chat', requests: [{ custom_id: 'a', body: embeddingsBody() }] }, 'mixed body/type'],
    [{ type: 'chat', requests: [{ custom_id: 'a', body: { ...chatBody(), stream: true } }] }, 'stream chat'],
  ])('rejects %s (%s)', (body, _reason) => bad(() => capture(body)));

  it.each([undefined, null, '', 'with space', 'ключ', 'x'.repeat(129)])(
    'rejects invalid parent idempotency key %#',
    (idempotencyKey) => bad(() => capture(undefined, { idempotencyKey })),
  );

  it('rejects BYOK presence before durable identity exists', () => {
    bad(() => capture(undefined, { byokKeyPresent: true }));
  });

  it('rejects malformed declared session id before durable identity exists', () => {
    bad(() => capture(undefined, { declaredSessionId: 'bad session' }));
  });
});

describe('stored batch bounded HTTP request', () => {
  it('captures application/json with the exact parent headers', async () => {
    const request = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'idempotency-key': 'Batch.Key:1',
        'x-aiag-session-id': 'SID.1',
      },
      body: JSON.stringify(batchBody()),
    });
    const { identity } = await captureStoredBatchHttpRequest(request);
    expect(identity).toMatchObject({
      contractVersion: 5,
      batchType: 'chat',
      declaredSessionId: 'SID.1',
    });
  });

  it('rejects malformed JSON and invalid UTF-8 as fixed contract errors', async () => {
    const malformed = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{"type":"chat","requests":',
    });
    await expect(captureStoredBatchHttpRequest(malformed)).rejects.toMatchObject({
      code: 'INVALID_STORED_BATCH_HTTP_IDENTITY',
      status: 400,
    });

    const invalidUtf8 = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await expect(captureStoredBatchHttpRequest(invalidUtf8)).rejects.toBeInstanceOf(
      StoredBatchHttpContractError,
    );
  });

  it('rejects declared and streamed bodies above the 2 MiB cap before JSON parsing', async () => {
    const declared = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'k',
        'content-length': String(STORED_BATCH_REQUEST_BODY_LIMIT_BYTES + 1),
      },
      body: '{}',
    });
    await expect(captureStoredBatchHttpRequest(declared)).rejects.toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      status: 413,
    });

    const oversized = JSON.stringify(batchBody('chat', [chatBody('x'.repeat(STORED_BATCH_REQUEST_BODY_LIMIT_BYTES))]));
    const streamed = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: oversized,
    });
    await expect(captureStoredBatchHttpRequest(streamed)).rejects.toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      status: 413,
    });
  });

  it('rejects non-json content type and any X-Upstream-Key presence', async () => {
    const wrongType = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'idempotency-key': 'k' },
      body: JSON.stringify(batchBody()),
    });
    await expect(captureStoredBatchHttpRequest(wrongType)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
      status: 415,
    });

    const byok = new Request('http://test/v1/batches', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'k',
        'x-upstream-key': 'secret',
      },
      body: JSON.stringify(batchBody()),
    });
    await expect(captureStoredBatchHttpRequest(byok)).rejects.toMatchObject({
      code: 'UNSUPPORTED_EXECUTION_CONTRACT',
      status: 501,
    });
  });
});
