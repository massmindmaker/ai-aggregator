import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../lib/db";
import type { StoredChatAttemptArgs } from "../billing/stored-chat-attempt";
import { createPgTestClient } from "../../../database/scripts/pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from "../../../database/scripts/test-db-guard";

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) assertTestDatabaseEnvironment(process.env);
const slug = "openai/gpt-4o-mini";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** No gateway module/singleton is evaluated before the connected database marker guard. */
async function bridge(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async () => {
      const { default: postgres } = await import("postgres");
      const client: SqlClient = postgres(process.env.TEST_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
      });
      try {
        // Independently confirm that the actual production driver connected to the guarded DB.
        const identity =
          await client`SELECT current_database() AS name, marker FROM public._aiag_test_database_marker WHERE singleton = TRUE`;
        expect(identity[0]).toEqual({
          name: "ai_aggregator_test",
          marker: "ai-aggregator:test-database:v1",
        });
        const f = await fixture(client);
        try {
          await run(f);
        } finally {
          await f.cleanup();
        }
      } finally {
        await client.end();
        const { sql } = await import("../lib/db");
        await sql.end();
      }
    },
  );
}
async function fixture(client: SqlClient) {
  const { createStoredChatAttempt } =
    await import("../billing/stored-chat-attempt");
  const common = await import("../billing/admission");
  const v2 = await import("../billing/quota-admission");
  const { openRouterUpstream } = await import("../upstreams/openrouter");
  const user = randomUUID(),
    org = randomUUID(),
    key = randomUUID(),
    billing = randomUUID(),
    attempt = randomUUID();
  await client`INSERT INTO users(id,email) VALUES(${user}::uuid,${`bridge-${user}@example.test`})`;
  await client`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'bridge',${user}::uuid,1000000000)`;
  await client`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'bridge',${randomUUID()},${key.slice(0, 16)},1000000)`;
  await client`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000000)`;
  await client`INSERT INTO gateway_quota_key_policies(api_key_id,org_id,session_microcredits_limit_v2) VALUES(${key}::uuid,${org}::uuid,1000000000)`;
  const args: StoredChatAttemptArgs = {
    orgId: org,
    apiKeyId: key,
    clientRequestId: "bridge-trace",
    declaredSessionId: "Case.SID_:-",
    preDispatchDeadlineAt: new Date(Date.now() + 120000).toISOString(),
    cachingDiscount: "0.5",
    model: {
      slug,
      type: "chat",
      candidates: [
        {
          id: "openrouter",
          upstream_id: "openrouter",
          upstream_model_id: slug,
          provider: "openai",
          price_per_1k_input: 999,
          price_per_1k_output: 999,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: randomUUID(),
            prices: {
              inputCentsPer1k: "1",
              outputCentsPer1k: "2",
              markup: "2",
            },
          },
        },
      ],
    },
    requestedMode: "fastest",
    policy: {},
    body: {
      model: slug,
      messages: [{ role: "user", content: "private prompt" }],
    },
    defaultMaxOutputTokens: 4096,
  };
  const fetchStub = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
    async () =>
      new Response(
        JSON.stringify({
          id: "cmpl-bridge",
          object: "chat.completion",
          model: slug,
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "private answer" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 50 },
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetchStub);
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
  vi.stubEnv("AIAG_EGRESS_PROXY_URL", "");
  const deps = {
    getAdapter: () => openRouterUpstream,
    admitGatewayChargeV2: vi.fn(
      (a: Parameters<typeof v2.admitGatewayChargeV2>[0]) =>
        v2.admitGatewayChargeV2(a, client),
    ),
    markGatewayChargeDispatched: vi.fn(
      (a: Parameters<typeof common.markGatewayChargeDispatched>[0]) =>
        common.markGatewayChargeDispatched(a, client),
    ),
    recordGatewayChargeOutcomeV2: vi.fn(
      (a: Parameters<typeof v2.recordGatewayChargeOutcomeV2>[0]) =>
        v2.recordGatewayChargeOutcomeV2(a, client),
    ),
    settleAdmittedGatewayCharge: vi.fn(
      (a: Parameters<typeof common.settleAdmittedGatewayCharge>[0]) =>
        common.settleAdmittedGatewayCharge(a, client),
    ),
    cancelUndispatchedGatewayCharge: vi.fn(
      (a: Parameters<typeof common.cancelUndispatchedGatewayCharge>[0]) =>
        common.cancelUndispatchedGatewayCharge(a, client),
    ),
  };
  function ready() {
    let n = 0;
    const handle = createStoredChatAttempt(args, {
      ...deps,
      newUuid: () => (n++ === 0 ? billing : attempt),
    });
    if (handle.status !== "ready") throw Error(handle.status);
    return handle;
  }
  async function cleanup() {
    // FK RESTRICT preserves audit in production. Remove only this UUID-owned test fixture.
    await client`DELETE FROM gateway_charge_quota_events WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid)`;
    await client`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid)`;
    await client`DELETE FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_quota_buckets WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_quota_key_policies WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_quota_org_policies WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_transactions WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_api_keys WHERE org_id=${org}::uuid`;
    await client`DELETE FROM organizations WHERE id=${org}::uuid`;
    await client`DELETE FROM users WHERE id=${user}::uuid`;
  }
  return {
    client,
    org,
    key,
    billing,
    args,
    deps,
    fetchStub,
    ready,
    createStoredChatAttempt,
    v2,
    common,
    cleanup,
  };
}

describe.skipIf(!enabled)("guarded postgres.js Task5 quota v2 bridge", () => {
  it("settles the actual wrapper/adapter path, replays exactly, and rejects changed v2 identity without another POST", async () =>
    bridge(async (f) => {
      const handle = f.ready();
      f.args.declaredSessionId = "mutated-after-capture";
      f.args.model.candidates[0]!.billing = {
        ...f.args.model.candidates[0]!.billing!,
        prices: { inputCentsPer1k: "99", outputCentsPer1k: "2", markup: "2" },
      };
      const first = handle.run();
      expect(handle.run()).toBe(first);
      const result = await first;
      expect(
        result,
        JSON.stringify(result, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).toMatchObject({ kind: "settled_success", actualCostCredits: 210n });
      if (result.kind !== "settled_success")
        throw Error(JSON.stringify(result));
      expect(f.fetchStub).toHaveBeenCalledTimes(1);
      expect(f.deps.admitGatewayChargeV2).toHaveBeenCalledTimes(1);
      expect(f.deps.recordGatewayChargeOutcomeV2).toHaveBeenCalledTimes(1);
      expect(f.deps.settleAdmittedGatewayCharge).toHaveBeenCalledTimes(1);
      expect(f.fetchStub.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        redirect: "manual",
      });
      expect(String(f.fetchStub.mock.calls[0]?.[1]?.body)).not.toContain("SID");
      const admissionArgs = f.deps.admitGatewayChargeV2.mock.calls[0]![0];
      const contexts =
        await f.client`SELECT declared_session_id, supplier_quote_snapshot, supplier_authorized_max_usd_micro::text AS maximum, supplier_actual_usd_micro::text AS actual, supplier_usage_snapshot FROM gateway_charge_quota_contexts WHERE billing_request_id=${f.billing}::uuid`;
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        declared_session_id: "Case.SID_:-",
        supplier_quote_snapshot: admissionArgs.supplierQuoteSnapshot,
        actual: "1400",
        supplier_usage_snapshot: result.admission.usageSnapshot,
      });
      expect(admissionArgs.supplierQuoteSnapshot).toEqual({
        version: 2,
        formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
        tokenQuote: admissionArgs.quoteSnapshot.tokenQuote,
      });
      expect(BigInt(contexts[0]!.maximum)).toBeGreaterThan(1400n);
      const reservations =
        await f.client`SELECT kind,state,reserved_max::text AS maximum,actual_amount::text AS actual FROM gateway_charge_quota_reservations WHERE billing_request_id=${f.billing}::uuid ORDER BY kind`;
      expect(reservations.map((r) => [r.kind, r.state, r.actual])).toEqual([
        ["key_month_charged_v2", "settled", "210"],
        ["key_session_charged_v2", "settled", "210"],
        ["org_day_supplier_v2", "settled", "1400"],
      ]);
      expect(reservations.map((r) => r.maximum)).toEqual([
        admissionArgs.authorizedMaxCredits.toString(),
        admissionArgs.authorizedMaxCredits.toString(),
        contexts[0]!.maximum,
      ]);
      const buckets =
        await f.client`SELECT kind,reserved_amount::text AS reserved,settled_amount::text AS settled FROM gateway_quota_buckets WHERE org_id=${f.org}::uuid ORDER BY kind`;
      expect(buckets.map((r) => [r.reserved, r.settled])).toEqual([
        ["0", "210"],
        ["0", "210"],
        ["0", "1400"],
      ]);
      const events =
        await f.client`SELECT kind,event_kind,reserved_delta::text AS reserved,settled_delta::text AS settled,released_amount::text AS released FROM gateway_charge_quota_events WHERE billing_request_id=${f.billing}::uuid ORDER BY kind,event_kind`;
      expect(events).toHaveLength(6);
      for (const r of reservations) {
        expect(
          events.filter((e) => e.kind === r.kind).map((e) => e.event_kind),
        ).toEqual(["reserved", "settled"]);
        const e = events.find(
          (e) => e.kind === r.kind && e.event_kind === "settled",
        )!;
        expect(
          BigInt(e.reserved) + BigInt(e.settled) + BigInt(e.released),
        ).toBe(0n);
        expect(e.settled).toBe(r.actual);
      }
      expect(
        await f.v2.admitGatewayChargeV2(admissionArgs, f.client),
      ).toMatchObject({ state: "settled", didTransition: false });
      expect(
        await f.v2.recordGatewayChargeOutcomeV2(
          f.deps.recordGatewayChargeOutcomeV2.mock.calls[0]![0],
          f.client,
        ),
      ).toMatchObject({ state: "settled", didTransition: false });
      expect(
        await f.common.settleAdmittedGatewayCharge(
          { admission: result.admission },
          f.client,
        ),
      ).toMatchObject({ state: "settled", didTransition: false });
      await expect(
        f.v2.admitGatewayChargeV2(
          { ...admissionArgs, declaredSessionId: "case.SID_:-" },
          f.client,
        ),
      ).rejects.toMatchObject({ code: "ADMISSION_CONFLICT" });
      await expect(
        f.v2.admitGatewayChargeV2(
          {
            ...admissionArgs,
            supplierQuoteSnapshot: {
              ...admissionArgs.supplierQuoteSnapshot,
              changed: true,
            },
          },
          f.client,
        ),
      ).rejects.toMatchObject({ code: "ADMISSION_CONFLICT" });
      f.args.declaredSessionId = "Case.SID_:-";
      f.args.model.candidates[0]!.billing = {
        ...f.args.model.candidates[0]!.billing!,
        prices: { inputCentsPer1k: "1", outputCentsPer1k: "2", markup: "2" },
      };
      expect(await f.ready().run()).toMatchObject({
        kind: "replay",
        state: "settled",
      });
      expect(f.fetchStub).toHaveBeenCalledTimes(1);
      expect(f.deps.markGatewayChargeDispatched).toHaveBeenCalledTimes(1);
      expect(
        await f.client`SELECT count(*)::text AS n FROM gateway_charge_quota_events WHERE billing_request_id=${f.billing}::uuid`,
      ).toMatchObject([{ n: "6" }]);
    }));

  it.each([
    "unenrolled",
    "sid-required",
    "invalid-sid",
    "quota-exceeded",
  ] as const)(
    "fails %s before any provider effect or durable reservation",
    async (reason) =>
      bridge(async (f) => {
        if (reason === "unenrolled")
          await f.client`DELETE FROM gateway_quota_org_policies WHERE org_id=${f.org}::uuid`;
        if (reason === "sid-required") f.args.declaredSessionId = null;
        if (reason === "quota-exceeded")
          await f.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=0 WHERE org_id=${f.org}::uuid`;
        if (reason === "invalid-sid") {
          f.args.declaredSessionId = "A\n";
          expect(f.createStoredChatAttempt(f.args, f.deps)).toMatchObject({
            status: "bad_request",
          });
        } else {
          expect(await f.ready().run()).toMatchObject(
            reason === "quota-exceeded"
              ? { kind: "rejected", code: "PAYMENT_REQUIRED" }
              : {
                  kind: "reconciliation_required",
                  stage: "admit",
                  lastConfirmedState: null,
                },
          );
        }
        expect(f.fetchStub).not.toHaveBeenCalled();
        expect(f.deps.markGatewayChargeDispatched).not.toHaveBeenCalled();
        expect(
          await f.client`SELECT count(*)::text AS n FROM gateway_charge_admissions WHERE org_id=${f.org}::uuid`,
        ).toMatchObject([{ n: "0" }]);
        expect(
          await f.client`SELECT count(*)::text AS n FROM gateway_quota_buckets WHERE org_id=${f.org}::uuid`,
        ).toMatchObject([{ n: "0" }]);
        expect(
          await f.client`SELECT payg_credits::text AS balance FROM organizations WHERE id=${f.org}::uuid`,
        ).toMatchObject([{ balance: "1000000000" }]);
      }),
  );

  it("retains legacy wrappers and exact JSON through the same production driver and common lifecycle", async () =>
    bridge(async (f) => {
      const snapshot = {
        version: 1,
        nested: { exact: "9007199254740993", text: 'quote"\\' },
      };
      const json = JSON.stringify(snapshot);
      expect(
        await f.client`SELECT jsonb_typeof(${json}::text::jsonb) AS type, ${json}::text::jsonb AS value`,
      ).toMatchObject([{ type: "object", value: snapshot }]);
      await f.client`UPDATE gateway_quota_org_policies SET enforcement_version=1 WHERE org_id=${f.org}::uuid`;
      // Explicit test-only callback injection exercises the retained public legacy functions.
      f.deps.admitGatewayChargeV2.mockImplementation((a) =>
        f.common.admitGatewayCharge(a, f.client),
      );
      f.deps.recordGatewayChargeOutcomeV2.mockImplementation((a) =>
        f.common.recordGatewayChargeOutcome(a, f.client),
      );
      const result = await f.ready().run();
      expect(result).toMatchObject({
        kind: "settled_success",
        actualCostCredits: 210n,
      });
      expect(f.fetchStub).toHaveBeenCalledTimes(1);
      expect(
        await f.client`SELECT count(*)::text AS n FROM gateway_charge_quota_contexts WHERE billing_request_id=${f.billing}::uuid`,
      ).toMatchObject([{ n: "0" }]);
      expect(
        await f.common.admitGatewayCharge(
          f.deps.admitGatewayChargeV2.mock.calls[0]![0],
          f.client,
        ),
      ).toMatchObject({ state: "settled", didTransition: false });
    }));

  it("allows explicit null SID with no session limit and settles only the two applicable buckets", async () =>
    bridge(async (f) => {
      await f.client`UPDATE gateway_quota_key_policies SET session_microcredits_limit_v2=NULL WHERE api_key_id=${f.key}::uuid`;
      f.args.declaredSessionId = null;
      expect(await f.ready().run()).toMatchObject({
        kind: "settled_success",
        actualCostCredits: 210n,
      });
      expect(
        await f.client`SELECT declared_session_id FROM gateway_charge_quota_contexts WHERE billing_request_id=${f.billing}::uuid`,
      ).toMatchObject([{ declared_session_id: null }]);
      const buckets =
        await f.client`SELECT kind,reserved_amount::text AS reserved FROM gateway_quota_buckets WHERE org_id=${f.org}::uuid ORDER BY kind`;
      expect(buckets.map((b) => [b.kind, b.reserved])).toEqual([
        ["key_month_charged_v2", "0"],
        ["org_day_supplier_v2", "0"],
      ]);
      expect(f.fetchStub).toHaveBeenCalledTimes(1);
    }));
});
