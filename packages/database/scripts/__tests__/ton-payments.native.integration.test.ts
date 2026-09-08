import { afterEach, describe, expect, it, vi } from "vitest";

import { assertTonCoreTestEnvironment } from "../ton-core-test-db-guard";
import { openTonFixture } from "./ton-payments.native.fixture";

const defaultDbAccess = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get() { defaultDbAccess.count += 1; throw new Error("TON_FIXTURE_DEFAULT_DB_ACCESSED"); } }),
}));

const RUN = process.env.RUN_TON_CORE_DB_INTEGRATION === "1";
if (RUN) assertTonCoreTestEnvironment(process.env);

describe.skipIf(!RUN)("TON invoice native core", () => {
  const fixtures: Array<Awaited<ReturnType<typeof openTonFixture>>> = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
  const open = async (...args: Parameters<typeof openTonFixture>) => {
    const fixture = await openTonFixture(...args);
    fixtures.push(fixture);
    return fixture;
  };

  it("twenty create retries retain one immutable server order", async () => {
    const f = await open();
    const domain = await import("../../src");
    const input = f.createInput({ idempotencyKey: "twenty-create" });
    const clients = await Promise.all(Array.from({ length: 20 }, () => f.openSecondary()));
    let invoices;
    try {
      invoices = await Promise.all(clients.map(({ db }) => domain.createTonInvoice(db, f.ctx, input, f.policy)));
    } finally {
      await Promise.all(clients.map(({ close }) => close()));
    }
    expect(new Set(invoices.map((invoice) => invoice.invoiceId)).size).toBe(1);
    expect(new Set(invoices.map((invoice) => invoice.orderId)).size).toBe(1);
    expect(new Set(invoices.map((invoice) => invoice.reference)).size).toBe(1);
    await expect(f.create({ ...input, priceRevision: "fixture-price-v2" })).rejects.toThrow("TON_IDEMPOTENCY_CONFLICT");
  });

  it("twenty poll/sweep retries settle one exact >2^53 native amount", async () => {
    const f = await open();
    const domain = await import("../../src");
    const invoice = await f.create();
    expect(invoice.amountAtomic).toBe("9007199254740993");
    const credit = f.verifiedCredit(invoice);
    const clients = await Promise.all(Array.from({ length: 20 }, () => f.openSecondary()));
    let results;
    try {
      results = await Promise.all(clients.map(({ db }) => domain.settleTonInvoice(db, invoice.invoiceId, credit)));
    } finally {
      await Promise.all(clients.map(({ close }) => close()));
    }
    expect(results.filter((result) => result.kind === "settled")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "already_settled")).toHaveLength(19);
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "9007199254740991", debt: "0", receiptCount: 1, eventCount: 1, decisionCount: 1, status: "settled" });
    await expect(f.client.query({ text: "SELECT o.payg_credits::text AS payg,o.subscription_credits::text AS subscription,o.refund_debt_credits::text AS debt,COALESCE(SUM(g.delta) FILTER (WHERE g.type='topup' AND g.source='ton'),0)::text AS ton_delta,COUNT(g.id) FILTER (WHERE g.type='topup' AND g.source='ton')::int AS ton_receipts FROM organizations o LEFT JOIN gateway_transactions g ON g.org_id=o.id WHERE o.id=$1::uuid GROUP BY o.payg_credits,o.subscription_credits,o.refund_debt_credits", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ payg: "9007199254740991", subscription: "0", debt: "0", ton_delta: "9007199254740991", ton_receipts: 1 }] });
  });

  it("keeps debt review immutable after debt is removed", async () => {
    const f = await open();
    const invoice = await f.create();
    await f.setOrgState("0", "1000");
    const credit = f.verifiedCredit(invoice);
    await expect(f.settle(invoice.invoiceId, credit)).resolves.toMatchObject({ kind: "review_required", reason: "refund_blocked" });
    await f.setOrgState("0", "0");
    await expect(f.settle(invoice.invoiceId, credit)).resolves.toMatchObject({ kind: "review_required", reason: "refund_blocked" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", debt: "0", receiptCount: 0, eventCount: 1, status: "review_required" });
  });

  it("replays the persisted request before mutable allowlist and expiry checks", async () => {
    const f = await open({ quoteTtlMs: 500 });
    const input = f.createInput({ idempotencyKey: "replay-before-policy" });
    const invoice = await f.createWithInput(input);
    f.policy.allowlist = [];
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expect(f.createWithInput(input)).resolves.toMatchObject({ invoiceId: invoice.invoiceId, orderId: invoice.orderId, status: "pending" });
    await expect(f.createWithInput({ ...input, priceRevision: "changed" })).rejects.toThrow("TON_IDEMPOTENCY_CONFLICT");
  });

  it("does not expose a persisted invoice to a different owner context", async () => {
    const f = await open();
    const domain = await import("../../src");
    const invoice = await f.create();
    await expect(domain.getTonInvoice(f.db, { actorUserId: "00000000-0000-4000-8000-000000000099", orgId: f.orgId }, invoice.invoiceId)).resolves.toBeNull();
  });

  it("keeps paid evidence as owner_changed review when the organization owner drifts", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "owner-drift" });
    const nextOwner = "00000000-0000-4000-8000-000000000088";
    await f.client.query({ text: "INSERT INTO users (id,email,is_active,is_banned) VALUES ($1::uuid,$2,TRUE,FALSE)", values: [nextOwner, "ton-owner-drift@example.test"] });
    await f.client.query({ text: "UPDATE organizations SET owner_id=$2::uuid WHERE id=$1::uuid", values: [f.orgId, nextOwner] });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "owner_changed" });
  });

  it("settles an allowlisted jetton only to its verified merchant wallet", async () => {
    const jetton = { network: "tvm:-3", kind: "jetton", decimals: 9, masterAddress: `0:${"a".repeat(64)}` } as const;
    const merchantWallet = `0:${"b".repeat(64)}`;
    const f = await open();
    f.policy.allowlist = [jetton, { network: "tvm:-3", kind: "native", decimals: 9 }];
    const base = f.createInput({ idempotencyKey: "jetton-ok", grantMicrocredits: "2" });
    const input = { ...base, quote: { ...base.quote, asset: jetton, fx: { ...base.quote.fx, targetAsset: jetton } } };
    const invoice = await f.createWithInput(input);
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice, { asset: jetton, recipientAccount: merchantWallet, jettonCredit: { masterAddress: jetton.masterAddress, merchantJettonWallet: merchantWallet } }))).resolves.toMatchObject({ kind: "settled" });
    const f2 = await open();
    f2.policy.allowlist = [jetton, { network: "tvm:-3", kind: "native", decimals: 9 }];
    const base2 = f2.createInput({ idempotencyKey: "jetton-wallet-mismatch", grantMicrocredits: "2" });
    const second = await f2.createWithInput({ ...base2, quote: { ...base2.quote, asset: jetton, fx: { ...base2.quote.fx, targetAsset: jetton } } });
    await expect(f2.settle(second.invoiceId, f2.verifiedCredit(second, { asset: jetton, recipientAccount: merchantWallet, jettonCredit: { masterAddress: jetton.masterAddress, merchantJettonWallet: `0:${"c".repeat(64)}` } }))).resolves.toMatchObject({ kind: "review_required", reason: "payment_mismatch" });
  });

  it("records mismatch, policy, underpayment, and overpayment without a receipt", async () => {
    const f = await open();
    const cases = [
      ["mismatch", { reference: "wrong-reference" }, "payment_mismatch"],
      ["sender", { sender: `0:${"8".repeat(64)}` }, "payment_mismatch"],
      ["recipient", { recipientAccount: `0:${"9".repeat(64)}` }, "payment_mismatch"],
      ["policy", { verifierVersion: "different-verifier" }, "verification_policy_mismatch"],
      ["under", { amountAtomic: "1" }, "underpayment"],
      ["over", { amountAtomic: "9007199254740994" }, "overpayment"],
    ] as const;
    for (const [key, patch, reason] of cases) {
      const invoice = await f.create({ idempotencyKey: `review-${key}` });
      await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice, patch))).resolves.toMatchObject({ kind: "review_required", reason });
      await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ receiptCount: 0, eventCount: 1, decisionCount: 1, status: "review_required" });
    }
  });

  it("pins one event fact and prevents cross-invoice consumption", async () => {
    const f = await open();
    const first = await f.create({ idempotencyKey: "event-first" });
    const original = f.verifiedCredit(first);
    await expect(f.settle(first.invoiceId, original)).resolves.toMatchObject({ kind: "settled" });
    await expect(f.settle(first.invoiceId, { ...original, amountAtomic: "1" })).resolves.toMatchObject({ kind: "evidence_conflict" });
    const f2 = await open();
    const second = await f2.create({ idempotencyKey: "event-second" });
    await expect(f2.settle(second.invoiceId, original)).resolves.toMatchObject({ kind: "review_required", reason: "event_already_consumed" });
    await expect(f2.snapshot(second.invoiceId)).resolves.toMatchObject({ receiptCount: 0, eventCount: 1, decisionCount: 1, status: "review_required" });
  });

  it("keeps invoice, event, decision, and TON receipt immutable in native SQL", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "immutable" });
    await expect(f.client.query({ text: "UPDATE ton_invoices SET grant_microcredits=2 WHERE id=$1::uuid", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.client.query({ text: "DELETE FROM ton_invoices WHERE id=$1::uuid", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "settled" });
    await expect(f.client.query({ text: "DELETE FROM ton_chain_events WHERE id=(SELECT settled_event_id FROM ton_invoices WHERE id=$1::uuid)", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.client.query({ text: "UPDATE ton_invoice_event_decisions SET reason='changed' WHERE invoice_id=$1::uuid", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.client.query({ text: "DELETE FROM ton_invoice_event_decisions WHERE invoice_id=$1::uuid", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.client.query({ text: "UPDATE gateway_transactions SET delta=0 WHERE request_id='ton:invoice:'||$1::uuid::text", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
    await expect(f.client.query({ text: "DELETE FROM gateway_transactions WHERE request_id='ton:invoice:'||$1::uuid::text", values: [invoice.invoiceId] })).rejects.toThrow("TON_IMMUTABLE");
  });

  it("rejects an orphan TON receipt at the deferred consistency boundary", async () => {
    const f = await open();
    await f.client.query({ text: "BEGIN", values: [] });
    try {
      await f.client.query({ text: "INSERT INTO gateway_transactions (org_id,request_id,type,source,delta,metadata) VALUES ($1::uuid,$2,'topup','ton',1,'{}'::jsonb)", values: [f.orgId, `ton:invoice:${"00000000-0000-4000-8000-000000000077"}`] });
      await expect(f.client.query({ text: "COMMIT", values: [] })).rejects.toThrow("TON_RECEIPT_ORPHAN");
    } finally { await f.client.query({ text: "ROLLBACK", values: [] }); }
  });

  it("rolls back an entire settlement when the final invoice CAS is injected to fail", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "final-cas-injection" });
    await f.client.query({ text: "CREATE FUNCTION aiag_fixture_fail_final_ton_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='settled' THEN RAISE EXCEPTION 'TON_FIXTURE_FINAL_CAS'; END IF; RETURN NEW; END $$", values: [] });
    await f.client.query({ text: "CREATE TRIGGER aiag_fixture_fail_final_ton_invoice BEFORE UPDATE ON ton_invoices FOR EACH ROW EXECUTE FUNCTION aiag_fixture_fail_final_ton_invoice()", values: [] });
    try {
      await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).rejects.toThrow("TON_FIXTURE_FINAL_CAS");
      await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", receiptCount: 0, eventCount: 0, decisionCount: 0, status: "pending" });
    } finally {
      await f.client.query({ text: "DROP TRIGGER aiag_fixture_fail_final_ton_invoice ON ton_invoices", values: [] });
      await f.client.query({ text: "DROP FUNCTION aiag_fixture_fail_final_ton_invoice()", values: [] });
    }
  });

  it("rolls back an entire settlement when TON receipt insertion is injected to fail", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "receipt-cas-injection" });
    await f.client.query({ text: "CREATE FUNCTION aiag_fixture_fail_ton_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='topup' AND NEW.source='ton' THEN RAISE EXCEPTION 'TON_FIXTURE_RECEIPT_CAS'; END IF; RETURN NEW; END $$", values: [] });
    await f.client.query({ text: "CREATE TRIGGER aiag_fixture_fail_ton_receipt BEFORE INSERT ON gateway_transactions FOR EACH ROW EXECUTE FUNCTION aiag_fixture_fail_ton_receipt()", values: [] });
    try {
      await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).rejects.toThrow("TON_FIXTURE_RECEIPT_CAS");
      await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", receiptCount: 0, eventCount: 0, decisionCount: 0, status: "pending" });
    } finally {
      await f.client.query({ text: "DROP TRIGGER aiag_fixture_fail_ton_receipt ON gateway_transactions", values: [] });
      await f.client.query({ text: "DROP FUNCTION aiag_fixture_fail_ton_receipt()", values: [] });
    }
  });

  it("retains the committed receipt after a caller loses the settlement acknowledgement", async () => {
    const f = await open();
    const domain = await import("../../src");
    const invoice = await f.create({ idempotencyKey: "lost-ack" });
    let committed: unknown;
    const ackLossDb = {
      async transaction<T>(run: (tx: { query: typeof f.client.query }) => Promise<T>): Promise<T> {
        await f.client.query({ text: "BEGIN", values: [] });
        const result = await run({ query: (config) => f.client.query(config) });
        await f.client.query({ text: "COMMIT", values: [] });
        committed = result;
        throw new Error("TON_FIXTURE_ACK_LOST");
      },
    };
    await expect(domain.settleTonInvoice(ackLossDb, invoice.invoiceId, f.verifiedCredit(invoice))).rejects.toThrow("TON_FIXTURE_ACK_LOST");
    await f.setOrgState("0");
    if (!committed || typeof committed !== "object" || !("receipt" in committed)) throw new Error("fixture_ack_commit_missing");
    const retryClient = await f.openSecondary();
    try {
      const retry = await domain.settleTonInvoice(retryClient.db, invoice.invoiceId, f.verifiedCredit(invoice));
      expect(retry).toEqual({ kind: "already_settled", receipt: committed.receipt });
    } finally { await retryClient.close(); }
  });

  it("commits a TON receipt before the dedicated post-commit child failure injection", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "parent-cleanup-injection" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "settled" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ receiptCount: 1, eventCount: 1, decisionCount: 1, status: "settled" });
    if (process.env.AIAG_TON_CORE_FIXTURE_FAIL_AFTER_COMMIT === "1") {
      throw new Error("TON_FIXTURE_COMMITTED_FAILURE");
    }
  });

  it("rejects malformed native evidence before it can create a durable event", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "malformed-evidence" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice, { jettonCredit: { masterAddress: `0:${"a".repeat(64)}`, merchantJettonWallet: `0:${"b".repeat(64)}` } }))).rejects.toThrow("TON_INVALID_JETTON");
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ receiptCount: 0, eventCount: 0, decisionCount: 0, status: "pending" });
  });

  it("blocks settlement behind an actual active RUB claim and preserves its event review", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "active-rub-claim" });
    const payment = await f.makeRubTopup();
    await expect(f.beginRealRubRefund(payment)).resolves.toMatchObject({ kind: "claimed" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "refund_blocked" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", receiptCount: 0, eventCount: 1, status: "review_required" });
  });

  it("reviews concurrent growth above the ceiling and real RUB clawback still settles", async () => {
    const f = await open({ initialPayg: "9007199254740989" });
    const invoice = await f.create({ idempotencyKey: "concurrent-growth", grantMicrocredits: "2" });
    const rub = await f.makeRubTopup();
    const other = await f.openSecondary();
    try {
      await other.client.query({ text: "UPDATE organizations SET payg_credits=payg_credits+1 WHERE id=$1::uuid", values: [f.orgId] });
    } finally { await other.close(); }
    const event = f.verifiedCredit(invoice);
    await expect(f.settle(invoice.invoiceId, event)).resolves.toMatchObject({ kind: "review_required", reason: "balance_compatibility_limit" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "9007199254740990", debt: "0", receiptCount: 0, status: "review_required" });
    await expect(f.finalizeRealRubRefund(rub)).resolves.toMatchObject({ kind: "settled", clawedCredits: 1000, paygRemovedCredits: 1000, debtAddedCredits: 0 });
    await expect(f.settle(invoice.invoiceId, event)).resolves.toMatchObject({ kind: "review_required", reason: "balance_compatibility_limit" });
  });

  it("keeps the pre-existing nonnegative PAYG constraint enabled", async () => {
    const f = await open();
    await expect(f.client.query({ text: "UPDATE organizations SET payg_credits=-1 WHERE id=$1::uuid", values: [f.orgId] })).rejects.toThrow();
    await expect(f.client.query({ text: "SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ payg: "0" }] });
  });

  it("refuses a pre-existing legacy PAYG row above the compatibility ceiling", async () => {
    const f = await open({ initialPayg: "9007199254740992" });
    await expect(f.create({ idempotencyKey: "unsafe-over-limit" })).rejects.toThrow("TON_BALANCE_COMPATIBILITY_LIMIT");
  });

  it("rejects a grant above the compatibility ceiling without persisting an invoice", async () => {
    const f = await open();
    await expect(f.create({ idempotencyKey: "grant-over-limit", grantMicrocredits: "9007199254740992" })).rejects.toThrow();
    await expect(f.client.query({ text: "SELECT count(*)::int AS invoices FROM ton_invoices WHERE org_id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ invoices: 0 }] });
  });

  it("reviews a safely created invoice after a legacy row becomes compatibility-unsafe", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "legacy-growth-after-create" });
    await f.setOrgState("9007199254740992");
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "balance_compatibility_limit" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "9007199254740992", debt: "0", receiptCount: 0, eventCount: 1, status: "review_required" });
  });

  it("keeps an expired payment as a durable review", async () => {
    const f = await open({ quoteTtlMs: 500 });
    const invoice = await f.create();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const late = f.verifiedCredit(invoice);
    await expect(f.settle(invoice.invoiceId, late)).resolves.toMatchObject({ kind: "review_required", reason: "late_payment" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ receiptCount: 0, eventCount: 1, decisionCount: 1, status: "review_required" });
  });

  it("races the actual expiry function with settlement without granting funds", async () => {
    const f = await open({ quoteTtlMs: 500 });
    const domain = await import("../../src");
    const invoice = await f.create({ idempotencyKey: "expire-settle-race" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const secondary = await f.openSecondary();
    try {
      const [, settlement] = await Promise.all([
        f.expire(invoice.invoiceId),
        domain.settleTonInvoice(secondary.db, invoice.invoiceId, f.verifiedCredit(invoice)),
      ]);
      expect(settlement).toMatchObject({ kind: "review_required", reason: "late_payment" });
    } finally { await secondary.close(); }
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", receiptCount: 0, eventCount: 1, decisionCount: 1, status: "review_required" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "late_payment" });
  });

  it("does not combine a partial event with a later exact event", async () => {
    const f = await open();
    const invoice = await f.create({ idempotencyKey: "partial-then-exact" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice, { amountAtomic: "1" }))).resolves.toMatchObject({ kind: "review_required", reason: "underpayment" });
    const exactOtherEvent = f.verifiedCredit(invoice, { txHash: "d".repeat(64), messageHash: "e".repeat(64), txLt: "2" });
    await expect(f.settle(invoice.invoiceId, exactOtherEvent)).resolves.toMatchObject({ kind: "review_required", reason: "invoice_in_review" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", receiptCount: 0, eventCount: 2, decisionCount: 2, status: "review_required" });
  });

  it("keeps a second transfer after settlement as durable review", async () => {
    const f = await open();
    const paid = await f.create({ idempotencyKey: "paid-first" });
    await expect(f.settle(paid.invoiceId, f.verifiedCredit(paid))).resolves.toMatchObject({ kind: "settled" });
    const additional = f.verifiedCredit(paid, { txHash: "6".repeat(64), messageHash: "7".repeat(64), txLt: "2" });
    await expect(f.settle(paid.invoiceId, additional)).resolves.toMatchObject({ kind: "review_required", reason: "additional_transfer" });
    await expect(f.snapshot(paid.invoiceId)).resolves.toMatchObject({ receiptCount: 1, eventCount: 2, decisionCount: 2, status: "settled" });
  });

  it("preserves the compatibility ceiling across actual RUB refund", async () => {
    const f = await open({ initialPayg: "9007199254740989" });
    const rub = await f.makeRubTopup();
    await expect(f.create({ grantMicrocredits: "3" })).rejects.toThrow("TON_BALANCE_COMPATIBILITY_LIMIT");
    defaultDbAccess.count = 0;
    await expect(f.finalizeRealRubRefund(rub)).resolves.toMatchObject({ kind: "settled", clawedCredits: 1000, paygRemovedCredits: 1000, debtAddedCredits: 0 });
    expect(defaultDbAccess.count).toBe(0);
    await expect(f.replayLastRealRubRefund()).resolves.toMatchObject({ kind: "already_settled" });
    await expect(f.client.query({ text: "SELECT payg_credits::text AS payg,refund_debt_credits::text AS debt FROM organizations WHERE id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ payg: "9007199254739989", debt: "0" }] });
  });

  it("allows exact ceiling then actual RUB clawback without Number coercion", async () => {
    const f = await open({ initialPayg: "9007199254740989" });
    const rub = await f.makeRubTopup();
    const invoice = await f.create({ grantMicrocredits: "2" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "settled" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "9007199254740991", receiptCount: 1 });
    await expect(f.finalizeRealRubRefund(rub)).resolves.toMatchObject({ kind: "settled", clawedCredits: 1000, paygRemovedCredits: 1000, debtAddedCredits: 0 });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "9007199254739991", debt: "0" });
    await expect(f.client.query({ text: "SELECT p.status,COUNT(g.id)::int AS refund_receipts FROM payments p LEFT JOIN gateway_transactions g ON g.org_id=p.topup_org_id AND g.type='refund' AND g.source='payg' WHERE p.id=$1::uuid GROUP BY p.status", values: [rub.paymentId] })).resolves.toMatchObject({ rows: [{ status: "refunded", refund_receipts: 1 }] });
  });
});
