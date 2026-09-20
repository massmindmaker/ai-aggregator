import { microCreditsToUsdMicroString } from './token-quote';
import {
  captureStoredEmbeddingsHttpIdentity,
  type StoredEmbeddingsHttpIdentity,
} from './stored-embeddings-http-identity';
import type { HttpResultV2 } from './http-terminal-recovery';

export const STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES = 262_144;
export const STORED_EMBEDDINGS_PRE_DISPATCH_WINDOW_MS = 30_000;

type Code =
  | 'INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY' | 'REQUEST_BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE' | 'UNSUPPORTED_EXECUTION_CONTRACT'
  | 'MODEL_NOT_ALLOWED' | 'PII_TRANSBORDER_BLOCKED' | 'KEY_POLICY_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE' | 'INVALID_STORED_EMBEDDINGS_REQUEST'
  | 'STORED_EMBEDDINGS_UNAVAILABLE' | 'AUTHENTICATION_REQUIRED'
  | 'REQUEST_CONFLICT' | 'REQUEST_PENDING' | 'REQUEST_RESULT_EXPIRED'
  | 'REQUEST_RESULT_UNAVAILABLE' | 'REQUEST_STATE_UNAVAILABLE';
type Definition = Readonly<{
  status: 202 | 400 | 401 | 403 | 409 | 410 | 413 | 415 | 501 | 503;
  code: Code;
  message: string;
  type: 'request_error' | 'authentication_error' | 'server_error';
  retryAfter?: '2';
}>;
const errors = Object.freeze({
  invalid_identity: { status: 400, code: 'INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY', message: 'Invalid stored embeddings request', type: 'request_error' },
  request_body_too_large: { status: 413, code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body too large', type: 'request_error' },
  unsupported_content_type: { status: 415, code: 'UNSUPPORTED_CONTENT_TYPE', message: 'JSON content type required', type: 'request_error' },
  unsupported_execution_contract: { status: 501, code: 'UNSUPPORTED_EXECUTION_CONTRACT', message: 'Operation unavailable in this execution mode', type: 'request_error' },
  model_not_allowed: { status: 403, code: 'MODEL_NOT_ALLOWED', message: 'Model not allowed for this key', type: 'request_error' },
  pii_transborder_blocked: { status: 403, code: 'PII_TRANSBORDER_BLOCKED', message: 'Request blocked by data policy', type: 'request_error' },
  key_policy_unavailable: { status: 503, code: 'KEY_POLICY_UNAVAILABLE', message: 'Key policy unavailable', type: 'server_error', retryAfter: '2' },
  model_unavailable: { status: 503, code: 'MODEL_UNAVAILABLE', message: 'Model unavailable', type: 'server_error', retryAfter: '2' },
  invalid_stored_embeddings_request: { status: 400, code: 'INVALID_STORED_EMBEDDINGS_REQUEST', message: 'Invalid stored embeddings request', type: 'request_error' },
  stored_embeddings_unavailable: { status: 503, code: 'STORED_EMBEDDINGS_UNAVAILABLE', message: 'Stored embeddings unavailable', type: 'server_error', retryAfter: '2' },
  authentication_required: { status: 401, code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required', type: 'authentication_error' },
  request_conflict: { status: 409, code: 'REQUEST_CONFLICT', message: 'Request conflicts with stored state', type: 'request_error' },
  request_pending: { status: 202, code: 'REQUEST_PENDING', message: 'Request is pending', type: 'request_error', retryAfter: '2' },
  request_result_expired: { status: 410, code: 'REQUEST_RESULT_EXPIRED', message: 'Stored response expired', type: 'request_error' },
  request_result_unavailable: { status: 409, code: 'REQUEST_RESULT_UNAVAILABLE', message: 'Stored response unavailable', type: 'request_error' },
  request_state_unavailable: { status: 503, code: 'REQUEST_STATE_UNAVAILABLE', message: 'Request state unavailable', type: 'server_error', retryAfter: '2' },
} as const satisfies Record<string, Definition>);

export type StoredEmbeddingsHttpErrorKind = keyof typeof errors;
export type StoredEmbeddingsHttpResponseDescriptor = Readonly<{
  status: number; body: unknown; headers: Readonly<Record<string, string>>;
}>;
export class StoredEmbeddingsHttpContractError extends Error {
  readonly status: number;
  readonly code: Code;
  constructor(definition: Definition) {
    super(definition.message);
    this.name = 'StoredEmbeddingsHttpContractError';
    this.status = definition.status;
    this.code = definition.code;
  }
}
function descriptor(status: number, body: unknown, headers: Record<string, string>): StoredEmbeddingsHttpResponseDescriptor {
  return Object.freeze({ status, body, headers: Object.freeze({
    'cache-control': 'private, no-store', 'content-type': 'application/json', ...headers,
  }) });
}
export function fixedStoredEmbeddingsHttpError(kind: StoredEmbeddingsHttpErrorKind): StoredEmbeddingsHttpResponseDescriptor {
  const definition = errors[kind];
  return descriptor(definition.status, Object.freeze({ error: Object.freeze({
    code: definition.code, message: definition.message, type: definition.type,
  }) }), 'retryAfter' in definition ? { 'retry-after': definition.retryAfter } : {});
}
function jsonContentType(value: string | null): boolean {
  return value !== null && value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}
async function boundedBody(request: Request): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && BigInt(declared) > BigInt(STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES)) {
    try { await request.body?.cancel(); } catch { /* fixed classification */ }
    throw new StoredEmbeddingsHttpContractError(errors.request_body_too_large);
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || size + value.byteLength > STORED_EMBEDDINGS_REQUEST_BODY_LIMIT_BYTES) {
        try { await reader.cancel(); } catch { /* fixed classification */ }
        throw new StoredEmbeddingsHttpContractError(errors.request_body_too_large);
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new StoredEmbeddingsHttpContractError(errors.invalid_identity); }
}

export async function captureStoredEmbeddingsHttpRequest(request: Request): Promise<Readonly<{ identity: StoredEmbeddingsHttpIdentity }>> {
  if (!jsonContentType(request.headers.get('content-type')))
    throw new StoredEmbeddingsHttpContractError(errors.unsupported_content_type);
  let body: unknown;
  try { body = JSON.parse(await boundedBody(request)); }
  catch (error) {
    if (error instanceof StoredEmbeddingsHttpContractError) throw error;
    throw new StoredEmbeddingsHttpContractError(errors.invalid_identity);
  }
  try {
    return Object.freeze({ identity: captureStoredEmbeddingsHttpIdentity({
      body,
      idempotencyKey: request.headers.get('idempotency-key'),
      declaredSessionId: request.headers.get('x-aiag-session-id'),
    }) });
  } catch { throw new StoredEmbeddingsHttpContractError(errors.invalid_identity); }
}

export function projectStoredEmbeddingsHttpResult(result: HttpResultV2<'embeddings'>): StoredEmbeddingsHttpResponseDescriptor {
  const billing: Record<string, string> = result.status === 'not_found'
    ? {}
    : { 'x-aiag-billing-request-id': result.billingRequestId };
  switch (result.status) {
    case 'ready': return descriptor(result.httpStatus, result.response, {
      ...billing, 'x-aiag-receipt-version': '1',
      'x-aiag-charged-microcredits': result.actualCostCredits.toString(),
      'x-aiag-charge-state': 'settled',
      'x-aiag-charged-usd-micro': microCreditsToUsdMicroString(result.actualCostCredits),
    });
    case 'rejected': return descriptor(result.httpStatus, result.response, billing);
    case 'pending': case 'expired': case 'unavailable': {
      const kind = result.status === 'pending' ? 'request_pending' : result.status === 'expired' ? 'request_result_expired' : 'request_result_unavailable';
      const fixed = fixedStoredEmbeddingsHttpError(kind);
      return descriptor(fixed.status, fixed.body, { ...fixed.headers, ...billing });
    }
    case 'not_found': throw new TypeError('A not-found result requires fresh preparation');
  }
}
