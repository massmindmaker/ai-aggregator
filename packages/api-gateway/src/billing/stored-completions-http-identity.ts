import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseAdmissionJsonObject } from './admission-result';
import { parseStoredChatBody } from './stored-chat-attempt-contract';

export const STORED_COMPLETIONS_HTTP_IDENTITY_BAD_REQUEST_CODE =
  'INVALID_STORED_COMPLETIONS_HTTP_IDENTITY' as const;

type StoredCompletionsMode =
  | 'auto'
  | 'fastest'
  | 'cheapest'
  | 'balanced'
  | 'ru-only';

export type StoredCompletionsHttpAttemptBody = Readonly<{
  model: string;
  messages: readonly [Readonly<{ role: 'user'; content: string }>];
  stream: false;
  max_tokens?: number;
}>;

export type StoredCompletionsHttpIdentity = Readonly<{
  contractVersion: 1;
  routeKind: 'completions';
  billingMode: 'stored';
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  requestedMode: StoredCompletionsMode | null;
  declaredSessionId: string | null;
  attemptBody: StoredCompletionsHttpAttemptBody;
}>;

function badRequest(): never {
  throw new TypeError(STORED_COMPLETIONS_HTTP_IDENTITY_BAD_REQUEST_CODE);
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
  )
    badRequest();
  return value;
}

function parseRequestedMode(value: unknown): StoredCompletionsMode {
  if (
    value !== 'auto' &&
    value !== 'fastest' &&
    value !== 'cheapest' &&
    value !== 'balanced' &&
    value !== 'ru-only'
  )
    badRequest();
  return value;
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

/** Exact v1 bytes are compact JSON for the controller-approved ordered tuple. */
export function canonicalStoredCompletionsHttpIdentityV1(args: Readonly<{
  model: string;
  requestedMode: StoredCompletionsMode | null;
  declaredSessionId: string | null;
  prompt: string;
  maxTokens: number | undefined;
}>): string {
  return JSON.stringify([
    1,
    'completions',
    'stored',
    args.model,
    args.requestedMode,
    args.declaredSessionId,
    args.prompt,
    args.maxTokens === undefined ? ['absent'] : ['present', args.maxTokens],
    false,
  ]);
}

export function normalizeStoredCompletionsBodyV1(body: unknown): Readonly<{
  requestedMode: StoredCompletionsMode | null;
  attemptBody: StoredCompletionsHttpAttemptBody;
}> {
  try {
    const detached = parseAdmissionJsonObject(body);
    const allowed = ['model', 'prompt', 'max_tokens', 'stream', 'aiag_mode'];
    if (Object.keys(detached).some((key) => !allowed.includes(key))) badRequest();
    if (
      typeof detached.prompt !== 'string' ||
      detached.prompt.length === 0 ||
      !wellFormed(detached.prompt)
    )
      badRequest();
    if (Object.hasOwn(detached, 'stream') && detached.stream !== false)
      badRequest();
    const requestedMode = Object.hasOwn(detached, 'aiag_mode')
      ? parseRequestedMode(detached.aiag_mode)
      : null;
    const prompt = detached.prompt;
    const supported = {
      model: detached.model,
      messages: [{ role: 'user' as const, content: prompt }],
      stream: false as const,
      ...(Object.hasOwn(detached, 'max_tokens')
        ? { max_tokens: detached.max_tokens }
        : {}),
    };
    const parsed = parseStoredChatBody(supported, detached.model as string);
    const messages = Object.freeze([
      Object.freeze({ role: 'user' as const, content: prompt }),
    ]) as StoredCompletionsHttpAttemptBody['messages'];
    return Object.freeze({
      requestedMode,
      attemptBody: Object.freeze({
        model: parsed.modelSlug,
        messages,
        stream: false as const,
        ...(parsed.maxTokens === undefined ? {} : { max_tokens: parsed.maxTokens }),
      }),
    });
  } catch {
    return badRequest();
  }
}

export function captureStoredCompletionsHttpIdentity(args: Readonly<{
  body: unknown;
  idempotencyKey: unknown;
  declaredSessionId: unknown;
}>): StoredCompletionsHttpIdentity {
  try {
    const normalized = normalizeStoredCompletionsBodyV1(args.body);
    const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
    const prompt = normalized.attemptBody.messages[0].content;
    const canonical = canonicalStoredCompletionsHttpIdentityV1({
      model: normalized.attemptBody.model,
      requestedMode: normalized.requestedMode,
      declaredSessionId,
      prompt,
      maxTokens: normalized.attemptBody.max_tokens,
    });
    return Object.freeze({
      contractVersion: 1,
      routeKind: 'completions',
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
