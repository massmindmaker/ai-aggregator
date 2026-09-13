import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../../../../../packages/api-gateway/src/lib/db";
import { createPgTestClient } from "../../../../../packages/database/scripts/pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from "../../../../../packages/database/scripts/test-db-guard";

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) assertTestDatabaseEnvironment(process.env);

const marker = "ai-aggregator:test-database:v1";
const modelSlug = "openai/gpt-4o-mini";
const nativeTestTimeoutMs = 40_000;

type TeardownStep =
  | "recovery-resources"
  | "fixture-rows"
  | "foreign-sentinel-verified"
  | "foreign-sentinel-deleted"
  | "primary-client-closed"
  | "secondary-client-closed"
  | "api-gateway-singleton-closed";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function guardedRun(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  onTeardownStep?: (step: TeardownStep) => void,
) {
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async (guardClient) => {
      const guardedIdentity = await guardClient.query<{ name: string; marker: string }>({
        text: "SELECT current_database() AS name, marker FROM public._aiag_test_database_marker WHERE singleton = TRUE",
        values: [],
      });
      expect(guardedIdentity.rows).toEqual([{ name: "ai_aggregator_test", marker }]);

      // Production database modules are loaded only after environment, connected
      // identity, and marker checks have all succeeded.
      const { default: postgres } = await import("postgres");
      const foreignUser = randomUUID();
      const foreignOrg = randomUUID();
      const sentinel = [{ id: foreignOrg, owner_id: foreignUser, payg_credits: "777777" }];
      const teardownFailures: Error[] = [];
      let primaryFailure: { error: unknown } | undefined;
      let client: SqlClient | undefined;
      let other: SqlClient | undefined;
      let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
      let foreignSentinelCreated = false;

      async function teardown(step: TeardownStep, action: () => Promise<unknown>) {
        try {
          await action();
        } catch (error) {
          teardownFailures.push(new Error(`guarded native teardown failed: ${step}`, { cause: error }));
        } finally {
          try {
            onTeardownStep?.(step);
          } catch (error) {
            teardownFailures.push(new Error(`guarded native teardown observer failed: ${step}`, { cause: error }));
          }
        }
      }

      try {
        client = postgres(process.env.TEST_DATABASE_URL!, { max: 4, onnotice: () => {} });
        other = postgres(process.env.TEST_DATABASE_URL!, { max: 4, onnotice: () => {} });
        for (const connection of [client, other]) {
          expect((await connection`
            SELECT current_database() AS name, marker
            FROM public._aiag_test_database_marker
            WHERE singleton = TRUE
          `)[0]).toEqual({ name: "ai_aggregator_test", marker });
        }
        await other.begin(async (tx) => {
          await tx`INSERT INTO users(id,email) VALUES(${foreignUser}::uuid,${`recovery-foreign-${foreignUser}@example.test`})`;
          await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${foreignOrg}::uuid,${foreignOrg},'recovery foreign sentinel',${foreignUser}::uuid,777777)`;
        });
        foreignSentinelCreated = true;
        expect(await other`
          SELECT id::text,owner_id::text,payg_credits::text
          FROM organizations WHERE id=${foreignOrg}::uuid
        `).toEqual(sentinel);
        fixture = await createFixture(client, other, foreignOrg);
        await run(fixture);
      } catch (error) {
        primaryFailure = { error };
      } finally {
        if (fixture !== undefined) {
          await teardown("recovery-resources", () => fixture!.closeOwnedRecoveryResources());
          await teardown("fixture-rows", () => fixture!.cleanup());
        }
        if (other !== undefined && foreignSentinelCreated) {
          await teardown("foreign-sentinel-verified", async () => {
            expect(await other!`
              SELECT id::text,owner_id::text,payg_credits::text
              FROM organizations WHERE id=${foreignOrg}::uuid
            `).toEqual(sentinel);
          });
          await teardown("foreign-sentinel-deleted", () => other!.begin(async (tx) => {
            expect(await tx`
              SELECT id::text,owner_id::text,payg_credits::text
              FROM organizations WHERE id=${foreignOrg}::uuid FOR UPDATE
            `).toEqual(sentinel);
            await tx`DELETE FROM organizations WHERE id=${foreignOrg}::uuid`;
            await tx`DELETE FROM users WHERE id=${foreignUser}::uuid`;
          }));
        }
        if (client !== undefined) await teardown("primary-client-closed", () => client!.end());
        if (other !== undefined) await teardown("secondary-client-closed", () => other!.end());
        await teardown("api-gateway-singleton-closed", async () => {
          const { sql } = await import("../../../../../packages/api-gateway/src/lib/db.js");
          await sql.end();
        });
      }

      if (primaryFailure !== undefined && teardownFailures.length === 0) throw primaryFailure.error;
      if (primaryFailure !== undefined || teardownFailures.length > 0) {
        throw new AggregateError(
          [...(primaryFailure === undefined ? [] : [primaryFailure.error]), ...teardownFailures],
          "guarded native recovery run failed",
        );
      }
    },
  );
}

async function createFixture(client: SqlClient, other: SqlClient, foreignOrg: string) {
  const http = await import("../../../../../packages/api-gateway/src/billing/http-storage.js");
  const terminal = await import("../../../../../packages/api-gateway/src/billing/http-terminal-recovery.js");
  const admission = await import("../../../../../packages/api-gateway/src/billing/admission.js");
  const quota = await import("../../../../../packages/api-gateway/src/billing/quota-admission.js");
  const { createStoredChatAttempt } = await import("../../../../../packages/api-gateway/src/billing/stored-chat-attempt.js");
  const dbModule = await import("../gateway-settlement-recovery-db.js");
  const recovery = await import("../gateway-settlement-recovery.js");

  const user = randomUUID();
  const org = randomUUID();
  const keys: string[] = [];
  const ownedFunctions = new Set<string>();
  const ownedTriggers = new Set<string>();
  const ownedRecoveryResources: Array<Readonly<{ close(): Promise<void> }>> = [];
  await client.begin(async (tx) => {
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${`recovery-${user}@example.test`})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'recovery owned fixture',${user}::uuid,1000000000)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000000)`;
  });

  async function createKey() {
    const key = randomUUID();
    await client`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'recovery owned key',${randomUUID()},${key.slice(0, 16)},1000000)`;
    keys.push(key);
    return key;
  }

  function ownRecoveryResource<T extends Readonly<{ close(): Promise<void> }>>(resource: T): T {
    ownedRecoveryResources.push(resource);
    return resource;
  }

  function createRecoveryDb() {
    return ownRecoveryResource(dbModule.createGatewaySettlementRecoveryDb(process.env.TEST_DATABASE_URL!));
  }

  function startRecovery(input: Parameters<typeof recovery.startGatewaySettlementRecovery>[0]) {
    return ownRecoveryResource(recovery.startGatewaySettlementRecovery(input));
  }

  async function closeOwnedRecoveryResources() {
    const failures: unknown[] = [];
    for (const resource of ownedRecoveryResources.splice(0).reverse()) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "owned recovery resource cleanup failed");
  }

  type Stage = "held" | "dispatched" | "outcome" | "settled";
  async function createAttempt(
    stage: Stage,
    options: Readonly<{ connection?: SqlClient; key?: string; deadlineMs?: number }> = {},
  ) {
    const connection = options.connection ?? client;
    const key = options.key ?? await createKey();
    const billingRequestId = randomUUID();
    const attemptId = randomUUID();
    const identity = {
      orgId: org,
      apiKeyId: key,
      routeKind: "chat" as const,
      billingMode: "stored" as const,
      contractVersion: 1 as const,
      idempotencyKeyDigest: digest(`idempotency:${billingRequestId}`),
      requestFingerprint: digest(`fingerprint:${billingRequestId}`),
    };
    const args = {
      orgId: org,
      apiKeyId: key,
      clientRequestId: `recovery-${billingRequestId}`,
      declaredSessionId: null,
      preDispatchDeadlineAt: new Date(Date.now() + (options.deadlineMs ?? 120_000)).toISOString(),
      cachingDiscount: "0.5",
      model: {
        slug: modelSlug,
        type: "chat" as const,
        candidates: [{
          id: "openrouter",
          upstream_id: "openrouter",
          upstream_model_id: modelSlug,
          provider: "openai",
          price_per_1k_input: 999,
          price_per_1k_output: 999,
          markup: 999,
          latency_p50_ms: 1,
          uptime: 1,
          ru_residency: false,
          billing: {
            modelUpstreamId: randomUUID(),
            prices: { inputCentsPer1k: "1", outputCentsPer1k: "2", markup: "2" },
          },
        }],
      },
      requestedMode: "fastest" as const,
      policy: {},
      body: { model: modelSlug, messages: [{ role: "user" as const, content: "private recovery fixture" }] },
      defaultMaxOutputTokens: 4096,
    };
    const output = {
      response: {
        id: `cmpl-${billingRequestId}`,
        object: "chat.completion" as const,
        created: 1,
        model: modelSlug,
        choices: [{
          index: 0,
          message: { role: "assistant" as const, content: "private recovery result" },
          finish_reason: "stop" as const,
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_input_tokens: 50 },
      },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedInputTokens: 50 },
    };
    let admitted: Awaited<ReturnType<typeof admission.admitGatewayCharge>> | undefined;
    let outcomeInput: Parameters<typeof http.recordGatewayHttpOutcome>[0] | undefined;
    const deps = {
      admitAttempt: async (value: Parameters<typeof quota.admitGatewayChargeV2>[0]) => {
        const result = await terminal.admitGatewayHttpCharge({ ...value, ...identity }, connection);
        if (result.kind === "admitted") admitted = result.admission;
        return result;
      },
      rejectUnstarted: (value: { billingRequestId: string }) =>
        terminal.rejectUnstartedGatewayHttpRequest({ ...value, ...identity }, connection),
      getAdapter: () => ({
        admittedChat: {
          contract: "openrouter-pinned-provider-chat-v1" as const,
          execute: async () => output,
        },
        chat: async () => { throw new Error("legacy provider path forbidden"); },
      }),
      admitGatewayChargeV2: (value: Parameters<typeof quota.admitGatewayChargeV2>[0]) =>
        quota.admitGatewayChargeV2(value, connection),
      markGatewayChargeDispatched: async (value: Parameters<typeof admission.markGatewayChargeDispatched>[0]) => {
        if (stage === "held") throw new Error("fixture stops while held");
        return admission.markGatewayChargeDispatched(value, connection);
      },
      recordGatewayChargeOutcomeV2: async () => { throw new Error("HTTP outcome wrapper is required"); },
      persistOutcome: async (value: Omit<Parameters<typeof http.recordGatewayHttpOutcome>[0], keyof typeof identity>) => {
        outcomeInput = { ...value, ...identity };
        if (stage === "dispatched") throw new Error("fixture stops while dispatched");
        return http.recordGatewayHttpOutcome(outcomeInput, connection);
      },
      settleAdmittedGatewayCharge: async (value: Parameters<typeof admission.settleAdmittedGatewayCharge>[0]) => {
        if (stage === "outcome") throw new Error("fixture leaves outcome recorded");
        return admission.settleAdmittedGatewayCharge(value, connection);
      },
      cancelUndispatchedGatewayCharge: (value: Parameters<typeof admission.cancelUndispatchedGatewayCharge>[0]) =>
        admission.cancelUndispatchedGatewayCharge(value, connection),
    };
    const handle = createStoredChatAttempt(args, {
      ...deps,
      newUuid: (() => {
        let call = 0;
        return () => call++ === 0 ? billingRequestId : attemptId;
      })(),
    });
    if (handle.status !== "ready") throw new Error(handle.status);
    const claim = await http.claimGatewayHttpRequest({ ...identity, billingRequestId }, connection);
    expect(claim).toMatchObject({ didClaim: true, billingRequestId });
    const result = await handle.run();
    if (stage === "held") expect(result).toMatchObject({ kind: "reconciliation_required", stage: "dispatch" });
    if (stage === "dispatched") expect(result).toMatchObject({ kind: "reconciliation_required", stage: "outcome" });
    if (stage === "outcome") expect(result).toMatchObject({ kind: "reconciliation_required", stage: "settle" });
    if (stage === "settled") expect(result).toMatchObject({ kind: "settled_success", billingRequestId });
    return { billingRequestId, attemptId, identity, admitted, outcomeInput, result };
  }

  async function createRejected() {
    const key = await createKey();
    const billingRequestId = randomUUID();
    const identity = {
      orgId: org, apiKeyId: key, routeKind: "chat" as const, billingMode: "stored" as const,
      contractVersion: 1 as const, idempotencyKeyDigest: digest(`reject:${billingRequestId}`),
      requestFingerprint: digest(`reject-fingerprint:${billingRequestId}`),
    };
    await http.claimGatewayHttpRequest({ ...identity, billingRequestId }, client);
    await terminal.rejectUnstartedGatewayHttpRequest({ ...identity, billingRequestId }, client);
    return { billingRequestId, identity };
  }

  async function hintFor(billingRequestId: string) {
    const rows = await other`
      SELECT org_id::text AS org_id,api_key_id::text AS api_key_id,billing_request_id::text AS billing_request_id,
        to_char(reconcile_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reconcile_at
      FROM gateway_charge_admissions WHERE billing_request_id=${billingRequestId}::uuid
    `;
    expect(rows).toHaveLength(1);
    return {
      orgId: String(rows[0]?.org_id), apiKeyId: String(rows[0]?.api_key_id),
      billingRequestId: String(rows[0]?.billing_request_id), reconcileAt: String(rows[0]?.reconcile_at),
    };
  }

  async function settlementFacts(billingRequestId: string) {
    return {
      admission: await other`
        SELECT state,actual_cost_credits::text AS actual_cost_credits,settled_at IS NOT NULL AS has_settled_at
        FROM gateway_charge_admissions WHERE billing_request_id=${billingRequestId}::uuid
      `,
      receipts: await other`
        SELECT source,delta::text FROM gateway_transactions WHERE request_id=${`gw:${billingRequestId}`} ORDER BY source
      `,
      settlements: await other`
        SELECT event_key,event_kind FROM gateway_charge_admission_events
        WHERE admission_id=${billingRequestId}::uuid AND event_key='settlement'
      `,
      reservations: await other`
        SELECT kind,state,actual_amount::text FROM gateway_charge_quota_reservations
        WHERE billing_request_id=${billingRequestId}::uuid ORDER BY kind
      `,
      quotaSettlements: await other`
        SELECT kind,event_kind,settled_delta::text FROM gateway_charge_quota_events
        WHERE billing_request_id=${billingRequestId}::uuid AND event_kind='settled' ORDER BY kind
      `,
    };
  }

  async function installSettlementFailure(billingRequestId: string) {
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `aiag_recovery_fail_${suffix}`;
    const triggerName = `aiag_recovery_fail_${suffix}`;
    if (!/^[a-z0-9_]+$/.test(functionName) || !/^[a-z0-9_]+$/.test(triggerName)) throw new Error("invalid fixture identifier");
    await client.unsafe(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = TG_ARGV[0] THEN RAISE EXCEPTION 'owned recovery settlement failure'; END IF; RETURN NEW; END $$`);
    ownedFunctions.add(functionName);
    await client.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON gateway_transactions FOR EACH ROW EXECUTE FUNCTION public.${functionName}('gw:${billingRequestId}')`);
    ownedTriggers.add(triggerName);
    return async () => {
      await client.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON gateway_transactions`);
      ownedTriggers.delete(triggerName);
      await client.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      ownedFunctions.delete(functionName);
    };
  }

  async function cleanup() {
    const failures: unknown[] = [];
    for (const triggerName of [...ownedTriggers]) {
      try { await client.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON gateway_transactions`); }
      catch (error) { failures.push(error); }
    }
    for (const functionName of [...ownedFunctions]) {
      try { await client.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`); }
      catch (error) { failures.push(error); }
    }
    try {
      const billingIds = (await client`
        SELECT billing_request_id::text FROM gateway_http_requests WHERE org_id=${org}::uuid
        UNION SELECT billing_request_id::text FROM gateway_charge_admissions WHERE org_id=${org}::uuid
      `).map((row) => String(row.billing_request_id));
      await client.begin(async (tx) => {
        const owner = await tx`SELECT owner_id::text FROM organizations WHERE id=${org}::uuid FOR UPDATE`;
        expect(owner).toEqual([{ owner_id: user }]);
        await tx`DELETE FROM gateway_http_rejections WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_http_results WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_http_requests WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${tx.array(billingIds)}::uuid[])`;
        await tx`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${tx.array(billingIds)}::uuid[])`;
        await tx`DELETE FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_quota_buckets WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_quota_key_policies WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_quota_org_policies WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_transactions WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_charge_admissions WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM gateway_api_keys WHERE org_id=${org}::uuid`;
        await tx`DELETE FROM organizations WHERE id=${org}::uuid`;
        await tx`DELETE FROM users WHERE id=${user}::uuid`;
      });
      const residual = await other`
        SELECT 'request' AS relation,count(*)::text AS count FROM gateway_http_requests WHERE org_id=${org}::uuid
        UNION ALL SELECT 'rejection',count(*)::text FROM gateway_http_rejections WHERE org_id=${org}::uuid
        UNION ALL SELECT 'result',count(*)::text FROM gateway_http_results WHERE org_id=${org}::uuid
        UNION ALL SELECT 'admission',count(*)::text FROM gateway_charge_admissions WHERE org_id=${org}::uuid
        UNION ALL SELECT 'context',count(*)::text FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid
        UNION ALL SELECT 'bucket',count(*)::text FROM gateway_quota_buckets WHERE org_id=${org}::uuid
        UNION ALL SELECT 'receipt',count(*)::text FROM gateway_transactions WHERE org_id=${org}::uuid
        UNION ALL SELECT 'key',count(*)::text FROM gateway_api_keys WHERE org_id=${org}::uuid
        UNION ALL SELECT 'org',count(*)::text FROM organizations WHERE id=${org}::uuid
        UNION ALL SELECT 'user',count(*)::text FROM users WHERE id=${user}::uuid
      `;
      for (const row of residual) expect(row.count, `owned cleanup residual: ${row.relation}`).toBe("0");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "recovery fixture cleanup failed");
  }

  return {
    client, other, org, foreignOrg, http, terminal, admission, dbModule, recovery,
    createKey, createAttempt, createRejected, hintFor, settlementFacts,
    installSettlementFailure, ownRecoveryResource, createRecoveryDb, startRecovery,
    closeOwnedRecoveryResources, cleanup,
  };
}

describe.skipIf(!enabled)("guarded native gateway settlement recovery", () => {
  it("runs every teardown step after a primary assertion and resource-close failure", async () => {
    const teardownSteps: TeardownStep[] = [];
    const callbacks: Array<() => void> = [];
    const clearTimeout = vi.fn();
    const failingClose = vi.fn(async () => {
      throw new Error("injected owned resource close failure");
    });
    let acquiredDb: Readonly<{ captureCycle(): Promise<unknown> }> | undefined;
    let observedFailure: unknown;

    try {
      await guardedRun(async (f) => {
        const tick = deferred<void>();
        const db = f.createRecoveryDb();
        acquiredDb = db;
        f.startRecovery({
          db,
          scheduler: {
            setTimeout(callback: () => void, delayMs: 60_000) {
              expect(delayMs).toBe(60_000);
              callbacks.push(callback);
              return callbacks.length;
            },
            clearTimeout,
          },
          onTick() {
            tick.resolve();
          },
        });
        await tick.promise;
        expect(callbacks).toHaveLength(1);
        f.ownRecoveryResource({ close: failingClose });
        throw new Error("injected primary scenario failure");
      }, (step) => teardownSteps.push(step));
    } catch (error) {
      observedFailure = error;
    }

    expect(observedFailure).toBeInstanceOf(AggregateError);
    const failures = (observedFailure as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ message: "injected primary scenario failure" });
    expect(failures[1]).toMatchObject({ message: "guarded native teardown failed: recovery-resources" });
    const resourceFailure = (failures[1] as Error & { cause?: unknown }).cause;
    expect(resourceFailure).toBeInstanceOf(AggregateError);
    expect((resourceFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "injected owned resource close failure" }),
    ]);
    expect(failingClose).toHaveBeenCalledTimes(1);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    if (acquiredDb === undefined) throw new Error("recovery DB was not acquired");
    await expect(acquiredDb.captureCycle()).rejects.toThrow("gateway settlement recovery database is closing");
    expect(teardownSteps).toEqual([
      "recovery-resources",
      "fixture-rows",
      "foreign-sentinel-verified",
      "foreign-sentinel-deleted",
      "primary-client-closed",
      "secondary-client-closed",
      "api-gateway-singleton-closed",
    ]);
  }, nativeTestTimeoutMs);

  it("settles through the scheduled loop, races two pools once, and replays a lost ACK with one financial effect", async () =>
    guardedRun(async (f) => {
      const scheduled = await f.createAttempt("outcome");
      const scheduledDb = f.createRecoveryDb();
      const callbacks: Array<() => void> = [];
      const tick = deferred<void>();
      const handle = f.startRecovery({
        db: scheduledDb,
        scheduler: {
          setTimeout(callback: () => void, delayMs: 60_000) {
            expect(delayMs).toBe(60_000);
            callbacks.push(callback);
            return callbacks.length;
          },
          clearTimeout: vi.fn(),
        },
        onTick(result) {
          expect(result).toMatchObject({ classification: "complete", selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
          tick.resolve();
        },
      });
      await tick.promise;
      expect(callbacks).toHaveLength(1);
      await handle.close();
      const scheduledFacts = await f.settlementFacts(scheduled.billingRequestId);
      expect(scheduledFacts.admission).toEqual([{ state: "settled", actual_cost_credits: "210", has_settled_at: true }]);
      expect(scheduledFacts.receipts).toHaveLength(1);
      expect(scheduledFacts.settlements).toEqual([{ event_key: "settlement", event_kind: "settlement" }]);
      expect(scheduledFacts.reservations).toHaveLength(2);
      expect(scheduledFacts.reservations.every((row) => row.state === "settled")).toBe(true);
      expect(scheduledFacts.quotaSettlements).toHaveLength(2);

      const raced = await f.createAttempt("outcome");
      const firstDb = f.createRecoveryDb();
      const secondDb = f.createRecoveryDb();
      const [first, second] = await Promise.all([
        f.recovery.createGatewaySettlementRecoveryLoop(firstDb).runTick(() => false),
        f.recovery.createGatewaySettlementRecoveryLoop(secondDb).runTick(() => false),
      ]);
      expect(first).toMatchObject({ selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
      expect(second).toMatchObject({ selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
      await Promise.all([firstDb.close(), secondDb.close()]);
      const raceFacts = await f.settlementFacts(raced.billingRequestId);
      expect(raceFacts.receipts).toHaveLength(1);
      expect(raceFacts.settlements).toHaveLength(1);
      expect(raceFacts.quotaSettlements).toHaveLength(2);

      const lost = await f.createAttempt("outcome");
      const lostHint = await f.hintFor(lost.billingRequestId);
      const native = f.createRecoveryDb();
      const lostAckDb = f.ownRecoveryResource({
        captureCycle: () => native.captureCycle(),
        selectPage: (input: Parameters<typeof native.selectPage>[0]) => native.selectPage(input),
        async recover(input: Parameters<typeof native.recover>[0]) {
          await native.recover(input);
          throw new Error("application lost committed acknowledgement");
        },
        close: () => native.close(),
      });
      const lostResult = await f.recovery.createGatewaySettlementRecoveryLoop(lostAckDb).runTick(() => false);
      expect(lostResult).toMatchObject({ classification: "partial_unconfirmed", selected: 1, attempted: 1, settled: 0, unconfirmed: 1 });
      await lostAckDb.close();
      const afterLost = await f.settlementFacts(lost.billingRequestId);
      const replayDb = f.createRecoveryDb();
      await expect(replayDb.recover(lostHint)).resolves.toMatchObject({ state: "settled", billingRequestId: lost.billingRequestId });
      await replayDb.close();
      expect(await f.settlementFacts(lost.billingRequestId)).toEqual(afterLost);
      expect(afterLost.receipts).toHaveLength(1);
      expect(afterLost.settlements).toHaveLength(1);
      expect(afterLost.quotaSettlements).toHaveLength(2);
    }), nativeTestTimeoutMs);

  it("recovers revoked and disabled keys plus an expired tombstone without changing retained HTTP evidence", async () =>
    guardedRun(async (f) => {
      const revokedKey = await f.createKey();
      const disabledKey = await f.createKey();
      const revoked = await f.createAttempt("outcome", { key: revokedKey });
      const disabled = await f.createAttempt("outcome", { key: disabledKey });
      const tombstone = await f.createAttempt("outcome");
      await f.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${revokedKey}::uuid`;
      await f.client`UPDATE gateway_api_keys SET disabled_at=clock_timestamp() WHERE id=${disabledKey}::uuid`;
      await f.client`
        WITH original AS (
          DELETE FROM gateway_http_results
          WHERE billing_request_id=${tombstone.billingRequestId}::uuid AND org_id=${f.org}::uuid
          RETURNING *
        )
        INSERT INTO gateway_http_results(
          billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,
          response_body,response_digest,stored_at,expires_at
        )
        SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,
          response_body,response_digest,t.at-INTERVAL '168 hours',t.at
        FROM original CROSS JOIN (SELECT clock_timestamp() AS at) AS t
      `;
      expect(await f.http.expireGatewayHttpResult({ orgId: f.org, billingRequestId: tombstone.billingRequestId }, f.client)).toBe(true);
      const tombstoneBefore = await f.other`
        SELECT response_body,response_digest,to_char(stored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
          to_char(payload_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS payload_expired_at
        FROM gateway_http_results WHERE billing_request_id=${tombstone.billingRequestId}::uuid
      `;
      expect(tombstoneBefore[0]?.response_body).toBeNull();

      const db = f.createRecoveryDb();
      const capture = await db.captureCycle();
      expect(capture).not.toBeNull();
      const page = await db.selectPage({
        cycleDueBefore: capture!.cycleDueBefore, after: null, upper: capture!.upper, limit: 20,
      });
      expect({
        revoked: page.hints.some((hint) => hint.billingRequestId === revoked.billingRequestId),
        disabled: page.hints.some((hint) => hint.billingRequestId === disabled.billingRequestId),
        tombstone: page.hints.some((hint) => hint.billingRequestId === tombstone.billingRequestId),
      }).toEqual({ revoked: true, disabled: true, tombstone: true });
      const result = await f.recovery.createGatewaySettlementRecoveryLoop(db).runTick(() => false);
      expect(result).toMatchObject({ selected: 3, attempted: 3, settled: 3, unconfirmed: 0 });
      await db.close();
      for (const item of [revoked, disabled, tombstone]) {
        expect((await f.settlementFacts(item.billingRequestId)).admission[0]?.state).toBe("settled");
      }
      expect(await f.other`
        SELECT response_body,response_digest,to_char(stored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
          to_char(payload_expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS payload_expired_at
        FROM gateway_http_results WHERE billing_request_id=${tombstone.billingRequestId}::uuid
      `).toEqual(tombstoneBefore);
    }), nativeTestTimeoutMs);

  it("excludes incomplete and rejected evidence, enforces owner facts, and advances past a failed prefix", async () =>
    guardedRun(async (f) => {
      const held = await f.createAttempt("held");
      const dispatched = await f.createAttempt("dispatched");
      const cancelledSource = await f.createAttempt("held");
      if (cancelledSource.admitted === undefined) throw new Error("missing held admission");
      await f.admission.cancelUndispatchedGatewayCharge({ admission: cancelledSource.admitted }, f.client);
      const rejected = await f.createRejected();
      const missingResult = await f.createAttempt("outcome");
      await f.client`DELETE FROM gateway_http_results WHERE billing_request_id=${missingResult.billingRequestId}::uuid`;
      const missingQuota = await f.createAttempt("outcome");
      await f.client`DELETE FROM gateway_charge_quota_events WHERE billing_request_id=${missingQuota.billingRequestId}::uuid`;
      await f.client`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id=${missingQuota.billingRequestId}::uuid`;
      await f.client`DELETE FROM gateway_charge_quota_contexts WHERE billing_request_id=${missingQuota.billingRequestId}::uuid`;

      const selector = f.createRecoveryDb();
      await expect(selector.captureCycle()).resolves.toBeNull();
      await expect(selector.recover({
        ...(await f.hintFor(missingResult.billingRequestId)),
        orgId: f.foreignOrg,
      })).rejects.toBeInstanceOf(Error);
      for (const billingRequestId of [
        held.billingRequestId, dispatched.billingRequestId, cancelledSource.billingRequestId,
        rejected.billingRequestId, missingResult.billingRequestId, missingQuota.billingRequestId,
      ]) {
        expect((await f.other`SELECT state FROM gateway_charge_admissions WHERE billing_request_id=${billingRequestId}::uuid`)[0]?.state)
          .not.toBe("settled");
      }
      await selector.close();

      const failedPrefix = await f.createAttempt("outcome");
      const later = await f.createAttempt("outcome");
      const removeFailure = await f.installSettlementFailure(failedPrefix.billingRequestId);
      const db = f.createRecoveryDb();
      const first = await f.recovery.createGatewaySettlementRecoveryLoop(db).runTick(() => false);
      expect(first).toMatchObject({ classification: "partial_unconfirmed", selected: 2, attempted: 2, settled: 1, unconfirmed: 1 });
      expect((await f.settlementFacts(failedPrefix.billingRequestId)).admission[0]?.state).toBe("outcome_recorded");
      expect((await f.settlementFacts(later.billingRequestId)).admission[0]?.state).toBe("settled");
      await db.close();
      await removeFailure();
      const retryDb = f.createRecoveryDb();
      const retry = await f.recovery.createGatewaySettlementRecoveryLoop(retryDb).runTick(() => false);
      expect(retry).toMatchObject({ classification: "complete", selected: 1, attempted: 1, settled: 1, unconfirmed: 0 });
      await retryDb.close();
      expect((await f.settlementFacts(failedPrefix.billingRequestId)).admission[0]?.state).toBe("settled");
    }), nativeTestTimeoutMs);

  it("uses outcome write time as the real cutoff and admits only bounded pre-cutoff late commits", async () =>
    guardedRun(async (f) => {
      const postCutoffTarget = await f.createAttempt("dispatched", { deadlineMs: 2_000 });
      if (postCutoffTarget.outcomeInput === undefined) throw new Error("missing deferred outcome input");
      // The deadline was future when admitted/dispatched. Let wall clock pass it;
      // no immutable admission timestamp is edited to manufacture the case.
      await f.client`SELECT pg_sleep(2.1)`;
      expect((await f.other`
        SELECT pre_dispatch_deadline_at < clock_timestamp() AS deadline_is_old
        FROM gateway_charge_admissions WHERE billing_request_id=${postCutoffTarget.billingRequestId}::uuid
      `)[0]?.deadline_is_old).toBe(true);
      const firstAnchor = await f.createAttempt("outcome");
      const writeGate = deferred<void>();
      const postWritten = deferred<string>();
      const postCommit = deferred<void>();
      const transactionStarted = deferred<void>();
      const postTransaction = f.client.begin(async (tx) => {
        transactionStarted.resolve();
        await writeGate.promise;
        const written = await f.http.recordGatewayHttpOutcome(postCutoffTarget.outcomeInput!, tx as unknown as SqlClient);
        if (written.outcomeRecordedAt === null) throw new Error("missing accepted outcome timestamp");
        postWritten.resolve(written.outcomeRecordedAt);
        await postCommit.promise;
      });
      let cutoffDb: ReturnType<typeof f.createRecoveryDb> | undefined;
      try {
        await transactionStarted.promise;
        cutoffDb = f.createRecoveryDb();
        const captured = await cutoffDb.captureCycle();
        expect(captured).not.toBeNull();
        writeGate.resolve();
        const postTimestamp = await postWritten.promise;
        expect(postTimestamp > captured!.cycleDueBefore).toBe(true);
        postCommit.resolve();
        await postTransaction;
        const currentPage = await cutoffDb.selectPage({
          cycleDueBefore: captured!.cycleDueBefore, after: null, upper: captured!.upper, limit: 20,
        });
        expect(currentPage.hints.some((hint) => hint.billingRequestId === postCutoffTarget.billingRequestId)).toBe(false);
        expect(currentPage.hints.some((hint) => hint.billingRequestId === firstAnchor.billingRequestId)).toBe(true);
        const laterCycle = await cutoffDb.captureCycle();
        expect(laterCycle).not.toBeNull();
        expect(laterCycle!.upper.billingRequestId).toBe(postCutoffTarget.billingRequestId);
      } finally {
        writeGate.resolve();
        postCommit.resolve();
        await postTransaction;
        await cutoffDb?.close();
      }

      const preCutoffTarget = await f.createAttempt("dispatched");
      if (preCutoffTarget.outcomeInput === undefined) throw new Error("missing deferred pre-cutoff outcome input");
      const preWritten = deferred<string>();
      const preCommit = deferred<void>();
      const preTransaction = f.client.begin(async (tx) => {
        const written = await f.http.recordGatewayHttpOutcome(preCutoffTarget.outcomeInput!, tx as unknown as SqlClient);
        if (written.outcomeRecordedAt === null) throw new Error("missing accepted pre-cutoff outcome timestamp");
        preWritten.resolve(written.outcomeRecordedAt);
        await preCommit.promise;
      });
      let upperFixture: Awaited<ReturnType<typeof createFixture>> | undefined;
      try {
        const preTimestamp = await preWritten.promise;
        // The pending outcome owns an organization row lock. A separate legal owner
        // supplies the visible upper bound without weakening that lock or backdating.
        upperFixture = await createFixture(f.other, f.other, f.foreignOrg);
        const upperAnchor = await upperFixture.createAttempt("outcome");
        const boundedDb = f.createRecoveryDb();
        const boundedCapture = await boundedDb.captureCycle();
        expect(boundedCapture).not.toBeNull();
        expect(boundedCapture!.upper.billingRequestId).toBe(upperAnchor.billingRequestId);
        preCommit.resolve();
        await preTransaction;
        expect(preTimestamp <= boundedCapture!.cycleDueBefore).toBe(true);
        const boundedPage = await boundedDb.selectPage({
          cycleDueBefore: boundedCapture!.cycleDueBefore, after: null, upper: boundedCapture!.upper, limit: 20,
        });
        expect(boundedPage.hints.some((hint) => hint.billingRequestId === preCutoffTarget.billingRequestId)).toBe(true);
        expect(boundedPage.hints.some((hint) => hint.billingRequestId === upperAnchor.billingRequestId)).toBe(true);
        await boundedDb.close();
      } finally {
        preCommit.resolve();
        await preTransaction;
        await upperFixture?.cleanup();
      }
    }), nativeTestTimeoutMs);
});
