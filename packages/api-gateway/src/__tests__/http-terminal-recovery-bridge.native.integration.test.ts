import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../lib/db";
import type {
  StoredChatAttemptArgs,
  StoredChatAttemptDependencies,
} from "../billing/stored-chat-attempt";
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
  const terminal = await import("../billing/http-terminal-recovery");
  const { createStoredChatAttempt } =
    await import("../billing/stored-chat-attempt");
  const common = await import("../billing/admission"),
    v2 = await import("../billing/quota-admission");
  const user = randomUUID(),
    org = randomUUID(),
    key = randomUUID();
  await client.begin(async (tx) => {
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${`http-bridge-${user}@example.test`})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'http bridge',${user}::uuid,1000000000)`;
    await tx`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'http bridge',${randomUUID()},${key.slice(0, 16)},1000000)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000000)`;
  }); // Only a committed synthetic owner authorizes cleanup.
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
    admitAttempt: (a: Parameters<typeof v2.admitGatewayChargeV2>[0]) =>
      terminal.admitGatewayHttpCharge({ ...a, ...identity }, client),
    rejectUnstarted: (a: { billingRequestId: string }) =>
      terminal.rejectUnstartedGatewayHttpRequest({ ...a, ...identity }, client),
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
    let billingIds: string[] = [];
    await client.begin(async (tx) => {
      const client = tx;
      expect(
        (
          await client`SELECT owner_id FROM organizations WHERE id=${org}::uuid FOR UPDATE`
        )[0]?.owner_id,
      ).toBe(user);
      expect(
        (
          await client`SELECT org_id FROM gateway_api_keys WHERE id=${key}::uuid`
        )[0]?.org_id,
      ).toBe(org);
      const mappings =
        await client`SELECT billing_request_id,api_key_id FROM gateway_http_requests WHERE org_id=${org}::uuid`;
      const admissions =
        await client`SELECT billing_request_id,api_key_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
      for (const admission of admissions) expect(admission.api_key_id).toBe(key);
      billingIds = [...new Set([...mappings, ...admissions].map((r) => String(r.billing_request_id)))];
      for (const mapping of mappings) {
        expect(mapping.api_key_id).toBe(key);
        await client`DELETE FROM gateway_http_rejections WHERE org_id=${org}::uuid AND api_key_id=${key}::uuid AND billing_request_id=${mapping.billing_request_id}::uuid`;
      }
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
    });
    // A successful callback/ACK alone is insufficient: verify committed absence
    // from the independent connection, retaining IDs before their parent rows vanish.
    const remaining = await other`
      SELECT 'negative' AS relation,count(*)::text AS count FROM gateway_http_rejections WHERE org_id=${org}::uuid
      UNION ALL SELECT 'result',count(*)::text FROM gateway_http_results WHERE org_id=${org}::uuid
      UNION ALL SELECT 'mapping',count(*)::text FROM gateway_http_requests WHERE org_id=${org}::uuid
      UNION ALL SELECT 'quota event',count(*)::text FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${other.array(billingIds)}::uuid[])
      UNION ALL SELECT 'quota reservation',count(*)::text FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${other.array(billingIds)}::uuid[])
      UNION ALL SELECT 'quota context',count(*)::text FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid
      UNION ALL SELECT 'quota bucket',count(*)::text FROM gateway_quota_buckets WHERE org_id=${org}::uuid
      UNION ALL SELECT 'quota policy',count(*)::text FROM gateway_quota_org_policies WHERE org_id=${org}::uuid
      UNION ALL SELECT 'transaction',count(*)::text FROM gateway_transactions WHERE org_id=${org}::uuid
      UNION ALL SELECT 'admission',count(*)::text FROM gateway_charge_admissions WHERE org_id=${org}::uuid
      UNION ALL SELECT 'key',count(*)::text FROM gateway_api_keys WHERE org_id=${org}::uuid OR id=${key}::uuid
      UNION ALL SELECT 'organization',count(*)::text FROM organizations WHERE id=${org}::uuid
      UNION ALL SELECT 'user',count(*)::text FROM users WHERE id=${user}::uuid`;
    expect(remaining).toHaveLength(13);
    for (const residual of remaining)
      expect(residual.count, `owned cleanup residual: ${residual.relation}`).toBe("0");
  }
  return {
    client,
    other,
    http,
    terminal,
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

describe.skipIf(!enabled)("guarded postgres.js terminal/recovery C1b", () => {
  it("detects residual owned rows when cleanup receives a false commit acknowledgement", async () =>
    bridge(async (sentinel) => {
      const h = await sentinel.prepare();
      await h.run();
      const before = await sentinel.snapshot(h.billingRequestId);
      expect(before.quotas.length).toBeGreaterThan(0);
      expect(before.balance).toHaveLength(1);
      const mappingBefore = await sentinel.other`SELECT * FROM gateway_http_requests WHERE org_id=${sentinel.org}::uuid AND api_key_id=${sentinel.key}::uuid`;
      expect(mappingBefore).toHaveLength(1);
      let rollbackCleanup = false;
      const rollback = Error("test cleanup rollback before commit");
      const intercepted = new Proxy(sentinel.client, {
        get(target, property) {
          if (property !== "begin") return Reflect.get(target, property);
          return async (run: (tx: SqlClient) => Promise<unknown>) => {
            try {
              return await target.begin(async (tx) => {
                const result = await run(tx as unknown as SqlClient);
                if (rollbackCleanup) throw rollback;
                return result;
              });
            } catch (error) {
              if (rollbackCleanup && error === rollback) return undefined;
              throw error;
            }
          };
        },
      });
      const disposable = await fixture(intercepted, sentinel.other);
      try {
        const controller = new AbortController();
        disposable.args.signal = controller.signal;
        const rejected = await disposable.prepare();
        controller.abort();
        expect(await rejected.run()).toMatchObject({kind: "rejected"});
        rollbackCleanup = true;
        await expect(disposable.cleanup()).rejects.toThrow();
      } finally {
        rollbackCleanup = false;
        await disposable.cleanup();
      }
      expect(await sentinel.snapshot(h.billingRequestId)).toEqual(before);
      expect(await sentinel.other`SELECT * FROM gateway_http_requests WHERE org_id=${sentinel.org}::uuid AND api_key_id=${sentinel.key}::uuid`).toEqual(mappingBefore);
    }));
  it("claims before execution and uses sole admission/outcome writers with stable replay", async () =>
    bridge(async (f) => {
      const legacy = f.deps.admitGatewayChargeV2;
      f.deps.admitGatewayChargeV2 = vi.fn(async () => {
        throw Error("fallback forbidden");
      });
      const h = await f.prepare();
      expect(await h.run()).toMatchObject({
        kind: "settled_success",
        actualCostCredits: 210n,
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.deps.admitGatewayChargeV2).not.toHaveBeenCalled();
      expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
      const stored = await f.terminal.readGatewayHttpResultV2(
        f.identity,
        f.other,
      );
      expect(stored).toMatchObject({
        status: "ready",
        actualCostCredits: 210n,
        response: f.output.response,
      });
      const before = await f.snapshot(h.billingRequestId);
      const replay = await f.http.claimGatewayHttpRequest(
        { ...f.identity, billingRequestId: randomUUID() },
        f.other,
      );
      expect(replay).toMatchObject({
        didClaim: false,
        billingRequestId: h.billingRequestId,
      });
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toEqual(stored);
      expect(await f.snapshot(h.billingRequestId)).toEqual(before);
      expect(f.execute).toHaveBeenCalledTimes(1);
      f.deps.admitGatewayChargeV2 = legacy;
    }));
  it("persists a confirmed SQL funds rejection and blocks all provider work", async () =>
    bridge(async (f) => {
      await f.client`UPDATE organizations SET payg_credits=0 WHERE id=${f.org}::uuid`;
      const h = await f.prepare();
      expect(await h.run()).toEqual({
        kind: "rejected",
        billingRequestId: h.billingRequestId,
        code: "PAYMENT_REQUIRED",
      });
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toMatchObject({
        status: "rejected",
        code: "PAYMENT_REQUIRED",
        httpStatus: 402,
      });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.deps.persistOutcome).not.toHaveBeenCalled();
      expect(f.deps.settleAdmittedGatewayCharge).not.toHaveBeenCalled();
      expect((await f.snapshot(h.billingRequestId)).admissions).toHaveLength(0);
    }));
  it("durably closes an abort only after claim ACK and before first admission invocation", async () =>
    bridge(async (f) => {
      const controller = new AbortController();
      f.args.signal = controller.signal;
      const h = await f.prepare();
      controller.abort();
      expect(await h.run()).toEqual({
        kind: "rejected",
        billingRequestId: h.billingRequestId,
        code: "REQUEST_NOT_STARTED",
      });
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toMatchObject({ status: "rejected", code: "REQUEST_NOT_STARTED" });
      expect(f.execute).not.toHaveBeenCalled();
    }));
  it("treats a lost business-reject ACK as reconciliation and reads the committed original", async () =>
    bridge(async (f) => {
      await f.client`UPDATE organizations SET payg_credits=0 WHERE id=${f.org}::uuid`;
      const original = f.deps.admitAttempt;
      f.deps.admitAttempt = async (a) => {
        await original(a);
        throw Error("lost ACK");
      };
      const h = await f.prepare();
      expect(await h.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "admit",
        lastConfirmedState: null,
      });
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toMatchObject({ status: "rejected", code: "PAYMENT_REQUIRED" });
      expect(f.execute).not.toHaveBeenCalled();
    }));
  it.each(["outcome", "settle"] as const)(
    "recovers committed %s after ACK loss without provider retry",
    async (stage) =>
      bridge(async (f) => {
        if (stage === "outcome") {
          const original = f.deps.persistOutcome.getMockImplementation()!;
          f.deps.persistOutcome.mockImplementation(async (a) => {
            await original(a);
            throw Error("lost outcome ACK");
          });
        } else {
          const original =
            f.deps.settleAdmittedGatewayCharge.getMockImplementation()!;
          f.deps.settleAdmittedGatewayCharge.mockImplementation(async (a) => {
            await original(a);
            throw Error("lost settle ACK");
          });
        }
        const h = await f.prepare();
        expect(await h.run()).toMatchObject({
          kind: "reconciliation_required",
          stage,
        });
        const settled = await f.terminal.recoverGatewayHttpSettlement(
          {
            orgId: f.org,
            apiKeyId: f.key,
            billingRequestId: h.billingRequestId,
          },
          f.other,
        );
        expect(settled).toMatchObject({
          state: "settled",
          actualCostCredits: 210n,
          didTransition: stage === "outcome",
        });
        const before = await f.snapshot(h.billingRequestId);
        expect(
          (
            await f.terminal.recoverGatewayHttpSettlement(
              {
                orgId: f.org,
                apiKeyId: f.key,
                billingRequestId: h.billingRequestId,
              },
              f.other,
            )
          ).didTransition,
        ).toBe(false);
        expect(await f.snapshot(h.billingRequestId)).toEqual(before);
        expect(f.execute).toHaveBeenCalledTimes(1);
      }),
  );
  it("recovers a dispatched obligation after revoke but denies public result access", async () =>
    bridge(async (f) => {
      f.deps.settleAdmittedGatewayCharge.mockRejectedValue(
        Error("process stopped"),
      );
      const h = await f.prepare();
      expect(await h.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "settle",
      });
      await f.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
      expect(
        await f.terminal.recoverGatewayHttpSettlement(
          {
            orgId: f.org,
            apiKeyId: f.key,
            billingRequestId: h.billingRequestId,
          },
          f.other,
        ),
      ).toMatchObject({ state: "settled" });
      await expect(
        f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_ACCESS_DENIED" });
      expect(f.execute).toHaveBeenCalledTimes(1);
    }));
  it("binds exact money beyond2^53 through admission, outcome, recovery and read", async () =>
    bridge(async (f) => {
      const amount = 10014900000000000n;
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
      await f.client`UPDATE organizations SET payg_credits=${"9223372036854775807"}::bigint WHERE id=${f.org}::uuid`;
      await f.client`UPDATE gateway_api_keys SET cost_limit_monthly_rub=NULL WHERE id=${f.key}::uuid`;
      f.deps.settleAdmittedGatewayCharge.mockRejectedValue(
        Error("needs recovery"),
      );
      const h = await f.prepare();
      expect(await h.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "settle",
      });
      expect(
        (
          await f.terminal.recoverGatewayHttpSettlement(
            {
              orgId: f.org,
              apiKeyId: f.key,
              billingRequestId: h.billingRequestId,
            },
            f.other,
          )
        ).actualCostCredits,
      ).toBe(amount);
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toMatchObject({ status: "ready", actualCostCredits: amount });
      expect(f.execute).toHaveBeenCalledTimes(1);
    }));
  it("does not run or terminalize when claim acknowledgement is unknown", async () =>
    bridge(async (f) => {
      const { createStoredChatAttempt } =
        await import("../billing/stored-chat-attempt");
      const h = createStoredChatAttempt(f.args, f.deps);
      if (h.status !== "ready") throw Error(h.status);
      await f.http.claimGatewayHttpRequest(
        { ...f.identity, billingRequestId: h.billingRequestId },
        f.client,
      );
      // Simulated application ACK loss: no runnable handle is delivered by composition.
      const replay = await f.http.claimGatewayHttpRequest(
        { ...f.identity, billingRequestId: randomUUID() },
        f.other,
      );
      expect(replay.didClaim).toBe(false);
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toMatchObject({ status: "pending" });
      expect(f.execute).not.toHaveBeenCalled();
      expect((await f.snapshot(h.billingRequestId)).admissions).toHaveLength(0);
    }));
  it("rolls back an outcome transaction and refuses settlement without evidence", async () =>
    bridge(async (f) => {
      f.deps.persistOutcome.mockImplementation(async (a) =>
        f.client.begin(async (tx) => {
          await f.http.recordGatewayHttpOutcome(
            { ...a, ...f.identity },
            tx as unknown as SqlClient,
          );
          throw Error("rollback outcome");
        }),
      );
      const h = await f.prepare();
      expect(await h.run()).toMatchObject({
        kind: "reconciliation_required",
        stage: "outcome",
      });
      const before = await f.snapshot(h.billingRequestId);
      expect(before.results).toHaveLength(0);
      await expect(
        f.terminal.recoverGatewayHttpSettlement(
          {
            orgId: f.org,
            apiKeyId: f.key,
            billingRequestId: h.billingRequestId,
          },
          f.other,
        ),
      ).rejects.toMatchObject({ code: "HTTP_STORAGE_CONFLICT" });
      expect(await f.snapshot(h.billingRequestId)).toEqual(before);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.deps.recordGatewayChargeOutcomeV2).not.toHaveBeenCalled();
    }));
  it("recovers an expired tombstone without rebuilding completion or extending retention", async () =>
    bridge(async (f) => {
      f.deps.settleAdmittedGatewayCharge.mockRejectedValue(
        Error("process stopped"),
      );
      const h = await f.prepare();
      await h.run();
      await f.client`WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=${h.billingRequestId}::uuid AND org_id=${f.org}::uuid AND api_key_id=${f.key}::uuid RETURNING *) INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at) SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
      await f.http.expireGatewayHttpResult(
        { orgId: f.org, billingRequestId: h.billingRequestId },
        f.client,
      );
      const before = await f.terminal.readGatewayHttpResultV2(
        f.identity,
        f.other,
      );
      expect(before.status).toBe("expired");
      await f.terminal.recoverGatewayHttpSettlement(
        { orgId: f.org, apiKeyId: f.key, billingRequestId: h.billingRequestId },
        f.other,
      );
      expect(
        await f.terminal.readGatewayHttpResultV2(f.identity, f.other),
      ).toEqual(before);
      expect(f.execute).toHaveBeenCalledTimes(1);
    }));
});
