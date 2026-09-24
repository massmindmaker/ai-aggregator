import { microCreditsToUsdMicroString } from './token-quote';
import {
  captureStoredCompletionsHttpIdentity,
  type StoredCompletionsHttpIdentity,
} from './stored-completions-http-identity';
import type { HttpResultV2 } from './http-terminal-recovery';

export const STORED_COMPLETIONS_REQUEST_BODY_LIMIT_BYTES = 262_144;
export const STORED_COMPLETIONS_PRE_DISPATCH_WINDOW_MS = 30_000;

type ErrorCode =
  | 'INVALID_STORED_COMPLETIONS_HTTP_IDENTITY'
  | 'REQUEST_BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'UNSUPPORTED_EXECUTION_CONTRACT'
  | 'MODEL_NOT_ALLOWED'
  | 'PII_TRANSBORDER_BLOCKED'
  | 'KEY_POLICY_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_STORED_COMPLETIONS_REQUEST'
  | 'STORED_COMPLETIONS_UNAVAILABLE'
  | 'AUTHENTICATION_REQUIRED'
  | 'REQUEST_CONFLICT'
  | 'REQUEST_PENDING'
  | 'REQUEST_RESULT_EXPIRED'
  | 'REQUEST_RESULT_UNAVAILABLE'
  | 'REQUEST_STATE_UNAVAILABLE';
type ErrorType = 'request_error' | 'authentication_error' | 'server_error';
type ErrorDefinition = Readonly<{
  status: 202 | 400 | 401 | 403 | 409 | 410 | 413 | 415 | 501 | 503;
  code: ErrorCode;
  message: string;
  type: ErrorType;
  retryAfter?: '2';
}>;

const errors = Object.freeze({
  invalid_identity: { status: 400, code: 'INVALID_STORED_COMPLETIONS_HTTP_IDENTITY', message: 'Invalid stored completions request', type: 'request_error' },
  request_body_too_large: { status: 413, code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body too large', type: 'request_error' },
  unsupported_content_type: { status: 415, code: 'UNSUPPORTED_CONTENT_TYPE', message: 'JSON content type required', type: 'request_error' },
  unsupported_execution_contract: { status: 501, code: 'UNSUPPORTED_EXECUTION_CONTRACT', message: 'Operation unavailable in this execution mode', type: 'request_error' },
  model_not_allowed: { status: 403, code: 'MODEL_NOT_ALLOWED', message: 'Model not allowed for this key', type: 'request_error' },
  pii_transborder_blocked: { status: 403, code: 'PII_TRANSBORDER_BLOCKED', message: 'Request blocked by data policy', type: 'request_error' },
  key_policy_unavailable: { status: 503, code: 'KEY_POLICY_UNAVAILABLE', message: 'Key policy unavailable', type: 'server_error', retryAfter: '2' },
  model_unavailable: { status: 503, code: 'MODEL_UNAVAILABLE', message: 'Model unavailable', type: 'server_error', retryAfter: '2' },
  invalid_stored_completions_request: { status: 400, code: 'INVALID_STORED_COMPLETIONS_REQUEST', message: 'Invalid stored completions request', type: 'request_error' },
  stored_completions_unavailable: { status: 503, code: 'STORED_COMPLETIONS_UNAVAILABLE', message: 'Stored completions unavailable', type: 'server_error', retryAfter: '2' },
  authentication_required: { status: 401, code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required', type: 'authentication_error' },
  request_conflict: { status: 409, code: 'REQUEST_CONFLICT', message: 'Request conflicts with stored state', type: 'request_error' },
  request_pending: { status: 202, code: 'REQUEST_PENDING', message: 'Request is pending', type: 'request_error', retryAfter: '2' },
  request_result_expired: { status: 410, code: 'REQUEST_RESULT_EXPIRED', message: 'Stored response expired', type: 'request_error' },
  request_result_unavailable: { status: 409, code: 'REQUEST_RESULT_UNAVAILABLE', message: 'Stored response unavailable', type: 'request_error' },
  request_state_unavailable: { status: 503, code: 'REQUEST_STATE_UNAVAILABLE', message: 'Request state unavailable', type: 'server_error', retryAfter: '2' },
} as const satisfies Record<string, ErrorDefinition>);

export type StoredCompletionsHttpErrorKind = keyof typeof errors;
export type StoredCompletionsHttpResponseDescriptor = Readonly<{
  status: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}>;

export class StoredCompletionsHttpContractError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly type: ErrorType;
  constructor(definition: ErrorDefinition) {
    super(definition.message);
    this.name = 'StoredCompletionsHttpContractError';
    this.status = definition.status;
    this.code = definition.code;
    this.type = definition.type;
  }
}

function descriptor(status: number, body: unknown, headers: Record<string, string>): StoredCompletionsHttpResponseDescriptor {
  return Object.freeze({
    status,
    body,
    headers: Object.freeze({
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
      ...headers,
    }),
  });
}

export function fixedStoredCompletionsHttpError(kind: StoredCompletionsHttpErrorKind): StoredCompletionsHttpResponseDescriptor {
  const definition = errors[kind];
  return descriptor(
    definition.status,
    Object.freeze({ error: Object.freeze({ code: definition.code, message: definition.message, type: definition.type }) }),
    'retryAfter' in definition ? { 'retry-after': definition.retryAfter } : {},
  );
}

function contentTypeIsJson(value: string | null): boolean {
  if (value === null) return false;
  return value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^[0-9]+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(STORED_COMPLETIONS_REQUEST_BODY_LIMIT_BYTES)
  ) {
    try { await request.body?.cancel(); } catch { /* classification is fixed */ }
    throw new StoredCompletionsHttpContractError(errors.request_body_too_large);
  }
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || size + value.byteLength > STORED_COMPLETIONS_REQUEST_BODY_LIMIT_BYTES) {
        try { await reader.cancel(); } catch { /* classification is fixed */ }
        throw new StoredCompletionsHttpContractError(errors.request_body_too_large);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StoredCompletionsHttpContractError(errors.invalid_identity);
  }
}

export type CapturedStoredCompletionsHttpRequest = Readonly<{
  identity: StoredCompletionsHttpIdentity;
}>;

export async function captureStoredCompletionsHttpRequest(request: Request): Promise<CapturedStoredCompletionsHttpRequest> {
  if (!contentTypeIsJson(request.headers.get('content-type')))
    throw new StoredCompletionsHttpContractError(errors.unsupported_content_type);
  const raw = await readBoundedBody(request);
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { throw new StoredCompletionsHttpContractError(errors.invalid_identity); }
  try {
    return Object.freeze({
      identity: captureStoredCompletionsHttpIdentity({
        body,
        idempotencyKey: request.headers.get('idempotency-key'),
        declaredSessionId: request.headers.get('x-aiag-session-id'),
      }),
    });
  } catch {
    throw new StoredCompletionsHttpContractError(errors.invalid_identity);
  }
}

function billingHeaders(billingRequestId: string): Record<string, string> {
  return { 'x-aiag-billing-request-id': billingRequestId };
}

/** Maps only authoritative durable facts; it never creates an HTTP result. */
export function projectStoredCompletionsHttpResult(result: HttpResultV2<'completions'>): StoredCompletionsHttpResponseDescriptor {
  switch (result.status) {
    case 'ready':
      return descriptor(result.httpStatus, result.response, {
        ...billingHeaders(result.billingRequestId),
        'x-aiag-receipt-version': '1',
        'x-aiag-charged-microcredits': result.actualCostCredits.toString(),
        'x-aiag-charge-state': 'settled',
        'x-aiag-charged-usd-micro': microCreditsToUsdMicroString(result.actualCostCredits),
      });
    case 'rejected':
      return descriptor(result.httpStatus, result.response, billingHeaders(result.billingRequestId));
    case 'pending': {
      const response = fixedStoredCompletionsHttpError('request_pending');
      return descriptor(response.status, response.body, { ...response.headers, ...billingHeaders(result.billingRequestId) });
    }
    case 'expired': {
      const response = fixedStoredCompletionsHttpError('request_result_expired');
      return descriptor(response.status, response.body, { ...response.headers, ...billingHeaders(result.billingRequestId) });
    }
    case 'unavailable': {
      const response = fixedStoredCompletionsHttpError('request_result_unavailable');
      return descriptor(response.status, response.body, { ...response.headers, ...billingHeaders(result.billingRequestId) });
    }
    case 'not_found':
      return fixedStoredCompletionsHttpError('request_state_unavailable');
  }
}
