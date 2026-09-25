import { captureDeclaredSessionId } from './admission-internal';
import type { HttpRejectionCode } from './http-terminal-recovery';
import { z } from 'zod';
import {
  normalizeAdmissionTimestamp,
  normalizeAdmissionUuid,
  parseAdmissionJsonObject,
  type GatewayChargeAdmissionResult,
  type GatewayChargeAdmissionState,
  type JsonObject,
} from './admission-result';
import type { FrozenChatCandidate } from './candidate-quote';
import { calculateTokenCharge } from './token-quote';
import type {
  AdmittedChatResponse,
  AdmittedChatUsage,
} from '../upstreams/interface';

export const STORED_CHAT_FORMULA =
  'db-input-output-cents-per-1k-legacy-whole-cache-v1';
const bodySchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    stream: z.literal(false).optional(),
    max_tokens: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

/** Only this unused contract is strict; mounted legacy request shapes are untouched. */
export function parseStoredChatBody(body: unknown, modelSlug: string) {
  // Reject prototypes/accessors and detach before parsing, without invoking client getters.
  const parsed = bodySchema.parse(parseAdmissionJsonObject(body));
  if (parsed.model !== modelSlug)
    throw new TypeError('Invalid stored chat model');
  return Object.freeze({
    modelSlug: parsed.model,
    messages: Object.freeze(
      parsed.messages.map((message) => Object.freeze(message)),
    ),
    maxTokens: parsed.max_tokens,
  });
}

export function parseStoredChatStreamBody(body: unknown, modelSlug: string) {
  const parsed = bodySchema.extend({ stream: z.literal(true) }).parse(parseAdmissionJsonObject(body));
  if (parsed.model !== modelSlug || (parsed.max_tokens !== undefined && parsed.max_tokens > 2048)) throw new TypeError('Invalid stored chat stream');
  return Object.freeze({ modelSlug: parsed.model, messages: Object.freeze(parsed.messages.map((message) => Object.freeze(message))), maxTokens: parsed.max_tokens });
}

export function validateStoredChatIdentity(
  args: Readonly<{
    orgId: string;
    apiKeyId: string;
    clientRequestId: string | null;
    declaredSessionId: string | null;
    preDispatchDeadlineAt: string;
    cachingDiscount: string;
  }>,
) {
  const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
  const orgId = normalizeAdmissionUuid(args.orgId);
  const apiKeyId = normalizeAdmissionUuid(args.apiKeyId);
  const clientRequestId = args.clientRequestId;
  if (
    clientRequestId !== null &&
    (typeof clientRequestId !== 'string' ||
      clientRequestId.trim() === '' ||
      clientRequestId.length > 255)
  ) {
    throw new TypeError('Invalid stored chat trace');
  }
  const preDispatchDeadlineAt = normalizeAdmissionTimestamp(
    args.preDispatchDeadlineAt,
  );
  const cachingDiscount = args.cachingDiscount;
  // Reuse the exact decimal parser/range contract; never recover a tariff from a float.
  calculateTokenCharge(
    { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' },
    { promptTokens: 0, completionTokens: 0, cachedInputTokens: 0 },
    cachingDiscount,
  );
  return Object.freeze({
    orgId,
    apiKeyId,
    clientRequestId,
    declaredSessionId,
    preDispatchDeadlineAt,
    cachingDiscount,
  });
}

export type StoredChatAttemptStage =
  | 'pre_admit_terminal'
  | 'admit'
  | 'dispatch'
  | 'provider'
  | 'usage'
  | 'outcome'
  | 'settle'
  | 'cancel';
export type StoredChatAttemptResult =
  | Readonly<{
      kind: 'settled_success';
      billingRequestId: string;
      actualCostCredits: bigint;
      response: AdmittedChatResponse;
      admission: GatewayChargeAdmissionResult;
    }>
  | Readonly<{ kind: 'cancelled_no_charge'; billingRequestId: string }>
  | Readonly<{ kind: 'not_started'; billingRequestId: string }>
  | Readonly<{
      kind: 'replay';
      billingRequestId: string;
      state: GatewayChargeAdmissionState;
    }>
  | Readonly<{
      kind: 'rejected';
      billingRequestId: string;
      code: HttpRejectionCode;
    }>
  | Readonly<{
      kind: 'reconciliation_required';
      billingRequestId: string;
      stage: StoredChatAttemptStage;
      lastConfirmedState: GatewayChargeAdmissionState | null;
    }>;
export type StoredChatAttemptPreparation =
  | Readonly<{ status: 'bad_request'; code: 'INVALID_STORED_CHAT_REQUEST' }>
  | Readonly<{ status: 'unavailable'; code: 'STORED_CHAT_UNAVAILABLE' }>
  | Readonly<{
      status: 'ready';
      billingRequestId: string;
      run(): Promise<StoredChatAttemptResult>;
    }>;

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid usage count');
  return value;
}

/** Adapter owns its public DTO schema; this boundary adds financial bounds and freezes evidence. */
export function captureStoredChatEvidence(
  output: Readonly<{
    response: AdmittedChatResponse;
    usage: AdmittedChatUsage;
  }>,
  chosen: FrozenChatCandidate,
  cachingDiscount: string,
  billingRequestId: string,
  attemptId: string,
): Readonly<{
  response: AdmittedChatResponse;
  usageSnapshot: JsonObject;
  actualCostCredits: bigint;
}> {
  const detached = parseAdmissionJsonObject(output);
  const usage = detached.usage as JsonObject;
  const response = detached.response as JsonObject;
  const publicUsage = response.usage as JsonObject;
  const promptTokens = count(usage.promptTokens),
    completionTokens = count(usage.completionTokens);
  const totalTokens = count(usage.totalTokens),
    cachedInputTokens = count(usage.cachedInputTokens);
  if (
    !Number.isSafeInteger(promptTokens + completionTokens) ||
    totalTokens !== promptTokens + completionTokens ||
    cachedInputTokens > promptTokens ||
    completionTokens > chosen.maxOutputTokens ||
    totalTokens > chosen.profile.contextWindowTokens ||
    publicUsage.prompt_tokens !== promptTokens ||
    publicUsage.completion_tokens !== completionTokens ||
    publicUsage.total_tokens !== totalTokens ||
    (publicUsage.cached_input_tokens !== undefined &&
      publicUsage.cached_input_tokens !== cachedInputTokens)
  ) {
    throw new TypeError('Inconsistent or unbounded completion usage');
  }
  if (
    typeof response.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(response.id) ||
    typeof response.model !== 'string' ||
    !/^[A-Za-z0-9_./:@+-]{1,256}$/.test(response.model)
  )
    throw new TypeError('Invalid completion metadata');
  const actualCostCredits = calculateTokenCharge(
    chosen.billing.prices,
    { promptTokens, completionTokens, cachedInputTokens },
    cachingDiscount,
  );
  if (actualCostCredits < 0n || actualCostCredits > chosen.maxCredits)
    throw new RangeError('Actual exceeds chosen maximum');
  const usageSnapshot = parseAdmissionJsonObject({
    version: 1,
    usageContract: chosen.profile.adapterContract,
    billingRequestId,
    attemptId,
    upstreamId: chosen.upstreamId,
    upstreamModelId: chosen.upstreamModelId,
    adapterKey: chosen.adapterKey,
    modelSlug: chosen.modelSlug,
    modelUpstreamId: chosen.billing.modelUpstreamId,
    profileId: chosen.profile.profileId,
    profileRevision: chosen.profile.revision,
    completionId: response.id,
    reportedModel: response.model,
    usage: { promptTokens, completionTokens, totalTokens, cachedInputTokens },
    formulaVersion: STORED_CHAT_FORMULA,
  });
  return Object.freeze({
    response: response as unknown as AdmittedChatResponse,
    usageSnapshot,
    actualCostCredits,
  });
}
