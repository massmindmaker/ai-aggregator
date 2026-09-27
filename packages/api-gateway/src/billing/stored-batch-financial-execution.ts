import { createHash } from 'node:crypto';
import {
  admissionJsonObjectsEqual,
  parseAdmissionBigint,
  parseAdmissionJsonObject,
  type GatewayChargeAdmissionResult,
  type JsonObject,
} from './admission-result';
import {
  AdmissionDeadlineExpiredError,
  cancelUndispatchedGatewayCharge,
  markGatewayChargeDispatched,
  settleAdmittedGatewayCharge,
} from './admission';
import { recordGatewayChargeOutcomeV2 } from './quota-admission';
import { findReviewedChatProfile } from './reviewed-token-profiles';
import { findReviewedEmbeddingProfile } from './reviewed-embedding-profiles';
import { parseCandidateBillingFacts } from '../routing/engine';
import { captureStoredChatEvidence, STORED_CHAT_FORMULA } from './stored-chat-attempt-contract';
import { captureStoredEmbeddingsEvidence, STORED_EMBEDDINGS_FORMULA } from './stored-embeddings-attempt-contract';
import { parseStoredHttpChatResponse, projectStoredHttpCompletionResponse } from './http-storage-result';
import type { FrozenChatCandidate } from './candidate-quote';
import type { FrozenEmbeddingCandidate } from './embedding-candidate-quote';
import { recordStoredBatchPendingEvidence, type StoredBatchWorkerItem } from './stored-batch-storage';
import type { StoredBatchRuntimePreparation } from '../batch-runtime';
import type {
  AdmittedChatMechanics,
  AdmittedChatRequest,
  AdmittedEmbeddingsMechanics,
  AdmittedEmbeddingsRequest,
} from '../upstreams/interface';

export type BatchFinancialOutcome =
  | Readonly<{ kind: 'settled_success'; output: JsonObject; resultDigest: string; settledAt: string }>
  | Readonly<{ kind: 'cancelled_no_charge'; errorCode: string }>
  | Readonly<{ kind: 'retry_later'; retryAt: string }>
  | Readonly<{ kind: 'reconciliation_required'; errorCode: string }>;

export type StoredBatchFinancialDependencies = Readonly<{
  markGatewayChargeDispatched: typeof markGatewayChargeDispatched;
  recordStoredBatchPendingEvidence: typeof recordStoredBatchPendingEvidence;
  recordGatewayChargeOutcomeV2: typeof recordGatewayChargeOutcomeV2;
  settleAdmittedGatewayCharge: typeof settleAdmittedGatewayCharge;
  cancelUndispatchedGatewayCharge: typeof cancelUndispatchedGatewayCharge;
  now: () => Date;
}>;

const UNKNOWN = (errorCode: string): BatchFinancialOutcome =>
  Object.freeze({ kind: 'reconciliation_required', errorCode });

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameObject(left: unknown, right: unknown): boolean {
  if (!object(left) || !object(right)) return false;
  try {
    return admissionJsonObjectsEqual(parseAdmissionJsonObject(left), parseAdmissionJsonObject(right));
  } catch {
    return false;
  }
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}
function resultDigest(value: JsonObject): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertHeldIdentity(item: StoredBatchWorkerItem): void {
  const admission = item.admission;
  if (
    item.status !== 'processing' || admission.state !== 'held' ||
    admission.billingRequestId !== item.billingRequestId ||
    admission.routeKind !== item.routeKind || admission.billingMode !== 'stored' ||
    admission.modelSlug !== item.modelSlug ||
    admission.preDispatchDeadlineAt !== item.deadlineAt ||
    admission.attemptId !== null || admission.upstreamId !== null ||
    admission.pricingSnapshot !== null
  ) throw new Error('Unconfirmed held batch admission');
}

type FrozenEvidence =
  | Readonly<{ kind: 'chat'; candidate: FrozenChatCandidate; discount: string }>
  | Readonly<{ kind: 'embeddings'; candidate: FrozenEmbeddingCandidate }>;

/** All price and request facts are checked before a provider can be dispatched. */
function freezeEvidence(item: StoredBatchWorkerItem): FrozenEvidence {
  const snapshot = item.pricingSnapshot;
  const quote = item.admission.quoteSnapshot;
  const tokenQuote = quote.tokenQuote;
  const policy = snapshot.actualChargePolicy;
  if (!object(tokenQuote) || !Array.isArray(tokenQuote.candidates) ||
      !object(tokenQuote.candidates[0]) || !object(policy))
    throw new Error('Missing pinned quote');
  const { actualChargePolicy: _policy, ...chosen } = snapshot;
  if (!sameObject(chosen, tokenQuote.candidates[0]) ||
      !sameObject(policy, quote.actualChargePolicy) ||
      tokenQuote.authorizedMaxCredits !== item.admission.authorizedMaxCredits.toString())
    throw new Error('Pinned quote drift');
  if (
    snapshot.modelSlug !== item.modelSlug || snapshot.upstreamId !== item.upstreamId ||
    snapshot.upstreamModelId !== item.upstreamModelId || snapshot.adapterKey !== item.adapterKey ||
    snapshot.modelUpstreamId !== item.modelUpstreamId ||
    item.providerRequest.modelId !== item.upstreamModelId ||
    Object.hasOwn(item.providerRequest, 'byokKey') || Object.hasOwn(item.providerRequest, 'egressProxyUrl') ||
    !sameObject(item.providerRequest.endpointPolicy, snapshot.endpointPolicy)
  ) throw new Error('Pinned request drift');
  const billing = parseCandidateBillingFacts({ modelUpstreamId: item.modelUpstreamId, prices: snapshot.prices });
  const maxCredits = parseAdmissionBigint(snapshot.maxCredits, 'batch_max_credits', false);
  if (!billing || maxCredits > item.admission.authorizedMaxCredits ||
      !positive(snapshot.contextWindowTokens) || !positive(snapshot.profileRevision) ||
      typeof snapshot.profileId !== 'string' || !snapshot.profileId)
    throw new Error('Invalid pinned price');

  if (item.routeKind === 'embeddings') {
    const profile = findReviewedEmbeddingProfile({
      modelSlug: item.modelSlug, modelType: 'embedding', upstreamId: item.upstreamId,
      upstreamModelId: item.upstreamModelId, adapterKey: item.adapterKey,
    });
    if (!profile || snapshot.modelType !== 'embedding' ||
        profile.profileId !== snapshot.profileId || profile.revision !== snapshot.profileRevision ||
        profile.adapterContract !== snapshot.adapterContract ||
        profile.contextWindowTokens !== snapshot.contextWindowTokens ||
        !sameObject(profile.endpointPolicy, snapshot.endpointPolicy) ||
        snapshot.dimensions !== profile.dimensions || snapshot.encodingFormat !== 'float' ||
        !positive(snapshot.inputCount) || snapshot.inputCount > profile.maxInputs ||
        !Array.isArray(item.providerRequest.input) ||
        item.providerRequest.input.length !== snapshot.inputCount ||
        policy.formulaVersion !== STORED_EMBEDDINGS_FORMULA || policy.cachingDiscount !== '1')
      throw new Error('Unreviewed embedding profile');
    const candidate: FrozenEmbeddingCandidate = Object.freeze({
      modelSlug: item.modelSlug, modelType: 'embedding', upstreamId: item.upstreamId,
      upstreamModelId: item.upstreamModelId, adapterKey: item.adapterKey,
      provider: 'pinned', ruResidency: false, priority: undefined, egressProxyUrl: null,
      profile, billing, inputCount: snapshot.inputCount,
      dimensions: 1536, encodingFormat: 'float', maxCredits,
    });
    return Object.freeze({ kind: 'embeddings', candidate });
  }

  const profile = findReviewedChatProfile({
    modelSlug: item.modelSlug, modelType: 'chat', upstreamId: item.upstreamId,
    upstreamModelId: item.upstreamModelId, adapterKey: item.adapterKey,
  });
  if (!profile || snapshot.modelType !== 'chat' ||
      profile.profileId !== snapshot.profileId || profile.revision !== snapshot.profileRevision ||
      profile.adapterContract !== snapshot.adapterContract ||
      profile.contextWindowTokens !== snapshot.contextWindowTokens ||
      !sameObject(profile.endpointPolicy, snapshot.endpointPolicy) ||
      !positive(snapshot.maxOutputTokens) || snapshot.maxOutputTokens > profile.maxOutputTokens ||
      item.providerRequest.maxTokens !== snapshot.maxOutputTokens ||
      !Array.isArray(item.providerRequest.messages) ||
      policy.formulaVersion !== STORED_CHAT_FORMULA ||
      typeof policy.cachingDiscount !== 'string')
    throw new Error('Unreviewed chat profile');
  const candidate: FrozenChatCandidate = Object.freeze({
    modelSlug: item.modelSlug, modelType: 'chat', upstreamId: item.upstreamId,
    upstreamModelId: item.upstreamModelId, adapterKey: item.adapterKey,
    provider: 'pinned', ruResidency: false, priority: undefined, egressProxyUrl: null,
    profile, billing, maxOutputTokens: snapshot.maxOutputTokens, maxCredits,
  });
  return Object.freeze({ kind: 'chat', candidate, discount: policy.cachingDiscount });
}

function confirmedOutcome(
  item: StoredBatchWorkerItem,
  admission: GatewayChargeAdmissionResult,
  cost: bigint,
  usage: JsonObject,
): boolean {
  return (
    admission.billingRequestId === item.billingRequestId &&
    admission.attemptId === item.attemptId && admission.upstreamId === item.upstreamId &&
    admission.actualCostCredits === cost && admission.outcomeKind === 'success' &&
    admission.usageSnapshot !== null && admissionJsonObjectsEqual(admission.usageSnapshot, usage) &&
    admission.pricingSnapshot !== null && admissionJsonObjectsEqual(admission.pricingSnapshot, item.pricingSnapshot)
  );
}

export async function executeStoredBatchFinancial(
  item: StoredBatchWorkerItem,
  prepared: StoredBatchRuntimePreparation | null,
  injected: Partial<StoredBatchFinancialDependencies> = {},
): Promise<BatchFinancialOutcome> {
  const deps: StoredBatchFinancialDependencies = {
    markGatewayChargeDispatched, recordStoredBatchPendingEvidence, recordGatewayChargeOutcomeV2,
    settleAdmittedGatewayCharge, cancelUndispatchedGatewayCharge,
    now: () => new Date(), ...injected,
  };
  async function cancel(errorCode: string): Promise<BatchFinancialOutcome> {
    try {
      const cancelled = await deps.cancelUndispatchedGatewayCharge({ admission: item.admission });
      if (cancelled.state === 'cancelled' && cancelled.billingRequestId === item.billingRequestId &&
          cancelled.actualCostCredits === null)
        return Object.freeze({ kind: 'cancelled_no_charge', errorCode });
    } catch { /* Unknown cancellation must preserve the hold for reconciliation. */ }
    return UNKNOWN('CANCEL_UNCONFIRMED');
  }
  function retryLater(): BatchFinancialOutcome {
    const next = Math.min(deps.now().getTime() + 5_000, Date.parse(item.deadlineAt));
    return Object.freeze({ kind: 'retry_later', retryAt: new Date(next).toISOString() });
  }
  try { assertHeldIdentity(item); } catch { return UNKNOWN('FINANCIAL_IDENTITY_INVALID'); }
  if (Date.parse(item.deadlineAt) <= deps.now().getTime()) return cancel('BATCH_ITEM_EXPIRED');
  if (!prepared || prepared.item !== item) return retryLater();
  let evidence: FrozenEvidence;
  try {
    evidence = freezeEvidence(item);
    if (prepared.adapter.contract !== item.pricingSnapshot.adapterContract ||
        prepared.request !== item.providerRequest)
      throw new Error('Prepared mechanics drift');
  } catch { return retryLater(); }

  let dispatched: GatewayChargeAdmissionResult;
  try {
    const result = await deps.markGatewayChargeDispatched({
      admission: item.admission, attemptId: item.attemptId,
      upstreamId: item.upstreamId, pricingSnapshot: item.pricingSnapshot,
    });
    if (result.kind === 'replay') return UNKNOWN('DISPATCH_REPLAY');
    if (result.kind !== 'dispatch_granted' || !result.admission.didTransition ||
        result.admission.state !== 'dispatched' ||
        result.admission.billingRequestId !== item.billingRequestId ||
        result.admission.attemptId !== item.attemptId ||
        result.admission.upstreamId !== item.upstreamId ||
        result.admission.pricingSnapshot === null ||
        !admissionJsonObjectsEqual(result.admission.pricingSnapshot, item.pricingSnapshot))
      return UNKNOWN('DISPATCH_UNCONFIRMED');
    dispatched = result.admission;
  } catch (error) {
    if (error instanceof AdmissionDeadlineExpiredError) return cancel('BATCH_ITEM_EXPIRED');
    return UNKNOWN('DISPATCH_UNCONFIRMED');
  }

  let output: JsonObject;
  let cost: bigint;
  let usage: JsonObject;
  try {
    if (evidence.kind === 'embeddings') {
      const actual = await (prepared.adapter as AdmittedEmbeddingsMechanics)
        .execute(prepared.request as AdmittedEmbeddingsRequest);
      const captured = captureStoredEmbeddingsEvidence(
        actual, evidence.candidate, item.billingRequestId, item.attemptId,
      );
      output = parseAdmissionJsonObject(captured.response);
      cost = captured.actualCostCredits;
      usage = captured.usageSnapshot;
    } else {
      const actual = await (prepared.adapter as AdmittedChatMechanics)
        .execute(prepared.request as AdmittedChatRequest);
      const captured = captureStoredChatEvidence(
        actual, evidence.candidate, evidence.discount, item.billingRequestId, item.attemptId,
      );
      const publicChat = parseStoredHttpChatResponse(captured.response);
      output = parseAdmissionJsonObject(item.routeKind === 'completions'
        ? projectStoredHttpCompletionResponse(publicChat) : publicChat);
      cost = captured.actualCostCredits;
      usage = captured.usageSnapshot;
    }
  } catch { return UNKNOWN('PROVIDER_OR_USAGE_UNCONFIRMED'); }

  const digest = resultDigest(output);
  try {
    await deps.recordStoredBatchPendingEvidence(item.id, {
      output, usageSnapshot: usage, actualCostCredits: cost, resultDigest: digest,
    });
  } catch { return UNKNOWN('EVIDENCE_UNCONFIRMED'); }

  try {
    const outcome = await deps.recordGatewayChargeOutcomeV2({
      admission: dispatched, actualCostCredits: cost, usageSnapshot: usage, outcomeKind: 'success',
    });
    if (!['outcome_recorded', 'settled'].includes(outcome.state) ||
        !confirmedOutcome(item, outcome, cost, usage))
      return UNKNOWN('OUTCOME_UNCONFIRMED');
    const settled = outcome.state === 'settled'
      ? outcome
      : await deps.settleAdmittedGatewayCharge({ admission: outcome });
    if (settled.state !== 'settled' || !settled.settledAt ||
        !confirmedOutcome(item, settled, cost, usage))
      return UNKNOWN('SETTLE_UNCONFIRMED');
    return Object.freeze({
      kind: 'settled_success', output, resultDigest: digest, settledAt: settled.settledAt,
    });
  } catch { return UNKNOWN('OUTCOME_OR_SETTLE_UNCONFIRMED'); }
}
