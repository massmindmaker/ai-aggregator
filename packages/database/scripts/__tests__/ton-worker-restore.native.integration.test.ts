import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTonWorkerRoles } from "./ton-worker-boundary.native.fixture";
import { rehearseTonWorkerRestore } from "../ton-worker-restore";
import {
  createTonSettlementWorkerDatabase,
  settleTonInvoiceAsWorker,
} from "../../src/ton-reconciliation-internal";
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "real pg_dump/pg_restore monetary role rehearsal",
  () => {
    it(
      "restores schema, grants, receipt and pending obligation without touching original balances",
      async () =>
        withTonWorkerRoles(async (f) => {
          const first = await f.makeInvoice(),
            pending = await f.makeInvoice(),
            workerUrl = new URL(f.url);
          workerUrl.username = f.roles.worker;
          workerUrl.password = "";
          const worker = createTonSettlementWorkerDatabase(workerUrl.href, {
            workerRole: f.roles.worker,
            ownerRole: f.roles.owner,
          });
          let receipt: any;
          try {
            const result = await settleTonInvoiceAsWorker(
              worker,
              first.invoice.invoiceId,
              first.credit,
            );
            expect(result.kind).toBe("settled");
            if ("receipt" in result) receipt = result.receipt;
          } finally {
            await worker.close();
          }
          const sourceCounts = (
            await f.root.query(
              "SELECT count(*)::int AS n FROM public.gateway_transactions",
            )
          ).rows;
          const proof = await rehearseTonWorkerRestore(
            f.url,
            f.roles,
            async (restoredUrl) => {
              const control = new Client({
                connectionString: restoredUrl,
                ssl: false,
              });
              await control.connect();
              const u = new URL(restoredUrl);
              u.username = f.roles.worker;
              u.password = "";
              const restored = createTonSettlementWorkerDatabase(u.href, {
                workerRole: f.roles.worker,
                ownerRole: f.roles.owner,
              });
              try {
                expect(
                  await settleTonInvoiceAsWorker(
                    restored,
                    first.invoice.invoiceId,
                    first.credit,
                  ),
                ).toEqual({ kind: "already_settled", receipt });
                expect(
                  (
                    await settleTonInvoiceAsWorker(
                      restored,
                      pending.invoice.invoiceId,
                      pending.credit,
                    )
                  ).kind,
                ).toBe("settled");
                expect(
                  (
                    await control.query(
                      "SELECT payg_credits::text AS amount FROM public.organizations WHERE id=$1",
                      [pending.invoice.orgId],
                    )
                  ).rows[0].amount,
                ).toBe("1000");
                const a = new URL(restoredUrl);
                a.username = f.roles.api;
                a.password = "";
                const app = new Client({
                  connectionString: a.href,
                  ssl: false,
                });
                await app.connect();
                try {
                  await expect(
                    app.query(
                      "SELECT aiag_ton_worker.settle_invoice_v1($1,$2)",
                      [
                        pending.invoice.invoiceId,
                        JSON.stringify(pending.credit),
                      ],
                    ),
                  ).rejects.toMatchObject({ code: "42501" });
                  await expect(
                    app.query("UPDATE public.organizations SET payg_credits=0"),
                  ).rejects.toMatchObject({ code: "42501" });
                } finally {
                  await app.end();
                }
              } finally {
                await restored.close();
                await control.end();
              }
            },
          );
          expect(proof).toMatchObject({
            kind: "restored_and_verified_local",
            ownershipAndGrantsPreserved: true,
            sourceUnchanged: true,
            destinationRemoved: true,
            archiveRemoved: true,
          });
          expect(proof.tablesCompared).toBeGreaterThan(100);
          expect(
            (
              await f.root.query(
                "SELECT payg_credits::text AS amount FROM public.organizations WHERE id=$1",
                [pending.invoice.orgId],
              )
            ).rows[0].amount,
          ).toBe("0");
          expect(
            (
              await f.root.query(
                "SELECT count(*)::int AS n FROM public.gateway_transactions",
              )
            ).rows,
          ).toEqual(sourceCounts);
        }),
      180000,
    );
    it(
      "cleans its destination and archive after verification failure while leaving source available",
      async () =>
        withTonWorkerRoles(async (f) => {
          const list = async () =>
            (
              await f.root.query(
                "SELECT datname FROM pg_catalog.pg_database WHERE datname LIKE 'aiag_restore_%' ORDER BY datname",
              )
            ).rows;
          const before = await list();
          await expect(
            rehearseTonWorkerRestore(f.url, f.roles, async () => {
              throw Error("synthetic verification failure");
            }),
          ).rejects.toThrow("TON_RESTORE_REHEARSAL_FAILED");
          expect(await list()).toEqual(before);
          expect(
            (await f.root.query("SELECT current_database() AS name")).rows[0]
              .name,
          ).toBe(new URL(f.url).pathname.slice(1));
        }),
      180000,
    );
    it(
      "cleans a created destination even after its commit acknowledgement is lost",
      async () =>
        withTonWorkerRoles(async (f) => {
          const original = Client.prototype.query;
          let createdName: string | undefined;
          const spy = vi
            .spyOn(Client.prototype, "query")
            .mockImplementation(function (this: Client, ...args: unknown[]) {
              const text = args[0];
              const work = Reflect.apply(original, this, args);
              if (
                typeof text === "string" &&
                /^CREATE DATABASE "aiag_restore_[a-f0-9]{32}" TEMPLATE template0$/.test(
                  text,
                )
              ) {
                createdName = text.split('"')[1];
                return Promise.resolve(work).then(() => {
                  throw Error("synthetic lost CREATE DATABASE acknowledgement");
                });
              }
              return work;
            } as never);
          try {
            await expect(
              rehearseTonWorkerRestore(f.url, f.roles, async () => {
                throw Error("must not enter");
              }),
            ).rejects.toThrow("TON_RESTORE_REHEARSAL_FAILED");
            expect(createdName).toBeTruthy();
            expect(
              (
                await f.root.query(
                  "SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",
                  [createdName],
                )
              ).rows,
            ).toHaveLength(0);
          } finally {
            spy.mockRestore();
            if (createdName && /^aiag_restore_[a-f0-9]{32}$/.test(createdName))
              await f.root.query(
                'DROP DATABASE IF EXISTS "' + createdName + '" WITH (FORCE)',
              );
          }
        }),
      180000,
    );
    it(
      "never deletes a same-name database when CREATE definitively reports a competing object",
      async () =>
        withTonWorkerRoles(async (f) => {
          const original = Client.prototype.query;
          let createdName: string | undefined;
          const spy = vi
            .spyOn(Client.prototype, "query")
            .mockImplementation(function (this: Client, ...args: unknown[]) {
              const text = args[0];
              if (
                typeof text === "string" &&
                /^CREATE DATABASE "aiag_restore_[a-f0-9]{32}" TEMPLATE template0$/.test(
                  text,
                )
              ) {
                createdName = text.split('"')[1];
                return Promise.resolve(
                  Reflect.apply(original, f.root, args),
                ).then(() => Reflect.apply(original, this, args));
              }
              return Reflect.apply(original, this, args);
            } as never);
          try {
            await expect(
              rehearseTonWorkerRestore(f.url, f.roles, async () => {
                throw Error("must not enter");
              }),
            ).rejects.toThrow("TON_RESTORE_REHEARSAL_FAILED");
            expect(createdName).toBeTruthy();
            expect(
              (
                await f.root.query(
                  "SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",
                  [createdName],
                )
              ).rows,
            ).toHaveLength(1);
          } finally {
            spy.mockRestore();
            if (createdName && /^aiag_restore_[a-f0-9]{32}$/.test(createdName))
              await f.root.query(
                'DROP DATABASE IF EXISTS "' + createdName + '" WITH (FORCE)',
              );
          }
        }),
      180000,
    );
  },
);
