import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { SqlClient } from "../lib/db";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
} from "../../../database/scripts/test-db-guard";
import { createPgTestClient } from "../../../database/scripts/pg-test-client";

export const slug = "openai/gpt-4o-mini";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function guard() {
  assertTestDatabaseEnvironment(process.env);
  const redis = new URL(process.env.REDIS_URL!);
  if (
    redis.protocol !== "redis:" ||
    redis.hostname !== "127.0.0.1" ||
    redis.port !== "16379" ||
    redis.search ||
    !["", "/0", "/"].includes(redis.pathname)
  )
    throw Error("MC3 requires dedicated Redis 127.0.0.1:16379 database 0");
}
export type CatalogMutationOwnership = {
  state: "not_started" | "uncertain" | "committed" | "rolled_back";
};
export type StoredMountedRuntimeOptions = Readonly<{
  executionMode?: "stored_chat_only" | "stored_chat_embeddings_completions";
  cachingDiscount?: string;
  providerCompletionTokens?: number;
  providerCachedInputTokens?: number;
  providerText?: string;
}>;
export async function runtime(options: StoredMountedRuntimeOptions = {}) {
  guard();
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async () => {},
  );
  const environmentNames = [
    "GATEWAY_HTTP_EXECUTION_MODE",
    "OPENROUTER_API_KEY",
    "AIAG_FORCE_MOCK",
    "CACHING_DISCOUNT",
  ];
  const originalEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const restoreEnvironment = () => {
    for (const name of environmentNames) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const setupCleanup: Array<() => Promise<unknown> | void> = [
    restoreEnvironment,
  ];
  try {
    process.env.GATEWAY_HTTP_EXECUTION_MODE = options.executionMode ?? "stored_chat_only";
    process.env.OPENROUTER_API_KEY = "mc3-transport-stub-only";
    delete process.env.AIAG_FORCE_MOCK;
    process.env.CACHING_DISCOUNT = options.cachingDiscount ?? "0.5";
    const { default: postgres } = await import("postgres");
    const client = postgres(process.env.TEST_DATABASE_URL!, {
      max: 1,
      onnotice: () => {},
    });
    setupCleanup.push(() => client.end());
    const other = postgres(process.env.TEST_DATABASE_URL!, {
      max: 1,
      onnotice: () => {},
    });
    setupCleanup.push(() => other.end());
    const { sql } = await import("../lib/db");
    setupCleanup.push(() => sql.end());
    const redisModule = await import("../lib/redis");
    const redis = redisModule.redis;
    setupCleanup.push(() => redis.disconnect());
    const transport = await import("../upstreams/fetch-upstream");
    const output = {
      id: "cmpl-native",
      object: "chat.completion",
      created: 1,
      model: slug,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: options.providerText ?? "native private completion" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: options.providerCompletionTokens ?? 20,
        total_tokens: 100 + (options.providerCompletionTokens ?? 20),
        prompt_tokens_details: { cached_tokens: options.providerCachedInputTokens ?? 50 },
      },
    };
    const provider = vi.spyOn(transport, "fetchUpstream").mockImplementation(
      async () =>
        new Response(JSON.stringify(output), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    setupCleanup.push(() => provider.mockRestore());
    // Fail any accidental non-provider network request before DNS. app.fetch is in-process.
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw Error("MC3 forbidden network");
      });
    setupCleanup.push(() => network.mockRestore());
    const storage = await import("../billing/http-storage");
    const terminal = await import("../billing/http-terminal-recovery");
    const admission = await import("../billing/admission");
    const resolver = await import("../routing/stored-chat-fresh-resolver");
    const policy = await import("../billing/stored-chat-fresh-policy");
    const fresh = vi.spyOn(resolver, "resolveStoredChatFreshModel");
    const prep = vi.spyOn(policy, "prepareStoredChatFreshPolicy");
    const legacy = vi.spyOn(await import("../billing/settle"), "settleCharge");
    const { logger } = await import("../lib/logger");
    const logs = [
      vi.spyOn(logger, "error"),
      vi.spyOn(logger, "warn"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "debug"),
    ];
    const legacyLog = vi.spyOn(await import("../logging/stream"), "logRequest");
    const failover = vi.spyOn(
      await import("../routing/failover"),
      "executeWithFailover",
    );
    const { app } = await import("../server");
    await redis.ping();
    const rpm = redisModule.makeRedis("ratelimit");
    setupCleanup.push(() => rpm.disconnect());
    await rpm.ping();
    const catalog = async (reader: SqlClient = client) => ({
      models:
        await reader`SELECT to_jsonb(m)::text AS row FROM models m WHERE slug=${slug}`,
      candidates:
        await reader`SELECT to_jsonb(mu)::text AS row FROM model_upstreams mu JOIN models m ON mu.model_id=m.id WHERE m.slug=${slug} ORDER BY mu.id`,
      upstreams:
        await reader`SELECT to_jsonb(u)::text AS row FROM upstreams u WHERE id='openrouter'`,
    });
    const original = await catalog();
    // These are the canonical seed/profile anchors, never arbitrary catalog rows.
    expect(original.models).toHaveLength(1);
    expect(original.candidates).toHaveLength(1);
    expect(original.upstreams).toHaveLength(1);
    const m = JSON.parse(original.models[0]!.row as string),
      c = JSON.parse(original.candidates[0]!.row as string),
      u = JSON.parse(original.upstreams[0]!.row as string);
    expect(m).toMatchObject({
      slug,
      type: "chat",
      enabled: true,
      status: "live",
    });
    expect(c).toMatchObject({
      model_id: m.id,
      upstream_id: "openrouter",
      upstream_model_id: slug,
      enabled: true,
    });
    // 0006_seed_models + 0057_markup_180; fail on catalog drift before mutation.
    expect(Number(c.price_per_1k_input)).toBe(0.015);
    expect(Number(c.price_per_1k_output)).toBe(0.06);
    expect(Number(c.markup)).toBe(1.8);
    expect(m.display_name).toBe("GPT-4o mini");
    expect(u.provider).toBe("openrouter");
    expect(u).toMatchObject({ id: "openrouter", enabled: true });
    type Catalog = Awaited<ReturnType<typeof catalog>>;
    type Mutation = {
      before: Catalog;
      after: Catalog;
      ownership?: CatalogMutationOwnership;
    };
    let expected = original;
    let pending: Mutation | null = null;
    const same = (left: Catalog, right: Catalog) =>
      JSON.stringify(left) === JSON.stringify(right);
    async function reconcileMutation() {
      if (!pending) return;
      const intent = pending;
      const observed = await catalog(other);
      if (same(observed, intent.after)) {
        expected = intent.after;
        if (intent.ownership) intent.ownership.state = "committed";
      } else if (same(observed, intent.before)) {
        expected = intent.before;
        if (intent.ownership) intent.ownership.state = "rolled_back";
      } else {
        throw Error(
          "refuse to adopt competing catalog mutation during reconciliation",
        );
      }
      pending = null;
    }
    async function mutateCatalog(
      run: (db: SqlClient) => Promise<unknown>,
      options: {
        ownership?: CatalogMutationOwnership;
        losePostCommitSnapshotAck?: boolean;
      } = {},
    ) {
      await reconcileMutation();
      try {
        await client.begin(async (tx) => {
          // Serialize the precondition, mutation and intended snapshot. A failed
          // in-transaction snapshot rolls back instead of losing cleanup ownership.
          await tx`LOCK TABLE models,model_upstreams,upstreams IN SHARE ROW EXCLUSIVE MODE`;
          expect(
            same(await catalog(tx as unknown as SqlClient), expected),
            "competing catalog mutation",
          ).toBe(true);
          const before = expected;
          await run(tx as unknown as SqlClient);
          const after = await catalog(tx as unknown as SqlClient);
          pending = { before, after, ownership: options.ownership };
          if (options.ownership) options.ownership.state = "uncertain";
        });
        // Keep intent and ownership before any fallible post-commit audit read.
        if (options.ownership) options.ownership.state = "committed";
        const observed = await catalog();
        if (options.losePostCommitSnapshotAck)
          throw Error("MC3 simulated post-commit snapshot ACK loss");
        if (!pending || !same(observed, pending.after))
          throw Error("competing post-commit catalog mutation");
        expected = pending.after;
        pending = null;
      } catch (originalError) {
        try {
          await reconcileMutation();
        } catch (reconciliationError) {
          // Keep pending intent for a later independent retry; never adopt an
          // unexplained row state or overwrite it during restore.
          throw new AggregateError(
            [originalError, reconciliationError],
            "MC3 catalog mutation and reconciliation failed",
          );
        }
        throw originalError;
      }
    }
    async function restoreCatalog() {
      await reconcileMutation();
      await mutateCatalog(async (tx) => {
        await tx`UPDATE models SET enabled=${m.enabled},status=${m.status} WHERE id=${m.id}::uuid`;
        await tx`UPDATE model_upstreams SET enabled=${c.enabled},price_per_1k_input=${c.price_per_1k_input},price_per_1k_output=${c.price_per_1k_output},markup=${c.markup},upstream_model_id=${c.upstream_model_id} WHERE id=${c.id}::uuid`;
        await tx`UPDATE upstreams SET enabled=${u.enabled},ru_residency=${u.ru_residency} WHERE id='openrouter'`;
      });
      expect(
        same(await catalog(other), original),
        "catalog restored exactly",
      ).toBe(true);
    }
    setupCleanup.push(restoreCatalog);
    async function close() {
      const failures: unknown[] = [];
      for (const close of [
        restoreCatalog,
        () => sql.end(),
        () => redis.quit(),
        () => rpm.quit(),
        () => client.end(),
        () => other.end(),
      ]) {
        try {
          await close();
        } catch (e) {
          failures.push(e);
        }
      }
      provider.mockRestore();
      network.mockRestore();
      fresh.mockRestore();
      prep.mockRestore();
      legacy.mockRestore();
      legacyLog.mockRestore();
      failover.mockRestore();
      for (const log of logs) log.mockRestore();
      restoreEnvironment();
      if (failures.length)
        throw new AggregateError(failures, "MC3 runtime cleanup failed");
    }
    return {
      client,
      other,
      sql,
      redis,
      rpm,
      app,
      storage,
      terminal,
      admission,
      provider,
      output,
      fresh,
      prep,
      legacy,
      logs,
      legacyLog,
      failover,
      mutateCatalog,
      restoreCatalog,
      reconcileMutation,
      close,
    };
  } catch (originalError) {
    const failures: unknown[] = [originalError];
    for (const cleanup of setupCleanup.reverse())
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    throw new AggregateError(failures, "MC3 setup and cleanup failed");
  }
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;
type DefaultStoredChatBody = Readonly<{
  model: string;
  messages: readonly [Readonly<{ role: 'user'; content: string }>];
}>;
export type StoredMountedOwnerOptions<Body = DefaultStoredChatBody> = Readonly<{
  path?: "/v1/chat/completions" | "/v1/completions";
  body?: Body;
  initialPaygCredits?: number;
}>;
export async function owner<Body = DefaultStoredChatBody>(
  r: Runtime,
  options: StoredMountedOwnerOptions<Body> = {},
) {
  const user = randomUUID(),
    org = randomUUID(),
    key = randomUUID(),
    token = `sk_aiag_test_${randomUUID().replaceAll("-", "")}`;
  await r.client.begin(async (tx) => {
    await tx`INSERT INTO users(id,email) VALUES(${user}::uuid,${`mc3-${user}@example.test`})`;
    await tx`INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES(${org}::uuid,${org},'MC3 owned native fixture',${user}::uuid,${options.initialPaygCredits ?? 1000000000})`;
    await tx`INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,rpm_limit,batch_rpm_limit,cost_limit_monthly_rub) VALUES(${key}::uuid,${org}::uuid,'MC3 owned key',${hash(token)},${token.slice(0, 20)},10000,10000,NULL)`;
    await tx`INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES(${org}::uuid,2,1000000000)`;
  });
  const body = (options.body ?? {
    model: slug,
    messages: [{ role: "user", content: "private MC3 prompt" }],
  }) as Body extends DefaultStoredChatBody ? Body : Body | DefaultStoredChatBody;
  const redisKeys = [
    `rl:rpm:${key}`,
    `rl:batch:${key}`,
    `usd_day:${org}:${new Date().toISOString().slice(0, 10)}`,
  ];
  const post = async (
    id = randomUUID(),
    data: unknown = body,
    init: RequestInit = {},
  ) => {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": id,
    });
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const result = await r.app.fetch(
      new Request(`http://native.test${options.path ?? "/v1/chat/completions"}`, {
        method: "POST",
        body: JSON.stringify(data),
        ...init,
        headers,
      }),
    );
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    for (const header of [
      "x-aiag-upstream-cost-usd-micro",
      "x-aiag-upstream-cost-rub",
      "x-aiag-charged-rub",
    ]) {
      expect(
        result.headers.has(header),
        "restricted response must not expose legacy supplier receipt",
      ).toBe(false);
    }
    return result;
  };
  const facts = async () => ({
    mapping:
      await r.other`SELECT * FROM gateway_http_requests WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    rejection:
      await r.other`SELECT * FROM gateway_http_rejections WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    result:
      await r.other`SELECT * FROM gateway_http_results WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    admission:
      await r.other`SELECT * FROM gateway_charge_admissions WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    ledger:
      await r.other`SELECT * FROM gateway_transactions WHERE org_id=${org}::uuid ORDER BY id`,
    bucket:
      await r.other`SELECT * FROM gateway_quota_buckets WHERE org_id=${org}::uuid ORDER BY id`,
    context:
      await r.other`SELECT * FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid ORDER BY billing_request_id`,
    event:
      await r.other`SELECT e.* FROM gateway_charge_quota_events e JOIN gateway_charge_admissions a USING(billing_request_id) WHERE a.org_id=${org}::uuid ORDER BY e.billing_request_id,e.bucket_id,e.event_kind`,
    pii: await r.other`SELECT * FROM pii_detections WHERE org_id=${org}::uuid ORDER BY id`,
    batch:
      await r.other`SELECT * FROM batches WHERE org_id=${org}::uuid ORDER BY batch_id`,
    balance:
      await r.other`SELECT payg_credits::text,subscription_credits::text FROM organizations WHERE id=${org}::uuid`,
  });
  async function cleanup() {
    const ids = (
      await r.client`SELECT billing_request_id FROM gateway_http_requests WHERE org_id=${org}::uuid UNION SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=${org}::uuid`
    ).map((x) => String(x.billing_request_id));
    await r.client.begin(async (tx) => {
      expect(
        (
          await tx`SELECT owner_id FROM organizations WHERE id=${org}::uuid FOR UPDATE`
        )[0]?.owner_id,
      ).toBe(user);
      await tx`DELETE FROM pii_detections WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM batches WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_rejections WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_results WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_http_requests WHERE org_id=${org}::uuid`;
      await tx`DELETE FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${ids}::uuid[])`;
      await tx`DELETE FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${ids}::uuid[])`;
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
    for (const redisKey of redisKeys) await r.redis.del(redisKey);
    const residual = await r.other`
      SELECT count(*)::text AS n FROM gateway_http_requests WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_http_rejections WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_http_results WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_charge_admissions WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_charge_quota_events WHERE billing_request_id=ANY(${ids}::uuid[])
      UNION ALL SELECT count(*)::text FROM gateway_charge_quota_reservations WHERE billing_request_id=ANY(${ids}::uuid[])
      UNION ALL SELECT count(*)::text FROM gateway_charge_quota_contexts WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_quota_buckets WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_quota_key_policies WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_quota_org_policies WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_transactions WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM gateway_api_keys WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM organizations WHERE id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM users WHERE id=${user}::uuid
      UNION ALL SELECT count(*)::text FROM pii_detections WHERE org_id=${org}::uuid
      UNION ALL SELECT count(*)::text FROM batches WHERE org_id=${org}::uuid`;
    expect(residual).toHaveLength(16);
    for (const row of residual) expect(row.n, "owned residual").toBe("0");
    for (const redisKey of redisKeys)
      expect(await r.redis.exists(redisKey)).toBe(0);
  }
  return { user, org, key, token, body, post, facts, cleanup, redisKeys };
}
export type Owner = Awaited<ReturnType<typeof owner<DefaultStoredChatBody>>>;
