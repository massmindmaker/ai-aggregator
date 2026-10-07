import { closeOwnedPgClient } from "../owned-pg-cleanup";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect } from "vitest";
import { withOwnedAuthorDb } from "./author-owned-db.native.fixture";
import { installTonWorkerBoundary } from "../ton-worker-boundary";
import {
  createTonInvoice,
  type TonPaymentDatabase,
  type TonSqlClient,
} from "../../src";
import { createQuote } from "@aiag/shared/ton-payment-contract";

export async function withTonWorkerRoles(
  run: (f: {
    root: Client;
    clients: Record<"web" | "api" | "worker", Client>;
    roles: { web: string; api: string; worker: string; owner: string };
    url: string;
    makeInvoice: () => Promise<{ invoice: any; credit: any }>;
  }) => Promise<void>,
  install = true,
) {
  await withOwnedAuthorDb(async (_, url) => {
    const root = new Client({ connectionString: url, ssl: false });
    await root.connect();
    const prefix = "tb_" + randomUUID().replaceAll("-", "");
    const roles = {
        web: prefix + "_web",
        api: prefix + "_api",
        worker: prefix + "_worker",
        owner: prefix + "_owner",
      },
      clients = {} as Record<"web" | "api" | "worker", Client>,
      created: string[] = [];
    let failed = false,
      operationFailed = false;
    let operationError: unknown;
    try {
      for (const [kind, role] of Object.entries(roles)) {
        await root.query(
          'CREATE ROLE "' +
            role +
            '" ' +
            (kind === "owner" ? "NOLOGIN" : "LOGIN") +
            " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
        );
        created.push(role);
      }
      const makeInvoice = async () => {
        const owner = randomUUID(),
          org = randomUUID();
        await root.query("INSERT INTO public.users(id,email) VALUES($1,$2)", [
          owner,
          owner + "@example.test",
        ]);
        await root.query(
          "INSERT INTO public.organizations(id,slug,name,owner_id,payg_credits) VALUES($1,$2,'boundary',$3,0)",
          [org, org, owner],
        );
        const now = Number(
          (
            await root.query(
              "SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now",
            )
          ).rows[0].now,
        );
        const asset = {
          network: "tvm:-3" as const,
          kind: "native" as const,
          decimals: 9 as const,
        };
        const quote = createQuote(
          {
            quoteId: "fixture-" + randomUUID(),
            sourcePrice: { unit: "gateway_microcredits", amountAtomic: "1000" },
            asset,
            fx: {
              sourceUnit: "gateway_microcredits",
              targetAsset: asset,
              numerator: "1000000",
              denominator: "1",
              rounding: "floor",
              source: "fixture",
              observedAtMs: now - 10,
              expiresAtMs: now + 600000,
            },
            additionalFeeAtomic: "0",
            expiresAtMs: now + 600000,
          },
          [asset],
          now,
        );
        const db: TonPaymentDatabase = {
          transaction: async <T>(fn: (c: TonSqlClient) => Promise<T>) => {
            await root.query("BEGIN");
            try {
              const value = await fn({
                query: async (config) => {
                  const r = await root.query(config.text, [...config.values]);
                  return { rows: r.rows, rowCount: r.rowCount };
                },
              });
              await root.query("COMMIT");
              return value;
            } catch (e) {
              await root.query("ROLLBACK");
              throw e;
            }
          },
        };
        const invoice = await createTonInvoice(
          db,
          { actorUserId: owner, orgId: org },
          {
            idempotencyKey: randomUUID(),
            grantMicrocredits: "1000",
            priceRevision: "fixture-v1",
            quote,
            recipient: "0:" + "1".repeat(64),
            expectedSender: "0:" + "2".repeat(64),
            finalityPolicyId: "fixture-policy",
            verifierVersion: "fixture-verifier",
          },
          { allowlist: [asset] },
        );
        const h = invoice.invoiceId.replaceAll("-", "");
        const credit = {
          network: "tvm:-3",
          asset,
          recipient: invoice.recipient,
          recipientAccount: invoice.recipient,
          sender: invoice.expectedSender,
          amountAtomic: invoice.amountAtomic,
          reference: invoice.reference,
          txHash: h + h,
          txLt: "1",
          messageHash: "b".repeat(64),
          messageIndex: 0,
          chainTimeMs: now - 3,
          observedAtMs: now - 2,
          verifiedAtMs: now - 1,
          blockAnchor: "fixture-block",
          masterchainAnchor: "fixture-masterchain",
          executionPathDigest: "e".repeat(64),
          verifierVersion: invoice.verifierVersion,
          finalityPolicyId: invoice.finalityPolicyId,
          jettonCredit: null,
        };
        return { invoice, credit };
      };
      // 0099 pre-creates the production principal on every migrated database;
      // rehearsals must install their own parameterized copy behind the same
      // schema name, so remove the migrated copy before any install/sabotage.
      await root.query("DROP SCHEMA IF EXISTS aiag_ton_worker CASCADE");
      if (install) await installTonWorkerBoundary(url, roles);
      for (const kind of ["web", "api", "worker"] as const) {
        const u = new URL(url);
        u.username = roles[kind];
        u.password = "";
        const c = new Client({ connectionString: u.href, ssl: false });
        await c.connect();
        clients[kind] = c;
        expect(
          (await c.query("SELECT session_user,current_user")).rows[0],
        ).toEqual({ session_user: roles[kind], current_user: roles[kind] });
      }
      await run({ root, clients, roles, url, makeInvoice });
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      const closed = await Promise.all(
        Object.values(clients).map((c) => closeOwnedPgClient(c)),
      );
      if (closed.some((ok) => !ok)) failed = true;
      for (const role of created.reverse()) {
        try {
          await root.query('DROP OWNED BY "' + role + '" CASCADE');
          await root.query('DROP ROLE "' + role + '"');
        } catch {
          failed = true;
        }
      }
      if (!(await closeOwnedPgClient(root))) failed = true;
    }
    if (failed) throw Error("TON_ROLE_FIXTURE_CLEANUP_UNCONFIRMED");
    if (operationFailed) throw operationError;
  });
}
