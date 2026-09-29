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

export async function settlementScenario(
  run: (f: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<Record<string, unknown>[]>;
    invoice: TonInvoice;
    deps: TonObserveReconcilerDeps;
    settle: (
      id: string,
      credit: import("@aiag/database").VerifiedChainCredit,
    ) => Promise<import("@aiag/database").TonSettlementResult>;
    restartSettlement: () => {
      deps: TonObserveReconcilerDeps;
      settle: (
        id: string,
        credit: import("@aiag/database").VerifiedChainCredit,
      ) => Promise<import("@aiag/database").TonSettlementResult>;
    };
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
        settle: (id, credit) => api.settleTonInvoice(db, id, credit),
        restartSettlement: () => {
          const fresh = connect();
          return {
            deps: depsFor(fresh),
            settle: (id, credit) => api.settleTonInvoice(fresh, id, credit),
          };
        },
        reopen: () => depsFor(connect()),
        input: {
          source: sources[0] as ReturnType<typeof source>,
          limit: 4,
          signal: new AbortController().signal,
        },
        evidence: e,
      });
    } finally {
      const closed = await Promise.all(databases.map((d) => d.close()));
      expect(closed.every((result) => result.kind === "closed")).toBe(true);
    }
  });
}
