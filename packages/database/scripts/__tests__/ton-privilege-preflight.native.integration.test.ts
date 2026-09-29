import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { withOwnedAuthorDb } from "./author-owned-db.native.fixture";
import {
  inspectTonPrivileges,
  withTonPrivilegeSnapshot,
} from "../ton-privilege-preflight";

// Real PostgreSQL, distinct actual logins; fixture roles are random and never deployed.
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "TON effective privilege preflight",
  () => {
    it(
      "detects real ACL bypass paths without modifying protected state or claiming runtime readiness",
      async () =>
        withOwnedAuthorDb(async (c, url) => {
          const prefix =
            "ton_audit_" + randomUUID().replaceAll("-", "").slice(0, 16);
          const roles = {
            web: prefix + "_web",
            api: prefix + "_api",
            worker: prefix + "_worker",
          };
          const inherited = prefix + "_inherited",
            setter = prefix + "_setter";
          const names = [...Object.values(roles), inherited, setter];
          const query = async (text: string, values: unknown[] = []) =>
            (await c.query({ text, values })).rows;
          const audit = () => inspectTonPrivileges(c, roles);
          const codes = (report: Awaited<ReturnType<typeof audit>>) =>
            report.findings.map((f) => f.code);
          async function mutation(sql: string, code: string) {
            await query("BEGIN");
            try {
              await query(sql);
              expect(codes(await audit())).toContain(code);
            } finally {
              await query("ROLLBACK");
            }
          }
          try {
            for (const role of names) {
              if (!/^[a-z0-9_]+$/.test(role))
                throw Error("unsafe test identity");
              await query(
                'CREATE ROLE "' +
                  role +
                  '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
              );
            }
            for (const role of Object.values(roles))
              await query('GRANT USAGE ON SCHEMA public TO "' + role + '"');
            await query(
              'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "' +
                roles.worker +
                '"',
            );
            await query(
              'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "' +
                roles.worker +
                '"',
            );
            await query(
              'GRANT INSERT, UPDATE ON public.ton_invoices,public.ton_chain_events,public.ton_invoice_event_decisions,public.gateway_transactions,public.organizations TO "' +
                roles.worker +
                '"',
            );
            const before = await query(
              "SELECT count(*)::text AS n FROM public.gateway_transactions",
            );
            const clean = await audit();
            expect(clean.status, JSON.stringify(clean.findings)).toBe(
              "review_required",
            );
            expect(clean.runtimeSettlementAllowed).toBe(false);
            expect(
              clean.findings.filter((f) => f.severity === "blocker"),
            ).toEqual([]);
            expect((await withTonPrivilegeSnapshot(c, roles)).status).toBe(
              "review_required",
            );
            expect(
              (
                await query(
                  "SELECT current_setting('transaction_read_only') AS value",
                )
              )[0].value,
            ).toBe("off");
            const workerUrl = new URL(url);
            workerUrl.username = roles.worker;
            workerUrl.password = "";
            const workerClient = new Client({
              connectionString: workerUrl.href,
              ssl: false,
            });
            await workerClient.connect();
            try {
              expect(
                (await workerClient.query("SELECT current_user AS role"))
                  .rows[0].role,
              ).toBe(roles.worker);
              await expect(
                workerClient.query(
                  "SELECT public.aiag_settle_ton_invoice_v1('00000000-0000-4000-8000-000000000001'::uuid,'{}'::jsonb)",
                ),
              ).rejects.toMatchObject({ code: "P0001" });
            } finally {
              await workerClient.end();
            }
            // Login, not merely SET ROLE on an admin session. No fake transfer or grant.
            for (const role of [roles.web, roles.api]) {
              const u = new URL(url);
              u.username = role;
              u.password = "";
              const app = new Client({ connectionString: u.href, ssl: false });
              await app.connect();
              try {
                expect(
                  (await app.query("SELECT current_user AS role")).rows[0].role,
                ).toBe(role);
                await expect(
                  app.query(
                    "SELECT public.aiag_settle_ton_invoice_v1('00000000-0000-4000-8000-000000000001'::uuid,'{}'::jsonb)",
                  ),
                ).rejects.toMatchObject({ code: "42501" });
                await expect(
                  app.query(
                    "UPDATE public.organizations SET payg_credits=payg_credits",
                  ),
                ).rejects.toMatchObject({ code: "42501" });
              } finally {
                await app.end();
              }
            }
            expect(
              codes(
                await inspectTonPrivileges(c, { ...roles, worker: roles.web }),
              ),
            ).toContain("SHARED_RUNTIME_ROLE");
            expect(
              codes(
                await inspectTonPrivileges(c, {
                  ...roles,
                  worker: prefix + "_missing",
                }),
              ),
            ).toContain("ROLE_MISSING");
            await mutation(
              'GRANT EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) TO "' +
                roles.web +
                '"',
              "APPLICATION_SETTLEMENT_EXECUTE",
            );
            await mutation(
              "GRANT EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) TO PUBLIC",
              "APPLICATION_SETTLEMENT_EXECUTE",
            );
            await mutation(
              'GRANT UPDATE(payg_credits) ON public.organizations TO "' +
                roles.api +
                '"',
              "APPLICATION_PROTECTED_WRITE",
            );
            await mutation(
              'GRANT EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) TO "' +
                inherited +
                '"; GRANT "' +
                inherited +
                '" TO "' +
                roles.web +
                '" WITH INHERIT TRUE, SET FALSE',
              "APPLICATION_SETTLEMENT_EXECUTE",
            );
            await mutation(
              'GRANT EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) TO "' +
                setter +
                '"; GRANT "' +
                setter +
                '" TO "' +
                roles.api +
                '" WITH INHERIT FALSE, SET TRUE',
              "APPLICATION_SETTLEMENT_EXECUTE",
            );
            await mutation(
              'GRANT CREATE ON SCHEMA public TO "' + roles.web + '"',
              "APPLICATION_SCHEMA_CREATE",
            );
            await mutation(
              'ALTER ROLE "' + roles.api + '" CREATEROLE',
              "ELEVATED_APPLICATION_ROLE",
            );
            await mutation(
              "ALTER TABLE public.ton_invoices DISABLE TRIGGER ton_invoice_guard",
              "PROTECTION_TRIGGER_MISSING",
            );
            await mutation(
              'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO "' +
                roles.web +
                '"',
              "APPLICATION_DEFAULT_GRANT",
            );
            await mutation(
              `CREATE FUNCTION public.ton_audit_bypass() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$; GRANT EXECUTE ON FUNCTION public.ton_audit_bypass() TO "${roles.web}"`,
              "UNREVIEWED_DEFINER",
            );
            await mutation(
              'REVOKE EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) FROM "' +
                roles.worker +
                '"',
              "WORKER_SETTLEMENT_UNAVAILABLE",
            );
            expect(
              await query(
                "SELECT count(*)::text AS n FROM public.gateway_transactions",
              ),
            ).toEqual(before);
            await mutation(
              "CREATE FUNCTION public.ton_audit_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; DROP TRIGGER ton_invoice_guard ON public.ton_invoices; CREATE TRIGGER ton_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ton_invoices FOR EACH ROW EXECUTE FUNCTION public.ton_audit_noop()",
              "PROTECTION_TRIGGER_MISSING",
            );
            await mutation(
              "DROP TABLE public.users CASCADE",
              "WORKER_INVOKER_RIGHTS_MISSING",
            );
            await mutation(
              `DROP TABLE public.users CASCADE; CREATE VIEW public.users AS SELECT 1 AS id; GRANT SELECT ON public.users TO "${roles.worker}"`,
              "WORKER_INVOKER_RIGHTS_MISSING",
            );
            expect((await audit()).status).toBe("review_required");
          } finally {
            for (const name of names) {
              await query('DROP OWNED BY "' + name + '"');
              await query('DROP ROLE "' + name + '"');
            }
          }
        }),
      180000,
    );
  },
);
