import {
  createTonSettlementWorkerDatabase,
  settleTonInvoiceAsWorker,
} from "../../src/ton-reconciliation-internal";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { withTonWorkerRoles as scenario } from "./ton-worker-boundary.native.fixture";
async function call(c: Client, invoice: any, credit: any) {
  return (
    await c.query(
      "SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result",
      [invoice.invoiceId, JSON.stringify(credit)],
    )
  ).rows[0].result;
}
async function counts(c: Client, invoice: any) {
  return (
    await c.query(
      `SELECT o.payg_credits::text AS balance,(SELECT count(*)::int FROM public.gateway_transactions g WHERE g.org_id=o.id AND g.source='ton') AS receipts,(SELECT count(*)::int FROM public.ton_invoice_event_decisions d WHERE d.invoice_id=$1) AS decisions FROM public.organizations o WHERE o.id=$2`,
      [invoice.invoiceId, invoice.orgId],
    )
  ).rows[0];
}
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "actual worker-only PostgreSQL TON settlement",
  () => {
    it(
      "commits under real restricted login, replays identical receipt and rejects app/direct worker bypasses",
      async () =>
        scenario(async (f) => {
          const { invoice, credit } = await f.makeInvoice();
          for (const c of Object.values(f.clients)) {
            await expect(
              c.query("SELECT public.aiag_settle_ton_invoice_v1($1,$2)", [
                invoice.invoiceId,
                JSON.stringify(credit),
              ]),
            ).rejects.toMatchObject({ code: "42501" });
            for (const sql of [
              "UPDATE public.organizations SET payg_credits=payg_credits",
              "INSERT INTO public.ton_chain_events DEFAULT VALUES",
              "INSERT INTO public.gateway_transactions DEFAULT VALUES",
              "UPDATE public.ton_invoices SET status=status",
              "DELETE FROM public.ton_invoice_event_decisions",
              "TRUNCATE public.ton_invoices CASCADE",
            ])
              await expect(c.query(sql)).rejects.toMatchObject({
                code: "42501",
              });
            await expect(
              c.query('SET ROLE "' + f.roles.owner + '"'),
            ).rejects.toMatchObject({ code: "42501" });
            await expect(
              c.query('SET SESSION AUTHORIZATION "' + f.roles.owner + '"'),
            ).rejects.toMatchObject({ code: "42501" });
          }
          for (const c of [f.clients.web, f.clients.api])
            await expect(call(c, invoice, credit)).rejects.toMatchObject({
              code: "42501",
            });
          expect(await counts(f.root, invoice)).toEqual({
            balance: "0",
            receipts: 0,
            decisions: 0,
          });
          const first = await call(f.clients.worker, invoice, credit);
          expect(first.kind).toBe("settled");
          expect(first.receipt.grantMicrocredits).toBe("1000");
          const replay = await call(f.clients.worker, invoice, credit);
          expect(replay).toEqual({
            kind: "already_settled",
            receipt: first.receipt,
          });
          expect(await counts(f.root, invoice)).toEqual({
            balance: "1000",
            receipts: 1,
            decisions: 1,
          });
        }),
      120000,
    );
    it(
      "concurrent real worker sessions retain one credit and rollback before commit leaves no money",
      async () =>
        scenario(async (f) => {
          const u = new URL(f.url);
          u.username = f.roles.worker;
          u.password = "";
          const second = new Client({ connectionString: u.href, ssl: false });
          await second.connect();
          try {
            const { invoice, credit } = await f.makeInvoice();
            await f.clients.worker.query("BEGIN");
            expect((await call(f.clients.worker, invoice, credit)).kind).toBe(
              "settled",
            );
            await f.clients.worker.query("ROLLBACK");
            expect(await counts(f.root, invoice)).toEqual({
              balance: "0",
              receipts: 0,
              decisions: 0,
            });
            const outcomes = await Promise.all([
              call(f.clients.worker, invoice, credit),
              call(second, invoice, credit),
            ]);
            expect(outcomes.map((x) => x.kind).sort()).toEqual([
              "already_settled",
              "settled",
            ]);
            expect(outcomes[0].receipt).toEqual(outcomes[1].receipt);
            expect(await counts(f.root, invoice)).toEqual({
              balance: "1000",
              receipts: 1,
              decisions: 1,
            });
          } finally {
            await second.end();
          }
        }),
      120000,
    );
    it(
      "does not trust current_role alone and cannot be redirected by temporary objects",
      async () =>
        scenario(async (f) => {
          const { invoice, credit } = await f.makeInvoice();
          await f.root.query(
            'GRANT "' + f.roles.worker + '" TO "' + f.roles.web + '"',
          );
          await f.clients.web.query('SET ROLE "' + f.roles.worker + '"');
          await expect(call(f.clients.web, invoice, credit)).rejects.toThrow(
            "TON_SETTLEMENT_SESSION_REQUIRED",
          );
          await f.clients.web.query("RESET ROLE");
          await expect(
            f.clients.worker.query("CREATE TABLE public.evil(id int)"),
          ).rejects.toMatchObject({ code: "42501" });
          await f.clients.worker.query(
            "CREATE TEMP TABLE organizations(payg_credits bigint)",
          );
          await f.clients.worker.query(
            "CREATE TEMP TABLE ton_invoices(id uuid)",
          );
          await f.clients.worker.query("SET search_path=pg_temp,public");
          expect((await call(f.clients.worker, invoice, credit)).kind).toBe(
            "settled",
          );
          expect(await counts(f.root, invoice)).toEqual({
            balance: "1000",
            receipts: 1,
            decisions: 1,
          });
        }),
      120000,
    );
    it(
      "rejects unvalidated network/asset data without inserting event or granting balance",
      async () =>
        scenario(async (f) => {
          const { invoice, credit } = await f.makeInvoice();
          for (const invalid of [
            { ...credit, network: "tvm:-239" },
            {
              ...credit,
              asset: {
                network: "tvm:-3",
                kind: "jetton",
                decimals: 6,
                masterAddress: "0:" + "e".repeat(64),
              },
              jettonCredit: {
                masterAddress: "0:" + "e".repeat(64),
                merchantJettonWallet: "0:" + "f".repeat(64),
              },
            },
          ])
            await expect(
              call(f.clients.worker, invoice, invalid),
            ).rejects.toThrow("TON_SETTLEMENT_ASSET_UNSUPPORTED");
          expect(await counts(f.root, invoice)).toEqual({
            balance: "0",
            receipts: 0,
            decisions: 0,
          });
        }),
      120000,
    );

    it(
      "uses the real dedicated internal client, refuses owner mismatch and reconnects to the committed receipt",
      async () =>
        scenario(async (f) => {
          const { invoice, credit } = await f.makeInvoice(),
            url = new URL(f.url);
          url.username = f.roles.worker;
          url.password = "";
          const wrong = createTonSettlementWorkerDatabase(url.href, {
            workerRole: f.roles.worker,
            ownerRole: "wrong_owner",
          });
          try {
            await expect(
              settleTonInvoiceAsWorker(wrong, invoice.invoiceId, credit),
            ).rejects.toThrow("TON_SETTLEMENT_SESSION_REFUSED");
          } finally {
            expect(await wrong.close()).toEqual({ kind: "closed" });
          }
          expect(await counts(f.root, invoice)).toEqual({
            balance: "0",
            receipts: 0,
            decisions: 0,
          });
          const db = createTonSettlementWorkerDatabase(url.href, {
            workerRole: f.roles.worker,
            ownerRole: f.roles.owner,
          });
          let saved: any;
          try {
            saved = await settleTonInvoiceAsWorker(
              db,
              invoice.invoiceId,
              credit,
            );
            expect(saved.kind).toBe("settled");
          } finally {
            expect(await db.close()).toEqual({ kind: "closed" });
          }
          // Simulate lost acknowledgement after a confirmed commit by reconnecting without another identity.
          const restarted = createTonSettlementWorkerDatabase(url.href, {
            workerRole: f.roles.worker,
            ownerRole: f.roles.owner,
          });
          try {
            expect(
              await settleTonInvoiceAsWorker(
                restarted,
                invoice.invoiceId,
                credit,
              ),
            ).toEqual({ kind: "already_settled", receipt: saved.receipt });
          } finally {
            expect(await restarted.close()).toEqual({ kind: "closed" });
          }
          expect(await counts(f.root, invoice)).toEqual({
            balance: "1000",
            receipts: 1,
            decisions: 1,
          });
        }),
      120000,
    );
  },
);
