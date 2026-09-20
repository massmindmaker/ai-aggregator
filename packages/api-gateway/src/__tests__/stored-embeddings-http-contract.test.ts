import { expect, it } from 'vitest';
import {
  captureStoredEmbeddingsHttpRequest,
  fixedStoredEmbeddingsHttpError,
  projectStoredEmbeddingsHttpResult,
} from '../billing/stored-embeddings-http-contract';

const body = { model: 'openai/text-embedding-3-small', input: ['a', 'b'] };
const request = (payload: unknown = body, headers: Record<string, string> = {}) => new Request('http://test/v1/embeddings', {
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'request-1', ...headers },
  body: JSON.stringify(payload),
});

it('captures only bounded JSON into the normalized identity', async () => {
  const captured = await captureStoredEmbeddingsHttpRequest(request());
  expect(captured.identity.attemptBody.input).toEqual(['a', 'b']);
  expect(Object.isFrozen(captured.identity.attemptBody.input)).toBe(true);
});

it('returns fixed contract failures for content type, size and invalid identity', async () => {
  await expect(captureStoredEmbeddingsHttpRequest(request(body, { 'content-type': 'text/plain' })))
    .rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_CONTENT_TYPE' });
  await expect(captureStoredEmbeddingsHttpRequest(request(body, { 'content-length': '262145' })))
    .rejects.toMatchObject({ status: 413, code: 'REQUEST_BODY_TOO_LARGE' });
  await expect(captureStoredEmbeddingsHttpRequest(request({ ...body, dimensions: 12 })))
    .rejects.toMatchObject({ status: 400, code: 'INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY' });
});

it('projects authoritative ready amounts and never provider metadata', () => {
  const response = { object: 'list' as const, model: body.model, data: [{ object: 'embedding' as const, index: 0, embedding: Array(1536).fill(0) }], usage: { prompt_tokens: 1000, total_tokens: 1000 } };
  const result = projectStoredEmbeddingsHttpResult({
    contractVersion: 1, status: 'ready', billingRequestId: '00000000-0000-4000-8000-000000000001',
    httpStatus: 200, contentType: 'application/json', response, actualCostCredits: 3n,
    storedAt: '2026-09-20T00:00:00.000000Z', expiresAt: '2026-09-21T00:00:00.000000Z',
  });
  expect(result.body).toBe(response);
  expect(result.headers).toMatchObject({
    'x-aiag-charged-microcredits': '3', 'x-aiag-charged-usd-micro': '30', 'x-aiag-charge-state': 'settled',
  });
  expect(JSON.stringify(result)).not.toMatch(/providerResponseId|supplier/i);
});

it('uses fixed pending and state errors', () => {
  expect(fixedStoredEmbeddingsHttpError('request_state_unavailable')).toMatchObject({ status: 503, headers: { 'retry-after': '2' } });
  expect(projectStoredEmbeddingsHttpResult({ contractVersion: 1, status: 'pending', billingRequestId: '00000000-0000-4000-8000-000000000001' }))
    .toMatchObject({ status: 202, body: { error: { code: 'REQUEST_PENDING' } } });
});
