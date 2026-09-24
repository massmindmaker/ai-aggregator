import { describe, expect, it } from 'vitest';
import {
  captureStoredCompletionsHttpRequest,
  fixedStoredCompletionsHttpError,
  projectStoredCompletionsHttpResult,
  STORED_COMPLETIONS_REQUEST_BODY_LIMIT_BYTES,
} from '../billing/stored-completions-http-contract';

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://gateway.test/v1/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k', ...headers },
    body,
  });
}

describe('stored completions HTTP contract', () => {
  it('captures valid UTF-8 JSON within the shared body bound', async () => {
    const captured = await captureStoredCompletionsHttpRequest(request(JSON.stringify({ model: 'm', prompt: 'hello' })));
    expect(captured.identity.attemptBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('rejects non-JSON and oversized bodies with fixed public errors', async () => {
    await expect(captureStoredCompletionsHttpRequest(request('{}', { 'content-type': 'text/plain' }))).rejects.toMatchObject({ status: 415 });
    await expect(captureStoredCompletionsHttpRequest(request('x'.repeat(STORED_COMPLETIONS_REQUEST_BODY_LIMIT_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
  });

  it('projects only authoritative stored success facts and exact charge headers', () => {
    const response = { id: 'cmpl-1', object: 'text_completion', created: 1, model: 'm', choices: [{ text: 'ok', index: 0, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as const;
    expect(projectStoredCompletionsHttpResult({
      contractVersion: 1, status: 'ready', billingRequestId: 'id', httpStatus: 200,
      contentType: 'application/json', response, actualCostCredits: 3n,
      storedAt: '2026-09-24T00:00:00.000000Z',
      expiresAt: '2026-09-25T00:00:00.000000Z',
    })).toEqual({
      status: 200,
      body: response,
      headers: {
        'cache-control': 'private, no-store', 'content-type': 'application/json',
        'x-aiag-billing-request-id': 'id', 'x-aiag-receipt-version': '1',
        'x-aiag-charged-microcredits': '3', 'x-aiag-charge-state': 'settled',
        'x-aiag-charged-usd-micro': '30',
      },
    });
    expect(fixedStoredCompletionsHttpError('request_pending').headers['retry-after']).toBe('2');
  });
});
