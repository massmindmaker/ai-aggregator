import type { TonNetworkId, TonQuote, Asset } from "@aiag/shared/ton-payment-contract";
export type AtomicString = string; // Runtime canonical decimal validation mandatory.
export interface TonInvoiceContext {
  actorUserId: string;
  orgId: string;
}
export interface CreateTonInvoiceInput {
  idempotencyKey: string;
  grantMicrocredits: AtomicString;
  priceRevision: string;
  quote: TonQuote;
  recipient: string;
  expectedSender: string | null;
  finalityPolicyId: string;
  verifierVersion: string;
}
export interface TonServerPolicy {
  allowlist: readonly Asset[];
}
export interface TonInvoice {
  schemaVersion: 1;
  product: "aggregator";
  purpose: "gateway_topup";
  invoiceId: string;
  ownerId: string;
  orgId: string;
  orderId: string;
  idempotencyKey: string;
  quoteId: string;
  quote: TonQuote;
  grantMicrocredits: AtomicString;
  priceRevision: string;
  network: TonNetworkId;
  asset: Asset;
  amountAtomic: AtomicString;
  recipient: string;
  reference: string;
  expectedSender: string | null;
  finalityPolicyId: string;
  verifierVersion: string;
  expiresAt: string;
  createdAt: string;
  status:
    | "pending"
    | "observed"
    | "confirmed"
    | "settled"
    | "expired"
    | "review_required";
  reviewReason: string | null;
}
export interface TonReceipt {
  receiptId: string;
  invoiceId: string;
  ownerId: string;
  orgId: string;
  orderId: string;
  eventId: string;
  grantMicrocredits: AtomicString;
  amountAtomic: AtomicString;
  network: TonNetworkId;
  asset: Asset;
  settledAt: string;
  paygAfterMicrocredits: AtomicString;
  refundDebtAfterMicrocredits: AtomicString;
}
export interface VerifiedChainCredit {
  network: TonNetworkId;
  asset: Asset;
  recipient: string;
  recipientAccount: string;
  sender: string;
  amountAtomic: AtomicString;
  reference: string;
  txHash: string;
  txLt: string;
  messageHash: string;
  messageIndex: number;
  chainTimeMs: number;
  observedAtMs: number;
  verifiedAtMs: number;
  blockAnchor: string;
  masterchainAnchor: string;
  executionPathDigest: string;
  verifierVersion: string;
  finalityPolicyId: string;
  jettonCredit: null | { masterAddress: string; merchantJettonWallet: string };
}
export type TonSettlementResult =
  | { kind: "settled" | "already_settled"; receipt: TonReceipt }
  | {
      kind: "review_required";
      invoiceId: string;
      eventId: string;
      reason: string;
    }
  | { kind: "not_found" }
  | { kind: "evidence_conflict"; eventId: string };
export interface TonSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    text: string;
    values: readonly unknown[];
  }): Promise<{ rows: Row[]; rowCount: number | null }>;
}
export interface TonPaymentDatabase {
  transaction<T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T>;
}

export type TonSourceErrorCode =
  | "origin_mismatch"
  | "redirect_rejected"
  | "response_too_large"
  | "http_unauthorized"
  | "rate_limited"
  | "timeout"
  | "upstream_5xx"
  | "provider_schema_invalid"
  | "pagination_regressed"
  | "recipient_binding_changed"
  | "unsupported_asset";

export type TonObservedReason =
  | "candidate_not_found"
  | "trace_incomplete"
  | "finality_pending";

export type TonReviewReason =
  | "network_mismatch"
  | "policy_mismatch"
  | "trace_oversized"
  | "trace_emulated"
  | "trace_aborted"
  | "trace_bounced"
  | "trace_failed"
  | "message_linkage_invalid"
  | "inclusion_mismatch"
  | "asset_mismatch"
  | "recipient_mismatch"
  | "sender_mismatch"
  | "reference_mismatch"
  | "amount_mismatch"
  | "jetton_master_mismatch"
  | "jetton_wallet_mismatch"
  | "jetton_notification_invalid";

export type TonSettlementObservationReason = "settlement_evidence_conflict";

export interface TonProviderCursor {
  schemaVersion: 1;
  beforeLt: string;
  beforeTransactionHash: string;
  cycleUpperLt: string;
}

export type TonSweepCursor = TonProviderCursor;

export type TonRecipientBinding = {
  recipientAccount: string;
  derivation:
    | { kind: "native"; ownerAddress: string }
    | {
        kind: "jetton";
        masterAddress: string;
        ownerAddress: string;
        walletAddress: string;
      };
};

export interface TonReconciliationSource {
  sourceId: string;
  network: TonNetworkId;
  asset: TonInvoice["asset"];
  invoiceRecipient: string;
  scanFloorTimeMs: number;
}

export type TonObservationInput = {
  schemaVersion: 1;
  invoiceId: string | null;
  sourceId: string;
  recipientAccount: string;
  eventIdentity: null | {
    txHash: string;
    messageHash: string;
    txLt: string;
  };
  providerId: "toncenter-v3-testnet";
  evidenceModel: "server_trusted_indexer";
  result:
    | {
        kind: "source_error";
        reason: TonSourceErrorCode;
        evidenceDigest: null;
      }
    | {
        kind: "observed";
        reason: TonObservedReason;
        evidenceDigest: string | null;
      }
    | {
        kind: "unmatched";
        reason: "invoice_reference_not_found";
        evidenceDigest: string;
      }
    | {
        kind: "verified_candidate";
        reason: "verified_candidate";
        evidenceDigest: string;
      }
    | {
        kind: "review_required";
        reason: TonReviewReason | TonSettlementObservationReason;
        evidenceDigest: string;
      };
  providerCursor: TonProviderCursor | null;
  snapshot: Record<string, unknown>;
  observedAtMs: number;
};

export type TonObservationResult = {
  observationId: string;
  outcome: "inserted" | "already_recorded";
  invoiceStatus: TonInvoice["status"] | null;
};

export type TonDatabaseCloseResult =
  | { kind: "closed" }
  | { kind: "deadline_exceeded"; phase: "pool" };

export interface CloseableTonWorkerDatabase extends TonPaymentDatabase {
  close(): Promise<TonDatabaseCloseResult>;
}
