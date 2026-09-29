import { settleTonInvoice } from '../../src/ton-reconciliation-internal';
import { randomUUID } from "node:crypto";
import type { Client as PgClient } from "pg";
import type { Database } from "../../src";

import type { Asset } from "@aiag/shared/ton-payment-contract";
import type {
  CreateTonInvoiceInput,
  TonInvoice,
  TonPaymentDatabase,
  TonSettlementResult,
  TonServerPolicy,
  TonSqlClient,
  VerifiedChainCredit,
} from "../../src";
import {
  assertTonCoreTestEnvironment,
  withTonCoreTestDatabase,
} from "../ton-core-test-db-guard";
import type { TestDatabaseClient } from "../test-db-guard";

type Environment = Record<string, string | undefined>;
const RUN = process.env.RUN_TON_CORE_DB_INTEGRATION === "1";
if (RUN) assertTonCoreTestEnvironment(process.env);

export const NATIVE_TON_ASSET: Asset = Object.freeze({ network: "tvm:-3", kind: "native", decimals: 9 });
export const NATIVE_TON_RECIPIENT = `0:${"1".repeat(64)}`;
const SENDER = `0:${"2".repeat(64)}`;
const MAX_SAFE_RUB_PAYG = "9007199254740991";

interface HeldClient { client: TestDatabaseClient; raw: PgClient; close(): Promise<void> }

/** Holds the verified callback open for the entire client lifetime. */
async function openHeldClient(env: Environment): Promise<HeldClient> {
  let resolveReady!: (client: TestDatabaseClient) => void;
  let rejectReady!: (error: unknown) => void;
  let release!: () => void;
  const ready = new Promise<TestDatabaseClient>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let raw: PgClient | undefined;
  const held = withTonCoreTestDatabase(env, { clientFactory: async (connectionString) => {
    const { Client } = await import("pg");
    const pg = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000, statement_timeout: 30_000, query_timeout: 35_000, options: "-c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000" });
    pg.on("error", () => {});
    raw = pg;
    return {
      connect: () => pg.connect(), end: () => pg.end(),
      async query(config) { const result = await pg.query(config.text, [...(config.values ?? [])]); return { rows: result.rows, rowCount: result.rowCount }; },
    };
  } }, async (client) => {
    resolveReady(client);
    await released;
  });
  void held.catch(rejectReady);
  const client = await ready;
  if (!raw) throw new Error("fixture_raw_client");
  let closed = false;
  return { client, raw, async close() { if (closed) return; closed = true; release(); await held; } };
}

function transactionDatabase(client: TestDatabaseClient): TonPaymentDatabase {
  return { async transaction<T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const result = await run({ query: (config) => client.query(config) });
      await client.query({ text: "COMMIT", values: [] });
      return result;
    } catch (error) {
      await client.query({ text: "ROLLBACK", values: [] });
      throw error;
    }
  } };
}

export interface TonSnapshot extends Record<string, unknown> {
  payg: string; debt: string; subscription: string; receiptCount: number; eventCount: number; decisionCount: number; status: string;
}
export interface TonNativeFixture {
  client: TestDatabaseClient; db: TonPaymentDatabase; ctx: { actorUserId: string; orgId: string }; policy: TonServerPolicy; userId: string; orgId: string;
  create(patch?: Partial<CreateTonInvoiceInput>): Promise<TonInvoice>;
  createWithInput(input: CreateTonInvoiceInput): Promise<TonInvoice>;
  createInput(patch?: Partial<CreateTonInvoiceInput>): CreateTonInvoiceInput;
  verifiedCredit(invoice: TonInvoice, patch?: Partial<VerifiedChainCredit>): VerifiedChainCredit;
  settle(invoiceId: string, credit: VerifiedChainCredit): Promise<TonSettlementResult>;
  expire(invoiceId: string): Promise<"expired" | "unchanged" | "not_found">;
  read(invoiceId: string): Promise<TonInvoice | null>;
  snapshot(invoiceId: string): Promise<TonSnapshot>;
  setOrgState(payg: string, debt?: string): Promise<void>;
  makeRubTopup(grantCredits?: string): Promise<{ paymentId: string; providerPaymentId: string; providerOrderId: string }>;
  beginRealRubRefund(payment: { paymentId: string; providerPaymentId: string; providerOrderId: string }): Promise<unknown>;
  finalizeRealRubRefund(payment: { paymentId: string; providerPaymentId: string; providerOrderId: string }): Promise<unknown>;
  replayLastRealRubRefund(): Promise<unknown>;
  openSecondary(): Promise<{ client: TestDatabaseClient; db: TonPaymentDatabase; refundDb: Database; close(): Promise<void> }>;
  close(): Promise<void>;
}

export async function openTonFixture(options: { initialPayg?: string; initialDebt?: string; quoteTtlMs?: number } = {}): Promise<TonNativeFixture> {
  assertTonCoreTestEnvironment(process.env);
  // No driver/domain module is loaded until the dedicated DB guard has passed.
  const held = await openHeldClient(process.env);
  const live = new Set<HeldClient>([held]);
  let opening = 0;
  try {
  const domain = await import("../../src");
  const contract = await import("@aiag/shared/ton-payment-contract");
  const client = held.client;
  const userId = randomUUID();
  const orgId = randomUUID();
  const dbNow = await client.query<{ now_ms: string }>({ text: "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms", values: [] });
  const now = Number(dbNow.rows[0]?.now_ms);
  if (!Number.isSafeInteger(now)) throw new Error("fixture_database_clock");
  await client.query({ text: "INSERT INTO users (id,email,is_active,is_banned) VALUES ($1::uuid,$2,TRUE,FALSE)", values: [userId, `ton-${userId}@example.test`] });
  await client.query({ text: "INSERT INTO organizations (id,slug,name,owner_id,is_active,subscription_credits,payg_credits,refund_debt_credits) VALUES ($1::uuid,$2,$3,$4::uuid,TRUE,0,$5::bigint,$6::bigint)", values: [orgId, `ton-${orgId}`, "TON native fixture", userId, options.initialPayg ?? "0", options.initialDebt ?? "0"] });
  const db = transactionDatabase(client);
  const policy: TonServerPolicy = { allowlist: [NATIVE_TON_ASSET] };
  let lastRefund: { claimId: string; payment: { paymentId: string; providerPaymentId: string; providerOrderId: string }; providerKey: string } | undefined;
  const createInput = (patch: Partial<CreateTonInvoiceInput> = {}): CreateTonInvoiceInput => {
    const grant = patch.grantMicrocredits ?? MAX_SAFE_RUB_PAYG;
    const quotedAtMs = now;
    const quote = contract.createQuote({
      quoteId: `quote-${randomUUID()}`, sourcePrice: { unit: "gateway_microcredits", amountAtomic: grant }, asset: NATIVE_TON_ASSET,
      fx: { sourceUnit: "gateway_microcredits", targetAsset: NATIVE_TON_ASSET, numerator: "1", denominator: "1", rounding: "floor", source: "fixture-rate-v1", observedAtMs: quotedAtMs - 1, expiresAtMs: quotedAtMs + (options.quoteTtlMs ?? 120_000) },
      additionalFeeAtomic: "2", expiresAtMs: quotedAtMs + (options.quoteTtlMs ?? 120_000),
    }, policy.allowlist, quotedAtMs);
    return { idempotencyKey: `fixture-${randomUUID()}`, grantMicrocredits: grant, priceRevision: "fixture-price-v1", quote, recipient: NATIVE_TON_RECIPIENT, expectedSender: SENDER, finalityPolicyId: "fixture-only-v1", verifierVersion: "fixture-verifier-v1", ...patch };
  };
  const create = (patch: Partial<CreateTonInvoiceInput> = {}) => domain.createTonInvoice(db, { actorUserId: userId, orgId }, createInput(patch), policy);
  const verifiedCredit = (invoice: TonInvoice, patch: Partial<VerifiedChainCredit> = {}): VerifiedChainCredit => {
    const eventSeed = invoice.invoiceId.replaceAll("-", "");
    return ({
    network: "tvm:-3", asset: NATIVE_TON_ASSET, recipient: invoice.recipient, recipientAccount: invoice.recipient, sender: invoice.expectedSender ?? SENDER, amountAtomic: invoice.amountAtomic, reference: invoice.reference,
    txHash: `${eventSeed}${eventSeed}`, txLt: "1", messageHash: `${eventSeed.split("").reverse().join("")}${eventSeed.split("").reverse().join("")}`, messageIndex: 0, chainTimeMs: now - 3, observedAtMs: now - 2, verifiedAtMs: now - 1,
    blockAnchor: "fixture-block-v1", masterchainAnchor: "fixture-masterchain-v1", executionPathDigest: "5".repeat(64), verifierVersion: invoice.verifierVersion, finalityPolicyId: invoice.finalityPolicyId, jettonCredit: null, ...patch,
    });
  };
  return {
    client, db, ctx: { actorUserId: userId, orgId }, policy, userId, orgId, create, createWithInput: (input) => domain.createTonInvoice(db, { actorUserId: userId, orgId }, input, policy), createInput, verifiedCredit,
    settle: (invoiceId, credit) => settleTonInvoice(db, invoiceId, credit), expire: (invoiceId) => domain.expireTonInvoice(db, invoiceId), read: (invoiceId) => domain.getTonInvoice(db, { actorUserId: userId, orgId }, invoiceId),
    async snapshot(invoiceId) {
      const result = await client.query<TonSnapshot>({ text: "SELECT o.payg_credits::text AS payg,o.refund_debt_credits::text AS debt,o.subscription_credits::text AS subscription,i.status,(SELECT count(*)::int FROM gateway_transactions g WHERE g.request_id='ton:invoice:'||i.id::text AND g.type='topup' AND g.source='ton') AS \"receiptCount\",(SELECT count(*)::int FROM ton_chain_events e JOIN ton_invoice_event_decisions d ON d.event_id=e.id WHERE d.invoice_id=i.id) AS \"eventCount\",(SELECT count(*)::int FROM ton_invoice_event_decisions d WHERE d.invoice_id=i.id) AS \"decisionCount\" FROM ton_invoices i JOIN organizations o ON o.id=i.org_id WHERE i.id=$1::uuid", values: [invoiceId] });
      const row = result.rows[0]; if (!row) throw new Error("fixture_snapshot_missing"); return row;
    },
    async setOrgState(payg, debt = "0") { await client.query({ text: "UPDATE organizations SET payg_credits=$2::bigint,refund_debt_credits=$3::bigint WHERE id=$1::uuid", values: [orgId, payg, debt] }); },
    async makeRubTopup(grantCredits = "1000") {
      const paymentId = randomUUID(); const providerPaymentId = `ton-rub-provider-${randomUUID()}`; const providerOrderId = `ton-rub-order-${randomUUID()}`;
      await client.query({ text: "INSERT INTO payments (id,user_id,amount,currency,status,tinkoff_payment_id,tinkoff_order_id,metadata,topup_org_id,topup_paid_kopecks,topup_grant_credits,topup_refunded_kopecks,topup_clawed_credits) VALUES($1::uuid,$2::uuid,'1.00','RUB','confirmed',$3,$4,$5::jsonb,$6::uuid,100,$7::bigint,0,0)", values: [paymentId, userId, providerPaymentId, providerOrderId, JSON.stringify({ kind: "topup", provider: "tinkoff" }), orgId, grantCredits] });
      return { paymentId, providerPaymentId, providerOrderId };
    },
    async beginRealRubRefund(payment) {
      const refunds = await import("../../../../apps/web/src/lib/payments/topup-refund");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      // `held.raw` is the exact pg.Client whose guard callback is still held open.
      const schema = await import("../../src/schema");
      const refundDb = drizzle(held.raw, { schema });
      const context = { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, route: "ACQ" as const, source: "cards" as const, receiptMode: "full_no_receipt" as const };
      return refunds.claimTopupRefund(payment.paymentId, 100, context, refundDb);
    },
    async finalizeRealRubRefund(payment) {
      const refunds = await import("../../../../apps/web/src/lib/payments/topup-refund");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const schema = await import("../../src/schema");
      const refundDb = drizzle(held.raw, { schema });
      const context = { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, route: "ACQ" as const, source: "cards" as const, receiptMode: "full_no_receipt" as const };
      const claim = await refunds.claimTopupRefund(payment.paymentId, 100, context, refundDb);
      if (claim.kind !== "claimed") throw new Error(`fixture_refund_claim_${claim.kind}`);
      const dispatched = await refunds.markTopupRefundDispatched(claim.claim.claimId, refundDb);
      if (dispatched.kind !== "marked") throw new Error(`fixture_refund_dispatch_${dispatched.kind}`);
      lastRefund = { claimId: claim.claim.claimId, payment, providerKey: claim.claim.providerKey };
      return refunds.finalizeTopupRefundProof(claim.claim.claimId, { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, externalRequestId: claim.claim.providerKey, status: "REFUNDED", originalAmountKopecks: 100, newAmountKopecks: 0 }, refundDb);
    },
    async replayLastRealRubRefund() {
      if (!lastRefund) throw new Error("fixture_refund_replay_missing");
      const refunds = await import("../../../../apps/web/src/lib/payments/topup-refund");
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const schema = await import("../../src/schema");
      const refundDb = drizzle(held.raw, { schema });
      return refunds.finalizeTopupRefundProof(lastRefund.claimId, { paymentId: lastRefund.payment.providerPaymentId, orderId: lastRefund.payment.providerOrderId, externalRequestId: lastRefund.providerKey, status: "REFUNDED", originalAmountKopecks: 100, newAmountKopecks: 0 }, refundDb);
    },
    async openSecondary() {
      if (live.size + opening >= 24) throw new Error("fixture_client_limit");
      opening += 1;
      try {
        const secondary = await openHeldClient(process.env);
        live.add(secondary);
        let closed = false;
        const { drizzle } = await import("drizzle-orm/node-postgres");
        const schema = await import("../../src/schema");
        return { client: secondary.client, db: transactionDatabase(secondary.client), refundDb: drizzle(secondary.raw, { schema }), async close() {
          if (closed) return;
          closed = true;
          live.delete(secondary);
          await secondary.close();
        } };
      } finally { opening -= 1; }
    },
    async close() {
      const clients = [...live];
      live.clear();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(clients.map((client) => client.close())),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_close_timeout")), 30_000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
  } catch (error) {
    await held.close();
    throw error;
  }
}
