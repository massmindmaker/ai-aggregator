import type { TonReceipt } from "@aiag/database";
import { invoice } from "./ton-recovery.fixture";
export function receipt(): TonReceipt {
  const i = invoice();
  return {
    receiptId: "40000000-0000-4000-8000-000000000001",
    eventId: "40000000-0000-4000-8000-000000000002",
    invoiceId: i.invoiceId,
    ownerId: i.ownerId,
    orgId: i.orgId,
    orderId: i.orderId,
    grantMicrocredits: i.grantMicrocredits,
    amountAtomic: i.amountAtomic,
    network: i.network,
    asset: i.asset,
    settledAt: "2026-09-29T10:00:00.123456+00:00",
    paygAfterMicrocredits: "1000",
    refundDebtAfterMicrocredits: "0",
  };
}
