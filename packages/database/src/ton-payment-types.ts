import type { TonQuote, Asset } from "@aiag/shared/ton-payment-contract";
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
  network: "tvm:-3";
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
  network: "tvm:-3";
  asset: Asset;
  settledAt: string;
  paygAfterMicrocredits: AtomicString;
  refundDebtAfterMicrocredits: AtomicString;
}
export interface VerifiedChainCredit {
  network: "tvm:-3";
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
