import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseAdmissionJsonObject } from './admission-result';
import { parseStoredChatBody } from './stored-chat-attempt-contract';

export const STORED_CHAT_HTTP_IDENTITY_BAD_REQUEST_CODE =
  'INVALID_STORED_CHAT_HTTP_IDENTITY' as const;

type StoredChatMode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';
type StoredChatMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;

export type StoredChatHttpAttemptBody = Readonly<{
  model: string;
  messages: readonly StoredChatMessage[];
  stream: false | true;
  max_tokens?: number;
}>;

export type StoredChatHttpIdentity = Readonly<{
  contractVersion: 1 | 2;
  routeKind: 'chat';
  billingMode: 'stored';
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  requestedMode: StoredChatMode | null;
  declaredSessionId: string | null;
  attemptBody: StoredChatHttpAttemptBody;
}>;

function badRequest(): never {
  throw new TypeError(STORED_CHAT_HTTP_IDENTITY_BAD_REQUEST_CODE);
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

function parseRequestedMode(value: unknown): StoredChatMode {
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

function parseBody(body: unknown): Readonly<{
  requestedMode: StoredChatMode | null;
  attemptBody: StoredChatHttpAttemptBody;
  canonical: Parameters<typeof canonicalStoredChatHttpIdentityV1>[0];
}> {
  const detached = parseAdmissionJsonObject(body);
  const hasMode = Object.hasOwn(detached, 'aiag_mode');
  const requestedMode = hasMode
    ? parseRequestedMode(detached.aiag_mode)
    : null;
  const supportedBody = Object.fromEntries(
    Object.entries(detached).filter(([key]) => key !== 'aiag_mode'),
  );
  if (typeof supportedBody.model !== 'string') badRequest();
  const stream = supportedBody.stream === true;
  // The v1 parser deliberately accepts only non-streaming bodies. Streaming
  // keeps the same strict shape, with the one explicit mode bit enabled.
  const parsed = parseStoredChatBody(
    stream ? { ...supportedBody, stream: false } : supportedBody,
    supportedBody.model,
  );
  if (stream && parsed.maxTokens !== undefined && parsed.maxTokens > 2048)
    badRequest();
  const messages = Object.freeze(
    parsed.messages.map((message) =>
      Object.freeze({ role: message.role, content: message.content }),
    ),
  );
  const attemptBody = Object.freeze({
    model: parsed.modelSlug,
    messages,
    stream: stream as false | true,
    ...(parsed.maxTokens === undefined ? {} : { max_tokens: parsed.maxTokens }),
  });
  return Object.freeze({
    requestedMode,
    attemptBody,
    canonical: Object.freeze({
      model: parsed.modelSlug,
      requestedMode,
      declaredSessionId: null,
      messages,
      maxTokens: parsed.maxTokens,
      stream,
    }),
  });
}

/**
 * Exact v1 bytes are compact JSON for this ordered tuple:
 * [1,"chat","stored",model,requestedModeOrNull,declaredSessionIdOrNull,
 *  [[role,content], ...], ["absent"]|["present",maxTokens], false]
 */
export function canonicalStoredChatHttpIdentityV1(args: Readonly<{
  model: string;
  requestedMode: StoredChatMode | null;
  declaredSessionId: string | null;
  messages: readonly StoredChatMessage[];
  maxTokens: number | undefined;
  stream?: boolean;
}>): string {
  return JSON.stringify([
    1,
    'chat',
    'stored',
    args.model,
    args.requestedMode,
    args.declaredSessionId,
    args.messages.map((message) => [message.role, message.content]),
    args.maxTokens === undefined ? ['absent'] : ['present', args.maxTokens],
    args.stream === true,
  ]);
}

export function captureStoredChatHttpIdentity(args: Readonly<{
  body: unknown;
  idempotencyKey: unknown;
  declaredSessionId: unknown;
}>): StoredChatHttpIdentity {
  try {
    const idempotencyKey = parseIdempotencyKey(args.idempotencyKey);
    const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
    const body = parseBody(args.body);
    const canonical = canonicalStoredChatHttpIdentityV1({
      ...body.canonical,
      declaredSessionId,
      stream: body.attemptBody.stream,
    });
    return Object.freeze({
      contractVersion: body.attemptBody.stream ? 2 : 1,
      routeKind: 'chat',
      billingMode: 'stored',
      idempotencyKeyDigest: sha256(idempotencyKey),
      requestFingerprint: sha256(canonical),
      requestedMode: body.requestedMode,
      declaredSessionId,
      attemptBody: body.attemptBody,
    });
  } catch {
    return badRequest();
  }
}
