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
import type { FrozenEmbeddingCandidate } from './embedding-candidate-quote';
import { calculateTokenCharge } from './token-quote';
import type {
  AdmittedEmbeddingsResponse,
  AdmittedEmbeddingsUsage,
} from '../upstreams/interface';

export const STORED_EMBEDDINGS_FORMULA =
  'db-input-output-cents-per-1k-legacy-whole-cache-v1' as const;
export const STORED_EMBEDDINGS_RESPONSE_LIMIT_BYTES = 1_048_576;

const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const input = z
  .string()
  .min(1)
  .refine(wellFormed)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 8192);
const bodySchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union([input, z.array(input).min(1).max(16)]),
    encoding_format: z.literal('float').optional(),
    dimensions: z.literal(1536).optional(),
  })
  .strict();

/** Strict second boundary after HTTP identity normalization. */
export function parseStoredEmbeddingsBody(body: unknown, modelSlug: string) {
  const parsed = bodySchema.parse(parseAdmissionJsonObject(body));
  if (parsed.model !== modelSlug)
    throw new TypeError('Invalid stored embeddings model');
  const inputs = typeof parsed.input === 'string' ? [parsed.input] : parsed.input;
  return Object.freeze({
    modelSlug: parsed.model,
    input: Object.freeze([...inputs]),
    encodingFormat: 'float' as const,
    dimensions: 1536 as const,
  });
}

export function validateStoredEmbeddingsIdentity(
  args: Readonly<{
    orgId: string;
    apiKeyId: string;
    clientRequestId: string | null;
    declaredSessionId: string | null;
    preDispatchDeadlineAt: string;
  }>,
) {
  const declaredSessionId = captureDeclaredSessionId(args.declaredSessionId);
  const orgId = normalizeAdmissionUuid(args.orgId);
  const apiKeyId = normalizeAdmissionUuid(args.apiKeyId);
  if (
    args.clientRequestId !== null &&
    (typeof args.clientRequestId !== 'string' ||
      args.clientRequestId.trim() === '' ||
      args.clientRequestId.length > 255)
  )
    throw new TypeError('Invalid stored embeddings trace');
  const preDispatchDeadlineAt = normalizeAdmissionTimestamp(
    args.preDispatchDeadlineAt,
  );
  calculateTokenCharge(
    { inputCentsPer1k: '0', outputCentsPer1k: '0', markup: '1' },
    { promptTokens: 0, completionTokens: 0, cachedInputTokens: 0 },
    '1',
  );
  return Object.freeze({
    orgId,
    apiKeyId,
    clientRequestId: args.clientRequestId,
    declaredSessionId,
    preDispatchDeadlineAt,
  });
}

export type StoredEmbeddingsAttemptStage =
  | 'pre_admit_terminal'
  | 'admit'
  | 'dispatch'
  | 'provider'
  | 'usage'
  | 'outcome'
  | 'settle'
  | 'cancel';
export type StoredEmbeddingsAttemptResult =
  | Readonly<{
      kind: 'settled_success';
      billingRequestId: string;
      actualCostCredits: bigint;
      response: AdmittedEmbeddingsResponse;
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
      stage: StoredEmbeddingsAttemptStage;
      lastConfirmedState: GatewayChargeAdmissionState | null;
    }>;
export type StoredEmbeddingsAttemptPreparation =
  | Readonly<{
      status: 'bad_request';
      code: 'INVALID_STORED_EMBEDDINGS_REQUEST';
    }>
  | Readonly<{
      status: 'unavailable';
      code: 'STORED_EMBEDDINGS_UNAVAILABLE';
    }>
  | Readonly<{
      status: 'ready';
      billingRequestId: string;
      run(): Promise<StoredEmbeddingsAttemptResult>;
    }>;

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid usage count');
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError('Invalid embeddings evidence shape');
}

/** Revalidates financial evidence independently from the transport parser. */
export function captureStoredEmbeddingsEvidence(
  output: Readonly<{
    response: AdmittedEmbeddingsResponse;
    usage: AdmittedEmbeddingsUsage;
  }>,
  chosen: FrozenEmbeddingCandidate,
  billingRequestId: string,
  attemptId: string,
): Readonly<{
  response: AdmittedEmbeddingsResponse;
  usageSnapshot: JsonObject;
  actualCostCredits: bigint;
}> {
  const detached = parseAdmissionJsonObject(output);
  exactKeys(detached, ['response', 'usage']);
  const usage = detached.usage as JsonObject;
  const response = detached.response as JsonObject;
  exactKeys(usage, ['promptTokens', 'totalTokens', 'providerResponseId']);
  exactKeys(response, ['object', 'model', 'data', 'usage']);

  const promptTokens = count(usage.promptTokens);
  const totalTokens = count(usage.totalTokens);
  const providerResponseId = usage.providerResponseId;
  if (
    totalTokens !== promptTokens ||
    promptTokens > chosen.profile.contextWindowTokens * chosen.inputCount ||
    (providerResponseId !== null &&
      (typeof providerResponseId !== 'string' ||
        providerResponseId.length < 1 ||
        providerResponseId.length > 256 ||
        !wellFormed(providerResponseId))) ||
    response.object !== 'list' ||
    response.model !== chosen.upstreamModelId ||
    !Array.isArray(response.data) ||
    response.data.length !== chosen.inputCount
  )
    throw new TypeError('Inconsistent or unbounded embeddings evidence');

  const publicUsage = response.usage as JsonObject;
  exactKeys(publicUsage, ['prompt_tokens', 'total_tokens']);
  if (
    publicUsage.prompt_tokens !== promptTokens ||
    publicUsage.total_tokens !== totalTokens
  )
    throw new TypeError('Inconsistent public embeddings usage');

  for (let index = 0; index < response.data.length; index += 1) {
    const item = response.data[index] as JsonObject;
    exactKeys(item, ['object', 'index', 'embedding']);
    if (
      item.object !== 'embedding' ||
      item.index !== index ||
      !Array.isArray(item.embedding) ||
      item.embedding.length !== chosen.dimensions ||
      item.embedding.some(
        (component) =>
          typeof component !== 'number' || !Number.isFinite(component),
      )
    )
      throw new TypeError('Invalid embeddings vector');
  }
  if (
    Buffer.byteLength(JSON.stringify(response), 'utf8') >
    STORED_EMBEDDINGS_RESPONSE_LIMIT_BYTES
  )
    throw new RangeError('Embeddings response exceeds storage limit');

  const actualCostCredits = calculateTokenCharge(
    chosen.billing.prices,
    { promptTokens, completionTokens: 0, cachedInputTokens: 0 },
    '1',
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
    providerResponseId,
    reportedModel: response.model,
    inputCount: chosen.inputCount,
    dimensions: chosen.dimensions,
    encodingFormat: chosen.encodingFormat,
    usage: {
      promptTokens,
      completionTokens: 0,
      totalTokens,
      cachedInputTokens: 0,
    },
    formulaVersion: STORED_EMBEDDINGS_FORMULA,
  });
  return Object.freeze({
    response: response as unknown as AdmittedEmbeddingsResponse,
    usageSnapshot,
    actualCostCredits,
  });
}
