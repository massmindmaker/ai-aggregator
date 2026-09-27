import {
  captureStoredBatchHttpIdentity,
  type StoredBatchHttpIdentity,
} from './stored-batch-http-identity';

export const STORED_BATCH_REQUEST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

type BatchContractErrorCode =
  | 'INVALID_STORED_BATCH_HTTP_IDENTITY'
  | 'REQUEST_BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'UNSUPPORTED_EXECUTION_CONTRACT';

type BatchContractStatus = 400 | 413 | 415 | 501;

export class StoredBatchHttpContractError extends Error {
  constructor(
    readonly code: BatchContractErrorCode,
    readonly status: BatchContractStatus,
  ) {
    super(code);
    this.name = 'StoredBatchHttpContractError';
  }
}

function fail(code: BatchContractErrorCode, status: BatchContractStatus): never {
  throw new StoredBatchHttpContractError(code, status);
}

function contentTypeIsJson(value: string | null): boolean {
  return value !== null && value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^[0-9]+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(STORED_BATCH_REQUEST_BODY_LIMIT_BYTES)
  ) {
    try { await request.body?.cancel(); } catch { /* classification is fixed */ }
    return fail('REQUEST_BODY_TOO_LARGE', 413);
  }
  if (request.body === null) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (
        !value ||
        size + value.byteLength > STORED_BATCH_REQUEST_BODY_LIMIT_BYTES
      ) {
        try { await reader.cancel(); } catch { /* classification is fixed */ }
        return fail('REQUEST_BODY_TOO_LARGE', 413);
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
    return fail('INVALID_STORED_BATCH_HTTP_IDENTITY', 400);
  }
}

export async function captureStoredBatchHttpRequest(
  request: Request,
): Promise<Readonly<{ identity: StoredBatchHttpIdentity }>> {
  if (!contentTypeIsJson(request.headers.get('content-type')))
    fail('UNSUPPORTED_CONTENT_TYPE', 415);
  if (request.headers.has('x-upstream-key'))
    fail('UNSUPPORTED_EXECUTION_CONTRACT', 501);

  const raw = await readBoundedBody(request);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail('INVALID_STORED_BATCH_HTTP_IDENTITY', 400);
  }

  try {
    return Object.freeze({
      identity: captureStoredBatchHttpIdentity({
        body,
        idempotencyKey: request.headers.get('idempotency-key'),
        declaredSessionId: request.headers.get('x-aiag-session-id'),
        byokKeyPresent: false,
      }),
    });
  } catch {
    return fail('INVALID_STORED_BATCH_HTTP_IDENTITY', 400);
  }
}
