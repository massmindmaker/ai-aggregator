import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) assertTestDatabaseEnvironment(process.env);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const formula = "db-input-output-cents-per-1k-legacy-whole-cache-v1";
type Fixture = { user: string; org: string; key: string };
async function open() {
  let db!: TestDatabaseClient, close!: () => Promise<void>;
  await withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async (c) => {
      db = c;
      const end = c.end.bind(c);
      close = async () => {
        await end();
      };
      c.end = async () => undefined;
    },
  );
  return { db, close };
}
function request(f: Fixture) {
  const candidate = {
    modelSlug: "openai/gpt-4o-mini",
    modelType: "chat",
    upstreamId: "openrouter",
    upstreamModelId: "openai/gpt-4o-mini",
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
    prices: { inputCentsPer1k: "0.1", outputCentsPer1k: "0.1", markup: "10" },
    maxCredits: "70",
  };
  const quote = {
    version: 1,
    tokenQuote: {
      version: 1,
      formulaVersion: formula,
      requestedMode: "auto",
      effectiveMode: "auto",
      authorizedMaxCredits: "70",
      candidates: [candidate],
    },
    actualChargePolicy: { formulaVersion: formula, cachingDiscount: "1" },
  };
  return {
    f,
    id: randomUUID(),
    attempt: randomUUID(),
    digest: hash(randomUUID()),
    fingerprint: hash("client-payload"),
    quote,
    deadline: new Date(Date.now() + 120000).toISOString(),
    supplier: {
      version: 2,
      formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
      tokenQuote: quote.tokenQuote,
    },
  };
}
type Request = ReturnType<typeof request>;
function usage(r: Request) {
  const p = r.quote.tokenQuote.candidates[0];
  return {
    version: 1,
    usageContract: p.adapterContract,
    billingRequestId: r.id,
    attemptId: r.attempt,
    upstreamId: p.upstreamId,
    upstreamModelId: p.upstreamModelId,
    adapterKey: p.adapterKey,
    modelSlug: p.modelSlug,
    modelUpstreamId: p.modelUpstreamId,
    profileId: p.profileId,
    profileRevision: p.profileRevision,
    completionId: "cmpl-test",
    reportedModel: p.modelSlug,
    usage: {
      promptTokens: 30,
      completionTokens: 0,
      totalTokens: 30,
      cachedInputTokens: 0,
    },
    formulaVersion: formula,
  };
}
function body() {
  return {
    id: "cmpl-test",
    object: "chat.completion",
    created: 123,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" as string | null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 0, total_tokens: 30 },
  };
}
function streamBody() {
  const final = {
    ...body(),
    usage: {
      ...body().usage,
      cached_input_tokens: 0,
    },
  };
  const common = {
    id: "cmpl-test",
    object: "chat.completion.chunk",
    created: 123,
    model: "openai/gpt-4o-mini",
  };
  return {
    object: "aiag.chat.stream.v1",
    events: [
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { content: "hello" },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
      {
        ...common,
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 0,
          total_tokens: 30,
          cached_input_tokens: 0,
        },
      },
    ],
    final,
  };
}
function completionBody() {
  return {
    id: "cmpl-test",
    object: "text_completion",
    created: 123,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        text: "hello",
        index: 0,
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 0, total_tokens: 30 },
  };
}
describe.skipIf(!enabled)("native gateway HTTP storage", () => {
  let db: TestDatabaseClient, close: () => Promise<void>;
  const fixtures: Fixture[] = [];
  const query = (text: string, values: readonly unknown[] = [], c = db) =>
    c.query({ text, values });
  async function fixture() {
    const f = { user: randomUUID(), org: randomUUID(), key: randomUUID() };
    fixtures.push(f);
    await query("INSERT INTO users(id,email) VALUES($1,$2)", [
      f.user,
      `http-${f.user}@example.test`,
    ]);
    await query(
      "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1,$2,'http',$3,1000000)",
      [f.org, f.org, f.user],
    );
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1,$2,'http',$3,$4)",
      [f.key, f.org, randomUUID(), f.key.slice(0, 16)],
    );
    await query(
      "INSERT INTO gateway_quota_org_policies(org_id,enforcement_version) VALUES($1,2)",
      [f.org],
    );
    return f;
  }
  const claim = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat'::varchar,'stored'::varchar,$4,$5,1::smallint)",
      [r.f.org, r.f.key, r.id, r.digest, r.fingerprint],
      c,
    );
  const read = (r: Request, c = db) =>
    query(
      "SELECT contract_version,status,billing_request_id,http_status,content_type,response_body,actual_cost_credits::text,to_char(stored_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS stored_at,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires_at FROM aiag_read_gateway_http_result_v1($1,$2,'chat'::varchar,'stored'::varchar,$3,$4,1::smallint)",
      [r.f.org, r.f.key, r.digest, r.fingerprint],
      c,
    );
  const admit = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','chat','stored','openai/gpt-4o-mini',$4,$5,$6,'SID',$7)",
      [
        r.f.org,
        r.id,
        r.f.key,
        r.quote.tokenQuote.authorizedMaxCredits,
        r.quote,
        r.deadline,
        r.supplier,
      ],
      c,
    );
  const dispatch = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,$4,$5)",
      [
        r.f.org,
        r.id,
        r.attempt,
        "openrouter",
        {
          ...r.quote.tokenQuote.candidates[0],
          actualChargePolicy: r.quote.actualChargePolicy,
        },
      ],
      c,
    );
  const write = (
    r: Request,
    response: unknown = body(),
    u: unknown = usage(r),
    actual = "30",
    c = db,
  ) =>
    query(
      "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,$6,$7,'success',$8,1::smallint)",
      [
        r.f.org,
        r.f.key,
        r.id,
        r.digest,
        r.fingerprint,
        actual,
        JSON.stringify(u),
        JSON.stringify(response),
      ],
      c,
    );
  const settle = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_settle_admitted_gateway_charge($1,$2)",
      [r.f.org, r.id],
      c,
    );
  const expire = (r: Request, c = db) =>
    query(
      "SELECT aiag_expire_gateway_http_result_v1($1,$2) AS expired",
      [r.f.org, r.id],
      c,
    );
  async function started() {
    const r = request(await fixture());
    await claim(r);
    await admit(r);
    await dispatch(r);
    return r;
  }
  async function startedCompletion() {
    const r = request(await fixture());
    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'completions'::varchar,'stored'::varchar,$4,$5,1::smallint)",
      [r.f.org, r.f.key, r.id, r.digest, r.fingerprint],
    );
    await query(
      "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','completions','stored','openai/gpt-4o-mini',$4,$5,$6,'SID',$7)",
      [r.f.org, r.id, r.f.key, r.quote.tokenQuote.authorizedMaxCredits, r.quote, r.deadline, r.supplier],
    );
    await dispatch(r);
    return r;
  }
  beforeAll(async () => {
    ({ db, close } = await open());
  });
  afterAll(async () => {
    await close?.();
  });
  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      // Missing-table RED still cleans only this suite's owned fixtures.
      for (const table of ["gateway_http_results", "gateway_http_requests"]) {
        if (
          (await query("SELECT to_regclass($1)::text AS name", [table])).rows[0]
            .name
        )
          await query(`DELETE FROM ${table} WHERE org_id=$1`, [f.org]);
      }
      for (const table of [
        "gateway_charge_quota_events",
        "gateway_charge_quota_reservations",
      ])
        await query(
          `DELETE FROM ${table} WHERE billing_request_id IN (SELECT billing_request_id FROM gateway_charge_admissions WHERE org_id=$1)`,
          [f.org],
        );
      for (const table of [
        "gateway_charge_quota_contexts",
        "gateway_quota_buckets",
        "gateway_quota_key_policies",
        "gateway_quota_org_policies",
        "gateway_transactions",
        "gateway_charge_admissions",
        "gateway_api_keys",
      ])
        await query(`DELETE FROM ${table} WHERE org_id=$1`, [f.org]);
      await query("DELETE FROM organizations WHERE id=$1", [f.org]);
      await query("DELETE FROM users WHERE id=$1", [f.user]);
    }
  });
  it("claims before admission, retains the winner UUID and rejects fingerprint changes", async () => {
    const r = request(await fixture());
    expect((await claim(r)).rows[0]).toMatchObject({
      billing_request_id: r.id,
      did_claim: true,
    });
    expect((await claim({ ...r, id: randomUUID() })).rows[0]).toMatchObject({
      billing_request_id: r.id,
      did_claim: false,
    });
    await expect(
      claim({ ...r, fingerprint: hash("different SID") }),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    expect((await read(r)).rows[0].status).toBe("pending");
    expect(
      (
        await query(
          "SELECT count(*)::text AS n FROM gateway_charge_admissions WHERE org_id=$1",
          [r.f.org],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it("commits outcome and result, releases quotas once, and exposes body only after settlement", async () => {
    const r = await started();
    expect((await write(r)).rows[0].did_transition).toBe(true);
    expect((await read(r)).rows[0]).toMatchObject({
      status: "pending",
      response_body: null,
      actual_cost_credits: null,
    });
    await settle(r);
    expect((await read(r)).rows[0]).toMatchObject({
      status: "ready",
      response_body: body(),
      actual_cost_credits: "30",
      http_status: 200,
    });
    expect((await write(r)).rows[0].did_transition).toBe(false);
    expect((await read(r)).rows[0].stored_at).toMatch(/\.\d{6}Z$/);
    expect((await expire(r)).rows[0].expired).toBe(false);
    expect(
      (
        await query(
          "SELECT reserved_amount::text,settled_amount::text FROM gateway_quota_buckets WHERE org_id=$1",
          [r.f.org],
        )
      ).rows,
    ).toEqual(Array(3).fill({ reserved_amount: "0", settled_amount: "30" }));
  });
  it("rejects extra provider data and does not leave an outcome", async () => {
    const r = await started();
    await expect(write(r, { ...body(), provider: "private" })).rejects.toThrow(
      "INVALID_HTTP_RESULT",
    );
    expect(
      (
        await query(
          "SELECT state FROM gateway_charge_admissions WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0].state,
    ).toBe("dispatched");
  });
  async function snapshot(r: Request) {
    return (
      await query(
        `SELECT jsonb_build_object(
      'admission', (SELECT to_jsonb(a) FROM gateway_charge_admissions a WHERE billing_request_id=$1),
      'context', (SELECT to_jsonb(q) FROM gateway_charge_quota_contexts q WHERE billing_request_id=$1),
      'org', (SELECT to_jsonb(o) FROM organizations o WHERE id=$2),
      'reservations', (SELECT jsonb_agg(to_jsonb(q) ORDER BY kind) FROM gateway_charge_quota_reservations q WHERE billing_request_id=$1),
      'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY kind,event_kind) FROM gateway_charge_quota_events e WHERE billing_request_id=$1),
      'result', (SELECT to_jsonb(h) FROM gateway_http_results h WHERE billing_request_id=$1)
    ) AS state`,
        [r.id, r.f.org],
      )
    ).rows[0].state;
  }
  async function blocked(pid: number) {
    for (let i = 0; i < 500; i++) {
      const row = (
        await query("SELECT cardinality(pg_blocking_pids($1)) AS n", [pid])
      ).rows[0];
      if (Number(row.n) > 0) return;
    }
    throw new Error("Expected observed PostgreSQL blocked backend");
  }
  async function race(
    first: (c: TestDatabaseClient) => Promise<unknown>,
    second: (c: TestDatabaseClient) => Promise<unknown>,
  ) {
    const a = await open(),
      b = await open();
    let pending: Promise<unknown> | undefined;
    try {
      await query("BEGIN", [], a.db);
      const result = await first(a.db);
      const pid = Number(
        (await query("SELECT pg_backend_pid() AS pid", [], b.db)).rows[0].pid,
      );
      pending = second(b.db);
      pending.catch(() => undefined);
      await blocked(pid);
      await query("COMMIT", [], a.db);
      return [result, await pending];
    } finally {
      await query("ROLLBACK", [], a.db);
      await pending?.catch(() => undefined);
      await a.close();
      await b.close();
    }
  }
  it("serializes competing claims on independent connections with observed locks", async () => {
    const r = request(await fixture());
    const results = await race(
      (c) => claim(r, c),
      (c) => claim({ ...r, id: randomUUID() }, c),
    );
    expect(results).toMatchObject([
      { rows: [{ did_claim: true, billing_request_id: r.id }] },
      { rows: [{ did_claim: false, billing_request_id: r.id }] },
    ]);
  });
  it("isolates scopes, refuses wrong owners and rejects UUID reuse including legacy ledger meaning", async () => {
    const r = request(await fixture()),
      other = request(await fixture());
    await claim(r);
    expect((await read({ ...r, f: other.f })).rows[0]).toMatchObject({
      status: "not_found",
      billing_request_id: null,
    });
    await expect(
      read({ ...r, f: { ...r.f, key: other.f.key } }),
    ).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(claim({ ...other, id: r.id })).rejects.toThrow(
      "HTTP_IDENTITY_CONFLICT",
    );
    expect(
      (await claim({ ...other, digest: r.digest })).rows[0].did_claim,
    ).toBe(true);
    await expect(
      query(
        `INSERT INTO gateway_http_requests(billing_request_id,org_id,api_key_id,route_kind,billing_mode,contract_version,idempotency_key_digest,request_fingerprint)
      VALUES($1,$2,$3,'chat','stored',1,$4,$5)`,
        [randomUUID(), r.f.org, other.f.key, hash("bad"), r.fingerprint],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const standalone = request(r.f);
    await admit(standalone);
    await expect(claim(standalone)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    const ledger = request(r.f);
    await query("SELECT * FROM aiag_settle_charge_credits($1,$2,1,'{}')", [
      r.f.org,
      ledger.id,
    ]);
    await expect(claim(ledger)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
  });
  it.each(["committed", "uncommitted"])(
    "claim %s ACK loss is read on new connections without another grant",
    async (kind) => {
      const r = request(await fixture()),
        a = await open();
      try {
        await query("BEGIN", [], a.db);
        await claim(r, a.db);
        if (kind === "committed") await query("COMMIT", [], a.db);
      } finally {
        await a.close();
      }
      const b = await open();
      try {
        expect((await read(r, b.db)).rows[0].status).toBe(
          kind === "committed" ? "pending" : "not_found",
        );
        if (kind === "committed")
          expect((await claim(r, b.db)).rows[0].did_claim).toBe(false);
        expect(
          (
            await query(
              "SELECT count(*)::text n FROM gateway_charge_admissions WHERE billing_request_id=$1",
              [r.id],
            )
          ).rows[0].n,
        ).toBe("0");
      } finally {
        await b.close();
      }
    },
  );
  it("projects no-admission, rejected admission, held, dispatched, cancelled and standalone outcome safely", async () => {
    const r = request(await fixture());
    expect((await read(r)).rows[0]).toEqual({
      contract_version: 1,
      status: "not_found",
      billing_request_id: null,
      http_status: null,
      content_type: null,
      response_body: null,
      actual_cost_credits: null,
      stored_at: null,
      expires_at: null,
    });
    await claim(r);
    await query(
      "UPDATE gateway_quota_org_policies SET enforcement_version=1 WHERE org_id=$1",
      [r.f.org],
    );
    await expect(admit(r)).rejects.toThrow("QUOTA_V2_NOT_ENABLED");
    expect((await read(r)).rows[0].status).toBe("pending");
    await query(
      "UPDATE gateway_quota_org_policies SET enforcement_version=2 WHERE org_id=$1",
      [r.f.org],
    );
    await admit(r);
    expect((await read(r)).rows[0].status).toBe("pending");
    await query(
      "SELECT * FROM aiag_cancel_undispatched_gateway_charge($1,$2)",
      [r.f.org, r.id],
    );
    expect((await read(r)).rows[0].status).toBe("unavailable");
    const s = await started();
    expect((await read(s)).rows[0].status).toBe("pending");
    await query(
      "SELECT * FROM aiag_record_gateway_charge_outcome_v2($1,$2,30,$3,'success')",
      [s.f.org, s.id, usage(s)],
    );
    await expect(write(s)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    await settle(s);
    expect((await read(s)).rows[0]).toMatchObject({
      status: "unavailable",
      response_body: null,
    });
  });
  it("rolls the real v2 outcome back when owned result INSERT trigger faults", async () => {
    const r = await started(),
      before = await snapshot(r);
    const suffix = r.id.replaceAll("-", "");
    const fn = `http_fault_${suffix}`;
    try {
      await query(`CREATE FUNCTION ${fn}() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.billing_request_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'HTTP_TEST_FAULT'; END IF; RETURN NEW; END $$`);
      await query(
        `CREATE TRIGGER ${fn} BEFORE INSERT ON gateway_http_results FOR EACH ROW EXECUTE FUNCTION ${fn}('${r.id}')`,
      );
      await expect(write(r)).rejects.toThrow("HTTP_TEST_FAULT");
      expect(await snapshot(r)).toEqual(before);
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${fn} ON gateway_http_results`);
      await query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    await write(r);
  });
  it("serializes competing outcome writers, preserving body and exact first timestamps", async () => {
    const r = await started();
    const result = await race(
      (c) => write(r, body(), usage(r), "30", c),
      (c) => write(r, body(), usage(r), "30", c),
    );
    expect(result).toMatchObject([
      { rows: [{ did_transition: true }] },
      { rows: [{ did_transition: false }] },
    ]);
    const before = await snapshot(r);
    const reordered = {
      usage: body().usage,
      choices: body().choices,
      model: body().model,
      created: 123,
      object: "chat.completion",
      id: "cmpl-test",
    };
    await write(r, reordered);
    expect(await snapshot(r)).toEqual(before);
    const changed = body();
    changed.choices[0].message.content = "different";
    await expect(write(r, changed)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(write(r, body(), usage(r), "31")).rejects.toThrow();
    await expect(
      write(r, body(), { ...usage(r), attemptId: randomUUID() }),
    ).rejects.toThrow();
    expect(await snapshot(r)).toEqual(before);
  });
  it.each(["committed", "uncommitted"])(
    "atomic outcome/result %s ACK loss never splits evidence",
    async (kind) => {
      const r = await started(),
        before = await snapshot(r),
        a = await open();
      try {
        await query("BEGIN", [], a.db);
        await write(r, body(), usage(r), "30", a.db);
        if (kind === "committed") await query("COMMIT", [], a.db);
      } finally {
        await a.close();
      }
      const b = await open();
      try {
        if (kind === "uncommitted") expect(await snapshot(r)).toEqual(before);
        else {
          expect(
            (await write(r, body(), usage(r), "30", b.db)).rows[0]
              .did_transition,
          ).toBe(false);
          await settle(r, b.db);
          expect((await read(r, b.db)).rows[0].status).toBe("ready");
        }
      } finally {
        await b.close();
      }
    },
  );
  it("allows trusted completion after revoke but denies revoked/disabled public reads and claims", async () => {
    const r = await started();
    await query(
      "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
      [r.f.key],
    );
    await write(r);
    await settle(r);
    await expect(read(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(claim(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await query(
      "UPDATE gateway_api_keys SET revoked_at=NULL,disabled_at=clock_timestamp() WHERE id=$1",
      [r.f.key],
    );
    await expect(read(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await query(
      "UPDATE gateway_api_keys SET disabled_at=NULL,policies=$2,model_whitelist=$3,cost_limit_monthly_rub=0.01 WHERE id=$1",
      [r.f.key, { default_mode: "ru-only" }, JSON.stringify(["different"])],
    );
    await query(
      "UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=0,revision=revision+1 WHERE org_id=$1",
      [r.f.org],
    );
    expect((await read(r)).rows[0].status).toBe("ready");
  });
  it("orders revoke-first and read-first with real blocked connections and key locks", async () => {
    const r = await started();
    await write(r);
    await settle(r);
    const revoke = async (c: TestDatabaseClient) => {
      await query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [r.f.org],
        c,
      );
      await query(
        "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
        [r.f.key],
        c,
      );
    };
    const first = await race((c) => read(r, c), revoke);
    expect(first[0]).toMatchObject({ rows: [{ status: "ready" }] });
    await expect(read(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await query("UPDATE gateway_api_keys SET revoked_at=NULL WHERE id=$1", [
      r.f.key,
    ]);
    await expect(race(revoke, (c) => read(r, c))).rejects.toThrow(
      "HTTP_ACCESS_DENIED",
    );
  });
  async function historical(r: Request, due: boolean) {
    // Replace only this UUID's test row using consistent historical INSERT, never a production clock override.
    await query(
      `WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=$1 RETURNING *)
      INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
      SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,
      t.at-CASE WHEN $2 THEN INTERVAL '168 hours' ELSE INTERVAL '167 hours' END,
      t.at-CASE WHEN $2 THEN INTERVAL '0 hours' ELSE INTERVAL '-1 hour' END FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`,
      [r.id, due],
    );
  }
  it("keeps seven-day retention and immutable tombstones after concurrent purge/read/replay", async () => {
    const r = await started();
    await write(r);
    await settle(r);
    expect(
      (
        await query(
          "SELECT expires_at-stored_at=INTERVAL '168 hours' AS exact FROM gateway_http_results WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0].exact,
    ).toBe(true);
    await historical(r, false);
    expect((await read(r)).rows[0].status).toBe("ready");
    expect((await expire(r)).rows[0].expired).toBe(false);
    await historical(r, true);
    const expired = (await read(r)).rows[0];
    expect(expired).toMatchObject({
      status: "expired",
      response_body: null,
      http_status: null,
      actual_cost_credits: null,
    });
    const results = await race(
      (c) => expire(r, c),
      (c) => read(r, c),
    );
    expect(results).toMatchObject([
      { rows: [{ expired: true }] },
      { rows: [{ status: "expired", response_body: null }] },
    ]);
    const tombstone = await snapshot(r);
    await write(r);
    expect(await snapshot(r)).toEqual(tombstone);
    expect((await expire(r)).rows[0].expired).toBe(false);
    expect((await claim({ ...r, id: randomUUID() })).rows[0].did_claim).toBe(
      false,
    );
    const changed = body();
    changed.choices[0].message.content = "restore";
    await expect(write(r, changed)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    const s = await started();
    await write(s);
    await historical(s, true);
    expect((await read(s)).rows[0].status).toBe("expired");
  });
  it("rejects direct identity/payload updates and FK owner/delete violations", async () => {
    const r = await started();
    await write(r);
    for (const [text, values] of [
      [
        "UPDATE gateway_http_requests SET request_fingerprint=$2 WHERE billing_request_id=$1",
        [r.id, hash("changed")],
      ],
      [
        "UPDATE gateway_http_requests SET created_at=created_at+INTERVAL '1 hour' WHERE billing_request_id=$1",
        [r.id],
      ],
      [
        "UPDATE gateway_http_results SET response_body=$2 WHERE billing_request_id=$1",
        [r.id, { ...body(), created: 456 }],
      ],
      [
        "UPDATE gateway_http_results SET response_digest=$2 WHERE billing_request_id=$1",
        [r.id, hash("changed")],
      ],
      [
        "UPDATE gateway_http_results SET expires_at=expires_at+INTERVAL '1 hour' WHERE billing_request_id=$1",
        [r.id],
      ],
      [
        "UPDATE gateway_http_results SET response_body=NULL,payload_expired_at=clock_timestamp() WHERE billing_request_id=$1",
        [r.id],
      ],
    ] as Array<[string, unknown[]]>)
      await expect(query(text, values)).rejects.toThrow(
        "HTTP_IDENTITY_CONFLICT",
      );
    await expect(
      query("DELETE FROM gateway_http_requests WHERE billing_request_id=$1", [
        r.id,
      ]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23001)$/) });
    await expect(
      query(
        "DELETE FROM gateway_charge_admissions WHERE billing_request_id=$1",
        [r.id],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23001)$/) });
    await expect(
      query("UPDATE gateway_api_keys SET org_id=$2 WHERE id=$1", [
        r.f.key,
        (await fixture()).org,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  const malformed: Array<[string, (b: ReturnType<typeof body>) => unknown]> = [
    ["scalar", () => 5],
    ["array", () => []],
    ["null", () => null],
    ["double serialized", (b) => JSON.stringify(b)],
    [
      "missing root key",
      (b) => {
        const { id: _id, ...rest } = b;
        return rest;
      },
    ],
    ["extra root", (b) => ({ ...b, cost: 1 })],
    ["wrong object", (b) => ({ ...b, object: "other" })],
    ["invalid id", (b) => ({ ...b, id: "bad id" })],
    ["oversize id", (b) => ({ ...b, id: "a".repeat(257) })],
    ["invalid model", (b) => ({ ...b, model: "模型" })],
    ["nonarray choices", (b) => ({ ...b, choices: {} })],
    ["empty choices", (b) => ({ ...b, choices: [] })],
    ["two choices", (b) => ({ ...b, choices: [...b.choices, ...b.choices] })],
    [
      "extra choice",
      (b) => ({ ...b, choices: [{ ...b.choices[0], logprobs: {} }] }),
    ],
    [
      "wrong index",
      (b) => ({ ...b, choices: [{ ...b.choices[0], index: 1 }] }),
    ],
    [
      "string index",
      (b) => ({ ...b, choices: [{ ...b.choices[0], index: "0" }] }),
    ],
    [
      "extra message",
      (b) => ({
        ...b,
        choices: [
          {
            ...b.choices[0],
            message: { ...b.choices[0].message, tool_calls: [] },
          },
        ],
      }),
    ],
    [
      "wrong role",
      (b) => ({
        ...b,
        choices: [{ ...b.choices[0], message: { role: "user", content: "x" } }],
      }),
    ],
    [
      "numeric content",
      (b) => ({
        ...b,
        choices: [
          { ...b.choices[0], message: { role: "assistant", content: 4 } },
        ],
      }),
    ],
    [
      "wrong finish",
      (b) => ({
        ...b,
        choices: [{ ...b.choices[0], finish_reason: "tool_calls" }],
      }),
    ],
    [
      "extra usage",
      (b) => ({ ...b, usage: { ...b.usage, prompt_tokens_details: {} } }),
    ],
    ...[-1, 1.2, "30", null, 9007199254740992].map(
      (n) =>
        [
          `invalid count ${n}`,
          (b: ReturnType<typeof body>) => ({
            ...b,
            usage: { ...b.usage, prompt_tokens: n },
          }),
        ] as [string, (b: ReturnType<typeof body>) => unknown],
    ),
    [
      "sum mismatch",
      (b) => ({ ...b, usage: { ...b.usage, total_tokens: 31 } }),
    ],
    [
      "cached exceeds prompt",
      (b) => ({ ...b, usage: { ...b.usage, cached_input_tokens: 31 } }),
    ],
    ["created overflow", (b) => ({ ...b, created: 9007199254740992 })],
    ["created fractional", (b) => ({ ...b, created: 0.1 })],
  ];
  it.each(malformed)(
    "rejects malformed DTO: %s without mutation",
    async (_name, mutate) => {
      const r = await started(),
        before = await snapshot(r);
      await expect(write(r, mutate(body()))).rejects.toMatchObject({
        message: "INVALID_HTTP_RESULT",
        code: "P0001",
      });
      expect(await snapshot(r)).toEqual(before);
    },
  );
  it.each([null, "", "text"])(
    "preserves allowed content %s and optional cached presence",
    async (content) => {
      const r = await started(),
        b = body();
      b.choices[0].message.content = content;
      await write(r, b);
      await settle(r);
      expect((await read(r)).rows[0].response_body).toEqual(b);
      const s = await started(),
        u = usage(s);
      u.usage.cachedInputTokens = 10;
      await write(s, body(), u);
      await settle(s);
      expect((await read(s)).rows[0].response_body).toEqual(body());
      const t = await started(),
        cached = {
          ...body(),
          usage: { ...body().usage, cached_input_tokens: 10 },
        },
        evidence = usage(t);
      evidence.usage.cachedInputTokens = 10;
      await write(t, cached, evidence);
      await settle(t);
      expect((await read(t)).rows[0].response_body).toEqual(cached);
    },
  );
  it("rejects evidence mismatches and bounds canonical UTF-8 bytes exactly at 1MiB", async () => {
    const r = await started();
    for (const b of [
      { ...body(), id: "cmpl-other" },
      { ...body(), model: "other/model" },
      {
        ...body(),
        usage: { prompt_tokens: 29, completion_tokens: 1, total_tokens: 30 },
      },
      { ...body(), usage: { ...body().usage, cached_input_tokens: 1 } },
    ])
      await expect(write(r, b)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    const b = body();
    b.choices[0].message.content = "😀";
    const size = Number(
      (
        await query(
          "SELECT octet_length(convert_to($1::jsonb::text,'UTF8')) AS bytes",
          [b],
        )
      ).rows[0].bytes,
    );
    b.choices[0].message.content += "x".repeat(1048576 - size);
    expect(
      (
        await query(
          "SELECT octet_length(convert_to($1::jsonb::text,'UTF8')) AS bytes",
          [b],
        )
      ).rows[0].bytes,
    ).toBe(1048576);
    const tooLarge = structuredClone(b);
    tooLarge.choices[0].message.content += "x";
    await expect(write(r, tooLarge)).rejects.toMatchObject({
      message: "HTTP_RESULT_TOO_LARGE",
      code: "P0001",
    });
    await write(r, b);
    await settle(r);
    expect((await read(r)).rows[0].response_body).toEqual(b);
  });
  it("keeps exact amounts beyond 2^53 and public safe-count edges", async () => {
    const r = request(await fixture()),
      p = r.quote.tokenQuote.candidates[0];
    p.prices = { inputCentsPer1k: "1", outputCentsPer1k: "1", markup: "1" };
    p.contextWindowTokens = Number.MAX_SAFE_INTEGER;
    p.maxOutputTokens = Number.MAX_SAFE_INTEGER;
    p.maxCredits = "9007199254740991";
    // With markup 2, retail amount crosses JS safe range; supplier still fits BIGINT.
    p.prices.markup = "2";
    p.maxCredits = "18014398509481982";
    r.quote.tokenQuote.authorizedMaxCredits = p.maxCredits;
    await query("UPDATE organizations SET payg_credits=$2 WHERE id=$1", [
      r.f.org,
      p.maxCredits,
    ]);
    await claim(r);
    await admit(r);
    await dispatch(r);
    const u = usage(r);
    u.usage.promptTokens = Number.MAX_SAFE_INTEGER;
    u.usage.totalTokens = Number.MAX_SAFE_INTEGER;
    const b = body();
    b.created = Number.MAX_SAFE_INTEGER;
    b.usage.prompt_tokens = Number.MAX_SAFE_INTEGER;
    b.usage.total_tokens = Number.MAX_SAFE_INTEGER;
    await write(r, b, u, p.maxCredits);
    await settle(r);
    expect((await read(r)).rows[0].actual_cost_credits).toBe(
      "18014398509481982",
    );
  });

  it.each([
    "",
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    "a".repeat(63) + "\n",
    "界".repeat(64),
  ])("rejects noncanonical digest/fingerprint %s", async (invalid) => {
    const r = request(await fixture());
    await expect(claim({ ...r, digest: invalid })).rejects.toMatchObject({
      message: "INVALID_HTTP_REQUEST",
      code: "P0001",
    });
    await expect(read({ ...r, fingerprint: invalid })).rejects.toMatchObject({
      message: "INVALID_HTTP_REQUEST",
      code: "P0001",
    });
  });
  it("isolates another active key in the same organization and rejects wrong writer owner", async () => {
    const r = await started(),
      key = randomUUID();
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1,$2,'other',$3,$4)",
      [key, r.f.org, randomUUID(), key.slice(0, 16)],
    );
    const other = { ...r, id: randomUUID(), f: { ...r.f, key } };
    expect((await read(other)).rows[0].status).toBe("not_found");
    expect((await claim(other)).rows[0].did_claim).toBe(true);
    await expect(write({ ...r, f: other.f })).rejects.toThrow(
      "HTTP_ACCESS_DENIED",
    );
    await expect(
      query(
        "UPDATE gateway_http_requests SET api_key_id=$2 WHERE billing_request_id=$1",
        [r.id, key],
      ),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await write(r);
    await expect(
      query(
        "UPDATE gateway_http_results SET api_key_id=$2 WHERE billing_request_id=$1",
        [r.id, key],
      ),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
  });
  it.each(["length", "content_filter"])(
    "preserves accepted finish reason %s and zero timestamp",
    async (reason) => {
      const r = await started(),
        b = body();
      b.choices[0].finish_reason = reason;
      b.created = 0;
      await write(r, b);
      await settle(r);
      expect((await read(r)).rows[0].response_body).toEqual(b);
    },
  );
  it("composes the BIGINT maximum reserve with exact large settlement", async () => {
    const r = request(await fixture()),
      p = r.quote.tokenQuote.candidates[0];
    p.prices.markup = "1317624576693539401";
    p.maxCredits = "9223372036854775807";
    r.quote.tokenQuote.authorizedMaxCredits = p.maxCredits;
    await query("UPDATE organizations SET payg_credits=$2 WHERE id=$1", [
      r.f.org,
      p.maxCredits,
    ]);
    await claim(r);
    await admit(r);
    await dispatch(r);
    await write(r, body(), usage(r), "3952873730080618203");
    await settle(r);
    expect((await read(r)).rows[0].actual_cost_credits).toBe(
      "3952873730080618203",
    );
  });

  it("persists and settles the exact embeddings reserve, usage, response, and supplier amount", async () => {
    const f = await fixture();
    const candidate = {
      modelSlug: "openai/text-embedding-3-small",
      modelType: "embedding",
      upstreamId: "openrouter",
      upstreamModelId: "openai/text-embedding-3-small",
      adapterKey: "openrouter",
      modelUpstreamId: randomUUID(),
      profileId: "openrouter-openai-text-embedding-3-small-embeddings-v1",
      profileRevision: 1,
      adapterContract: "openrouter-pinned-provider-embeddings-v1",
      endpointPolicy: {
        only: ["openai"],
        allowFallbacks: false,
        requireParameters: true,
      },
      contextWindowTokens: 8192,
      inputCount: 2,
      dimensions: 1536,
      encodingFormat: "float",
      prices: {
        inputCentsPer1k: "0.002",
        outputCentsPer1k: "0",
        markup: "1.25",
      },
      maxCredits: "41",
    };
    const tokenQuote = {
      version: 1,
      formulaVersion: formula,
      requestedMode: "auto",
      effectiveMode: "auto",
      authorizedMaxCredits: "41",
      candidates: [candidate],
    };
    const quote = {
      version: 1,
      tokenQuote,
      actualChargePolicy: { formulaVersion: formula, cachingDiscount: "1" },
    };
    const supplier = {
      version: 2,
      formulaVersion: "catalog-input-output-cents-per-1k-usd-micro-v2",
      tokenQuote,
    };
    const billingRequestId = randomUUID();
    const attemptId = randomUUID();
    const digest = hash(randomUUID());
    const fingerprint = hash("embeddings-client-payload");
    const usageSnapshot = {
      version: 1,
      usageContract: candidate.adapterContract,
      billingRequestId,
      attemptId,
      upstreamId: candidate.upstreamId,
      upstreamModelId: candidate.upstreamModelId,
      adapterKey: candidate.adapterKey,
      modelSlug: candidate.modelSlug,
      modelUpstreamId: candidate.modelUpstreamId,
      profileId: candidate.profileId,
      profileRevision: candidate.profileRevision,
      providerResponseId: "emb-test",
      reportedModel: candidate.modelSlug,
      inputCount: 2,
      dimensions: 1536,
      encodingFormat: "float",
      usage: {
        promptTokens: 1000,
        completionTokens: 0,
        totalTokens: 1000,
        cachedInputTokens: 0,
      },
      formulaVersion: formula,
    };
    const response = {
      object: "list",
      model: candidate.modelSlug,
      data: [0, 1].map((index) => ({
        object: "embedding",
        index,
        embedding: Array.from({ length: 1536 }, () => 0),
      })),
      usage: { prompt_tokens: 1000, total_tokens: 1000 },
    };
    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'embeddings','stored',$4,$5,1::smallint)",
      [f.org, f.key, billingRequestId, digest, fingerprint],
    );
    await expect(
      query(
        "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','chat','stored',$4,$5,$6,$7,'SID',$8)",
        [
          f.org,
          billingRequestId,
          f.key,
          candidate.modelSlug,
          "41",
          JSON.stringify(quote),
          new Date(Date.now() + 120000).toISOString(),
          JSON.stringify(supplier),
        ],
      ),
    ).rejects.toThrow("INVALID_SUPPLIER_QUOTE");
    const admitted = await query(
      "SELECT authorized_max_credits::text,state FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','embeddings','stored',$4,$5,$6,$7,'SID',$8)",
      [
        f.org,
        billingRequestId,
        f.key,
        candidate.modelSlug,
        "41",
        JSON.stringify(quote),
        new Date(Date.now() + 120000).toISOString(),
        JSON.stringify(supplier),
      ],
    );
    expect(admitted.rows[0]).toEqual({
      authorized_max_credits: "41",
      state: "held",
    });
    expect(
      (
        await query(
          "SELECT supplier_authorized_max_usd_micro::text AS supplier FROM gateway_charge_quota_contexts WHERE billing_request_id=$1",
          [billingRequestId],
        )
      ).rows[0].supplier,
    ).toBe("328");
    await query(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,'openrouter',$4)",
      [
        f.org,
        billingRequestId,
        attemptId,
        JSON.stringify({ ...candidate, actualChargePolicy: quote.actualChargePolicy }),
      ],
    );
    await expect(
      query(
        "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,3,$6,'success',$7,1::smallint)",
        [
          f.org,
          f.key,
          billingRequestId,
          digest,
          fingerprint,
          JSON.stringify({
            ...usageSnapshot,
            usage: { ...usageSnapshot.usage, totalTokens: 999 },
          }),
          JSON.stringify(response),
        ],
      ),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(
      query(
        "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,3,$6,'success',$7,1::smallint)",
        [
          f.org,
          f.key,
          billingRequestId,
          digest,
          fingerprint,
          JSON.stringify(usageSnapshot),
          JSON.stringify({
            ...response,
            data: [{ ...response.data[0], embedding: [0] }, response.data[1]],
          }),
        ],
      ),
    ).rejects.toThrow("INVALID_HTTP_RESULT");
    await query(
      "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,3,$6,'success',$7,1::smallint)",
      [
        f.org,
        f.key,
        billingRequestId,
        digest,
        fingerprint,
        JSON.stringify(usageSnapshot),
        JSON.stringify(response),
      ],
    );
    const recorded = await query(
      "SELECT a.state,a.actual_cost_credits::text,q.supplier_actual_usd_micro::text AS supplier_actual FROM gateway_charge_admissions a JOIN gateway_charge_quota_contexts q USING(billing_request_id) WHERE a.billing_request_id=$1",
      [billingRequestId],
    );
    expect(recorded.rows[0]).toEqual({
      state: "outcome_recorded",
      actual_cost_credits: "3",
      supplier_actual: "20",
    });
    await query("SELECT * FROM aiag_settle_admitted_gateway_charge($1,$2)", [
      f.org,
      billingRequestId,
    ]);
    const replay = await query(
      "SELECT status,response_body,actual_cost_credits::text FROM aiag_read_gateway_http_result_v1($1,$2,'embeddings','stored',$3,$4,1::smallint)",
      [f.org, f.key, digest, fingerprint],
    );
    expect(replay.rows[0]).toEqual({
      status: "ready",
      response_body: response,
      actual_cost_credits: "3",
    });
    expect(
      (
        await query(
          "SELECT array_agg(kind||':'||reserved_amount::text||':'||settled_amount::text ORDER BY kind) AS amounts FROM gateway_quota_buckets WHERE org_id=$1",
          [f.org],
        )
      ).rows[0].amounts,
    ).toEqual([
      "key_month_charged_v2:0:3",
      "key_session_charged_v2:0:3",
      "org_day_supplier_v2:0:20",
    ]);
  });

  it("persists exact text completions, binds trusted chat usage, and rejects wrong DTO/model type", async () => {
    const r = await startedCompletion();
    await write(r, completionBody());
    await settle(r);
    const readResult = await query(
      "SELECT status,response_body,actual_cost_credits::text AS actual_cost_credits FROM aiag_read_gateway_http_result_v1($1::uuid,$2::uuid,'completions'::varchar,'stored'::varchar,$3::text,$4::text,1::smallint)",
      [r.f.org, r.f.key, r.digest, r.fingerprint],
    );
    expect(readResult.rows).toEqual([{
      status: "ready",
      response_body: completionBody(),
      actual_cost_credits: "30",
    }]);
    const digest = await query(
      "SELECT response_digest=encode(sha256(convert_to(response_body::text,'UTF8')),'hex') AS exact FROM gateway_http_results WHERE billing_request_id=$1",
      [r.id],
    );
    expect(digest.rows[0].exact).toBe(true);

    for (const response of [
      { ...completionBody(), object: "chat.completion" },
      { ...completionBody(), choices: [{ ...completionBody().choices[0], logprobs: [] }] },
    ]) {
      const invalid = await startedCompletion();
      await expect(write(invalid, response)).rejects.toThrow("INVALID_HTTP_RESULT");
      expect((await query(
        "SELECT count(*)::int AS count FROM gateway_http_results WHERE billing_request_id=$1",
        [invalid.id],
      )).rows[0].count).toBe(0);
    }

    const wrongModel = request(await fixture());
    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1::uuid,$2::uuid,$3::uuid,'completions'::varchar,'stored'::varchar,$4::text,$5::text,1::smallint)",
      [wrongModel.f.org, wrongModel.f.key, wrongModel.id, wrongModel.digest, wrongModel.fingerprint],
    );
    const embeddingQuote = structuredClone(wrongModel.quote);
    embeddingQuote.tokenQuote.candidates[0].modelType = "embedding";
    const embeddingSupplier = { ...wrongModel.supplier, tokenQuote: embeddingQuote.tokenQuote };
    await expect(query(
      "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','completions','stored','openai/gpt-4o-mini',$4,$5,$6,'SID',$7)",
      [wrongModel.f.org, wrongModel.id, wrongModel.f.key, embeddingQuote.tokenQuote.authorizedMaxCredits, embeddingQuote, wrongModel.deadline, embeddingSupplier],
    )).rejects.toThrow("INVALID_SUPPLIER_QUOTE");
  });

  it("keeps key FOR SHARE until authenticated read commits", async () => {
    const r = request(await fixture());
    await claim(r);
    const results = await race(
      (c) => read(r, c),
      (c) =>
        query(
          "SELECT id FROM gateway_api_keys WHERE id=$1 FOR UPDATE",
          [r.f.key],
          c,
        ),
    );
    expect(results).toMatchObject([
      { rows: [{ status: "pending" }] },
      { rows: [{ id: r.f.key }] },
    ]);
  });
  it("serializes purge with writer replay without restoring content or extending retention", async () => {
    const r = await started();
    await write(r);
    await settle(r);
    await historical(r, true);
    const results = await race(
      (c) => expire(r, c),
      (c) => write(r, body(), usage(r), "30", c),
    );
    expect(results).toMatchObject([
      { rows: [{ expired: true }] },
      { rows: [{ did_transition: false }] },
    ]);
    expect(
      (
        await query(
          "SELECT response_body,payload_expired_at IS NOT NULL AS purged FROM gateway_http_results WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0],
    ).toEqual({ response_body: null, purged: true });
  });
  it("binds contract version to the stored response envelope in both directions", async () => {
    const v1 = await started();
    await expect(write(v1, streamBody())).rejects.toThrow("INVALID_HTTP_RESULT");
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM gateway_http_results WHERE billing_request_id=$1",
          [v1.id],
        )
      ).rows[0].count,
    ).toBe(0);

    const v2 = request(await fixture());
    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat'::varchar,'stored'::varchar,$4,$5,2::smallint)",
      [v2.f.org, v2.f.key, v2.id, v2.digest, v2.fingerprint],
    );
    await admit(v2);
    await dispatch(v2);
    await expect(
      query(
        "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,30,$6,'success',$7,2::smallint)",
        [
          v2.f.org,
          v2.f.key,
          v2.id,
          v2.digest,
          v2.fingerprint,
          JSON.stringify(usage(v2)),
          JSON.stringify(body()),
        ],
      ),
    ).rejects.toThrow("INVALID_HTTP_RESULT");
    expect(
      (
        await query(
          "SELECT count(*)::int AS count FROM gateway_http_results WHERE billing_request_id=$1",
          [v2.id],
        )
      ).rows[0].count,
    ).toBe(0);
  });


  it("persists and recovers fixed-fee BYOK contract v3 and conflicts with stored reuse", async () => {
    const r = request(await fixture());
    const fee = "1000";
    const feeQuote = {
      version: 2,
      formulaVersion: "byok-fee-microcredits-v2",
      upstreamId: "openrouter",
      feeMicrocredits: fee,
    };
    const supplier = { version: 2, formulaVersion: "byok-zero-v2" };
    const feeUsage = {
      version: 2,
      formulaVersion: "byok-fee-microcredits-v2",
      billingRequestId: r.id,
      attemptId: r.attempt,
      upstreamId: "openrouter",
      verified: true,
    };

    await query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat'::varchar,'byok_fee'::varchar,$4,$5,3::smallint)",
      [r.f.org, r.f.key, r.id, r.digest, r.fingerprint],
    );

    await expect(
      query(
        "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat'::varchar,'stored'::varchar,$4,$5,1::smallint)",
        [r.f.org, r.f.key, randomUUID(), r.digest, hash("different-stored-body")],
      ),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");

    await query(
      "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','chat','byok_fee','openai/gpt-4o-mini',$4,$5,$6,'SID',$7)",
      [r.f.org, r.id, r.f.key, fee, feeQuote, r.deadline, supplier],
    );
    await query(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,'openrouter',$4)",
      [r.f.org, r.id, r.attempt, feeQuote],
    );
    await query(
      "SELECT * FROM aiag_record_gateway_http_outcome_v1($1,$2,$3,$4,$5,$6,$7,'success',$8,3::smallint)",
      [
        r.f.org,
        r.f.key,
        r.id,
        r.digest,
        r.fingerprint,
        fee,
        JSON.stringify(feeUsage),
        JSON.stringify(body()),
      ],
    );

    const recovered = await query(
      "SELECT state,billing_mode,outcome_kind,actual_cost_credits::text FROM aiag_recover_gateway_http_settlement_v1($1,$2,$3)",
      [r.f.org, r.f.key, r.id],
    );
    expect(recovered.rows).toEqual([
      {
        state: "settled",
        billing_mode: "byok_fee",
        outcome_kind: "success",
        actual_cost_credits: fee,
      },
    ]);

    const replay = await query(
      "SELECT contract_version,status,http_status,content_type,response_body,actual_cost_credits::text FROM aiag_read_gateway_http_result_v1($1,$2,'chat'::varchar,'byok_fee'::varchar,$3,$4,3::smallint)",
      [r.f.org, r.f.key, r.digest, r.fingerprint],
    );
    expect(replay.rows).toMatchObject([
      {
        contract_version: 3,
        status: "ready",
        http_status: 200,
        content_type: "application/json",
        response_body: body(),
        actual_cost_credits: fee,
      },
    ]);
    expect(
      (
        await query(
          "SELECT supplier_authorized_max_usd_micro::text AS reserved,supplier_actual_usd_micro::text AS actual FROM gateway_charge_quota_contexts WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows,
    ).toEqual([{ reserved: "0", actual: "0" }]);
    expect(
      (
        await query(
          "SELECT payg_credits::text AS payg FROM organizations WHERE id=$1",
          [r.f.org],
        )
      ).rows,
    ).toEqual([{ payg: "999000" }]);
  });

  it("rejects nonstored/unsupported version and null UUID inputs without a mapping", async () => {
    const r = request(await fixture());
    for (const [route, mode, version, id] of [
      ["audio", "stored", 1, r.id],
      ["chat", "byok_fee", 1, r.id],
      ["chat", "stored", 3, r.id],
      ["chat", "stored", 1, null],
    ]) {
      await expect(
        query(
          "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,$4,$5,$6,$7,$8::smallint)",
          [r.f.org, r.f.key, id, route, mode, r.digest, r.fingerprint, version],
        ),
      ).rejects.toThrow("INVALID_HTTP_REQUEST");
    }
  });
});
