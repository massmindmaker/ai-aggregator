/** Side-effect-free durable batch execution entry point. */
import { getUpstream } from './upstreams/registry';
import type { AdmittedChatMechanics, AdmittedEmbeddingsMechanics } from './upstreams/interface';
import type { StoredBatchWorkerItem } from './billing/stored-batch-storage';
import { admissionJsonObjectsEqual, parseAdmissionJsonObject } from './billing/admission-result';
export { executeStoredBatchFinancial, type BatchFinancialOutcome } from './billing/stored-batch-financial-execution';
export { recoverStoredBatchEvidenceOnce, type StoredBatchEvidenceRecoveryResult } from './billing/stored-batch-evidence-recovery';
export { ensureOwnedBatchJob, type OwnedBatchQueue } from './lib/batch-queue';
export type { StoredBatchWorkerItem } from './billing/stored-batch-storage';
export { claimNextStoredBatchItem, markStoredBatchItemTerminal, refreshStoredBatchAggregate, hasQueuedStoredBatchItems, listRecoverableStoredBatches, releaseStoredBatchItemClaimForRetry, recordStoredBatchPendingEvidence, loadStoredBatchPendingEvidence, listStoredBatchEvidenceRecoveryCandidates, completeStoredBatchItemFromPendingEvidence, reconcileStaleStoredBatchProcessing } from './billing/stored-batch-storage';

export type StoredBatchRuntimePreparation = Readonly<{
  item: StoredBatchWorkerItem;
  adapter: AdmittedChatMechanics | AdmittedEmbeddingsMechanics;
  request: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameJson(a: unknown, b: unknown): boolean {
  try { return admissionJsonObjectsEqual(parseAdmissionJsonObject(a), parseAdmissionJsonObject(b)); } catch { return false; }
}
function pinnedChatRequest(value: unknown, item: StoredBatchWorkerItem): Record<string, unknown> | null {
  if (!isRecord(value) || value.modelId !== item.upstreamModelId || value.byokKey !== undefined || value.egressProxyUrl !== undefined || !Array.isArray(value.messages) || !Number.isSafeInteger(value.maxTokens) || Number(value.maxTokens) < 1) return null;
  return value;
}
function pinnedEmbeddingsRequest(value: unknown, item: StoredBatchWorkerItem): Record<string, unknown> | null {
  if (!isRecord(value) || value.modelId !== item.upstreamModelId || value.byokKey !== undefined || value.egressProxyUrl !== undefined || !Array.isArray(value.input) || value.input.some((entry) => typeof entry !== 'string')) return null;
  return value;
}

/** Resolve only the reviewed admitted mechanism. It never performs I/O. */
export function preparePinnedStoredBatchRuntime(
  item: StoredBatchWorkerItem,
  resolve: (provider: string) => ReturnType<typeof getUpstream> = getUpstream,
): StoredBatchRuntimePreparation | null {
  try {
    // V1 batch admission forbids a proxy. A fleet default added after admission
    // must not silently change the pinned transport route at execution time.
    if (process.env.AIAG_EGRESS_PROXY_URL?.trim()) return null;
    const upstream = resolve(item.adapterKey);
    const persistedRequest = item.providerRequest;
    const snapshotContract = item.pricingSnapshot.adapterContract;
    if (typeof snapshotContract !== 'string') return null;
    if (item.routeKind === 'embeddings') {
      const mechanics = upstream.admittedEmbeddings;
      if (!mechanics || mechanics.contract !== snapshotContract) return null;
      const request = pinnedEmbeddingsRequest(persistedRequest, item);
      if (!request || !sameJson(request.endpointPolicy, item.pricingSnapshot.endpointPolicy)) return null;
      return Object.freeze({ item, adapter: mechanics, request });
    }
    const mechanics = upstream.admittedChat;
    if (!mechanics || mechanics.contract !== snapshotContract) return null;
    const request = pinnedChatRequest(persistedRequest, item);
    if (!request || !sameJson(request.endpointPolicy, item.pricingSnapshot.endpointPolicy) || request.maxTokens !== item.pricingSnapshot.maxOutputTokens) return null;
    return Object.freeze({ item, adapter: mechanics, request });
  } catch { return null; }
}
