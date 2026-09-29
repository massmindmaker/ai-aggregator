import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTonInvoice, type TonInvoice } from "@aiag/database";
import { createQuote } from "@aiag/shared/ton-payment-contract";
import * as api from "@aiag/database/ton-reconciliation-internal";
import type { TonObserveReconcilerDeps } from "../ton-payment-reconciler.js";
import { reconcileTonInvoices } from "../ton-payment-reconciler.js";
import {
  TON_VERIFIER_VERSION,
  TON_FINALITY_POLICY_ID,
} from "../ton-payment-verifier.js";
import {
  source,
  evidence,
  cursor,
  deferred,
  fixture,
} from "./ton-recovery.fixture";
import { withOwnedAuthorDb } from "../../../../packages/database/scripts/__tests__/author-owned-db.native.fixture";

async function scenario(
  run: (f: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<Record<string, unknown>[]>;
    invoice: TonInvoice;
    deps: TonObserveReconcilerDeps;
    db: api.CloseableTonWorkerDatabase;
    reopen: () => TonObserveReconcilerDeps;
    input: {
      source: ReturnType<typeof source>;
      limit: number;
      signal: AbortSignal;
    };
    evidence: ReturnType<typeof evidence>;
  }) => Promise<void>,
) {
  await withOwnedAuthorDb(async (client, url) => {
    const databases: api.CloseableTonWorkerDatabase[] = [];
    const query = async (text: string, values: unknown[] = []) =>
      (await client.query({ text, values })).rows;
    const connect = () => {
      const db = api.createTonWorkerDatabase(url);
      databases.push(db);
      return db;
    };
    const db = connect(),
      owner = randomUUID(),
      org = randomUUID();
    try {
      await query("INSERT INTO users(id,email) VALUES($1,$2)", [
        owner,
        owner + "@example.test",
      ]);
      await query(
        "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1,$2,'ton-recovery-test',$3,0)",
        [org, org, owner],
      );
      const now = Number(
          (
            await query(
              "SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now",
            )
          )[0].now,
        ),
        asset = source().asset;
      const quote = createQuote(
        {
          quoteId: "synthetic-" + randomUUID(),
          sourcePrice: { unit: "gateway_microcredits", amountAtomic: "1000" },
          asset,
          fx: {
            sourceUnit: "gateway_microcredits",
            targetAsset: asset,
            numerator: "1000000",
            denominator: "1",
            rounding: "floor",
            source: "synthetic-test",
            observedAtMs: now - 1000,
            expiresAtMs: now + 600000,
          },
          additionalFeeAtomic: "0",
          expiresAtMs: now + 600000,
        },
        [asset],
        now,
      );
      const invoice = await createTonInvoice(
        db,
        { actorUserId: owner, orgId: org },
        {
          idempotencyKey: randomUUID(),
          grantMicrocredits: "1000",
          priceRevision: "synthetic-v1",
          quote,
          recipient: source().invoiceRecipient,
          expectedSender: "0:" + "2".repeat(64),
          finalityPolicyId: TON_FINALITY_POLICY_ID,
          verifierVersion: TON_VERIFIER_VERSION,
        },
        { allowlist: [asset] },
      );
      const e = evidence("1000", invoice.reference);
      e.source.fetchedAtMs = now + 1;
      e.transactions[0].chainTimeMs = now;
      const depsFor = (
        database: api.CloseableTonWorkerDatabase,
      ): TonObserveReconcilerDeps => ({
        ...fixture().deps,
        newLeaseOwner: randomUUID,
        getInvoice: (id) => api.getTonInvoiceForReconciliation(database, id),
        listSources: (input) =>
          api.listTonReconciliationSources(database, input),
        findInvoices: (input) =>
          api.findTonInvoicesForReconciliation(database, input),
        recordObservation: (input) =>
          api.recordTonChainObservation(database, input),
        claimLease: (input) => api.claimTonReconciliationLease(database, input),
        bindRecipient: (input) =>
          api.bindTonReconciliationRecipient(database, input),
        renewLease: (input) => api.renewTonReconciliationLease(database, input),
        advanceCursor: (input) =>
          api.advanceTonReconciliationCursor(database, input),
        releaseLease: (id, owner) =>
          api.releaseTonReconciliationLease(database, id, owner),
        provider: {
          resolveRecipientAccount: async () => ({
            kind: "resolved",
            recipientAccount: source().invoiceRecipient,
          }),
          scanAccountPage: async () => ({
            kind: "page",
            evidence: [structuredClone(e)],
            nextCursor: null,
            exhausted: true,
          }),
        },
      });
      const sources = await api.listTonReconciliationSources(db, {
        afterSourceId: null,
        limit: 16,
        assetKind: "native",
      });
      expect(sources).toHaveLength(1);
      await run({
        query,
        invoice,
        db,
        deps: depsFor(db),
        reopen: () => depsFor(connect()),
        input: {
          source: sources[0] as ReturnType<typeof source>,
          limit: 4,
          signal: new AbortController().signal,
        },
        evidence: e,
      });
      expect(
        (
          await query(
            "SELECT payg_credits::text AS amount FROM organizations WHERE id=$1",
            [org],
          )
        )[0],
      ).toEqual({ amount: "0" });
      expect(
        (await query("SELECT count(*)::int AS n FROM ton_chain_events"))[0],
      ).toEqual({ n: 0 });
    } finally {
      const closed = await Promise.all(databases.map((d) => d.close()));
      expect(closed.every((result) => result.kind === "closed")).toBe(true);
    }
  });
}

describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "TON observe runner with real persistence and separate connections",
  () => {
    it("persists one observation, recovers after lost observation ACK and gives no spendable credit", async () =>
      scenario(async (f) => {
        const original = f.deps.recordObservation;
        let lose = true;
        f.deps.recordObservation = async (data) => {
          const result = await original(data);
          if (lose) {
            lose = false;
            throw Error("lost committed observation ACK");
          }
          return result;
        };
        expect(await reconcileTonInvoices(f.input, f.deps)).toEqual({
          kind: "stopped",
          reason: "db_error",
          processed: 0,
          pagesAdvanced: 0,
        });
        const before = await f.query(
          "SELECT id::text,observation_key FROM ton_chain_observations",
        );
        expect(before).toHaveLength(1);
        expect(
          (
            await f.query(
              "SELECT cursor,lease_owner FROM ton_reconciliation_cursors",
            )
          )[0],
        ).toEqual({ cursor: null, lease_owner: null });
        expect(await reconcileTonInvoices(f.input, f.reopen())).toEqual({
          kind: "completed",
          processed: 1,
          pagesAdvanced: 1,
        });
        expect(
          await f.query(
            "SELECT id::text,observation_key FROM ton_chain_observations",
          ),
        ).toEqual(before);
        expect(
          (
            await f.query("SELECT status FROM ton_invoices WHERE id=$1", [
              f.invoice.invoiceId,
            ])
          )[0],
        ).toEqual({ status: "observed" });
      }));
    it("excludes a concurrent runner and holds no SQL transaction while provider work is pending", async () =>
      scenario(async (f) => {
        const gate = deferred<void>(),
          started = deferred<void>(),
          base = f.deps.provider.scanAccountPage;
        f.deps.provider.scanAccountPage = async (...args) => {
          started.resolve();
          await gate.promise;
          return base(...args);
        };
        const running = reconcileTonInvoices(f.input, f.deps);
        try {
          await started.promise;
          expect(
            (
              await f.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
              )
            )[0],
          ).toEqual({ n: 0 });
          const other = f.reopen();
          let calls = 0;
          other.provider.scanAccountPage = async () => {
            calls++;
            throw Error("must not scan");
          };
          expect(await reconcileTonInvoices(f.input, other)).toEqual({
            kind: "not_started",
            reason: "busy",
          });
          expect(calls).toBe(0);
        } finally {
          gate.resolve();
          await running;
        }
        expect(
          (
            await f.query(
              "SELECT count(*)::int AS n FROM ton_chain_observations",
            )
          )[0],
        ).toEqual({ n: 1 });
      }));
    it("discards a page after lease takeover and cannot release the replacement owner", async () =>
      scenario(async (f) => {
        const started = deferred<void>(),
          gate = deferred<void>(),
          base = f.deps.provider.scanAccountPage;
        f.deps.provider.scanAccountPage = async (...args) => {
          started.resolve();
          await gate.promise;
          return base(...args);
        };
        const running = reconcileTonInvoices(f.input, f.deps),
          replacement = randomUUID();
        try {
          await started.promise;
          await f.query(
            "UPDATE ton_reconciliation_cursors SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1",
            [f.input.source.sourceId],
          );
          expect(
            await api.claimTonReconciliationLease(f.db, {
              source: f.input.source,
              providerId: "toncenter-v3-testnet",
              leaseOwner: replacement,
              leaseMs: 90000,
            }),
          ).toMatchObject({ kind: "claimed" });
        } finally {
          gate.resolve();
        }
        expect(await running).toEqual({
          kind: "stopped",
          reason: "lease_lost",
          processed: 0,
          pagesAdvanced: 0,
        });
        expect(
          (
            await f.query(
              "SELECT lease_owner::text FROM ton_reconciliation_cursors",
            )
          )[0].lease_owner,
        ).toBe(replacement);
        expect(
          (
            await f.query(
              "SELECT count(*)::int AS n FROM ton_chain_observations",
            )
          )[0],
        ).toEqual({ n: 0 });
      }));
    it("uses the DB cursor after advance commit with lost ACK, never the old caller position", async () =>
      scenario(async (f) => {
        const original = f.deps.advanceCursor;
        f.deps.provider.scanAccountPage = async () => ({
          kind: "page",
          evidence: [f.evidence],
          nextCursor: cursor(),
          exhausted: false,
        });
        f.deps.advanceCursor = async (data) => {
          await original(data);
          throw Error("lost advance ACK");
        };
        expect(
          await reconcileTonInvoices({ ...f.input, limit: 1 }, f.deps),
        ).toMatchObject({
          kind: "stopped",
          reason: "db_error",
          pagesAdvanced: 0,
        });
        const resumed = f.reopen();
        let captured: unknown;
        resumed.provider.scanAccountPage = async (_account, c) => {
          captured = c;
          return {
            kind: "page",
            evidence: [],
            nextCursor: null,
            exhausted: true,
          };
        };
        expect(await reconcileTonInvoices(f.input, resumed)).toEqual({
          kind: "completed",
          processed: 0,
          pagesAdvanced: 1,
        });
        expect(captured).toEqual(cursor());
        expect(
          (await f.query("SELECT cursor FROM ton_reconciliation_cursors"))[0],
        ).toEqual({ cursor: null });
      }));
    it("persists source backoff and a later instance cannot fetch before DB next_attempt_at", async () =>
      scenario(async (f) => {
        f.deps.provider.scanAccountPage = async () => ({
          kind: "source_error",
          code: "rate_limited",
          retryAfterMs: 5000,
        });
        expect(await reconcileTonInvoices(f.input, f.deps)).toMatchObject({
          kind: "source_error",
          code: "rate_limited",
        });
        const row = (
          await f.query(
            "SELECT cursor,consecutive_failures,next_attempt_at>clock_timestamp() AS delayed FROM ton_reconciliation_cursors",
          )
        )[0];
        expect(row).toEqual({
          cursor: null,
          consecutive_failures: 1,
          delayed: true,
        });
        const again = f.reopen();
        again.provider.scanAccountPage = async () => {
          throw Error("must not call");
        };
        expect(await reconcileTonInvoices(f.input, again)).toEqual({
          kind: "not_started",
          reason: "busy",
        });
        expect(
          (
            await f.query("SELECT status FROM ton_invoices WHERE id=$1", [
              f.invoice.invoiceId,
            ])
          )[0],
        ).toEqual({ status: "pending" });
      }));
    it("shutdown after observation ACK leaves the cursor replayable and releases ownership once", async () =>
      scenario(async (f) => {
        const controller = new AbortController(),
          original = f.deps.recordObservation;
        f.deps.recordObservation = async (data) => {
          const result = await original(data);
          controller.abort();
          return result;
        };
        expect(
          await reconcileTonInvoices(
            { ...f.input, signal: controller.signal },
            f.deps,
          ),
        ).toMatchObject({
          kind: "stopped",
          reason: "shutdown",
          pagesAdvanced: 0,
        });
        expect(
          (
            await f.query(
              "SELECT cursor,lease_owner FROM ton_reconciliation_cursors",
            )
          )[0],
        ).toEqual({ cursor: null, lease_owner: null });
        expect(await reconcileTonInvoices(f.input, f.reopen())).toMatchObject({
          kind: "completed",
        });
        expect(
          (
            await f.query(
              "SELECT count(*)::int AS n FROM ton_chain_observations",
            )
          )[0],
        ).toEqual({ n: 1 });
      }));
  },
);
