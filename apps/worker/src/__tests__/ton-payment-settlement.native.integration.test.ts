import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { settlementScenario } from "./ton-settlement.native.fixture";
import { reconcileTonInvoicesWithFixtureSettlement } from "../ton-payment-reconciler.js";
import { deferred, cursor } from "./ton-recovery.fixture";
const done = { kind: "completed", processed: 1, pagesAdvanced: 1 };
async function balance(
  f: Parameters<Parameters<typeof settlementScenario>[0]>[0],
  expected = "1000",
) {
  expect(
    (
      await f.query(
        "SELECT payg_credits::text AS amount FROM organizations WHERE id=$1",
        [f.invoice.orgId],
      )
    )[0],
  ).toEqual({ amount: expected });
  expect(
    (
      await f.query(
        "SELECT count(*)::int AS n,coalesce(sum(delta),0)::text AS amount FROM gateway_transactions WHERE source='ton' AND type='topup' AND org_id=$1",
        [f.invoice.orgId],
      )
    )[0],
  ).toEqual({ n: expected === "0" ? 0 : 1, amount: expected });
}
const hook = (
  settle: Parameters<
    typeof reconcileTonInvoicesWithFixtureSettlement
  >[2]["settleVerifiedCredit"],
) => ({ mode: "settle" as const, settleVerifiedCredit: settle });
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "native TON verified candidate to one durable credit",
  () => {
    it(
      "settles only after durable observation; restart replays the same receipt and one grant",
      async () =>
        settlementScenario(async (f) => {
          const persist = f.deps.recordObservation;
          let lose = true;
          f.deps.recordObservation = async (input) => {
            const r = await persist(input);
            if (lose) {
              lose = false;
              throw Error("observation committed ACK lost");
            }
            return r;
          };
          const receipts: string[] = [];
          const runSettle = async (
            id: string,
            c: Parameters<typeof f.settle>[1],
          ) => {
            expect(
              (
                await f.query(
                  "SELECT count(*)::int AS n FROM ton_chain_observations",
                )
              )[0].n,
            ).toBe(1);
            const r = await f.settle(id, c);
            if ("receipt" in r) receipts.push(r.receipt.receiptId);
            return r;
          };
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(runSettle),
            ),
          ).toMatchObject({
            kind: "stopped",
            reason: "db_error",
            processed: 0,
          });
          await balance(f, "0");
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(runSettle),
            ),
          ).toEqual(done);
          const fresh = f.restartSettlement();
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              fresh.deps,
              hook(async (id, c) => {
                const r = await fresh.settle(id, c);
                expect(r.kind).toBe("already_settled");
                if ("receipt" in r)
                  expect(r.receipt.receiptId).toBe(receipts[0]);
                return r;
              }),
            ),
          ).toEqual(done);
          await balance(f);
          expect(
            (
              await f.query("SELECT count(*)::int AS n FROM ton_chain_events")
            )[0].n,
          ).toBe(1);
          expect(
            (
              await f.query(
                "SELECT count(*)::int AS n FROM ton_invoice_event_decisions",
              )
            )[0].n,
          ).toBe(1);
        }),
      120000,
    );
    it(
      "recovers real settlement commit with lost ACK without a second ledger grant",
      async () =>
        settlementScenario(async (f) => {
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(async (id, c) => {
                await f.settle(id, c);
                throw Error("settled ACK lost");
              }),
            ),
          ).toMatchObject({
            kind: "stopped",
            reason: "db_error",
            processed: 0,
          });
          await balance(f);
          expect(
            (await f.query("SELECT cursor FROM ton_reconciliation_cursors"))[0]
              .cursor,
          ).toBeNull();
          await f.db.close();
          const restarted = f.restartSettlement();
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              restarted.deps,
              hook(restarted.settle),
            ),
          ).toEqual(done);
          await balance(f);
        }),
      120000,
    );
    it(
      "reclaims committed cursor after lost advance ACK without replaying inference or double credit",
      async () =>
        settlementScenario(async (f) => {
          const next = {
            schemaVersion: 1 as const,
            beforeLt: "1000",
            beforeTransactionHash: f.evidence.transactions[0].hash,
            cycleUpperLt: "1000",
          };
          f.deps.provider.scanAccountPage = async () => ({
            kind: "page",
            evidence: [f.evidence],
            nextCursor: next,
            exhausted: false,
          });
          const advance = f.deps.advanceCursor;
          f.deps.advanceCursor = async (v) => {
            await advance(v);
            throw Error("cursor committed ACK lost");
          };
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              { ...f.input, limit: 1 },
              f.deps,
              hook(f.settle),
            ),
          ).toMatchObject({
            kind: "stopped",
            reason: "db_error",
            processed: 0,
          });
          expect(
            (await f.query("SELECT cursor FROM ton_reconciliation_cursors"))[0]
              .cursor,
          ).toEqual(next);
          const restarted = f.restartSettlement();
          let calls = 0;
          restarted.deps.provider.scanAccountPage = async (
            _account,
            position,
          ) => {
            expect(position).toEqual(next);
            return {
              kind: "page",
              evidence: [],
              nextCursor: null,
              exhausted: true,
            };
          };
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              restarted.deps,
              hook(async (id, c) => {
                calls++;
                return restarted.settle(id, c);
              }),
            ),
          ).toEqual({ kind: "completed", processed: 0, pagesAdvanced: 1 });
          expect(calls).toBe(0);
          await balance(f);
        }),
      120000,
    );
    it(
      "records review after owner change with no grant and replays the same durable event decision",
      async () =>
        settlementScenario(async (f) => {
          const owner = randomUUID();
          await f.query("INSERT INTO users(id,email) VALUES($1,$2)", [
            owner,
            owner + "@example.test",
          ]);
          await f.query("UPDATE organizations SET owner_id=$1 WHERE id=$2", [
            owner,
            f.invoice.orgId,
          ]);
          const kinds: string[] = [];
          const settle = async (
            id: string,
            c: Parameters<typeof f.settle>[1],
          ) => {
            const r = await f.settle(id, c);
            kinds.push(r.kind);
            expect(r).toMatchObject({
              kind: "review_required",
              invoiceId: f.invoice.invoiceId,
              reason: "owner_changed",
            });
            return r;
          };
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(settle),
            ),
          ).toEqual(done);
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.reopen(),
              hook(settle),
            ),
          ).toEqual(done);
          await balance(f, "0");
          expect(kinds).toEqual(["review_required", "review_required"]);
          expect(
            (
              await f.query(
                "SELECT count(*)::int AS n FROM ton_invoice_event_decisions",
              )
            )[0].n,
          ).toBe(1);
        }),
      120000,
    );
    it(
      "persists a distinct conflict observation before cursor advance and survives its lost ACK",
      async () =>
        settlementScenario(async (f) => {
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(f.settle),
            ),
          ).toEqual(done);
          const changed = structuredClone(f.evidence);
          changed.transactions[0].lt = "1001";
          f.deps.provider.scanAccountPage = async () => ({
            kind: "page",
            evidence: [changed],
            nextCursor: null,
            exhausted: true,
          });
          let lose = true;
          const record = f.deps.recordObservation;
          f.deps.recordObservation = async (data) => {
            const r = await record(data);
            if (data.result.reason === "settlement_evidence_conflict" && lose) {
              lose = false;
              throw Error("conflict committed ACK lost");
            }
            return r;
          };
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(f.settle),
            ),
          ).toMatchObject({ kind: "stopped", processed: 0 });
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              f.deps,
              hook(f.settle),
            ),
          ).toEqual(done);
          expect(
            (
              await f.query(
                "SELECT count(*)::int AS n FROM ton_chain_observations WHERE result_kind='review_required' AND reason='settlement_evidence_conflict'",
              )
            )[0].n,
          ).toBe(1);
          await balance(f);
          expect(
            (
              await f.query("SELECT status FROM ton_invoices WHERE id=$1", [
                f.invoice.invoiceId,
              ])
            )[0].status,
          ).toBe("settled");
        }),
      120000,
    );
    it(
      "serializes concurrent worker claims while a settlement dependency is in flight",
      async () =>
        settlementScenario(async (f) => {
          const entered = deferred<void>(),
            release = deferred<void>();
          let calls = 0;
          const pending = reconcileTonInvoicesWithFixtureSettlement(
            f.input,
            f.deps,
            hook(async (id, c) => {
              calls++;
              entered.resolve();
              await release.promise;
              return f.settle(id, c);
            }),
          );
          await entered.promise;
          try {
            const second = f.restartSettlement();
            expect(
              await reconcileTonInvoicesWithFixtureSettlement(
                f.input,
                second.deps,
                hook(async (id, c) => {
                  calls++;
                  return second.settle(id, c);
                }),
              ),
            ).toEqual({ kind: "not_started", reason: "busy" });
          } finally {
            release.resolve();
          }
          expect(await pending).toEqual(done);
          expect(calls).toBe(1);
          await balance(f);
        }),
      120000,
    );
    it.each(["before_settlement", "after_commit"] as const)(
      "retains one SQL authority and cannot clear a replacement lease at %s",
      async (phase) =>
        settlementScenario(async (f) => {
          const replacement = randomUUID();
          async function takeOver() {
            await f.query(
              "UPDATE ton_reconciliation_cursors SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1",
              [f.input.source.sourceId],
            );
            expect(
              await f.deps.claimLease({
                source: f.input.source,
                providerId: "toncenter-v3-testnet",
                leaseOwner: replacement,
                leaseMs: 90000,
              }),
            ).toMatchObject({ kind: "claimed" });
          }
          const original = f.deps.recordObservation;
          let called = 0;
          f.deps.recordObservation = async (data) => {
            const ack = await original(data);
            if (phase === "before_settlement") await takeOver();
            return ack;
          };
          const result = await reconcileTonInvoicesWithFixtureSettlement(
            f.input,
            f.deps,
            hook(async (id, credit) => {
              called++;
              const ack = await f.settle(id, credit);
              if (phase === "after_commit") await takeOver();
              return ack;
            }),
          );
          expect(result).toEqual({
            kind: "stopped",
            reason: "lease_lost",
            processed: 0,
            pagesAdvanced: 0,
          });
          expect(called).toBe(phase === "after_commit" ? 1 : 0);
          expect(
            (
              await f.query(
                "SELECT lease_owner::text,cursor FROM ton_reconciliation_cursors",
              )
            )[0],
          ).toEqual({ lease_owner: replacement, cursor: null });
          await balance(f, phase === "after_commit" ? "1000" : "0");
          expect(
            await f.deps.releaseLease(f.input.source.sourceId, replacement),
          ).toBe("released");
          const restart = f.restartSettlement();
          expect(
            await reconcileTonInvoicesWithFixtureSettlement(
              f.input,
              restart.deps,
              hook(restart.settle),
            ),
          ).toEqual(done);
          await balance(f);
        }),
      120000,
    );
  },
);
