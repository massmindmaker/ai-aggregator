import { createHash } from 'node:crypto';
import type { TonInvoice, VerifiedChainCredit } from '@aiag/database';
import {
  TON_EVIDENCE_MODEL,
  TON_PROVIDER_ID,
  TON_PROVIDER_ORIGIN,
  type NormalizedTonEvidence,
  type NormalizedTonMessage,
  type NormalizedTonTransaction,
} from './ton-payment-evidence.js';

export { TON_EVIDENCE_MODEL, TON_PROVIDER_ID, TON_PROVIDER_ORIGIN };

export const TON_VERIFIER_VERSION = 'aiag-toncenter-v3-verifier-v1' as const;
export const TON_FINALITY_POLICY_ID =
  'toncenter-v3-testnet-provider-attested-mc-depth-2-v1' as const;

export interface TonVerifierPolicy {
  network: 'tvm:-3';
  providerId: typeof TON_PROVIDER_ID;
  evidenceModel: typeof TON_EVIDENCE_MODEL;
  verifierVersion: typeof TON_VERIFIER_VERSION;
  finalityPolicyId: typeof TON_FINALITY_POLICY_ID;
  minIndexedMasterchainDepth: 2;
  maxBundleBytes: 1_048_576;
  maxTraceTransactions: 128;
  maxMessagesPerTransaction: 64;
}

export const TON_VERIFIER_POLICY: Readonly<TonVerifierPolicy> = Object.freeze({
  network: 'tvm:-3',
  providerId: TON_PROVIDER_ID,
  evidenceModel: TON_EVIDENCE_MODEL,
  verifierVersion: TON_VERIFIER_VERSION,
  finalityPolicyId: TON_FINALITY_POLICY_ID,
  minIndexedMasterchainDepth: 2,
  maxBundleBytes: 1_048_576,
  maxTraceTransactions: 128,
  maxMessagesPerTransaction: 64,
});

export type TonObservedReason = 'candidate_not_found' | 'trace_incomplete' | 'finality_pending';

export type TonReviewReason =
  | 'network_mismatch'
  | 'policy_mismatch'
  | 'trace_oversized'
  | 'trace_emulated'
  | 'trace_aborted'
  | 'trace_bounced'
  | 'trace_failed'
  | 'message_linkage_invalid'
  | 'inclusion_mismatch'
  | 'asset_mismatch'
  | 'recipient_mismatch'
  | 'sender_mismatch'
  | 'reference_mismatch'
  | 'amount_mismatch'
  | 'jetton_master_mismatch'
  | 'jetton_wallet_mismatch'
  | 'jetton_notification_invalid';

export type TonVerificationResult =
  | { kind: 'verified'; credit: VerifiedChainCredit; evidenceDigest: string }
  | { kind: 'observed'; reason: TonObservedReason; evidenceDigest: string | null }
  | { kind: 'review_required'; reason: TonReviewReason; evidenceDigest: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(object[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function review(reason: TonReviewReason, evidenceDigest: string): TonVerificationResult {
  return { kind: 'review_required', reason, evidenceDigest };
}

function policyMatches(invoice: TonInvoice, evidence: NormalizedTonEvidence, policy: TonVerifierPolicy): boolean {
  return policy.network === TON_VERIFIER_POLICY.network
    && policy.providerId === TON_VERIFIER_POLICY.providerId
    && policy.evidenceModel === TON_VERIFIER_POLICY.evidenceModel
    && policy.verifierVersion === TON_VERIFIER_POLICY.verifierVersion
    && policy.finalityPolicyId === TON_VERIFIER_POLICY.finalityPolicyId
    && policy.minIndexedMasterchainDepth === TON_VERIFIER_POLICY.minIndexedMasterchainDepth
    && policy.maxBundleBytes === TON_VERIFIER_POLICY.maxBundleBytes
    && policy.maxTraceTransactions === TON_VERIFIER_POLICY.maxTraceTransactions
    && policy.maxMessagesPerTransaction === TON_VERIFIER_POLICY.maxMessagesPerTransaction
    && invoice.verifierVersion === policy.verifierVersion
    && invoice.finalityPolicyId === policy.finalityPolicyId
    && evidence.source.providerId === policy.providerId
    && evidence.source.origin === TON_PROVIDER_ORIGIN
    && evidence.source.evidenceModel === policy.evidenceModel;
}

function sameAsset(first: TonInvoice['asset'], second: TonInvoice['asset']): boolean {
  if (first.network !== second.network || first.kind !== second.kind || first.decimals !== second.decimals) {
    return false;
  }
  return first.kind === 'native'
    || (second.kind === 'jetton' && first.masterAddress === second.masterAddress);
}

function sameMessage(first: NormalizedTonMessage, second: NormalizedTonMessage): boolean {
  // Position belongs to the containing transaction: an outgoing slot can only
  // become the zero-indexed input of a later transaction. Validate each
  // position independently during normalization, but do not require equality
  // across that transaction boundary.
  const { index: _firstIndex, ...firstFacts } = first;
  const { index: _secondIndex, ...secondFacts } = second;
  return stableJson(firstFacts) === stableJson(secondFacts);
}

function traceLinkageIsValid(evidence: NormalizedTonEvidence): boolean {
  const ordered = evidence.trace.orderedTransactionHashes;
  if (ordered.length === 0 || ordered.length !== evidence.transactions.length) return false;
  if (new Set(ordered).size !== ordered.length) return false;
  const incoming = new Map<string, { message: NormalizedTonMessage; transactionIndex: number }>();
  const outgoing = new Map<string, { message: NormalizedTonMessage; transactionIndex: number }>();
  for (let index = 0; index < evidence.transactions.length; index += 1) {
    const transaction = evidence.transactions[index]!;
    if (ordered[index] !== transaction.hash || transaction.account !== transaction.inMessage.destination) {
      return false;
    }
    if (index > 0 && transaction.chainTimeMs < evidence.transactions[index - 1]!.chainTimeMs) {
      return false;
    }
    if (incoming.has(transaction.inMessage.hash)) return false;
    incoming.set(transaction.inMessage.hash, { message: transaction.inMessage, transactionIndex: index });
    for (const message of transaction.outMessages) {
      if (message.hash === transaction.inMessage.hash || outgoing.has(message.hash)) return false;
      outgoing.set(message.hash, { message, transactionIndex: index });
    }
  }
  for (const [messageHash, sent] of outgoing) {
    const received = incoming.get(messageHash);
    if (
      !received
      || sent.transactionIndex >= received.transactionIndex
      || !sameMessage(sent.message, received.message)
    ) return false;
  }
  for (const [messageHash, received] of incoming) {
    if (received.transactionIndex === 0) continue;
    const sent = outgoing.get(messageHash);
    if (
      !sent
      || sent.transactionIndex >= received.transactionIndex
      || !sameMessage(sent.message, received.message)
    ) return false;
  }
  return true;
}

function inclusionIsValid(evidence: NormalizedTonEvidence): boolean {
  if (evidence.latestIndexedMasterchain.seqno < evidence.trace.masterchainSeqno) return false;
  if (evidence.source.fetchedAtMs < Math.max(...evidence.transactions.map((entry) => entry.chainTimeMs))) {
    return false;
  }
  const blockSeqnos = evidence.transactions.map((entry) => entry.blockRef.masterchainSeqno);
  if (
    !blockSeqnos.every((seqno) => seqno <= evidence.trace.masterchainSeqno)
    || !blockSeqnos.some((seqno) => seqno === evidence.trace.masterchainSeqno)
  ) return false;
  const blockIdentities = new Map<string, string>();
  for (const transaction of evidence.transactions) {
    const block = transaction.blockRef;
    const coordinate = `${block.workchain}:${block.shard}:${block.seqno}`;
    const identity = `${block.rootHash}:${block.fileHash}`;
    const knownIdentity = blockIdentities.get(coordinate);
    if (knownIdentity !== undefined && knownIdentity !== identity) return false;
    blockIdentities.set(coordinate, identity);
  }
  return true;
}

type Candidate = {
  transaction: NormalizedTonTransaction;
  message: NormalizedTonMessage;
  sender: string | null;
  recipient: string;
  amountAtomic: string;
  reference: string;
};

function nativeCandidate(evidence: NormalizedTonEvidence): Candidate | null {
  if (evidence.creditPath.kind !== 'native') return null;
  const path = evidence.creditPath;
  const transaction = evidence.transactions.find(
    (entry) => entry.hash === path.recipientTransactionHash,
  );
  if (!transaction || transaction.inMessage.hash !== path.creditMessageHash) return null;
  const payload = transaction.inMessage.decodedPayload;
  if (transaction.inMessage.opcode !== '0x00000000' || payload.kind !== 'native_comment') return null;
  return {
    transaction,
    message: transaction.inMessage,
    sender: transaction.inMessage.source,
    recipient: transaction.account,
    amountAtomic: transaction.inMessage.amountAtomic,
    reference: payload.reference,
  };
}

type JettonCandidate = Candidate & {
  transferMessage: NormalizedTonMessage;
  transfer: Extract<NormalizedTonMessage['decodedPayload'], { kind: 'jetton_transfer' }>;
  internal: Extract<NormalizedTonMessage['decodedPayload'], { kind: 'jetton_internal_transfer' }>;
  notification: Extract<NormalizedTonMessage['decodedPayload'], { kind: 'jetton_notification' }>;
  notificationMessage: NormalizedTonMessage;
};

function jettonCandidate(evidence: NormalizedTonEvidence): JettonCandidate | null {
  if (evidence.creditPath.kind !== 'jetton') return null;
  const path = evidence.creditPath;
  const transferIndex = evidence.transactions.findIndex(
    (entry) => entry.inMessage.hash === path.transferMessageHash,
  );
  const creditIndex = evidence.transactions.findIndex((entry) => entry.hash === path.creditTransactionHash);
  const notificationIndex = evidence.transactions.findIndex(
    (entry) => entry.inMessage.hash === path.notificationMessageHash,
  );
  if (
    transferIndex < 0 || creditIndex <= transferIndex || notificationIndex <= creditIndex
  ) return null;

  const transferTransaction = evidence.transactions[transferIndex]!;
  const creditTransaction = evidence.transactions[creditIndex]!;
  const notificationTransaction = evidence.transactions[notificationIndex]!;
  const internalMessage = transferTransaction.outMessages.find(
    (message) => message.hash === path.internalTransferMessageHash,
  );
  const notificationMessage = creditTransaction.outMessages.find(
    (message) => message.hash === path.notificationMessageHash,
  );
  if (
    !internalMessage ||
    creditTransaction.inMessage.hash !== path.internalTransferMessageHash ||
    !sameMessage(internalMessage, creditTransaction.inMessage) ||
    !notificationMessage ||
    !sameMessage(notificationMessage, notificationTransaction.inMessage) ||
    internalMessage.source !== transferTransaction.account ||
    internalMessage.destination !== creditTransaction.account ||
    notificationMessage.source !== creditTransaction.account ||
    notificationMessage.destination !== notificationTransaction.account ||
    transferTransaction.inMessage.opcode !== '0x0f8a7ea5' ||
    internalMessage.opcode !== '0x178d4519'
  ) return null;

  const transfer = transferTransaction.inMessage.decodedPayload;
  const internal = internalMessage.decodedPayload;
  const notification = notificationMessage.decodedPayload;
  if (
    transfer.kind !== 'jetton_transfer' ||
    internal.kind !== 'jetton_internal_transfer' ||
    notification.kind !== 'jetton_notification'
  ) return null;

  return {
    transaction: creditTransaction,
    message: creditTransaction.inMessage,
    sender: notification.sender,
    recipient: transfer.destination,
    amountAtomic: notification.amountAtomic,
    reference: notification.forwardReference,
    transferMessage: transferTransaction.inMessage,
    transfer,
    internal,
    notification,
    notificationMessage,
  };
}

export function verifyChainCredit(
  invoice: TonInvoice,
  evidence: NormalizedTonEvidence,
  policy: TonVerifierPolicy,
): TonVerificationResult {
  const evidenceDigest = digest(evidence);

  if (invoice.network !== 'tvm:-3' || evidence.network !== invoice.network) {
    return review('network_mismatch', evidenceDigest);
  }
  if (!policyMatches(invoice, evidence, policy)) return review('policy_mismatch', evidenceDigest);

  const serializedBytes = Buffer.byteLength(stableJson(evidence));
  if (
    serializedBytes > policy.maxBundleBytes ||
    evidence.transactions.length > policy.maxTraceTransactions ||
    evidence.transactions.some(
      (transaction) => transaction.outMessages.length + 1 > policy.maxMessagesPerTransaction,
    )
  ) return review('trace_oversized', evidenceDigest);

  if (evidence.transactions.some((transaction) => transaction.emulated)) {
    return review('trace_emulated', evidenceDigest);
  }
  if (evidence.transactions.some((transaction) => transaction.aborted)) {
    return review('trace_aborted', evidenceDigest);
  }
  if (evidence.transactions.some(
    (transaction) => transaction.inMessage.bounced
      || transaction.outMessages.some((message) => message.bounced),
  )) return review('trace_bounced', evidenceDigest);
  if (evidence.transactions.some(
    (transaction) => !transaction.computeSuccess || !transaction.actionSuccess,
  )) return review('trace_failed', evidenceDigest);
  if (!evidence.trace.complete) {
    return { kind: 'observed', reason: 'trace_incomplete', evidenceDigest };
  }
  if (!traceLinkageIsValid(evidence)) return review('message_linkage_invalid', evidenceDigest);
  if (!inclusionIsValid(evidence)) return review('inclusion_mismatch', evidenceDigest);
  if (!sameAsset(invoice.asset, evidence.asset)) return review('asset_mismatch', evidenceDigest);

  const jettonDetails = invoice.asset.kind === 'jetton' ? jettonCandidate(evidence) : null;
  const candidate = invoice.asset.kind === 'native' ? nativeCandidate(evidence) : jettonDetails;
  if (!candidate) return review('message_linkage_invalid', evidenceDigest);
  if (candidate.recipient !== invoice.recipient) return review('recipient_mismatch', evidenceDigest);
  if (
    jettonDetails !== null && evidence.creditPath.kind === 'jetton'
    && (
      evidence.creditPath.walletDerivationOwner !== invoice.recipient
      || jettonDetails.transfer.destination !== invoice.recipient
    )
  ) return review('recipient_mismatch', evidenceDigest);
  if (
    candidate.sender === null ||
    (invoice.expectedSender !== null && candidate.sender !== invoice.expectedSender)
  ) return review('sender_mismatch', evidenceDigest);
  if (
    jettonDetails !== null
    && (
      jettonDetails.transferMessage.source !== jettonDetails.notification.sender
      || jettonDetails.internal.sender !== jettonDetails.notification.sender
    )
  ) return review('sender_mismatch', evidenceDigest);
  if (candidate.reference !== invoice.reference) return review('reference_mismatch', evidenceDigest);
  if (
    jettonDetails !== null
    && (
      jettonDetails.transfer.forwardReference !== invoice.reference
      || jettonDetails.notification.forwardReference !== invoice.reference
    )
  ) return review('reference_mismatch', evidenceDigest);
  if (candidate.amountAtomic !== invoice.amountAtomic) return review('amount_mismatch', evidenceDigest);
  if (
    jettonDetails !== null
    && (
      jettonDetails.transfer.amountAtomic !== invoice.amountAtomic
      || jettonDetails.internal.amountAtomic !== invoice.amountAtomic
      || jettonDetails.notification.amountAtomic !== invoice.amountAtomic
    )
  ) return review('amount_mismatch', evidenceDigest);

  let jettonCredit: VerifiedChainCredit['jettonCredit'] = null;
  if (invoice.asset.kind === 'jetton') {
    if (evidence.creditPath.kind !== 'jetton' || jettonDetails === null) {
      return review('message_linkage_invalid', evidenceDigest);
    }
    if (evidence.creditPath.masterAddress !== invoice.asset.masterAddress) {
      return review('jetton_master_mismatch', evidenceDigest);
    }
    if (
      evidence.creditPath.derivedMerchantWallet !== jettonDetails.transaction.account ||
      jettonDetails.transaction.inMessage.destination !== evidence.creditPath.derivedMerchantWallet
    ) return review('jetton_wallet_mismatch', evidenceDigest);
    if (jettonDetails.notificationMessage.opcode !== '0x7362d09c') {
      return review('jetton_notification_invalid', evidenceDigest);
    }
    jettonCredit = {
      masterAddress: invoice.asset.masterAddress,
      merchantJettonWallet: evidence.creditPath.derivedMerchantWallet,
    };
  } else if (evidence.creditPath.kind !== 'native') {
    return review('asset_mismatch', evidenceDigest);
  }

  if (
    evidence.latestIndexedMasterchain.seqno - evidence.trace.masterchainSeqno
      < policy.minIndexedMasterchainDepth
  ) {
    return { kind: 'observed', reason: 'finality_pending', evidenceDigest };
  }

  const credit: VerifiedChainCredit = {
    network: 'tvm:-3',
    asset: invoice.asset,
    recipient: invoice.recipient,
    recipientAccount: candidate.transaction.account,
    sender: candidate.sender,
    amountAtomic: invoice.amountAtomic,
    reference: invoice.reference,
    txHash: candidate.transaction.hash,
    txLt: candidate.transaction.lt,
    messageHash: candidate.message.hash,
    messageIndex: candidate.message.index,
    chainTimeMs: candidate.transaction.chainTimeMs,
    observedAtMs: evidence.source.fetchedAtMs,
    verifiedAtMs: evidence.source.fetchedAtMs,
    blockAnchor: digest(candidate.transaction.blockRef),
    masterchainAnchor: digest(evidence.latestIndexedMasterchain),
    executionPathDigest: evidenceDigest,
    verifierVersion: invoice.verifierVersion,
    finalityPolicyId: invoice.finalityPolicyId,
    jettonCredit,
  };
  return { kind: 'verified', credit, evidenceDigest };
}
