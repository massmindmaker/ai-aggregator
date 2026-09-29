import { describe, expect, it } from "vitest";
import { withTonWorkerRoles } from "./ton-worker-boundary.native.fixture";
import { installTonWorkerBoundary } from "../ton-worker-boundary";
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === "1")(
  "atomic local TON privilege installation",
  () => {
    it.each([
      [
        "elevated worker",
        "TON_BOUNDARY_ROLE_STATE_UNSAFE",
        (f: any) => 'ALTER ROLE "' + f.roles.worker + '" CREATEROLE',
      ],
      [
        "inherited owner",
        "TON_BOUNDARY_MEMBERSHIP_UNSAFE",
        (f: any) => 'GRANT "' + f.roles.owner + '" TO "' + f.roles.web + '"',
      ],
      [
        "direct column money write",
        "TON_BOUNDARY_DIRECT_WRITE_UNSAFE",
        (f: any) =>
          'GRANT UPDATE(payg_credits) ON public.organizations TO "' +
          f.roles.api +
          '"',
      ],
      [
        "PUBLIC core execute",
        "TON_BOUNDARY_FUNCTION_AUTHORITY_UNSAFE",
        () =>
          "GRANT EXECUTE ON FUNCTION public.aiag_settle_ton_invoice_v1(uuid,jsonb) TO PUBLIC",
      ],
      [
        "public schema creation",
        "TON_BOUNDARY_SCHEMA_UNSAFE",
        () => "GRANT CREATE ON SCHEMA public TO PUBLIC",
      ],
      [
        "rewritten core helper",
        "TON_BOUNDARY_CORE_DRIFT",
        () =>
          `CREATE OR REPLACE FUNCTION public.aiag_ton_receipt_json_v1(_invoice uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$SELECT '{}'::jsonb$$`,
      ],
      [
        "changed trigger scope",
        "TON_BOUNDARY_TRIGGER_DRIFT",
        () =>
          "DROP TRIGGER ton_invoice_guard ON public.ton_invoices; CREATE TRIGGER ton_invoice_guard BEFORE UPDATE ON public.ton_invoices FOR EACH ROW EXECUTE FUNCTION public.aiag_ton_invoice_guard_v1()",
      ],
      [
        "missing trusted relation",
        "TON_BOUNDARY_RELATION_DRIFT",
        () => "ALTER TABLE public.users RENAME TO missing_users",
      ],
      [
        "additional monetary trigger",
        "TON_BOUNDARY_TRIGGER_DRIFT",
        () =>
          `CREATE FUNCTION public.unexpected_money_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.payg_credits:=NEW.payg_credits+1;RETURN NEW;END$$; CREATE TRIGGER extra_money BEFORE UPDATE OF payg_credits ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.unexpected_money_trigger()`,
      ],
      [
        "mid-install missing column",
        "TON_BOUNDARY_INSTALL_FAILED",
        () => "ALTER TABLE public.ton_invoices DROP COLUMN review_reason",
      ],
    ] as const)(
      "refuses %s with no partial wrapper/schema/grant",
      async (_name, code, mutation) =>
        withTonWorkerRoles(async (f) => {
          await f.root.query(mutation(f));
          const before = (
            await f.root.query(
              `SELECT relname,relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname IN('ton_invoices','ton_chain_events','gateway_transactions') ORDER BY relname`,
            )
          ).rows;
          await expect(
            installTonWorkerBoundary(f.url, f.roles),
          ).rejects.toThrow(code);
          expect(
            (
              await f.root.query(
                "SELECT to_regnamespace('aiag_ton_worker') AS schema",
              )
            ).rows[0].schema,
          ).toBeNull();
          expect(
            (
              await f.root.query(
                `SELECT relname,relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relname IN('ton_invoices','ton_chain_events','gateway_transactions') ORDER BY relname`,
              )
            ).rows,
          ).toEqual(before);
        }, false),
      120000,
    );
    it(
      "does not silently replace an installed boundary or weaken grants on rerun",
      async () =>
        withTonWorkerRoles(async (f) => {
          const read = async () =>
            (
              await f.root.query(
                "SELECT pg_get_functiondef('aiag_ton_worker.settle_invoice_v1(uuid,jsonb)'::regprocedure) AS body",
              )
            ).rows;
          const before = await read();
          await expect(
            installTonWorkerBoundary(f.url, f.roles),
          ).rejects.toThrow("TON_BOUNDARY_ALREADY_EXISTS");
          expect(await read()).toEqual(before);
        }),
      120000,
    );
    it(
      "refuses a borrowed transaction before committing caller financial work",
      async () =>
        withTonWorkerRoles(async (f) => {
          const { invoice } = await f.makeInvoice();
          await f.root.query("BEGIN");
          try {
            await f.root.query(
              "UPDATE public.organizations SET payg_credits=77 WHERE id=$1",
              [invoice.orgId],
            );
            await expect(
              installTonWorkerBoundary(
                {
                  query: async (config: {
                    text: string;
                    values?: readonly unknown[];
                  }) => {
                    const r = await f.root.query(config.text, [
                      ...(config.values ?? []),
                    ]);
                    return { rows: r.rows, rowCount: r.rowCount };
                  },
                } as never,
                f.roles,
              ),
            ).rejects.toThrow("TON_BOUNDARY_LOCAL_IDENTITY_REQUIRED");
          } finally {
            await f.root.query("ROLLBACK");
          }
          expect(
            (
              await f.root.query(
                "SELECT payg_credits::text AS amount FROM public.organizations WHERE id=$1",
                [invoice.orgId],
              )
            ).rows[0].amount,
          ).toBe("0");
        }, false),
      120000,
    );
  },
);
