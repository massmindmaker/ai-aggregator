import { expect, it } from 'vitest';
import {
  canonicalStoredEmbeddingsHttpIdentityV1,
  captureStoredEmbeddingsHttpIdentity,
} from '../billing/stored-embeddings-http-identity';

const capture = (body: unknown, idempotencyKey = 'same-key') =>
  captureStoredEmbeddingsHttpIdentity({ body, idempotencyKey, declaredSessionId: null });
const base = { model: 'openai/text-embedding-3-small', input: 'alpha' };

it('normalizes scalar/defaults into the exact embeddings tuple', () => {
  const identity = capture(base);
  expect(identity).toMatchObject({
    routeKind: 'embeddings', billingMode: 'stored', requestedMode: null,
    attemptBody: { model: base.model, input: ['alpha'], encoding_format: 'float', dimensions: 1536 },
  });
  expect(identity.requestFingerprint).toHaveLength(64);
  expect(canonicalStoredEmbeddingsHttpIdentityV1({
    model: base.model, requestedMode: null, declaredSessionId: null, input: ['alpha'],
  })).toBe('[1,"embeddings","stored","openai/text-embedding-3-small",null,null,["alpha"],"float",1536]');
});

it('makes omitted defaults and scalar input identical to explicit normalized values', () => {
  const implicit = capture(base);
  const explicit = capture({ ...base, input: ['alpha'], encoding_format: 'float', dimensions: 1536 });
  expect(explicit.requestFingerprint).toBe(implicit.requestFingerprint);
  expect(explicit.idempotencyKeyDigest).toBe(implicit.idempotencyKeyDigest);
});

it('preserves input order, whitespace and explicit mode in the fingerprint', () => {
  const first = capture({ ...base, input: [' a ', 'b'], aiag_mode: 'cheapest' });
  const reordered = capture({ ...base, input: ['b', ' a '], aiag_mode: 'cheapest' });
  const trimmed = capture({ ...base, input: ['a', 'b'], aiag_mode: 'cheapest' });
  expect(new Set([first.requestFingerprint, reordered.requestFingerprint, trimmed.requestFingerprint]).size).toBe(3);
});

it.each([
  {},
  { ...base, input: '' },
  { ...base, input: [] },
  { ...base, input: Array(17).fill('x') },
  { ...base, input: [1] },
  { ...base, input: 'x'.repeat(8193) },
  { ...base, input: '\ud800' },
  { ...base, encoding_format: 'base64' },
  { ...base, dimensions: 42 },
  { ...base, user: 'override' },
  { ...base, aiag_mode: 'invented' },
])('rejects malformed or unsupported body %#', (body) => {
  expect(() => capture(body)).toThrow('INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY');
});

it.each(['', 'with space', 'x'.repeat(129)])('rejects invalid idempotency key %j', (key) => {
  expect(() => capture(base, key)).toThrow('INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY');
});
