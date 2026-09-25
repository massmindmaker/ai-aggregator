import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../lib/db";
import type {
  StoredChatAttemptArgs,
  StoredChatAttemptDependencies,
} from "../billing/stored-chat-attempt";
import type { RecordGatewayHttpOutcomeArgs } from "../billing/http-storage";
import { createPgTestClient } from "../../../database/scripts/pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from "../../../database/scripts/test-db-guard";
const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) assertTestDatabaseEnvironment(process.env);
const slug = "openai/gpt-4o-mini";
// Import gateway runtime only after both environment and connected marker guards.
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
      const other: SqlClient = postgres(process.env.TEST_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
      });
      try {
        for (const c of [client, other])
          expect(
            (
              await c`SELECT current_database() AS name, marker FROM public._aiag_test_database_marker WHERE singleton=TRUE`
            )[0],
          ).toEqual({
            name: "ai_aggregator_test",
            marker: "ai-aggregator:test-database:v1",
          });
        const f = await fixture(client, other);
        try {
          await run(f);
        } finally {
          await f.cleanup();
        }
      } finally {
        await client.end();
        await other.end();
        const { sql } = await import("../lib/db");
        await sql.end();
      }
    },
  );
}
async function fixture(client: SqlClient, other: SqlClient) {
  const http = await import("../billing/http-storage");
  const { createStoredChatAttempt } =
    await import("../billing/stored-chat-attempt");
  const common = await import("../billing/admission"),
    v2 = await import("../billing/quota-admission");
  const user = randomUUID(),
    org = randomUUID(),
    key = randomUUID();
  await client`INSERT INTO users(id,email) VALUES(${user}::uuid,${`http-bridge-${user}@example.test`})`;
  await client`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'http bridge',${user}::uuid,1000000000)`;
  await client`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'http bridge',${randomUUID()},${key.slice(0, 16)},1000000)`;
  await client`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000000)`;
  const identity = {
    orgId: org,
    apiKeyId: key,
    routeKind: "chat" as const,
    billingMode: "stored" as const,
    contractVersion: 1 as const,
    idempotencyKeyDigest: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
  };
  const args: StoredChatAttemptArgs = {
    orgId: org,
    apiKeyId: key,
    clientRequestId: "trace",
    declaredSessionId: null,
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
  const output = {
    response: {
      id: "cmpl-http",
      object: "chat.completion" as const,
      created: 1,
      model: slug,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: 'exact " JSON\\ ответ',
          },
          finish_reason: "stop" as const,
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_input_tokens: 50,
      },
    },
    usage: {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 50,
    },
  };
  const execute = vi.fn(async () => output);
  const deps = {
    getAdapter: () => ({
      admittedChat: {
        contract: "openrouter-pinned-provider-chat-v1" as const,
        execute,
      },
      chat: async () => {
        throw Error("legacy forbidden");
      },
    }),
    admitGatewayChargeV2: (a: Parameters<typeof v2.admitGatewayChargeV2>[0]) =>
      v2.admitGatewayChargeV2(a, client),
    markGatewayChargeDispatched: (
      a: Parameters<typeof common.markGatewayChargeDispatched>[0],
    ) => common.markGatewayChargeDispatched(a, client),
    recordGatewayChargeOutcomeV2: vi.fn(async () => {
      throw Error("fallback forbidden");
    }),
    settleAdmittedGatewayCharge: vi.fn(
      (a: Parameters<typeof common.settleAdmittedGatewayCharge>[0]) =>
        common.settleAdmittedGatewayCharge(a, client),
    ),
    cancelUndispatchedGatewayCharge: (
      a: Parameters<typeof common.cancelUndispatchedGatewayCharge>[0],
    ) => common.cancelUndispatchedGatewayCharge(a, client),
    persistOutcome: vi.fn<
      Parameters<NonNullable<StoredChatAttemptDependencies["persistOutcome"]>>,
      ReturnType<NonNullable<StoredChatAttemptDependencies["persistOutcome"]>>
    >((a) => http.recordGatewayHttpOutcome({ ...a, ...identity }, client)),
  };
  async function prepare() {
    const handle = createStoredChatAttempt(args, deps);
    if (handle.status !== "ready") throw Error(handle.status);
    const claim = await http.claimGatewayHttpRequest(
      { ...identity, billingRequestId: handle.billingRequestId },
      client,
    );
    // This test composition only grants run after a valid fresh autocommit ACK.
    if (!claim.didClaim || claim.billingRequestId !== handle.billingRequestId)
      throw Error("No execution grant");
    return handle;
  }
  async function snapshot(billing: string) {
    return {
      admissions:
        await client`SELECT state,actual_cost_credits::text AS cost,usage_snapshot FROM gateway_charge_admissions WHERE billing_request_id=${billing}::uuid`,
      results:
        await client`SELECT response_body,response_digest FROM gateway_http_results WHERE billing_request_id=${billing}::uuid`,
      quotas:
        await client`SELECT kind,reserved_amount::text AS reserved,settled_amount::text AS settled FROM gateway_quota_buckets WHERE org_id=${org}::uuid ORDER BY kind`,
      balance:
        await client`SELECT payg_credits::text AS balance FROM organizations WHERE id=${org}::uuid`,
      transactions:
        await client`SELECT delta::text AS cost FROM gateway_transactions WHERE org_id=${org}::uuid`,
    };
  }
  async function cleanup() {
    await client`DELETE FROM gateway_http_results WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_http_requests WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_charge_quota_events WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid)`;
    await client`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid)`;
    await client`DELETE FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_quota_buckets WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_quota_org_policies WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_transactions WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
    await client`DELETE FROM gateway_api_keys WHERE org_id=${org}::uuid`;
    await client`DELETE FROM organizations WHERE id=${org}::uuid`;
    await client`DELETE FROM users WHERE id=${user}::uuid`;
  }
  return {
    client,
    other,
    http,
    common,
    v2,
    org,
    key,
    identity,
    args,
    output,
    execute,
    deps,
    prepare,
    snapshot,
    cleanup,
  };
}

describe.skipIf(!enabled)("guarded postgres.js HTTP storage bridge B1", () => {
  it("claims the owned ready handle, atomically stores exact JSON, settles once, and replays on a second connection", async () =>
    bridge(async (f) => {
      expect(await f.http.readGatewayHttpResult(f.identity, f.client)).toEqual({
        contractVersion: 1,
        status: "not_found",
      });
      const handle = await f.prepare();
      expect(
        await f.http.readGatewayHttpResult(f.identity, f.other),
      ).toMatchObject({ status: "pending" });
      const promise = handle.run();
      expect(handle.run()).toBe(promise);
      const result = await promise;
      expect(result).toMatchObject({
        kind: "settled_success",
        actualCostCredits: 210n,
      });
      const stored = await f.http.readGatewayHttpResult(f.identity, f.other);
      expect(stored).toMatchObject({
        status: "ready",
        response: f.output.response,
        actualCostCredits: 210n,
        billingRequestId: handle.billingRequestId,
      });
      const before = await f.snapshot(handle.billingRequestId);
      expect(before.admissions[0]).toMatchObject({
        state: "settled",
        cost: "210",
      });
      expect(before.balance[0]).toMatchObject({ balance: "999999790" });
      expect(before.transactions).toHaveLength(1);
      expect(before.quotas.map((r) => r.settled)).toEqual(["210", "1400"]);
      expect(
        await f.http.claimGatewayHttpRequest(
          { ...f.identity, billingRequestId: randomUUID() },
          f.other,
        ),
      ).toMatchObject({
        didClaim: false,
        billingRequestId: handle.billingRequestId,
      });
      expect(await f.http.readGatewayHttpResult(f.identity, f.other)).toEqual(
        stored,
      );
      await expect(
        f.http.claimGatewayHttpRequest(
          {
            ...f.identity,
            billingRequestId: randomUUID(),
            requestFingerprint: "c".repeat(64),
          },
          f.other,
        ),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_CONFLICT" });
      expect(await f.snapshot(handle.billingRequestId)).toEqual(before);
      expect(
        await f.http.expireGatewayHttpResult(
          { orgId: f.org, billingRequestId: handle.billingRequestId },
          f.client,
        ),
      ).toBe(false);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.deps.persistOutcome).toHaveBeenCalledTimes(1);
      expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
    }), 15_000);
  it("records and settles after dispatch-time revoke while read and claim deny access", async () =>
    bridge(async (f) => {
      f.execute.mockImplementation(async () => {
        await f.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
        return f.output;
      });
      const handle = await f.prepare();
      expect(await handle.run()).toMatchObject({ kind: "settled_success" });
      await expect(
        f.http.readGatewayHttpResult(f.identity, f.other),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_ACCESS_DENIED" });
      await expect(
        f.http.claimGatewayHttpRequest(
          { ...f.identity, billingRequestId: randomUUID() },
          f.other,
        ),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_ACCESS_DENIED" });
      expect((await f.snapshot(handle.billingRequestId)).results).toHaveLength(
        1,
      );
    }));
  it("treats a committed outcome with lost ACK as reconciliation; reconnect proves pending and recovery settles without reexecution", async () =>
    bridge(async (f) => {
      let captured: RecordGatewayHttpOutcomeArgs | undefined;
      const lostAckClient = new Proxy(f.client, {
        apply(target, receiver, params: unknown[]) {
          const query: unknown = Reflect.apply(target, receiver, params);
          if (
            Array.isArray(params[0]) &&
            params[0].join("").includes("WITH admission")
          )
            return Promise.resolve(query).then(() => {
              throw Error("simulated lost transport ACK");
            });
          return query;
        },
      });
      f.deps.persistOutcome.mockImplementation(async (a) => {
        captured = { ...a, ...f.identity };
        return f.http.recordGatewayHttpOutcome(captured, lostAckClient);
      });
      const handle = await f.prepare();
      expect(await handle.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "outcome",
      });
      expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
      expect(
        await f.http.readGatewayHttpResult(f.identity, f.other),
      ).toMatchObject({ status: "pending" });
      expect(
        await f.http.claimGatewayHttpRequest(
          { ...f.identity, billingRequestId: randomUUID() },
          f.other,
        ),
      ).toMatchObject({
        didClaim: false,
        billingRequestId: handle.billingRequestId,
      });
      const recorded = await f.http.recordGatewayHttpOutcome(
        captured!,
        f.other,
      );
      expect(recorded).toMatchObject({
        didTransition: false,
        state: "outcome_recorded",
      });
      await f.common.settleAdmittedGatewayCharge(
        { admission: recorded },
        f.other,
      );
      expect(
        await f.http.readGatewayHttpResult(f.identity, f.other),
      ).toMatchObject({
        status: "ready",
        response: f.output.response,
        actualCostCredits: 210n,
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
    }));
  it.each(["invalid-dto", "oversize", "insert-fault"] as const)(
    "rolls back outcome and result on %s without fallback",
    async (reason) =>
      bridge(async (f) => {
        const handle = await f.prepare();
        let before: Awaited<ReturnType<typeof f.snapshot>> | undefined;
        const faultName = `http_bridge_fault_${handle.billingRequestId.replaceAll("-", "")}`;
        if (reason === "insert-fault") {
          // UUID-scoped disposable test fault, removed in finally; no migration/schema contract changes.
          await f.client.unsafe(
            `CREATE FUNCTION ${faultName}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.billing_request_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'HTTP_TEST_FAULT'; END IF; RETURN NEW; END $$`,
          );
          await f.client.unsafe(
            `CREATE TRIGGER ${faultName} BEFORE INSERT ON gateway_http_results FOR EACH ROW EXECUTE FUNCTION ${faultName}('${handle.billingRequestId}')`,
          );
        }
        f.deps.persistOutcome.mockImplementation(async (a) => {
          before = await f.snapshot(handle.billingRequestId);
          const response =
            reason === "invalid-dto"
              ? { ...a.response, provider: "private" }
              : reason === "oversize"
                ? {
                    ...a.response,
                    choices: [
                      {
                        ...a.response.choices[0]!,
                        message: {
                          role: "assistant" as const,
                          content: "я".repeat(600000),
                        },
                      },
                    ],
                  }
                : a.response;
          return f.http.recordGatewayHttpOutcome(
            { ...a, ...f.identity, response },
            f.client,
          );
        });
        try {
          expect(await handle.run()).toMatchObject({
            kind: "reconciliation_required",
            stage: "outcome",
            lastConfirmedState: "dispatched",
          });
          expect(before).toBeDefined();
          expect(await f.snapshot(handle.billingRequestId)).toEqual(before);
          expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
          expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
          expect(f.execute).toHaveBeenCalledTimes(1);
        } finally {
          if (reason === "insert-fault") {
            await f.client.unsafe(
              `DROP TRIGGER IF EXISTS ${faultName} ON gateway_http_results`,
            );
            await f.client.unsafe(`DROP FUNCTION IF EXISTS ${faultName}()`);
          }
        }
      }),
  );

  it("round-trips a settled charge above 2^53 as exact BIGINT through the real driver", async () =>
    bridge(async (f) => {
      await f.client`UPDATE organizations SET payg_credits=9223372036854775807 WHERE id=${f.org}::uuid`;
      await f.client`UPDATE gateway_api_keys SET cost_limit_monthly_rub=NULL WHERE id=${f.key}::uuid`;
      f.args.model.candidates[0]!.billing = {
        ...f.args.model.candidates[0]!.billing!,
        prices: {
          ...f.args.model.candidates[0]!.billing!.prices,
          markup: "1000000000000",
        },
      };
      f.output.response.usage.prompt_tokens = 10000;
      f.output.response.usage.total_tokens = 10020;
      f.output.usage.promptTokens = 10000;
      f.output.usage.totalTokens = 10020;
      const handle = await f.prepare(),
        result = await handle.run();
      expect(result.kind).toBe("settled_success");
      if (result.kind !== "settled_success")
        throw Error(JSON.stringify(result));
      expect(result.actualCostCredits).toBe(10014900000000000n);
      expect(result.actualCostCredits).toBeGreaterThan(9007199254740992n);
      const rows =
        await f.client`SELECT actual_cost_credits::text AS cost FROM gateway_charge_admissions WHERE billing_request_id=${handle.billingRequestId}::uuid`;
      expect(rows[0]!.cost).toBe(result.actualCostCredits.toString());
      expect(
        await f.http.readGatewayHttpResult(f.identity, f.other),
      ).toMatchObject({
        status: "ready",
        actualCostCredits: result.actualCostCredits,
      });
    }));
  it("preserves expired status and tombstone through wrappers without reuse", async () =>
    bridge(async (f) => {
      const handle = await f.prepare();
      expect(await handle.run()).toMatchObject({ kind: "settled_success" });
      // Test-only historical fixture, keeps real immutable trigger and fixed retention intact.
      await f.client`WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=${handle.billingRequestId}::uuid RETURNING *) INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at) SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
      const expired = await f.http.readGatewayHttpResult(f.identity, f.client);
      expect(expired.status).toBe("expired");
      expect(expired).not.toHaveProperty("response");
      expect(expired).not.toHaveProperty("actualCostCredits");
      expect(
        await f.http.expireGatewayHttpResult(
          { orgId: f.org, billingRequestId: handle.billingRequestId },
          f.client,
        ),
      ).toBe(true);
      expect(
        await f.http.expireGatewayHttpResult(
          { orgId: f.org, billingRequestId: handle.billingRequestId },
          f.client,
        ),
      ).toBe(false);
      expect(await f.http.readGatewayHttpResult(f.identity, f.other)).toEqual(
        expired,
      );
      expect(
        await f.http.claimGatewayHttpRequest(
          { ...f.identity, billingRequestId: randomUUID() },
          f.other,
        ),
      ).toMatchObject({ didClaim: false });
    }));
});
