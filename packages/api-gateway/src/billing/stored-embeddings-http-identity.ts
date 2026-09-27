import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseAdmissionJsonObject } from './admission-result';

export const STORED_EMBEDDINGS_HTTP_IDENTITY_BAD_REQUEST_CODE =
  'INVALID_STORED_EMBEDDINGS_HTTP_IDENTITY' as const;

type StoredEmbeddingsMode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';

export type StoredEmbeddingsHttpAttemptBody = Readonly<{
  model: string;
  input: readonly string[];
  encoding_format: 'float';
  dimensions: 1536;
}>;

export type StoredEmbeddingsHttpIdentity = Readonly<{
  contractVersion: 1;
  routeKind: 'embeddings';
  billingMode: 'stored';
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  requestedMode: StoredEmbeddingsMode | null;
  declaredSessionId: string | null;
  attemptBody: StoredEmbeddingsHttpAttemptBody;
}>;

function badRequest(): never {
  throw new TypeError(STORED_EMBEDDINGS_HTTP_IDENTITY_BAD_REQUEST_CODE);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[^A-Za-z0-9._:-]/.test(value)
  ) badRequest();
  return value;
}

function parseRequestedMode(value: unknown): StoredEmbeddingsMode {
  if (!['auto', 'fastest', 'cheapest', 'balanced', 'ru-only'].includes(value as string))
    badRequest();
  return value as StoredEmbeddingsMode;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function parseInput(value: unknown): readonly string[] {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length < 1 || values.length > 16)
    badRequest();
  const copy = values.map((input) => {
    if (
      typeof input !== 'string' ||
      input.length === 0 ||
      !wellFormed(input) ||
      Buffer.byteLength(input, 'utf8') > 8192
    ) badRequest();
    return input;
  });
  return Object.freeze(copy);
}

/** Exact v1 bytes are compact JSON for the controller-approved ordered tuple. */
export function canonicalStoredEmbeddingsHttpIdentityV1(args: Readonly<{
  model: string;
  requestedMode: StoredEmbeddingsMode | null;
  declaredSessionId: string | null;
  input: readonly string[];
}>): string {
  return JSON.stringify([
    1,
    'embeddings',
    'stored',
    args.model,
    args.requestedMode,
    args.declaredSessionId,
    [...args.input],
    'float',
    1536,
  ]);
}

export function normalizeStoredEmbeddingsBodyV1(body: unknown): Readonly<{
  requestedMode: StoredEmbeddingsMode | null;
  attemptBody: StoredEmbeddingsHttpAttemptBody;
}> {
  try {
    const detached = parseAdmissionJsonObject(body);
    const allowed = ['model', 'input', 'encoding_format', 'dimensions', 'aiag_mode'];
    if (Object.keys(detached).some((key) => !allowed.includes(key))) badRequest();
    if (
      typeof detached.model !== 'string' ||
      detached.model.length < 1 ||
      detached.model.length > 256 ||
      !/^[A-Za-z0-9_./:@+-]+$/.test(detached.model)
    ) badRequest();
    if (Object.hasOwn(detached, 'encoding_format') && detached.encoding_format !== 'float')
      badRequest();
    if (Object.hasOwn(detached, 'dimensions') && detached.dimensions !== 1536)
      badRequest();
    const requestedMode = Object.hasOwn(detached, 'aiag_mode')
      ? parseRequestedMode(detached.aiag_mode)
      : null;
    const input = parseInput(detached.input);
    return Object.freeze({
      requestedMode,
      attemptBody: Object.freeze({
        model: detached.model,
        input,
        encoding_format: 'float',
        dimensions: 1536,
      }),
    });
  } catch {
    return badRequest();
  }
}

export function captureStoredEmbeddingsHttpIdentity(args: Readonly<{
  body: unknown;
  idempotencyKey: unknown;
  declaredSessionId: unknown;
}>): StoredEmbeddingsHttpIdentity {
  try {
    const normalized = normalizeStoredEmbeddingsBodyV1(args.body);
    const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
    const canonical = canonicalStoredEmbeddingsHttpIdentityV1({
      model: normalized.attemptBody.model,
      requestedMode: normalized.requestedMode,
      declaredSessionId,
      input: normalized.attemptBody.input,
    });
    return Object.freeze({
      contractVersion: 1,
      routeKind: 'embeddings',
      billingMode: 'stored',
      idempotencyKeyDigest: sha256(parseIdempotencyKey(args.idempotencyKey)),
      requestFingerprint: sha256(canonical),
      requestedMode: normalized.requestedMode,
      declaredSessionId,
      attemptBody: normalized.attemptBody,
    });
  } catch {
    return badRequest();
  }
}
