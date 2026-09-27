import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseAdmissionJsonObject } from './admission-result';
import {
  normalizeStoredChatBodyV1,
  type StoredChatHttpAttemptBody,
} from './stored-chat-http-identity';
import {
  normalizeStoredEmbeddingsBodyV1,
  type StoredEmbeddingsHttpAttemptBody,
} from './stored-embeddings-http-identity';
import {
  normalizeStoredCompletionsBodyV1,
  type StoredCompletionsHttpAttemptBody,
} from './stored-completions-http-identity';

export const STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE =
  'INVALID_STORED_BATCH_HTTP_IDENTITY' as const;

export type StoredBatchType = 'chat' | 'embeddings' | 'completions';
export type StoredBatchRouteKind = StoredBatchType;
type StoredBatchMode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';
export type StoredBatchAttemptBody =
  | StoredChatHttpAttemptBody
  | StoredEmbeddingsHttpAttemptBody
  | StoredCompletionsHttpAttemptBody;

export type StoredBatchItemIdentity = Readonly<{
  index: number;
  customId: string;
  routeKind: StoredBatchRouteKind;
  requestedMode: StoredBatchMode | null;
  requestFingerprint: string;
  attemptBody: StoredBatchAttemptBody;
}>;

export type StoredBatchHttpIdentity = Readonly<{
  contractVersion: 5;
  routeKind: 'batch';
  billingMode: 'stored';
  batchType: StoredBatchType;
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  declaredSessionId: string | null;
  items: readonly StoredBatchItemIdentity[];
}>;

function badRequest(): never {
  throw new TypeError(STORED_BATCH_HTTP_IDENTITY_BAD_REQUEST_CODE);
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

function parseCustomId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[^A-Za-z0-9._:-]/.test(value)
  ) badRequest();
  return value;
}

function parseType(value: unknown): StoredBatchType {
  if (value !== 'chat' && value !== 'embeddings' && value !== 'completions')
    badRequest();
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  ) badRequest();
}

function normalizeItem(
  type: StoredBatchType,
  body: unknown,
): Readonly<{
  requestedMode: StoredBatchMode | null;
  attemptBody: StoredBatchAttemptBody;
}> {
  if (type === 'chat') {
    const normalized = normalizeStoredChatBodyV1(body);
    if (normalized.attemptBody.stream) badRequest();
    return normalized;
  }
  if (type === 'embeddings') return normalizeStoredEmbeddingsBodyV1(body);
  return normalizeStoredCompletionsBodyV1(body);
}

export function captureStoredBatchHttpIdentity(args: Readonly<{
  body: unknown;
  idempotencyKey: unknown;
  declaredSessionId: unknown;
  byokKeyPresent: boolean;
}>): StoredBatchHttpIdentity {
  try {
    if (args.byokKeyPresent !== false) badRequest();
    const detached = parseAdmissionJsonObject(args.body);
    exactKeys(detached, ['type', 'requests']);
    const batchType = parseType(detached.type);
    if (!Array.isArray(detached.requests) || detached.requests.length < 1 || detached.requests.length > 100)
      badRequest();

    const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
    const seen = new Set<string>();
    const canonicalItems: unknown[] = [];
    const items = detached.requests.map((rawItem, index) => {
      const item = parseAdmissionJsonObject(rawItem, 'batch_item');
      exactKeys(item, ['custom_id', 'body']);
      const customId = parseCustomId(item.custom_id);
      if (seen.has(customId)) badRequest();
      seen.add(customId);
      const normalized = normalizeItem(batchType, item.body);
      const itemCanonical = [
        5,
        'batch-item',
        'stored',
        batchType,
        declaredSessionId,
        index,
        customId,
        normalized.requestedMode,
        normalized.attemptBody,
      ] as const;
      canonicalItems.push(itemCanonical);
      return Object.freeze({
        index,
        customId,
        routeKind: batchType,
        requestedMode: normalized.requestedMode,
        requestFingerprint: sha256(JSON.stringify(itemCanonical)),
        attemptBody: normalized.attemptBody,
      });
    });

    const canonical = JSON.stringify([
      5,
      'batch',
      'stored',
      batchType,
      declaredSessionId,
      canonicalItems,
    ]);
    return Object.freeze({
      contractVersion: 5,
      routeKind: 'batch',
      billingMode: 'stored',
      batchType,
      idempotencyKeyDigest: sha256(parseIdempotencyKey(args.idempotencyKey)),
      requestFingerprint: sha256(canonical),
      declaredSessionId,
      items: Object.freeze(items),
    });
  } catch {
    return badRequest();
  }
}
