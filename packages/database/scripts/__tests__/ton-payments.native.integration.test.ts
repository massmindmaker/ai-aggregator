import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertTonCoreTestEnvironment } from "../ton-core-test-db-guard";
import { openTonFixture } from "./ton-payments.native.fixture";

const defaultDbAccess = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get() { defaultDbAccess.count += 1; throw new Error("TON_FIXTURE_DEFAULT_DB_ACCESSED"); } }),
}));

const RUN = process.env.RUN_TON_CORE_DB_INTEGRATION === "1";
if (RUN) assertTonCoreTestEnvironment(process.env);

async function expectBlocked(client: Awaited<ReturnType<typeof openTonFixture>>["client"], waiter: number, blocker: number) {
  const deadline = Date.now() + 2_000;
  do {
    const result = await client.query<{ blocked: boolean }>({ text: "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked", values: [waiter, blocker] });
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("TON_FIXTURE_LOCK_NOT_OBSERVED");
}
async function expectConservation(f: Awaited<ReturnType<typeof openTonFixture>>, payg: string, debt: string, ton: string, rub: string) {
  const result = await f.client.query({ text: "SELECT o.payg_credits::text AS payg,o.refund_debt_credits::text AS debt,o.subscription_credits::text AS subscription,COALESCE(sum(g.delta) FILTER(WHERE g.type='topup' AND g.source='ton'),0)::text AS ton,COALESCE(sum(g.delta) FILTER(WHERE g.type='refund' AND g.source='payg'),0)::text AS rub FROM organizations o LEFT JOIN gateway_transactions g ON g.org_id=o.id WHERE o.id=$1::uuid GROUP BY o.payg_credits,o.refund_debt_credits,o.subscription_credits", values: [f.orgId] });
  expect(result.rows).toEqual([{ payg, debt, subscription: "0", ton, rub }]);
}

describe.skipIf(!RUN)("TON invoice native core", () => {
  const fixtures: Array<Awaited<ReturnType<typeof openTonFixture>>> = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
  const open = async (...args: Parameters<typeof openTonFixture>) => {
    const fixture = await openTonFixture(...args);
    fixtures.push(fixture);
    return fixture;
  };

  it("matches the historical TON core inventory on its disposable 0072 manifest", async () => {
    const f = await open();
    // The owned TON core database deliberately ends at0072; the head baseline
    // includes later catalog/reconciliation tables and cannot be its oracle.
    const manifest = await f.client.query({ text: "SELECT count(*)::int AS count,max(version) AS latest FROM schema_migrations", values: [] });
    expect(manifest.rows).toEqual([{ count: 72, latest: 'migrations/0072_ton_invoice_core.sql' }]);
    const inventory = await f.client.query({ text: "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'", values: [] });
    expect(inventory.rows).toEqual([{ count: 110 }]);
  }, 30000);

  it("matches all 18 applied function bodies and denies PUBLIC EXECUTE", async () => {
    const f = await open();
    const source = await readFile("packages/database/src/functions/ton-invoice-core.sql", "utf8");
    const expected = [...source.matchAll(/CREATE FUNCTION (\w+)\([^]*? AS \$\$([^]*?)\$\$;/g)];
    expect(expected).toHaveLength(18);
    const applied = await f.client.query<{ name: string; definition: string; invoker: boolean; public_execute: boolean; config: string[] }>({
      text: "SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition,NOT p.prosecdef AS invoker,p.proconfig AS config,EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname",
      values: [expected.map((match) => match[1])],
    });
    expect(applied.rows).toHaveLength(18);
    for (const match of expected) {
      const row = applied.rows.find((entry) => entry.name === match[1]);
      expect(row).toMatchObject({ invoker: true, public_execute: false, config: ["search_path=pg_catalog, public, pg_temp"] });
      expect(row?.definition.split("$function$")[1]?.trim()).toBe(match[2].trim());
    }
  });

  it("TON commit releases the org lock to a waiting real RUB refund", async () => {
    const f = await open({ initialPayg: "1000" });
    const invoice = await f.create({ grantMicrocredits: "300" });
    const payment = await f.makeRubTopup();
    const ton = await f.openSecondary();
    const rub = await f.openSecondary();
    const refunds = await import("../../../../apps/web/src/lib/payments/topup-refund");
    const domain = await import("../../src");
    const pid = async (client: typeof f.client) => (await client.query<{ pid: number }>({ text: "SELECT pg_backend_pid() AS pid", values: [] })).rows[0]!.pid;
    const [tonPid, rubPid] = await Promise.all([pid(ton.client), pid(rub.client)]);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settlement = domain.settleTonInvoice({ transaction: (run) => ton.db.transaction(async (tx) => {
      const result = await run(tx);
      entered();
      await gate;
      return result;
    }) }, invoice.invoiceId, f.verifiedCredit(invoice));
    let claim: ReturnType<typeof refunds.claimTopupRefund> | undefined;
    try {
      await held;
      claim = refunds.claimTopupRefund(payment.paymentId, 100, { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, route: "ACQ", source: "cards", receiptMode: "full_no_receipt" }, rub.refundDb);
      await expectBlocked(f.client, rubPid, tonPid);
    } finally { release(); }
    await expect(settlement).resolves.toMatchObject({ kind: "settled" });
    const claimed = await claim!;
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("TON_FIXTURE_CLAIM");
    await expect(refunds.markTopupRefundDispatched(claimed.claim.claimId, rub.refundDb)).resolves.toMatchObject({ kind: "marked" });
    await expect(refunds.finalizeTopupRefundProof(claimed.claim.claimId, { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, externalRequestId: claimed.claim.providerKey, status: "REFUNDED", originalAmountKopecks: 100, newAmountKopecks: 0 }, rub.refundDb)).resolves.toMatchObject({ kind: "settled" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "300", debt: "0", subscription: "0", receiptCount: 1, status: "settled" });
    await expectConservation(f, "300", "0", "300", "-1000");
    expect(defaultDbAccess.count).toBe(0);
  });

  it.each(["claim", "finalize"] as const)("real RUB %s holds the org lock before TON, which durably reviews", async (phase) => {
    const f = await open({ initialPayg: "100" });
    const invoice = await f.create({ grantMicrocredits: "300" });
    const payment = await f.makeRubTopup();
    const rub = await f.openSecondary();
    const ton = await f.openSecondary();
    const refunds = await import("../../../../apps/web/src/lib/payments/topup-refund");
    const domain = await import("../../src");
    const context = { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, route: "ACQ" as const, source: "cards" as const, receiptMode: "full_no_receipt" as const };
    const pid = async (client: typeof f.client) => (await client.query<{ pid: number }>({ text: "SELECT pg_backend_pid() AS pid", values: [] })).rows[0]!.pid;
    const [rubPid, tonPid, gatePid] = await Promise.all([pid(rub.client), pid(ton.client), pid(f.client)]);
    let existing: Awaited<ReturnType<typeof refunds.claimTopupRefund>> | undefined;
    if (phase === "finalize") {
      existing = await refunds.claimTopupRefund(payment.paymentId, 100, context, rub.refundDb);
      if (existing.kind !== "claimed") throw new Error("TON_FIXTURE_CLAIM");
      await refunds.markTopupRefundDispatched(existing.claim.claimId, rub.refundDb);
    }
    // A fixture-only BEFORE UPDATE trigger blocks the actual RUB function after
    // its org lock, without changing accepted RUB source or disabling any guard.
    const table = phase === "claim" ? "payments" : "organizations";
    await f.client.query({ text: "CREATE FUNCTION aiag_fixture_rub_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(718200,1); RETURN NEW; END $$", values: [] });
    await f.client.query({ text: `CREATE TRIGGER aiag_fixture_rub_gate BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION aiag_fixture_rub_gate()`, values: [] });
    await f.client.query({ text: "SELECT pg_advisory_lock($1,$2)", values: [718200, 1] });
    let rubWork: Promise<unknown> | undefined;
    let settlement: ReturnType<typeof domain.settleTonInvoice> | undefined;
    try {
      rubWork = phase === "claim"
        ? refunds.claimTopupRefund(payment.paymentId, 100, context, rub.refundDb)
        : refunds.finalizeTopupRefundProof(existing!.kind === "claimed" ? existing!.claim.claimId : "", { paymentId: payment.providerPaymentId, orderId: payment.providerOrderId, externalRequestId: existing!.kind === "claimed" ? existing!.claim.providerKey : "", status: "REFUNDED", originalAmountKopecks: 100, newAmountKopecks: 0 }, rub.refundDb);
      await expectBlocked(f.client, rubPid, gatePid);
      settlement = domain.settleTonInvoice(ton.db, invoice.invoiceId, f.verifiedCredit(invoice));
      await expectBlocked(f.client, tonPid, rubPid);
    } finally {
      await f.client.query({ text: "SELECT pg_advisory_unlock($1,$2)", values: [718200, 1] });
      await Promise.allSettled([rubWork, settlement]);
      await f.client.query({ text: `DROP TRIGGER aiag_fixture_rub_gate ON ${table}`, values: [] });
      await f.client.query({ text: "DROP FUNCTION aiag_fixture_rub_gate()", values: [] });
    }
    await expect(rubWork).resolves.toMatchObject({ kind: phase === "claim" ? "claimed" : "settled" });
    await expect(settlement).resolves.toMatchObject({ kind: "review_required", reason: "refund_blocked" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "refund_blocked" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: phase === "claim" ? "100" : "0", debt: phase === "claim" ? "0" : "900", receiptCount: 0, eventCount: 1, decisionCount: 1, status: "review_required" });
    await expectConservation(f, phase === "claim" ? "100" : "0", phase === "claim" ? "0" : "900", "0", phase === "claim" ? "0" : "-1000");
    expect(defaultDbAccess.count).toBe(0);
  });

  it("two pending invoices cannot together exceed the resulting PAYG ceiling", async () => {
    const f = await open({ initialPayg: "9007199254740987" });
    const first = await f.create({ grantMicrocredits: "3" });
    const second = await f.create({ grantMicrocredits: "3" });
    await expect(f.settle(first.invoiceId, f.verifiedCredit(first))).resolves.toMatchObject({ kind: "settled" });
    const credit = f.verifiedCredit(second);
    await expect(f.settle(second.invoiceId, credit)).resolves.toMatchObject({ kind: "review_required", reason: "balance_compatibility_limit" });
    await expect(f.snapshot(second.invoiceId)).resolves.toMatchObject({ payg: "9007199254740990", debt: "0", subscription: "0", receiptCount: 0 });
    await expectConservation(f, "9007199254740990", "0", "3", "0");
    await f.setOrgState("0");
    await expect(f.settle(second.invoiceId, credit)).resolves.toMatchObject({ kind: "review_required", reason: "balance_compatibility_limit" });
    await expect(f.snapshot(second.invoiceId)).resolves.toMatchObject({ receiptCount: 0, eventCount: 1, decisionCount: 1 });
  });

  it.each([
    ["grantMicrocredits", "03"], ["grantMicrocredits", "9223372036854775808"],
    ["recipient", "not-an-address"], ["priceRevision", "x".repeat(17000)],
    ["quote.sourcePrice.unit", "rub_kopecks"], ["quote.sourcePrice.amountAtomic", "4"],
    ["quote.fx.sourceUnit", "rub_kopecks"], ["quote.fx.denominator", "0"],
    ["quote.fx.numerator", "9223372036854775807"], ["quote.fx.rounding", "bankers"],
    ["quote.additionalFeeAtomic", "-1"], ["quote.additionalFeeAtomic", "9223372036854775807"],
    ["quote.amountAtomic", "6"], ["quote.asset.decimals", 6], ["invoiceId", "client-chosen"],
  ])("rejects malformed domain and direct SQL payload %s=%j with no writes", async (field, value) => {
    const f = await open();
    const input = f.createInput({ grantMicrocredits: "3" });
    const invoice = await f.createWithInput(input);
    const before = await f.snapshot(invoice.invoiceId);
    const malformed = JSON.parse(JSON.stringify(input));
    const parts = String(field).split(".");
    let target = malformed;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)!] = value;
    await expect(f.createWithInput(malformed)).rejects.toThrow();
    const payload = { schemaVersion: 1, purpose: "gateway_topup", ownerId: f.userId, orgId: f.orgId, ...malformed };
    await expect(f.client.query({ text: "SELECT aiag_ton_payload_v1($1::jsonb,$2::uuid,$3::uuid)", values: [JSON.stringify(payload), f.userId, f.orgId] })).rejects.toThrow(/TON_/);
    await expect(f.client.query({ text: "SELECT aiag_create_ton_invoice_v1($1::uuid,$2::uuid,$3::jsonb,$4::text)", values: [f.userId, f.orgId, JSON.stringify(payload), "0".repeat(64)] })).rejects.toThrow(/TON_/);
    await expect(f.snapshot(invoice.invoiceId)).resolves.toEqual(before);
    await expect(f.client.query({ text: "SELECT count(*)::int AS count FROM ton_invoices WHERE org_id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("rejects a column/quote snapshot mismatch before insertion", async () => {
    const f = await open();
    const invoice = await f.create({ grantMicrocredits: "3" });
    await expect(f.client.query({ text: "INSERT INTO ton_invoices SELECT (jsonb_populate_record(NULL::ton_invoices,to_jsonb(i)||jsonb_build_object('amount_atomic',99))).* FROM ton_invoices i WHERE i.id=$1::uuid", values: [invoice.invoiceId] })).rejects.toThrow("TON_SNAPSHOT_MISMATCH");
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ payg: "0", status: "pending", receiptCount: 0 });
  });

  it("cannot commit an intermediate confirmed invoice", async () => {
    const f = await open();
    const invoice = await f.create({ grantMicrocredits: "3" });
    const before = await f.snapshot(invoice.invoiceId);
    await f.client.query({ text: "BEGIN", values: [] });
    try {
      await f.client.query({ text: "UPDATE ton_invoices SET status='observed' WHERE id=$1::uuid", values: [invoice.invoiceId] });
      await f.client.query({ text: "UPDATE ton_invoices SET status='confirmed' WHERE id=$1::uuid", values: [invoice.invoiceId] });
      await expect(f.client.query({ text: "COMMIT", values: [] })).rejects.toThrow("TON_SETTLEMENT_INCONSISTENT");
    } finally { await f.client.query({ text: "ROLLBACK", values: [] }); }
    await expect(f.snapshot(invoice.invoiceId)).resolves.toEqual(before);
  });

  it.each(["event_id", "owner_user_id", "grant_microcredits", "order_id"])("rejects mismatched receipt %s at commit and rolls back money and evidence", async (field) => {
    const f = await open();
    const invoice = await f.create({ grantMicrocredits: "3" });
    const before = await f.snapshot(invoice.invoiceId);
    await f.client.query({ text: "CREATE FUNCTION aiag_fixture_bad_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='ton' AND NEW.type='topup' THEN NEW.metadata=jsonb_set(NEW.metadata,ARRAY[TG_ARGV[0]],to_jsonb('mismatch'::text)); END IF; RETURN NEW; END $$", values: [] });
    // `field` is one of the four literals in it.each, never external input.
    await f.client.query({ text: `CREATE TRIGGER aiag_fixture_bad_receipt_link BEFORE INSERT ON gateway_transactions FOR EACH ROW EXECUTE FUNCTION aiag_fixture_bad_receipt_link('${field}')`, values: [] });
    try {
      await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).rejects.toThrow("TON_SETTLEMENT_INCONSISTENT");
      await expect(f.snapshot(invoice.invoiceId)).resolves.toEqual(before);
    } finally {
      await f.client.query({ text: "DROP TRIGGER aiag_fixture_bad_receipt_link ON gateway_transactions", values: [] });
      await f.client.query({ text: "DROP FUNCTION aiag_fixture_bad_receipt_link()", values: [] });
    }
  });

  it("proves committed-state cleanup when the owned child is forcibly stopped", async () => {
    const f = await open();
    const invoice = await f.create({ grantMicrocredits: "3" });
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "settled" });
    await expect(f.snapshot(invoice.invoiceId)).resolves.toMatchObject({ receiptCount: 1, status: "settled" });
    if (process.env.AIAG_TON_CORE_FIXTURE_HANG_AFTER_COMMIT === "1") {
      // Only this guard-proven fixture can launch this one descendant. It stays
      // in the parent's detached group and deliberately ignores TERM to require KILL.
      const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: false, stdio: ["ignore", "pipe", "ignore"] });
      await new Promise<void>((resolveReady, reject) => {
        stubborn.stdout.once("data", () => resolveReady());
        stubborn.once("error", () => reject(new Error("TON_FIXTURE_CHILD_SPAWN")));
      });
      process.stdout.write("TON_FIXTURE_COMMITTED_HANG_READY\n");
      await new Promise<never>(() => {});
    }
  }, 240_000);

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
    const domain = await import("../../src");
    await expect(f.read(invoice.invoiceId)).resolves.toBeNull();
    await expect(domain.getTonInvoice(f.db, { actorUserId: nextOwner, orgId: f.orgId }, invoice.invoiceId)).resolves.toBeNull();
    await expect(f.settle(invoice.invoiceId, f.verifiedCredit(invoice))).resolves.toMatchObject({ kind: "review_required", reason: "owner_changed" });
  });

  it("denies an actual billing-enabled org member owner-only create and read", async () => {
    const f = await open();
    const member = await open();
    const invoice = await f.create({ grantMicrocredits: "3" });
    const domain = await import("../../src");
    await f.client.query({ text: "INSERT INTO organization_members (organization_id,user_id,role,permissions) VALUES ($1::uuid,$2::uuid,'admin',$3::jsonb)", values: [f.orgId, member.userId, JSON.stringify({ canManageBilling: true })] });
    const ctx = { actorUserId: member.userId, orgId: f.orgId };
    await expect(domain.getTonInvoice(f.db, ctx, invoice.invoiceId)).resolves.toBeNull();
    await expect(domain.createTonInvoice(f.db, ctx, f.createInput({ grantMicrocredits: "3" }), f.policy)).rejects.toThrow("TON_NOT_AUTHORIZED");
    await expect(f.client.query({ text: "SELECT count(*)::int AS count FROM ton_invoices WHERE org_id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("replays pinned jetton decimals after policy changes but denies new removed-asset keys", async () => {
    const f = await open();
    const jetton = { network: "tvm:-3", kind: "jetton", decimals: 9, masterAddress: `0:${"a".repeat(64)}` } as const;
    const base = f.createInput({ grantMicrocredits: "3" });
    const input = { ...base, quote: { ...base.quote, asset: jetton, fx: { ...base.quote.fx, targetAsset: jetton } } };
    f.policy.allowlist = [jetton];
    const invoice = await f.createWithInput(input);
    f.policy.allowlist = [{ ...jetton, decimals: 6 }];
    await expect(f.createWithInput(input)).resolves.toEqual(invoice);
    await expect(f.createWithInput({ ...input, idempotencyKey: "new-pinned-decimals" })).rejects.toThrow();
    f.policy.allowlist = [];
    await expect(f.createWithInput(input)).resolves.toEqual(invoice);
    await expect(f.createWithInput({ ...input, idempotencyKey: "new-removed-asset" })).rejects.toThrow();
    await expect(f.client.query({ text: "SELECT count(*)::int AS count FROM ton_invoices WHERE org_id=$1::uuid", values: [f.orgId] })).resolves.toMatchObject({ rows: [{ count: 1 }] });
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
