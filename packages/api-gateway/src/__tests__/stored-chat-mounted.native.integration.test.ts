import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  guard,
  runtime,
  owner,
  slug,
  type Runtime,
  type Owner,
} from "./stored-chat-mounted.native.fixture";
import type { SqlClient } from "../lib/db";

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) guard();
const receipt = "x-aiag-charged-microcredits";
async function response(r: Response) {
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers),
    body: (await r.json()) as { error: { code: string } },
  };
}
function noReceipt(r: Response) {
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  for (const h of [
    receipt,
    "x-aiag-charged-usd-micro",
    "x-aiag-charge-state",
    "x-aiag-receipt-version",
    "x-aiag-upstream-cost-usd-micro",
    "x-aiag-cost-usd",
  ])
    expect(r.headers.has(h), h).toBe(false);
}
async function waitFor(check: () => Promise<boolean>, message: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(message);
}
describe.skipIf(!enabled)(
  "MC01–18 guarded actual server.ts mounted native acceptance",
  () => {
    let r: Runtime, f: Owner, sentinel: Owner;
    let sentinelBefore: unknown,
      sentinelKeyBefore: unknown,
      queuesBefore: unknown;
    const queues = async () => {
      const keys = (await r.redis.keys("bull:batch-process:*")).sort();
      return Promise.all(
        keys.map(async (key) => [key, await r.redis.dump(key)]),
      );
    };
    let restore: Array<() => void> = [];
    beforeAll(async () => {
      r = await runtime();
      sentinel = await owner(r);
      expect((await sentinel.post()).status).toBe(200);
      sentinelBefore = await sentinel.facts();
      sentinelKeyBefore =
        await r.other`SELECT to_jsonb(k)::text AS row FROM gateway_api_keys k WHERE id=${sentinel.key}::uuid`;
      queuesBefore = await queues();
      await r.redis.set(
        `mc3:unrelated:${sentinel.org}`,
        "populated unrelated value",
      );
    }, 30000);
    beforeEach(async () => {
      f = await owner(r);
      r.provider.mockClear();
      r.fresh.mockClear();
      r.prep.mockClear();
      r.legacy.mockClear();
    });
    afterEach(async () => {
      for (const undo of restore.reverse()) undo();
      restore = [];
      const failures: unknown[] = [];
      for (const cleanup of [
        () => f?.cleanup(),
        () => r.restoreCatalog(),
        async () => {
          expect(await sentinel.facts()).toEqual(sentinelBefore);
          expect(
            JSON.stringify(
              await r.other`SELECT to_jsonb(k)::text AS row FROM gateway_api_keys k WHERE id=${sentinel.key}::uuid`,
            ) === JSON.stringify(sentinelKeyBefore),
            "unrelated key unchanged",
          ).toBe(true);
          expect(await queues()).toEqual(queuesBefore);
          expect(await r.redis.get(`mc3:unrelated:${sentinel.org}`)).toBe(
            "populated unrelated value",
          );
          expect(r.legacy).not.toHaveBeenCalled();
          expect(r.legacyLog).not.toHaveBeenCalled();
          expect(r.failover).not.toHaveBeenCalled();
          const logs = JSON.stringify(r.logs.map((log) => log.mock.calls));
          for (const secret of [
            f.token,
            "private MC3 prompt",
            "diagnostic secret",
            "mc3-transport-stub-only",
          ])
            expect(logs).not.toContain(secret);
          const triggers =
            await r.other`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname IN ('gateway_http_request_immutable','gateway_http_result_immutable','gateway_http_rejection_immutable') ORDER BY tgname`;
          expect(triggers.length).toBeGreaterThanOrEqual(2);
          for (const trigger of triggers) expect(trigger.tgenabled).toBe("O");
        },
      ])
        try {
          await cleanup();
        } catch (e) {
          failures.push(e);
        }
      if (failures.length)
        throw new AggregateError(failures, "MC18 per-case cleanup failed");
    });
    afterAll(async () => {
      if (!r) return;
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => {
          if (sentinel) {
            await sentinel.cleanup();
            await r.redis.del(`mc3:unrelated:${sentinel.org}`);
          }
        },
        () => r.close(),
      ])
        try {
          await cleanup();
        } catch (e) {
          failures.push(e);
        }
      if (failures.length)
        throw new AggregateError(failures, "MC18 final cleanup failed");
    });
    async function fixed(res: Response, status: number) {
      expect(res.status).toBe(status);
      noReceipt(res);
      const json = (await res.json()) as {
        error: {
          code: string;
          message: string;
          type?: string;
          details?: unknown;
        };
      };
      expect(Object.keys(json)).toEqual(["error"]);
      if (json.error.code === "UNAUTHORIZED")
        expect(json).toEqual({
          error: { code: "UNAUTHORIZED", message: "Invalid API key" },
        });
      else if (json.error.code === "RATE_LIMITED") {
        expect(Object.keys(json.error).sort()).toEqual([
          "code",
          "details",
          "message",
        ]);
        expect(json.error.message).toBe("Rate limit exceeded");
      } else
        expect(Object.keys(json.error).sort()).toEqual([
          "code",
          "message",
          "type",
        ]);
      for (const secret of [
        f.token,
        "private MC3 prompt",
        "mc3-transport-stub-only",
        "diagnostic secret",
      ])
        expect(JSON.stringify(json)).not.toContain(secret);
      return json;
    }
    async function noEffects() {
      const facts = await f.facts();
      for (const k of [
        "mapping",
        "rejection",
        "result",
        "admission",
        "ledger",
        "context",
        "event",
        "batch",
      ] as const)
        expect(facts[k], k).toHaveLength(0);
      expect(r.provider).not.toHaveBeenCalled();
      expect(r.legacy).not.toHaveBeenCalled();
    }
    async function settle(id = randomUUID()) {
      const res = await f.post(id);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      return { id, res };
    }
    it("MC01: startup-captured restricted mode ignores header/query/body attempts to choose legacy", async () => {
      const config = await import("../config");
      expect(config.config.GATEWAY_HTTP_EXECUTION_MODE).toBe(
        "stored_chat_only",
      );
      process.env.GATEWAY_HTTP_EXECUTION_MODE = "legacy";
      try {
        const res = await r.app.fetch(
          new Request(
            "http://native.test/v1/embeddings?GATEWAY_HTTP_EXECUTION_MODE=legacy",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${f.token}`,
                "x-gateway-http-execution-mode": "legacy",
              },
              body: "{}",
            },
          ),
        );
        await fixed(res, 501);
        await noEffects();
      } finally {
        process.env.GATEWAY_HTTP_EXECUTION_MODE = "stored_chat_only";
      }
    });
    it("MC02: native fresh auth rejects missing/malformed/unknown/revoked/disabled bearer without reading a Redis authorization cache", async () => {
      const cacheRead = vi.spyOn(r.redis, "get");
      restore.push(() => cacheRead.mockRestore());
      for (const token of [
        "",
        "Bearer bad",
        "Bearer sk_aiag_test_000000000000000000000000",
      ]) {
        await fixed(
          await r.app.fetch(
            new Request("http://native.test/v1/chat/completions", {
              method: "POST",
              headers: { authorization: token },
            }),
          ),
          401,
        );
      }
      for (const column of ["revoked_at", "disabled_at"] as const) {
        if (column === "revoked_at")
          await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
        else
          await r.client`UPDATE gateway_api_keys SET revoked_at=NULL,disabled_at=clock_timestamp() WHERE id=${f.key}::uuid`;
        await fixed(await f.post(), 401);
      }
      expect(cacheRead).not.toHaveBeenCalled();
      await noEffects();
    });
    it("MC03: bounded chunked bytes and malformed JSON/identity/content type or authority fields create no mapping", async () => {
      const variants: Array<[RequestInit, number]> = [
        [{ headers: { "idempotency-key": "" } }, 400],
        [{ headers: { "idempotency-key": "bad key" } }, 400],
        [{ headers: { "x-aiag-session-id": "bad session" } }, 400],
        [{ body: "{" }, 400],
        [{ headers: { "content-type": "text/plain" } }, 415],
      ];
      for (const [init, status] of variants)
        await fixed(await f.post(randomUUID(), f.body, init), status);
      for (const extra of [
        { billingRequestId: randomUUID() },
        { orgId: f.org },
        { callback: "https://outside.invalid" },
      ])
        await fixed(await f.post(randomUUID(), { ...f.body, ...extra }), 400);
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(65536).fill(32));
          if (pulls === 20) c.close();
        },
      });
      const raw = new Request("http://native.test/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.token}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: stream,
        duplex: "half",
      } as RequestInit);
      await fixed(await r.app.fetch(raw), 413);
      expect(pulls).toBeLessThan(20);
      await noEffects();
    });
    it("MC03/04: B2 equivalence, significant distinctions, exact stable native receipt and one lifecycle", async () => {
      const { id, res } = await settle();
      const first = await response(res);
      const before = await f.facts();
      expect(before.mapping).toHaveLength(1);
      expect(before.admission).toHaveLength(1);
      expect(before.result).toHaveLength(1);
      expect(before.ledger).toHaveLength(1);
      expect(before.admission[0]?.state).toBe("settled");
      expect(first.headers[receipt]).toBe(
        String(before.admission[0]?.actual_cost_credits),
      );
      expect(first.headers["x-aiag-charged-usd-micro"]).toBe(
        (BigInt(first.headers[receipt]!) * 10n).toString(),
      );
      const repeat = await response(
        await f.post(id, {
          messages: f.body.messages,
          model: slug,
          stream: false,
        }),
      );
      expect(repeat.body).toEqual(first.body);
      expect(repeat.headers[receipt]).toBe(first.headers[receipt]);
      expect(repeat.headers["x-aiag-billing-request-id"]).toBe(
        first.headers["x-aiag-billing-request-id"],
      );
      expect(await f.facts()).toEqual(before);
      expect(r.provider).toHaveBeenCalledTimes(1);
      expect(r.fresh).toHaveBeenCalledTimes(1);
      expect(r.prep).toHaveBeenCalledTimes(1);
      for (const extra of [
        { aiag_mode: "auto" },
        { max_tokens: 4096 },
        { messages: [{ role: "user", content: "different" }] },
      ])
        await fixed(await f.post(id, { ...f.body, ...extra }), 409);
      expect(r.provider).toHaveBeenCalledTimes(1);
    });
    it("MC05: two fresh not_found requests visibly wait for real PG claim lock; exactly one durable winner", async () => {
      let release!: () => void, locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = r.client.begin(async (tx) => {
        await tx`LOCK TABLE gateway_http_requests IN SHARE ROW EXCLUSIVE MODE`;
        locked();
        await gate;
      });
      await ready;
      let reads = 0,
        releaseReads!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const actualRead = r.terminal.readGatewayHttpResultV2;
      const readSpy = vi
        .spyOn(r.terminal, "readGatewayHttpResultV2")
        .mockImplementation(async (a) => {
          const committed = await actualRead(a);
          if (committed.status === "not_found") {
            reads++;
            if (reads === 2) releaseReads();
            await readGate;
          }
          return committed;
        });
      restore.push(() => readSpy.mockRestore());
      const id = randomUUID();
      const first = f.post(id),
        second = f.post(id);
      try {
        await waitFor(
          async () =>
            Number(
              (
                await r.other`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%aiag_claim_gateway_http_request_v1%'`
              )[0]?.n,
            ) >= 2,
          "two native claim lock waits not observed",
        );
        expect(r.fresh).toHaveBeenCalledTimes(2);
        expect(r.provider).not.toHaveBeenCalled();
      } finally {
        releaseReads();
        release();
        await held;
      }
      const results = await Promise.all([first, second]);
      for (const res of results) expect([200, 202]).toContain(res.status);
      const final = await f.post(id);
      expect(final.status).toBe(200);
      const facts = await f.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.admission).toHaveLength(1);
      expect(facts.ledger).toHaveLength(1);
      expect(r.provider).toHaveBeenCalledTimes(1);
      const uuid = String(facts.mapping[0]?.billing_request_id);
      for (const res of results)
        expect(res.headers.get("x-aiag-billing-request-id")).toBe(uuid);
    }, 15000);
    it("MC06: ready replay bypasses frozen/depublished catalog, changed key policy/default/PII and balance/caps", async () => {
      const { id, res } = await settle();
      const original = await response(res);
      const facts = await f.facts();
      await r.client`UPDATE gateway_api_keys SET policies='{"default_mode":"ru-only","unknown_property":true}',model_whitelist='["forbidden"]'::jsonb WHERE id=${f.key}::uuid`;
      await r.client`UPDATE organizations SET payg_credits=0 WHERE id=${f.org}::uuid`;
      await r.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=1,revision=revision+1 WHERE org_id=${f.org}::uuid`;
      for (const status of ["frozen", "depublished"]) {
        await r.mutateCatalog(
          (db) =>
            db`UPDATE models SET status=${status},enabled=FALSE WHERE slug=${slug}`,
        );
        const replay = await response(await f.post(id));
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(original.body);
        expect(replay.headers[receipt]).toBe(original.headers[receipt]);
      }
      expect(r.fresh).toHaveBeenCalledTimes(1);
      expect(r.prep).toHaveBeenCalledTimes(1);
      expect(r.provider).toHaveBeenCalledTimes(1);
      const after = await f.facts();
      for (const field of [
        "ledger",
        "bucket",
        "result",
        "mapping",
        "pii",
        "event",
        "admission",
      ] as const)
        expect(after[field]).toEqual(facts[field]);
      await r.client`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
      await fixed(await f.post(id), 401);
    });
    it("MC07: actual Redis RPM exhaustion/disconnection deny replay, recovery returns stored result; spending cache not admission", async () => {
      const { id } = await settle();
      const facts = await f.facts();
      await r.client`UPDATE gateway_api_keys SET rpm_limit=1 WHERE id=${f.key}::uuid`;
      const exhausted = await f.post(id);
      expect(Number(exhausted.headers.get("retry-after"))).toBeGreaterThan(0);
      await fixed(exhausted, 429);
      await r.redis.del(`rl:rpm:${f.key}`);
      r.rpm.disconnect();
      try {
        await fixed(await f.post(id), 503);
      } finally {
        await r.rpm.connect();
      }
      await r.redis.set(f.redisKeys[2]!, "999999999");
      expect((await f.post(id)).status).toBe(200);
      expect(await f.facts()).toEqual(facts);
      expect(r.provider).toHaveBeenCalledTimes(1);
    });
    it.each([
      "PAYMENT_REQUIRED",
      "REFUND_BLOCKED",
      "QUOTA_EXCEEDED",
      "SESSION_REQUIRED",
      "REQUEST_NOT_STARTED",
    ] as const)(
      "MC08: real C1 durable %s retains original UUID and zero financial effects",
      async (code) => {
        const controller = new AbortController();
        if (code === "PAYMENT_REQUIRED")
          await r.client`UPDATE organizations SET payg_credits=0 WHERE id=${f.org}::uuid`;
        if (code === "REFUND_BLOCKED")
          await r.client`UPDATE organizations SET refund_debt_credits=1 WHERE id=${f.org}::uuid`;
        if (code === "QUOTA_EXCEEDED")
          await r.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=1 WHERE org_id=${f.org}::uuid`;
        if (code === "SESSION_REQUIRED")
          await r.client`INSERT INTO gateway_quota_key_policies(org_id,api_key_id,session_microcredits_limit_v2) VALUES(${f.org}::uuid,${f.key}::uuid,1000000)`;
        if (code === "REQUEST_NOT_STARTED") controller.abort();
        const id = randomUUID(),
          res = await f.post(id, f.body, { signal: controller.signal });
        const result = await response(res);
        expect(result.body.error.code).toBe(code);
        noReceipt(res);
        const facts = await f.facts();
        expect(facts.mapping).toHaveLength(1);
        expect(facts.rejection).toHaveLength(1);
        expect(facts.admission).toHaveLength(0);
        expect(facts.ledger).toHaveLength(0);
        expect(r.provider).not.toHaveBeenCalled();
        await r.client`UPDATE organizations SET payg_credits=1000000000,refund_debt_credits=0 WHERE id=${f.org}::uuid`;
        await r.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=1000000000 WHERE org_id=${f.org}::uuid`;
        const repeat = await response(await f.post(id));
        expect(repeat.body).toEqual(result.body);
        expect(repeat.status).toBe(result.status);
        expect(repeat.headers["x-aiag-billing-request-id"]).toBe(
          result.headers["x-aiag-billing-request-id"],
        );
        expect(r.provider).not.toHaveBeenCalled();
      },
    );
    it.each(["claim", "admit", "dispatch", "outcome", "settle"] as const)(
      "MC09/10: simulated application %s ACK loss preserves native committed facts, recovery never reruns provider",
      async (stage) => {
        const fault = async <T>(run: () => Promise<T>) => {
          await run();
          throw Error("MC3 simulated application ACK loss diagnostic secret");
        };
        if (stage === "claim") {
          const actual = r.storage.claimGatewayHttpRequest;
          const spy = vi
            .spyOn(r.storage, "claimGatewayHttpRequest")
            .mockImplementation((a) => fault(() => actual(a)));
          restore.push(() => spy.mockRestore());
        }
        if (stage === "admit") {
          const actual = r.terminal.admitGatewayHttpCharge;
          const spy = vi
            .spyOn(r.terminal, "admitGatewayHttpCharge")
            .mockImplementation((a) => fault(() => actual(a)));
          restore.push(() => spy.mockRestore());
        }
        if (stage === "dispatch") {
          const actual = r.admission.markGatewayChargeDispatched;
          const spy = vi
            .spyOn(r.admission, "markGatewayChargeDispatched")
            .mockImplementation((a) => fault(() => actual(a)));
          restore.push(() => spy.mockRestore());
        }
        if (stage === "outcome") {
          const actual = r.storage.recordGatewayHttpOutcome;
          const spy = vi
            .spyOn(r.storage, "recordGatewayHttpOutcome")
            .mockImplementation((a) => fault(() => actual(a)));
          restore.push(() => spy.mockRestore());
        }
        if (stage === "settle") {
          const actual = r.admission.settleAdmittedGatewayCharge;
          const spy = vi
            .spyOn(r.admission, "settleAdmittedGatewayCharge")
            .mockImplementation((a) => fault(() => actual(a)));
          restore.push(() => spy.mockRestore());
        }
        const id = randomUUID();
        await fixed(await f.post(id), 503);
        const facts = await f.facts();
        expect(facts.mapping).toHaveLength(1);
        const billing = String(facts.mapping[0]?.billing_request_id);
        const repeat = await f.post(id);
        expect(repeat.status).toBe(stage === "settle" ? 200 : 202);
        expect(repeat.headers.get("x-aiag-billing-request-id")).toBe(billing);
        expect(r.provider).toHaveBeenCalledTimes(
          ["outcome", "settle"].includes(stage) ? 1 : 0,
        );
        if (stage === "outcome" || stage === "settle") {
          const recovered = await r.terminal.recoverGatewayHttpSettlement(
            { orgId: f.org, apiKeyId: f.key, billingRequestId: billing },
            r.other,
          );
          expect(recovered.state).toBe("settled");
          expect(recovered.didTransition).toBe(stage === "outcome");
          expect((await f.post(id)).status).toBe(200);
          expect((await f.facts()).ledger).toHaveLength(1);
          expect(r.provider).toHaveBeenCalledTimes(1);
        } else {
          noReceipt(repeat);
          expect(await f.facts()).toEqual(facts);
        }
      },
    );
    it("MC11: expired live payload then official erased tombstone return410 without TTL reset or receipt", async () => {
      const { id, res } = await settle();
      const billing = res.headers.get("x-aiag-billing-request-id")!;
      await r.client`WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=${billing}::uuid AND org_id=${f.org}::uuid RETURNING *) INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at) SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,t.at-INTERVAL '168 hours',t.at FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`;
      await fixed(await f.post(id), 410);
      await r.storage.expireGatewayHttpResult(
        { orgId: f.org, billingRequestId: billing },
        r.client,
      );
      const facts = await f.facts();
      await fixed(await f.post(id), 410);
      expect(await f.facts()).toEqual(facts);
      expect(facts.result[0]?.response_body).toBeNull();
      expect(r.provider).toHaveBeenCalledTimes(1);
    });
    it("MC12: actual zero charge is a real settled receipt, distinct from missing financial facts", async () => {
      const previous = structuredClone(r.output.usage);
      r.output.usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      };
      try {
        const { res } = await settle();
        expect(res.headers.get(receipt)).toBe("0");
        expect(res.headers.get("x-aiag-charged-usd-micro")).toBe("0");
        expect((await f.facts()).admission[0]?.state).toBe("settled");
      } finally {
        r.output.usage = previous;
      }
    });
    it("MC13/17: all paid routes, method/trailing aliases and unsupported features fail before legacy/provider/queue work", async () => {
      for (const path of [
        "/completions",
        "/embeddings",
        "/images/generations",
        "/video/generations",
        "/audio/speech",
        "/audio/transcriptions",
        "/batches",
        "/chat/completions",
      ])
        for (const suffix of ["", "/"])
          for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            if (path === "/chat/completions" && method === "POST") continue;
            const res = await r.app.fetch(
              new Request(`http://native.test/v1${path}${suffix}`, {
                method,
                headers: {
                  authorization: `Bearer ${f.token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ requests: [f.body], ...f.body }),
              }),
            );
            expect([501, 404, 405]).toContain(res.status);
            noReceipt(res);
          }
      for (const extra of [
        { stream: true },
        { tools: [] },
        { functions: [] },
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://outside.invalid" },
                },
              ],
            },
          ],
        },
      ])
        await fixed(await f.post(randomUUID(), { ...f.body, ...extra }), 501);
      await fixed(
        await f.post(randomUUID(), f.body, {
          headers: { "x-upstream-key": "secret provider key" },
        }),
        501,
      );
      await noEffects();
      for (const path of ["/models", "/balance", "/batches/mc3-unknown"]) {
        const res = await r.app.fetch(
          new Request(`http://native.test/v1${path}`, {
            headers: { authorization: `Bearer ${f.token}` },
          }),
        );
        expect(res.status).toBe(path.includes("batches") ? 404 : 200);
        expect(
          (await r.app.fetch(new Request(`http://native.test/v1${path}`)))
            .status,
        ).toBe(401);
      }
      await noEffects();
    });
    it("MC14: unenforceable policies, legacy quota ambiguity, v1 org and unavailable adapter cannot reach provider", async () => {
      for (const policy of [
        { unknown: true },
        { default_mode: "invalid" },
        { per_session_budget_cap_rub: 1 },
        { allow_pii_transborder: "true" },
      ]) {
        await r.client`UPDATE gateway_api_keys SET policies=${r.client.json(policy)} WHERE id=${f.key}::uuid`;
        await fixed(await f.post(), 503);
      }
      await r.client`UPDATE gateway_api_keys SET policies='{}',model_whitelist='["forbidden"]'::jsonb WHERE id=${f.key}::uuid`;
      await fixed(await f.post(), 403);
      await r.client`UPDATE gateway_api_keys SET model_whitelist='[]'::jsonb WHERE id=${f.key}::uuid`;
      delete process.env.OPENROUTER_API_KEY;
      try {
        await fixed(await f.post(), 503);
      } finally {
        process.env.OPENROUTER_API_KEY = "mc3-transport-stub-only";
      }
      await noEffects();
      await r.client`UPDATE gateway_quota_org_policies SET enforcement_version=1 WHERE org_id=${f.org}::uuid`;
      await fixed(await f.post(), 503);
      const facts = await f.facts();
      expect(facts.rejection).toHaveLength(0);
      expect(facts.admission).toHaveLength(0);
      expect(r.provider).not.toHaveBeenCalled();
    });
    it.each([
      "revoke-after-claim",
      "abort-after-hold",
      "disable-after-dispatch",
      "abort-after-dispatch",
    ] as const)(
      "MC15: %s respects fresh admission and dispatched accountability",
      async (stage) => {
        const controller = new AbortController();
        if (stage === "revoke-after-claim") {
          const actual = r.storage.claimGatewayHttpRequest;
          const spy = vi
            .spyOn(r.storage, "claimGatewayHttpRequest")
            .mockImplementation(async (a) => {
              const result = await actual(a);
              await r.other`UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=${f.key}::uuid`;
              return result;
            });
          restore.push(() => spy.mockRestore());
        } else if (stage === "abort-after-hold") {
          const actual = r.terminal.admitGatewayHttpCharge;
          const spy = vi
            .spyOn(r.terminal, "admitGatewayHttpCharge")
            .mockImplementation(async (a) => {
              const result = await actual(a);
              controller.abort();
              return result;
            });
          restore.push(() => spy.mockRestore());
        } else {
          const actual = r.admission.markGatewayChargeDispatched;
          const spy = vi
            .spyOn(r.admission, "markGatewayChargeDispatched")
            .mockImplementation(async (a) => {
              const result = await actual(a);
              if (stage === "disable-after-dispatch")
                await r.other`UPDATE gateway_api_keys SET disabled_at=clock_timestamp() WHERE id=${f.key}::uuid`;
              else controller.abort();
              return result;
            });
          restore.push(() => spy.mockRestore());
        }
        const id = randomUUID();
        const res = await f.post(id, f.body, { signal: controller.signal });
        const facts = await f.facts();
        expect(facts.rejection).toHaveLength(0);
        if (stage === "abort-after-hold") {
          await fixed(res, 409);
          expect(facts.admission[0]?.state).toBe("cancelled");
          expect(r.provider).not.toHaveBeenCalled();
        } else if (stage === "revoke-after-claim") {
          await fixed(res, 503);
          expect(facts.admission).toHaveLength(0);
          expect(r.provider).not.toHaveBeenCalled();
          await fixed(await f.post(id), 401);
        } else {
          expect(facts.admission[0]?.state).toBe("settled");
          expect(facts.ledger).toHaveLength(1);
          expect(r.provider).toHaveBeenCalledTimes(1);
          expect(res.status).toBe(
            stage === "disable-after-dispatch" ? 401 : 200,
          );
        }
      },
    );
    it.each(["outcome", "settle"] as const)(
      "MC16: real %s transaction followed by SQL fault rolls back all native writes",
      async (stage) => {
        if (stage === "outcome") {
          const actual = r.storage.recordGatewayHttpOutcome;
          const spy = vi
            .spyOn(r.storage, "recordGatewayHttpOutcome")
            .mockImplementation((a) =>
              r.client.begin(async (tx) => {
                await actual(a, tx as unknown as SqlClient);
                await tx`SELECT 1 / 0`;
                throw Error("unreachable");
              }),
            );
          restore.push(() => spy.mockRestore());
        } else {
          const actual = r.admission.settleAdmittedGatewayCharge;
          const spy = vi
            .spyOn(r.admission, "settleAdmittedGatewayCharge")
            .mockImplementation((a) =>
              r.client.begin(async (tx) => {
                await actual(a, tx as unknown as SqlClient);
                await tx`SELECT 1 / 0`;
                throw Error("unreachable");
              }),
            );
          restore.push(() => spy.mockRestore());
        }
        const id = randomUUID();
        await fixed(await f.post(id), 503);
        const facts = await f.facts();
        expect(facts.admission[0]?.state).toBe(
          stage === "outcome" ? "dispatched" : "outcome_recorded",
        );
        expect(facts.result).toHaveLength(stage === "outcome" ? 0 : 1);
        expect(facts.ledger).toHaveLength(0);
        expect(
          BigInt(facts.balance[0]!.payg_credits as string) +
            BigInt(facts.admission[0]!.held_payg_credits as string),
        ).toBe(1000000000n);
        expect((await f.post(id)).status).toBe(202);
        expect(await f.facts()).toEqual(facts);
        expect(r.provider).toHaveBeenCalledTimes(1);
      },
    );
    it("MC08: real SQL deadline expires while confirmed claim ACK delivery is held", async () => {
      const actual = r.storage.claimGatewayHttpRequest;
      const spy = vi
        .spyOn(r.storage, "claimGatewayHttpRequest")
        .mockImplementation(async (a) => {
          const committed = await actual(a);
          // A delayed application ACK is only a deadline test, not evidence of network ACK loss.
          await new Promise((resolve) => setTimeout(resolve, 30100));
          return committed;
        });
      restore.push(() => spy.mockRestore());
      const id = randomUUID();
      const result = await response(await f.post(id));
      expect(result.status).toBe(409);
      expect(result.body.error.code).toBe("ADMISSION_DEADLINE_EXPIRED");
      expect((await f.facts()).admission).toHaveLength(0);
      expect(r.provider).not.toHaveBeenCalled();
      expect((await response(await f.post(id))).body).toEqual(result.body);
    }, 40000);
    it.each(["large", "bigint_max"] as const)(
      "MC12: %s mounted replay projection from synthetic native C1 lifecycle (not fresh catalog quote)",
      async (kind) => {
        const { captureStoredChatHttpIdentity } =
          await import("../billing/stored-chat-http-identity");
        const id = randomUUID(),
          billing = randomUUID(),
          attempt = randomUUID();
        const captured = captureStoredChatHttpIdentity({
          body: f.body,
          idempotencyKey: id,
          declaredSessionId: null,
        });
        const scope = {
          orgId: f.org,
          apiKeyId: f.key,
          routeKind: "chat" as const,
          billingMode: "stored" as const,
          contractVersion: 1 as const,
          idempotencyKeyDigest: captured.idempotencyKeyDigest,
          requestFingerprint: captured.requestFingerprint,
        };
        const formula = "db-input-output-cents-per-1k-legacy-whole-cache-v1";
        // Same provenance as accepted C1 native boundary fixtures; this synthetic quote
        // intentionally exceeds today's catalog/profile and only exercises durable replay.
        const p = {
          modelSlug: slug,
          modelType: "chat",
          upstreamId: "openrouter",
          upstreamModelId: slug,
          adapterKey: "openrouter",
          modelUpstreamId: randomUUID(),
          profileId: "openrouter-openai-gpt-4o-mini-chat-v1",
          profileRevision: 1,
          adapterContract: "openrouter-pinned-provider-chat-v1",
          endpointPolicy: {
            only: ["openai"],
            allowFallbacks: false,
            requireParameters: true,
          },
          contextWindowTokens: 70,
          maxOutputTokens: 20,
          prices: {
            inputCentsPer1k: "0.1",
            outputCentsPer1k: "0.1",
            markup: "1317624576693539401",
          },
          maxCredits: "9223372036854775807",
        };
        let count = 30,
          actual = 3952873730080618203n,
          supplier = "30";
        if (kind === "large") {
          p.prices = {
            inputCentsPer1k: "1",
            outputCentsPer1k: "1",
            markup: "2",
          };
          p.contextWindowTokens = Number.MAX_SAFE_INTEGER;
          p.maxOutputTokens = Number.MAX_SAFE_INTEGER;
          p.maxCredits = "18014398509481982";
          count = 5007450000000000;
          actual = 10014900000000000n;
          supplier = "50074500000000000";
        }
        const tokenQuote = {
          version: 1,
          formulaVersion: formula,
          requestedMode: "auto",
          effectiveMode: "auto",
          authorizedMaxCredits: p.maxCredits,
          candidates: [p],
        };
        const actualChargePolicy = {
          formulaVersion: formula,
          cachingDiscount: "1",
        };
        await r.client`UPDATE organizations SET payg_credits=${p.maxCredits}::bigint WHERE id=${f.org}::uuid`;
        await r.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=NULL WHERE org_id=${f.org}::uuid`;
        expect(
          (
            await r.storage.claimGatewayHttpRequest(
              { ...scope, billingRequestId: billing },
              r.other,
            )
          ).didClaim,
        ).toBe(true);
        const admitted = await r.terminal.admitGatewayHttpCharge(
          {
            ...scope,
            billingRequestId: billing,
            clientRequestId: "trusted MC12 fixture",
            declaredSessionId: null,
            modelSlug: slug,
            authorizedMaxCredits: BigInt(p.maxCredits),
            preDispatchDeadlineAt: new Date(Date.now() + 120000).toISOString(),
            quoteSnapshot: { version: 1, tokenQuote, actualChargePolicy },
            supplierQuoteSnapshot: {
              version: 2,
              formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
              tokenQuote,
            },
          },
          r.other,
        );
        if (admitted.kind !== "admitted")
          throw Error("MC12 native fixture admission failed");
        const dispatched = await r.admission.markGatewayChargeDispatched(
          {
            admission: admitted.admission,
            attemptId: attempt,
            upstreamId: "openrouter",
            pricingSnapshot: { ...p, actualChargePolicy },
          },
          r.other,
        );
        const usageSnapshot = {
          version: 1,
          usageContract: p.adapterContract,
          billingRequestId: billing,
          attemptId: attempt,
          upstreamId: p.upstreamId,
          upstreamModelId: p.upstreamModelId,
          adapterKey: p.adapterKey,
          modelSlug: slug,
          modelUpstreamId: p.modelUpstreamId,
          profileId: p.profileId,
          profileRevision: 1,
          completionId: "cmpl-boundary",
          reportedModel: slug,
          usage: {
            promptTokens: count,
            completionTokens: 0,
            totalTokens: count,
            cachedInputTokens: 0,
          },
          formulaVersion: formula,
        };
        const body = {
          id: "cmpl-boundary",
          object: "chat.completion" as const,
          created: 1,
          model: slug,
          choices: [
            {
              index: 0 as const,
              message: {
                role: "assistant" as const,
                content: "trusted boundary result",
              },
              finish_reason: "stop" as const,
            },
          ],
          usage: {
            prompt_tokens: count,
            completion_tokens: 0,
            total_tokens: count,
          },
        };
        await r.storage.recordGatewayHttpOutcome(
          {
            ...scope,
            admission: dispatched.admission,
            actualCostCredits: actual,
            usageSnapshot,
            outcomeKind: "success",
            response: body,
          },
          r.other,
        );
        expect((await f.post(id)).status).toBe(202);
        await r.terminal.recoverGatewayHttpSettlement(
          { orgId: f.org, apiKeyId: f.key, billingRequestId: billing },
          r.other,
        );
        const facts = await f.facts();
        expect(String(facts.context[0]?.supplier_actual_usd_micro)).toBe(
          supplier,
        );
        expect(BigInt(facts.balance[0]!.payg_credits as string) + actual).toBe(
          BigInt(p.maxCredits),
        );
        expect(String(facts.ledger[0]?.delta)).toBe((-actual).toString());
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await f.post(id);
          expect(result.status).toBe(200);
          expect(result.headers.get(receipt)).toBe(actual.toString());
          expect(result.headers.get("x-aiag-charged-usd-micro")).toBe(
            (actual * 10n).toString(),
          );
          expect(await result.json()).toEqual(body);
        }
        expect(await f.facts()).toEqual(facts);
        expect(r.fresh).not.toHaveBeenCalled();
        expect(r.provider).not.toHaveBeenCalled();
      },
    );

    it("MC01/17: dedicated child process proves unset/default legacy and explicit legacy actual assembly; bad mode/config refuse startup", async () => {
      const boot = `
      import {assertTestDatabaseEnvironment,withGuardedTestDatabase} from './packages/database/scripts/test-db-guard.ts';
      import {createPgTestClient} from './packages/database/scripts/pg-test-client.ts';
      assertTestDatabaseEnvironment(process.env);
      await withGuardedTestDatabase(process.env,{clientFactory:createPgTestClient},async()=>{});
      const {config}=await import('./packages/api-gateway/src/config.ts');
      if(config.GATEWAY_HTTP_EXECUTION_MODE!=='legacy')throw Error('expected legacy');
      const {app}=await import('./packages/api-gateway/src/server.ts');
      globalThis.fetch=async()=>{throw Error('MC3 forbidden network');};
      try {
        const result=await app.fetch(new Request('http://native.test/v1/embeddings',{method:'POST',headers:{authorization:'Bearer '+process.env.MC3_FIXTURE_KEY,'content-type':'application/json'},body:'{}'}));
        if(result.status!==400 || (await result.json()).error.message!=='model + input required')throw Error('legacy handler missing');
        const read=await app.fetch(new Request('http://native.test/v1/balance',{headers:{authorization:'Bearer '+process.env.MC3_FIXTURE_KEY}}));
        if(read.status!==200)throw Error('legacy balance unavailable');
      }finally {
        await (await import('./packages/api-gateway/src/lib/db.ts')).sql.end();
        const redis=await import('./packages/api-gateway/src/lib/redis.ts');
        await redis.redis.quit();await redis.makeRedis('ratelimit').quit();
      }
      console.log('MC3 legacy verified');
    `;
      for (const mode of [undefined, "legacy"]) {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          MC3_FIXTURE_KEY: f.token,
        };
        if (mode === undefined) delete env.GATEWAY_HTTP_EXECUTION_MODE;
        else env.GATEWAY_HTTP_EXECUTION_MODE = mode;
        expect(
          execFileSync("bun", ["-e", boot], {
            env,
            encoding: "utf8",
            timeout: 15000,
          }),
        ).toContain("MC3 legacy verified");
      }
      for (const changes of [
        { GATEWAY_HTTP_EXECUTION_MODE: "invalid" },
        {
          GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only",
          CACHING_DISCOUNT: "1e-3",
        },
      ]) {
        expect(() =>
          execFileSync(
            "bun",
            ["-e", "await import('./packages/api-gateway/src/config.ts')"],
            {
              env: { ...process.env, ...changes },
              stdio: "pipe",
              timeout: 10000,
            },
          ),
        ).toThrow();
      }
      await noEffects();
    }, 40000);
    it("MC14: RU-only overrides policy false; blocking PII needs native RU candidate; ambiguous legacy daily cap refuses admission", async () => {
      await r.client`UPDATE gateway_api_keys SET ru_residency_only=TRUE,policies='{"forbid_non_ru":false}' WHERE id=${f.key}::uuid`;
      await fixed(await f.post(), 503);
      await noEffects();
      await r.client`UPDATE gateway_api_keys SET ru_residency_only=FALSE,policies='{}' WHERE id=${f.key}::uuid`;
      const pii = {
        ...f.body,
        messages: [
          {
            role: "user",
            content: "passport 4510 123456, phone +7 999 123-45-67",
          },
        ],
      };
      const denied = await f.post(randomUUID(), pii);
      expect(denied.status).toBe(403);
      expect(r.provider).not.toHaveBeenCalled();
      await r.mutateCatalog(
        (db) =>
          db`UPDATE upstreams SET ru_residency=TRUE WHERE id='openrouter'`,
      );
      expect((await f.post(randomUUID(), pii)).status).toBe(200);
      const before = await f.facts();
      expect(before.pii.length).toBeGreaterThan(0);
      await r.client`UPDATE gateway_api_keys SET daily_usd_cap=1 WHERE id=${f.key}::uuid`;
      await fixed(await f.post(), 503);
      expect(r.provider).toHaveBeenCalledTimes(1);
      expect((await f.facts()).admission).toHaveLength(1);
    });
    it("MC13/17: populated batch GET enforces organization ownership and creates no work", async () => {
      const batch = `batch_mc3_${randomUUID().replaceAll("-", "")}`;
      await r.client`INSERT INTO batches(batch_id,org_id,api_key_id,type,status,input_file_url,total_count,expires_at) VALUES(${batch},${f.org}::uuid,${f.key}::uuid,'chat','queued',${`inline:${batch}`},1,clock_timestamp()+INTERVAL '1 hour')`;
      const get = (token: string) =>
        r.app.fetch(
          new Request(`http://native.test/v1/batches/${batch}`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
      const before = await f.facts();
      const outsider = await owner(r);
      try {
        expect((await get(f.token)).status).toBe(200);
        expect((await get(outsider.token)).status).toBe(404);
        expect((await get("invalid")).status).toBe(401);
      } finally {
        await outsider.cleanup();
      }
      expect(await f.facts()).toEqual(before);
      expect(r.provider).not.toHaveBeenCalled();
    });
    it("MC16: invalid native-driver claim projection after committed SQL cannot grant execution", async () => {
      const actual = r.storage.claimGatewayHttpRequest;
      const driver = new Proxy(r.sql, {
        apply: async (target, thisArg, args) => {
          const native = await Reflect.apply(target, thisArg, args);
          return native.map((row: Record<string, unknown>) => ({
            ...row,
            did_claim: "true",
          }));
        },
      }) as SqlClient;
      const spy = vi
        .spyOn(r.storage, "claimGatewayHttpRequest")
        .mockImplementation((a) => actual(a, driver));
      restore.push(() => spy.mockRestore());
      const id = randomUUID();
      await fixed(await f.post(id), 503);
      const facts = await f.facts();
      expect(facts.mapping).toHaveLength(1);
      expect(facts.admission).toHaveLength(0);
      expect(r.provider).not.toHaveBeenCalled();
      expect((await f.post(id)).status).toBe(202);
      expect(await f.facts()).toEqual(facts);
    });

    it("MC12: maximum representable catalog price/markup stays exact in fresh mounted execution", async () => {
      await r.mutateCatalog(
        (db) =>
          db`UPDATE model_upstreams SET price_per_1k_input=99999999.9999999999,price_per_1k_output=99999999.9999999999,markup=9.9999 WHERE model_id=(SELECT id FROM models WHERE slug=${slug}) AND upstream_id='openrouter'`,
      );
      await r.client`UPDATE organizations SET payg_credits=9223372036854775807 WHERE id=${f.org}::uuid`;
      await r.client`UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=NULL WHERE org_id=${f.org}::uuid`;
      const previous = structuredClone(r.output.usage);
      r.output.usage = {
        prompt_tokens: 128000,
        completion_tokens: 0,
        total_tokens: 128000,
        prompt_tokens_details: { cached_tokens: 0 },
      };
      try {
        const { id, res } = await settle();
        expect(res.headers.get(receipt)).toBe("127998720000000");
        expect(res.headers.get("x-aiag-charged-usd-micro")).toBe(
          "1279987200000000",
        );
        const facts = await f.facts();
        expect(
          BigInt(facts.balance[0]!.payg_credits as string) + 127998720000000n,
        ).toBe(9223372036854775807n);
        expect((await f.post(id)).headers.get(receipt)).toBe("127998720000000");
        expect(await f.facts()).toEqual(facts);
      } finally {
        r.output.usage = previous;
      }
    });

    it("MC18: cleanup false ACK is detected by independent residual readback; unrelated sentinels survive", async () => {
      let failCleanup = false;
      const rollback = Error("MC3 deliberate cleanup rollback");
      const proxy = new Proxy(r.client, {
        get(target, property) {
          if (property !== "begin") return Reflect.get(target, property);
          return async (run: (tx: SqlClient) => Promise<unknown>) => {
            try {
              return await target.begin(async (tx) => {
                const result = await run(tx as unknown as SqlClient);
                if (failCleanup) throw rollback;
                return result;
              });
            } catch (error) {
              if (failCleanup && error === rollback) return;
              throw error;
            }
          };
        },
      });
      const disposable = await owner({ ...r, client: proxy });
      try {
        await r.client`UPDATE organizations SET payg_credits=0 WHERE id=${disposable.org}::uuid`;
        expect((await disposable.post()).status).toBe(402);
        failCleanup = true;
        await expect(disposable.cleanup()).rejects.toThrow();
      } finally {
        failCleanup = false;
        await disposable.cleanup();
      }
    });

    it("MC14: native catalog predicates fail closed for frozen/depublished/disabled model, candidate and upstream", async () => {
      for (const status of ["frozen", "depublished"]) {
        await r.mutateCatalog(
          (db) => db`UPDATE models SET status=${status} WHERE slug=${slug}`,
        );
        await fixed(await f.post(), 503);
        await r.restoreCatalog();
      }
      await r.mutateCatalog(
        (db) => db`UPDATE models SET enabled=FALSE WHERE slug=${slug}`,
      );
      await fixed(await f.post(), 503);
      await r.restoreCatalog();
      await r.mutateCatalog(
        (db) =>
          db`UPDATE model_upstreams SET enabled=FALSE WHERE model_id=(SELECT id FROM models WHERE slug=${slug}) AND upstream_id='openrouter'`,
      );
      await fixed(await f.post(), 503);
      await r.restoreCatalog();
      await r.mutateCatalog(
        (db) => db`UPDATE upstreams SET enabled=FALSE WHERE id='openrouter'`,
      );
      await fixed(await f.post(), 503);
      await r.restoreCatalog();
      await r.mutateCatalog(
        (db) =>
          db`UPDATE model_upstreams SET upstream_model_id='unsupported/profile' WHERE model_id=(SELECT id FROM models WHERE slug=${slug}) AND upstream_id='openrouter'`,
      );
      await fixed(await f.post(), 503);
      await noEffects();
    });

    it("MC06: synthetic historical and native current owned quota buckets do not re-admit durable replay (no wall-clock rollover claim)", async () => {
      const { id, res } = await settle();
      const original = await response(res);
      await r.client`INSERT INTO gateway_quota_buckets(id,org_id,api_key_id,kind,period_start,period_end,settled_amount)
      SELECT gen_random_uuid(),${f.org}::uuid,${f.key}::uuid,'key_month_charged_v2',at+offsets.delta,at+offsets.delta+INTERVAL '1 month',1000
      FROM (SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at) period
      CROSS JOIN (VALUES (INTERVAL '-1 month')) AS offsets(delta)`;
      await r.client`UPDATE gateway_api_keys SET cost_limit_monthly_rub=1 WHERE id=${f.key}::uuid`;
      const before = await f.facts();
      const replay = await response(await f.post(id));
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(original.body);
      expect(replay.headers[receipt]).toBe(original.headers[receipt]);
      expect(await f.facts()).toEqual(before);
      expect(r.provider).toHaveBeenCalledTimes(1);
      expect(r.fresh).toHaveBeenCalledTimes(1);
    });
    it("MC14: native mixed RU/non-RU pool filters owned unreviewed candidate and dispatches only reviewed canonical adapter", async () => {
      const upstream = `mc3-${randomUUID()}`,
        candidate = randomUUID();
      let committed = false;
      try {
        await r.mutateCatalog((db) =>
          db.begin(async (tx) => {
            await tx`INSERT INTO upstreams(id,provider,ru_residency,enabled) VALUES(${upstream},'openrouter',FALSE,TRUE)`;
            await tx`INSERT INTO model_upstreams(id,model_id,upstream_id,upstream_model_id,price_per_1k_input,price_per_1k_output,markup) SELECT ${candidate}::uuid,id,${upstream},${slug},0.015,0.06,1.8 FROM models WHERE slug=${slug}`;
          }),
        );
        committed = true;
        await r.mutateCatalog(
          (db) =>
            db`UPDATE upstreams SET ru_residency=TRUE WHERE id='openrouter'`,
        );
        const body = {
          ...f.body,
          messages: [{ role: "user", content: "phone +7 999 123-45-67" }],
        };
        expect((await f.post(randomUUID(), body)).status).toBe(200);
        const raw = await r.fresh.mock.results[0]!.value;
        expect(raw.candidates).toHaveLength(2);
        const prepared = r.prep.mock.results[0]!.value;
        expect(prepared.model.candidates).toHaveLength(1);
        expect(prepared.model.candidates[0].upstream_id).toBe("openrouter");
        expect(r.provider).toHaveBeenCalledTimes(1);
        expect((await f.facts()).admission[0]?.upstream_id).toBe("openrouter");
      } finally {
        if (committed) {
          await r.mutateCatalog((db) =>
            db.begin(async (tx) => {
              await tx`DELETE FROM model_upstreams WHERE id=${candidate}::uuid AND upstream_id=${upstream}`;
              await tx`DELETE FROM upstreams WHERE id=${upstream}`;
            }),
          );
          expect(
            (
              await r.other`SELECT count(*)::int AS n FROM model_upstreams WHERE id=${candidate}::uuid`
            )[0]?.n,
          ).toBe(0);
          expect(
            (
              await r.other`SELECT count(*)::int AS n FROM upstreams WHERE id=${upstream}`
            )[0]?.n,
          ).toBe(0);
        }
      }
    });
    it("MC18/02: actual runtime pool closure makes authentication unavailable; no cached replay grant", async () => {
      const { id } = await settle();
      const facts = await f.facts();
      await r.sql.end();
      const res = await f.post(id);
      expect(res.status).toBe(503);
      noReceipt(res);
      expect(await res.json()).toEqual({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication unavailable",
        },
      });
      expect(await f.facts()).toEqual(facts);
      expect(r.provider).toHaveBeenCalledTimes(1);
    });
  },
);
