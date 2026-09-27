import {
  completeStoredBatchItemFromPendingEvidence,
  hasQueuedStoredBatchItems,
  listStoredBatchEvidenceRecoveryCandidates,
  loadStoredBatchItem,
  markStoredBatchQueueRecoveryNeeded,
  refreshStoredBatchAggregate,
  type StoredBatchPendingEvidence,
  type StoredBatchWorkerItem,
} from './stored-batch-storage';
import { recordGatewayChargeOutcomeV2 } from './quota-admission';
import { settleAdmittedGatewayCharge } from './admission';
import { admissionJsonObjectsEqual, type GatewayChargeAdmissionResult } from './admission-result';

export type StoredBatchEvidenceRecoveryResult = Readonly<{ selected: number; recovered: number; unconfirmed: number }>;
type Deps = Readonly<{
  list: typeof listStoredBatchEvidenceRecoveryCandidates;
  load: typeof loadStoredBatchItem;
  record: typeof recordGatewayChargeOutcomeV2;
  settle: typeof settleAdmittedGatewayCharge;
  complete: typeof completeStoredBatchItemFromPendingEvidence;
  hasQueued: typeof hasQueuedStoredBatchItems;
  markRecovery: typeof markStoredBatchQueueRecoveryNeeded;
  refresh: typeof refreshStoredBatchAggregate;
}>;

function sameEvidence(item: StoredBatchWorkerItem, evidence: StoredBatchPendingEvidence): boolean {
  return (
    item.admission.billingRequestId === item.billingRequestId &&
    (item.status === 'processing' || item.status === 'reconciliation_required') &&
    item.admission.attemptId === item.attemptId &&
    item.admission.upstreamId === item.upstreamId &&
    item.admission.pricingSnapshot !== null &&
    admissionJsonObjectsEqual(item.admission.pricingSnapshot, item.pricingSnapshot) &&
    evidence.actualCostCredits >= 0n
  );
}

function evidenceArgs(admission: GatewayChargeAdmissionResult, evidence: StoredBatchPendingEvidence) {
  return { admission, actualCostCredits: evidence.actualCostCredits, usageSnapshot: evidence.usageSnapshot, outcomeKind: 'success' } as const;
}

export async function recoverStoredBatchEvidenceOnce(
  now: string,
  limit = 100,
  injected: Partial<Deps> = {},
): Promise<StoredBatchEvidenceRecoveryResult> {
  const deps: Deps = {
    list: listStoredBatchEvidenceRecoveryCandidates,
    load: loadStoredBatchItem,
    record: recordGatewayChargeOutcomeV2,
    settle: settleAdmittedGatewayCharge,
    complete: completeStoredBatchItemFromPendingEvidence,
    hasQueued: hasQueuedStoredBatchItems,
    markRecovery: markStoredBatchQueueRecoveryNeeded,
    refresh: refreshStoredBatchAggregate,
    ...injected,
  };
  const candidates = await deps.list(now, limit);
  let recovered = 0;
  let unconfirmed = 0;
  for (const candidate of candidates) {
    try {
      const item = await deps.load(candidate.itemId);
      const evidence = candidate.evidence;
      if (!item || !evidence || item.billingRequestId !== candidate.billingRequestId ||
          item.admission.state !== candidate.admissionState || !sameEvidence(item, evidence)) {
        unconfirmed += 1;
        continue;
      }
      let admission = item.admission;
      if (candidate.admissionState === 'dispatched') admission = await deps.record(evidenceArgs(admission, evidence));
      if (admission.state === 'outcome_recorded') admission = await deps.settle({ admission });
      if (admission.state !== 'settled' || admission.billingRequestId !== item.billingRequestId ||
          admission.attemptId !== item.attemptId || admission.upstreamId !== item.upstreamId ||
          admission.pricingSnapshot === null ||
          !admissionJsonObjectsEqual(admission.pricingSnapshot, item.pricingSnapshot) ||
          admission.actualCostCredits !== evidence.actualCostCredits || admission.outcomeKind !== 'success' ||
          !admission.settledAt || admission.usageSnapshot === null ||
          !admissionJsonObjectsEqual(admission.usageSnapshot, evidence.usageSnapshot)) {
        unconfirmed += 1;
        continue;
      }
      // A prior worker job may already have completed while queued siblings
      // remain. Set durable queue ownership before closing this item so a lost
      // ACK here cannot strand the siblings.
      if (await deps.hasQueued(candidate.batchId)) await deps.markRecovery(candidate.batchId, now);
      await deps.complete(candidate.itemId, admission.settledAt);
      await deps.refresh(candidate.parentId);
      recovered += 1;
    } catch {
      unconfirmed += 1;
    }
  }
  return Object.freeze({ selected: candidates.length, recovered, unconfirmed });
}
