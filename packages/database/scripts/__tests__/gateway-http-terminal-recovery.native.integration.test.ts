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
describe.skipIf(!enabled)("native HTTP terminal rejection and recovery", () => {
  let db: TestDatabaseClient, close: () => Promise<void>;
  const fixtures: Fixture[] = [];
  const query = (text: string, values: readonly unknown[] = [], c = db) =>
    c.query({ text, values });
  async function fixture() {
    const f = { user: randomUUID(), org: randomUUID(), key: randomUUID() };
    // Register only a fully committed owner. A failed duplicate INSERT grants no cleanup authority.
    await query("BEGIN");
    try {
      await query("INSERT INTO users(id,email) VALUES($1,$2) RETURNING id", [
        f.user,
        `terminal-${f.user}@example.test`,
      ]);
      await query(
        "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1,$2,'terminal',$3,1000000) RETURNING id",
        [f.org, f.org, f.user],
      );
      await query(
        "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1,$2,'terminal',$3,$4)",
        [f.key, f.org, randomUUID(), f.key.slice(0, 16)],
      );
      await query(
        "INSERT INTO gateway_quota_org_policies(org_id,enforcement_version) VALUES($1,2)",
        [f.org],
      );
      await query("COMMIT");
      fixtures.push(f);
      return f;
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  }
  const claim = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_claim_gateway_http_request_v1($1,$2,$3,'chat','stored',$4,$5,1::smallint)",
      [r.f.org, r.f.key, r.id, r.digest, r.fingerprint],
      c,
    );
  const read = (r: Request, c = db) =>
    query(
      "SELECT contract_version,status,billing_request_id,http_status,content_type,response_body,actual_cost_credits::text,stored_at::text,expires_at::text,rejection_code FROM aiag_read_gateway_http_result_v2($1,$2,'chat','stored',$3,$4,1::smallint)",
      [r.f.org, r.f.key, r.digest, r.fingerprint],
      c,
    );
  const admit = (r: Request, c = db, sid: string | null = "SID") =>
    query(
      "SELECT org_id,api_key_id,billing_request_id,status,(admission).state AS state,(admission).did_transition AS admission_transition,rejection_code,http_status,response_body,terminal_at::text,did_transition FROM aiag_admit_gateway_http_charge_v1($1,$2,$3,'trace','chat','stored','openai/gpt-4o-mini',$4,$5,$6,$7,$8,$9,$10,1::smallint)",
      [
        r.f.org,
        r.id,
        r.f.key,
        r.quote.tokenQuote.authorizedMaxCredits,
        JSON.stringify(r.quote),
        r.deadline,
        sid,
        JSON.stringify(r.supplier),
        r.digest,
        r.fingerprint,
      ],
      c,
    );
  const legacy = (r: Request, c = db, v2 = true) =>
    query(
      v2
        ? "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,'trace','chat','stored','openai/gpt-4o-mini',$4,$5,$6,'SID',$7)"
        : "SELECT * FROM aiag_admit_gateway_charge($1,$2,$3,'trace','chat','stored','openai/gpt-4o-mini',$4,$5,$6)",
      [
        r.f.org,
        r.id,
        r.f.key,
        r.quote.tokenQuote.authorizedMaxCredits,
        JSON.stringify(r.quote),
        r.deadline,
        ...(v2 ? [JSON.stringify(r.supplier)] : []),
      ],
      c,
    );
  const unstarted = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_reject_unstarted_gateway_http_request_v1($1,$2,$3,'chat','stored',$4,$5,1::smallint)",
      [r.f.org, r.f.key, r.id, r.digest, r.fingerprint],
      c,
    );
  const recover = (r: Request, c = db) =>
    query(
      "SELECT state,did_transition,actual_cost_credits::text FROM aiag_recover_gateway_http_settlement_v1($1,$2,$3)",
      [r.f.org, r.f.key, r.id],
      c,
    );
  const dispatch = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,'openrouter',$4)",
      [
        r.f.org,
        r.id,
        r.attempt,
        JSON.stringify({
          ...r.quote.tokenQuote.candidates[0],
          actualChargePolicy: r.quote.actualChargePolicy,
        }),
      ],
      c,
    );
  const write = (r: Request, c = db, actual = "30", u = usage(r), b = body()) =>
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
        JSON.stringify(b),
      ],
      c,
    );
  const settle = (r: Request, c = db) =>
    query(
      "SELECT * FROM aiag_settle_admitted_gateway_charge($1,$2)",
      [r.f.org, r.id],
      c,
    );
  async function snapshot(r: Request) {
    return (
      await query(
        `SELECT jsonb_build_object(
      'org',(SELECT to_jsonb(o) FROM organizations o WHERE id=$2),
      'admission',(SELECT to_jsonb(a) FROM gateway_charge_admissions a WHERE billing_request_id=$1),
      'context',(SELECT to_jsonb(a) FROM gateway_charge_quota_contexts a WHERE billing_request_id=$1),
      'buckets',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gateway_quota_buckets a WHERE org_id=$2),
      'reservations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY kind) FROM gateway_charge_quota_reservations a WHERE billing_request_id=$1),
      'events',(SELECT jsonb_agg(to_jsonb(a) ORDER BY kind,event_kind) FROM gateway_charge_quota_events a WHERE billing_request_id=$1),
      'admission_events',(SELECT jsonb_agg(to_jsonb(a) ORDER BY event_key) FROM gateway_charge_admission_events a WHERE admission_id=$1),
      'transactions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM gateway_transactions a WHERE org_id=$2),
      'result',(SELECT to_jsonb(a) FROM gateway_http_results a WHERE billing_request_id=$1)) AS facts`,
        [r.id, r.f.org],
      )
    ).rows[0].facts;
  }
  async function cleanup(f: Fixture) {
    await query("BEGIN");
    try {
      expect(
        (
          await query(
            "SELECT owner_id FROM organizations WHERE id=$1 FOR UPDATE",
            [f.org],
          )
        ).rows,
      ).toEqual([{ owner_id: f.user }]);
      expect(
        (
          await query("SELECT org_id FROM gateway_api_keys WHERE id=$1", [
            f.key,
          ])
        ).rows,
      ).toEqual([{ org_id: f.org }]);
      const rows = await query(
        "SELECT billing_request_id,api_key_id FROM gateway_http_requests WHERE org_id=$1",
        [f.org],
      );
      const hasNegative = Boolean(
        (
          await query(
            "SELECT to_regclass('gateway_http_rejections')::text AS name",
          )
        ).rows[0].name,
      );
      for (const row of rows.rows) {
        expect(row.api_key_id).toBe(f.key);
        const args = [f.org, f.key, row.billing_request_id];
        if (hasNegative)
          await query(
            "DELETE FROM gateway_http_rejections WHERE org_id=$1 AND api_key_id=$2 AND billing_request_id=$3",
            args,
          );
        await query(
          "DELETE FROM gateway_http_results WHERE org_id=$1 AND api_key_id=$2 AND billing_request_id=$3",
          args,
        );
        await query(
          "DELETE FROM gateway_http_requests WHERE org_id=$1 AND api_key_id=$2 AND billing_request_id=$3",
          args,
        );
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
      await query("DELETE FROM organizations WHERE id=$1 AND owner_id=$2", [
        f.org,
        f.user,
      ]);
      await query("DELETE FROM users WHERE id=$1", [f.user]);
      await query("COMMIT");
      expect(
        (await query("SELECT id FROM organizations WHERE id=$1", [f.org])).rows,
      ).toEqual([]);
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  }
  beforeAll(async () => {
    ({ db, close } = await open());
  });
  afterEach(async () => {
    for (const f of [...fixtures]) {
      await cleanup(f);
      fixtures.splice(fixtures.indexOf(f), 1);
    }
  });
  afterAll(async () => {
    await close?.();
  });
  it.each(["funds", "quota", "deadline", "session", "refund"] as const)(
    "atomically records known %s rejection without financial effects",
    async (kind) => {
      const r = request(await fixture());
      if (kind === "funds")
        await query("UPDATE organizations SET payg_credits=0 WHERE id=$1", [
          r.f.org,
        ]);
      if (kind === "quota")
        await query(
          "UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=0 WHERE org_id=$1",
          [r.f.org],
        );
      if (kind === "deadline")
        r.deadline = new Date(Date.now() - 10000).toISOString();
      if (kind === "session")
        await query(
          "INSERT INTO gateway_quota_key_policies(api_key_id,org_id,session_microcredits_limit_v2) VALUES($1,$2,100)",
          [r.f.key, r.f.org],
        );
      if (kind === "refund")
        await query(
          "UPDATE organizations SET refund_debt_credits=1 WHERE id=$1",
          [r.f.org],
        );
      await claim(r);
      const before = await snapshot(r);
      const codes = {
        funds: ["PAYMENT_REQUIRED", 402],
        quota: ["QUOTA_EXCEEDED", 429],
        deadline: ["ADMISSION_DEADLINE_EXPIRED", 409],
        session: ["SESSION_REQUIRED", 400],
        refund: ["REFUND_BLOCKED", 402],
      };
      expect(
        (await admit(r, db, kind === "session" ? null : "SID")).rows[0],
      ).toMatchObject({
        org_id: r.f.org,
        api_key_id: r.f.key,
        billing_request_id: r.id,
        status: "rejected",
        rejection_code: codes[kind][0],
        http_status: codes[kind][1],
        state: null,
        did_transition: true,
      });
      expect(await snapshot(r)).toEqual(before);
      const result = (await read(r)).rows[0];
      expect(result).toMatchObject({
        status: "rejected",
        billing_request_id: r.id,
        rejection_code: codes[kind][0],
        actual_cost_credits: null,
        expires_at: null,
      });
      expect((await admit(r)).rows[0].did_transition).toBe(false);
      expect((await read(r)).rows[0]).toEqual(result);
    },
  );
  it("settles recorded outcome once and never recreates evidence", async () => {
    const r = request(await fixture());
    await claim(r);
    await legacy(r);
    await dispatch(r);
    await write(r);
    expect((await recover(r)).rows[0]).toEqual({
      state: "settled",
      did_transition: true,
      actual_cost_credits: "30",
    });
    const before = await snapshot(r);
    expect((await recover(r)).rows[0].did_transition).toBe(false);
    expect(await snapshot(r)).toEqual(before);
    expect((await read(r)).rows[0]).toMatchObject({
      status: "ready",
      actual_cost_credits: "30",
      rejection_code: null,
      response_body: body(),
    });
  });
  async function started() {
    const r = request(await fixture());
    await claim(r);
    await admit(r);
    await dispatch(r);
    return r;
  }
  async function race(
    first: (c: TestDatabaseClient) => Promise<unknown>,
    second: (c: TestDatabaseClient) => Promise<unknown>,
  ) {
    const a = await open(),
      b = await open();
    let pending: Promise<unknown> | undefined;
    try {
      await query("SET statement_timeout='10s'", [], b.db);
      await query("BEGIN", [], a.db);
      const firstResult = await first(a.db);
      const pid = (await query("SELECT pg_backend_pid() AS pid", [], b.db))
        .rows[0].pid;
      pending = second(b.db);
      pending.catch(() => undefined);
      const deadline = Date.now() + 5000;
      let observed = false;
      while (Date.now() < deadline) {
        if (
          Number(
            (
              await query("SELECT cardinality(pg_blocking_pids($1)) AS n", [
                pid,
              ])
            ).rows[0].n,
          ) > 0
        ) {
          observed = true;
          break;
        }
      }
      expect(
        observed,
        "real connection must wait on the first transaction",
      ).toBe(true);
      await query("COMMIT", [], a.db);
      return [firstResult, await pending];
    } finally {
      await query("ROLLBACK", [], a.db);
      await pending?.catch(() => undefined);
      await a.close();
      await b.close();
    }
  }
  async function fault(
    r: Request,
    table:
      | "gateway_http_rejections"
      | "gateway_charge_quota_events"
      | "gateway_charge_admissions"
      | "gateway_transactions"
      | "gateway_charge_admission_events",
    event: "INSERT" | "UPDATE",
    code: string,
    message: string,
    run: () => Promise<void>,
  ) {
    // DDL identifiers are generated here, never request/env values. All fixture DML stays bound.
    const name = `terminal_fault_${randomUUID().replaceAll("-", "")}`;
    const field =
      table === "gateway_transactions"
        ? "org_id"
        : table === "gateway_charge_admission_events"
          ? "admission_id"
          : "billing_request_id";
    const id = table === "gateway_transactions" ? r.f.org : r.id;
    if (!/^[A-Z0-9]{5}$/.test(code) || !/^[A-Z_]+$/.test(message))
      throw Error("Invalid test fault constant");
    await query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE='${code}'; END $$`,
    );
    try {
      await query(
        `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW WHEN (NEW.${field}='${id}'::uuid) EXECUTE FUNCTION ${name}()`,
      );
      await run();
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await query(`DROP FUNCTION ${name}()`);
    }
  }
  it("preserves the negative fence against late v1/v2 admission after funds change", async () => {
    const r = request(await fixture());
    await claim(r);
    await unstarted(r);
    const result = (await read(r)).rows[0];
    const before = await snapshot(r);
    for (const v2 of [true, false])
      await expect(legacy(r, db, v2)).rejects.toThrow(
        "HTTP_TERMINAL_REJECTION_EXISTS",
      );
    expect(await snapshot(r)).toEqual(before);
    await query(
      "UPDATE organizations SET payg_credits=payg_credits+100 WHERE id=$1",
      [r.f.org],
    );
    expect((await claim({ ...r, id: randomUUID() })).rows[0]).toMatchObject({
      billing_request_id: r.id,
      did_claim: false,
    });
    expect((await admit(r)).rows[0]).toMatchObject({
      status: "rejected",
      rejection_code: "REQUEST_NOT_STARTED",
      did_transition: false,
    });
    expect((await unstarted(r)).rows[0].did_transition).toBe(false);
    expect((await read(r)).rows[0]).toEqual(result);
  });
  it("preserves FOUND for new and replayed legacy v1/v2 admissions", async () => {
    for (const v2 of [true, false]) {
      const r = request(await fixture());
      if (!v2)
        await query(
          "UPDATE gateway_quota_org_policies SET enforcement_version=1 WHERE org_id=$1",
          [r.f.org],
        );
      expect((await legacy(r, db, v2)).rows[0]).toMatchObject({
        state: "held",
        did_transition: true,
      });
      const before = await snapshot(r);
      const replay = (await legacy(r, db, v2)).rows[0];
      expect(Object.keys(replay)).toHaveLength(31);
      expect(replay).toMatchObject({ state: "held", did_transition: false });
      expect(await snapshot(r)).toEqual(before);
    }
  });
  it("keeps exactly one hold or negative under competing HTTP admits", async () => {
    for (const negative of [false, true]) {
      const r = request(await fixture());
      await claim(r);
      if (negative)
        await query("UPDATE organizations SET payg_credits=0 WHERE id=$1", [
          r.f.org,
        ]);
      expect(
        await race(
          (c) => admit(r, c),
          (c) => admit(r, c),
        ),
      ).toMatchObject([
        {
          rows: [
            {
              status: negative ? "rejected" : "admitted",
              did_transition: true,
            },
          ],
        },
        {
          rows: [
            {
              status: negative ? "rejected" : "admitted",
              did_transition: false,
            },
          ],
        },
      ]);
      expect(
        (
          await query(
            "SELECT count(*)::text AS n FROM gateway_charge_admissions WHERE billing_request_id=$1",
            [r.id],
          )
        ).rows[0].n,
      ).toBe(negative ? "0" : "1");
    }
  });
  it("serializes unstarted versus late admission in both real lock orders", async () => {
    const r = request(await fixture());
    await claim(r);
    await expect(
      race(
        (c) => unstarted(r, c),
        (c) => legacy(r, c),
      ),
    ).rejects.toThrow("HTTP_TERMINAL_REJECTION_EXISTS");
    expect((await read(r)).rows[0].status).toBe("rejected");
    const s = request(await fixture());
    await claim(s);
    await expect(
      race(
        (c) => admit(s, c),
        (c) => unstarted(s, c),
      ),
    ).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    expect((await read(s)).rows[0].status).toBe("pending");
    expect(
      (
        await query(
          "SELECT count(*)::text AS n FROM gateway_http_rejections WHERE billing_request_id=$1",
          [s.id],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it.each([true, false])(
    "keeps rejection ACK uncertainty factual (committed=%s)",
    async (committed) => {
      const r = request(await fixture());
      await claim(r);
      await query("UPDATE organizations SET payg_credits=0 WHERE id=$1", [
        r.f.org,
      ]);
      const before = await snapshot(r);
      const a = await open();
      try {
        await query("BEGIN", [], a.db);
        await admit(r, a.db);
        if (committed) await query("COMMIT", [], a.db);
      } finally {
        await a.close();
      }
      const b = await open();
      try {
        expect((await read(r, b.db)).rows[0].status).toBe(
          committed ? "rejected" : "pending",
        );
        expect(await snapshot(r)).toEqual(before);
      } finally {
        await b.close();
      }
    },
  );
  it("leaves pending uncertainty after an actual admission lock timeout", async () => {
    const r = request(await fixture());
    await claim(r);
    const before = await snapshot(r),
      a = await open(),
      b = await open();
    try {
      await query("BEGIN", [], a.db);
      await query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [r.f.org],
        a.db,
      );
      await query("SET lock_timeout='50ms'", [], b.db);
      await expect(admit(r, b.db)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await query("ROLLBACK", [], a.db);
      await a.close();
      await b.close();
    }
    expect((await read(r)).rows[0].status).toBe("pending");
    expect(await snapshot(r)).toEqual(before);
  });
  it.each(["admit", "dispatch"])(
    "never terminalizes committed %s with a lost ACK",
    async (stage) => {
      const r = request(await fixture());
      await claim(r);
      const a = await open();
      try {
        await query("BEGIN", [], a.db);
        await admit(r, a.db);
        if (stage === "dispatch") await dispatch(r, a.db);
        await query("COMMIT", [], a.db);
      } finally {
        await a.close();
      }
      const before = await snapshot(r);
      expect((await read(r)).rows[0].status).toBe("pending");
      await expect(unstarted(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
      await expect(recover(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
      expect(await snapshot(r)).toEqual(before);
    },
  );
  it("fails closed on administratively corrupted negative/admission coexistence", async () => {
    const r = request(await fixture());
    await claim(r);
    await admit(r);
    await query(
      "INSERT INTO gateway_http_rejections(billing_request_id,org_id,api_key_id,result_version,rejection_code,http_status,content_type,response_body,terminal_at) VALUES($1,$2,$3,1,'REQUEST_NOT_STARTED',409,'application/json',aiag_http_rejection_body_v1('REQUEST_NOT_STARTED'),clock_timestamp())",
      [r.id, r.f.org, r.f.key],
    );
    const before = await snapshot(r);
    await expect(legacy(r)).rejects.toThrow("HTTP_TERMINAL_REJECTION_EXISTS");
    await expect(admit(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    await expect(read(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    await expect(recover(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    expect(await snapshot(r)).toEqual(before);
  });
  it("never converts a failed rejection insert into rejected ACK", async () => {
    const r = request(await fixture());
    await claim(r);
    await query("UPDATE organizations SET payg_credits=0 WHERE id=$1", [
      r.f.org,
    ]);
    const before = await snapshot(r);
    await fault(
      r,
      "gateway_http_rejections",
      "INSERT",
      "P0001",
      "TEST_REJECTION_WRITE_FAILED",
      async () => {
        await expect(admit(r)).rejects.toThrow("TEST_REJECTION_WRITE_FAILED");
        expect((await read(r)).rows[0].status).toBe("pending");
        expect(await snapshot(r)).toEqual(before);
      },
    );
    expect((await admit(r)).rows[0].status).toBe("rejected");
  });
  it.each([
    ["P0003", "UNKNOWN_BUSINESS_ERROR"],
    ["P0004", "CONCURRENT_MODIFICATION"],
    ["P0005", "API_KEY_ORG_MISMATCH"],
    ["40001", "SERIALIZATION_FAILURE"],
  ])("does not terminalize unknown SQL %s/%s", async (code, message) => {
    const r = request(await fixture());
    await claim(r);
    const before = await snapshot(r);
    await fault(
      r,
      "gateway_charge_admissions",
      "INSERT",
      code,
      message,
      async () => {
        await expect(admit(r)).rejects.toMatchObject({ code, message });
        expect((await read(r)).rows[0].status).toBe("pending");
        expect(await snapshot(r)).toEqual(before);
      },
    );
  });
  it("rolls back every quota dimension when rejection occurs after partial reservation", async () => {
    const r = request(await fixture());
    await claim(r);
    // org_day sorts last; key/month and key/session reserves have already been attempted.
    await query(
      "UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=0 WHERE org_id=$1",
      [r.f.org],
    );
    const before = await snapshot(r);
    await admit(r);
    expect(await snapshot(r)).toEqual(before);
    expect(
      (
        await query(
          "SELECT count(*)::text AS n FROM gateway_quota_buckets WHERE org_id=$1",
          [r.f.org],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it.each(["held", "dispatched", "cancelled", "missing_result"])(
    "refuses unsupported recovery state %s without mutations",
    async (state) => {
      const r = request(await fixture());
      await claim(r);
      await admit(r);
      if (state === "dispatched" || state === "missing_result")
        await dispatch(r);
      if (state === "cancelled")
        await query(
          "SELECT * FROM aiag_cancel_undispatched_gateway_charge($1,$2)",
          [r.f.org, r.id],
        );
      if (state === "missing_result")
        await query(
          "SELECT * FROM aiag_record_gateway_charge_outcome_v2($1,$2,30,$3,'success')",
          [r.f.org, r.id, JSON.stringify(usage(r))],
        );
      const before = await snapshot(r);
      await expect(recover(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
      expect(await snapshot(r)).toEqual(before);
      await expect(unstarted(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    },
  );
  it("rejects missing mappings and unknown operations without manufacturing an outcome", async () => {
    const r = request(await fixture());
    const before = await snapshot(r);
    expect((await read(r)).rows[0].status).toBe("not_found");
    await expect(admit(r)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(unstarted(r)).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(recover(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await claim(r);
    await expect(recover(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    expect((await read(r)).rows[0].status).toBe("pending");
    expect(await snapshot(r)).toEqual(before);
  });
  it("denies revoked read/admit but permits internal settlement of the existing obligation", async () => {
    const r = await started();
    await write(r);
    await query(
      "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
      [r.f.key],
    );
    await expect(read(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(admit(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    expect((await recover(r)).rows[0].state).toBe("settled");
    const s = request(await fixture());
    await claim(s);
    await query(
      "UPDATE gateway_api_keys SET disabled_at=clock_timestamp() WHERE id=$1",
      [s.f.key],
    );
    await expect(unstarted(s)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(admit(s)).rejects.toThrow("API_KEY_ORG_MISMATCH");
    expect(
      (
        await query(
          "SELECT count(*)::text AS n FROM gateway_http_rejections WHERE billing_request_id=$1",
          [s.id],
        )
      ).rows[0].n,
    ).toBe("0");
  });
  it("isolates foreign scopes and conflicting fingerprints for all new entrypoints", async () => {
    const r = await started();
    await write(r);
    const other = request(await fixture());
    const before = await snapshot(r);
    await expect(recover({ ...r, f: other.f })).rejects.toThrow(
      "HTTP_ACCESS_DENIED",
    );
    await expect(admit({ ...r, f: other.f })).rejects.toThrow(
      "HTTP_IDENTITY_CONFLICT",
    );
    await expect(unstarted({ ...other, id: r.id })).rejects.toThrow(
      "HTTP_RESULT_STATE_CONFLICT",
    );
    expect((await read({ ...r, f: other.f })).rows[0].status).toBe("not_found");
    await expect(
      read({ ...r, fingerprint: hash("other SID") }),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(
      admit({ ...r, fingerprint: hash("other SID") }),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    expect(await snapshot(r)).toEqual(before);
  });
  it("serializes recovery with another recovery and the normal executor settlement", async () => {
    for (const ordinary of [false, true]) {
      const r = await started();
      await write(r);
      expect(
        await race(
          (c) => recover(r, c),
          (c) => (ordinary ? settle(r, c) : recover(r, c)),
        ),
      ).toMatchObject([
        { rows: [{ state: "settled", did_transition: true }] },
        { rows: [{ state: "settled", did_transition: false }] },
      ]);
      expect(
        (
          await query(
            "SELECT count(*)::text AS n FROM gateway_charge_admission_events WHERE admission_id=$1 AND event_kind='settlement'",
            [r.id],
          )
        ).rows[0].n,
      ).toBe("1");
      expect(
        (
          await query(
            "SELECT reserved_amount::text,settled_amount::text FROM gateway_quota_buckets WHERE org_id=$1",
            [r.f.org],
          )
        ).rows,
      ).toEqual(Array(3).fill({ reserved_amount: "0", settled_amount: "30" }));
    }
  });
  it.each([
    "gateway_transactions",
    "gateway_charge_admission_events",
    "gateway_charge_quota_events",
  ] as const)(
    "rolls back settlement on %s failure and retries once",
    async (table) => {
      const r = await started();
      await write(r);
      const before = await snapshot(r);
      await fault(
        r,
        table,
        "INSERT",
        "P0001",
        "TEST_SETTLEMENT_FAILED",
        async () => {
          await expect(recover(r)).rejects.toThrow("TEST_SETTLEMENT_FAILED");
          expect(await snapshot(r)).toEqual(before);
        },
      );
      expect((await recover(r)).rows[0].did_transition).toBe(true);
      expect((await recover(r)).rows[0].did_transition).toBe(false);
    },
  );
  it.each(["outcome", "settle"])(
    "recovers committed %s with simulated lost application ACK",
    async (stage) => {
      const r = await started(),
        a = await open();
      try {
        await query("BEGIN", [], a.db);
        await write(r, a.db);
        if (stage === "settle") await recover(r, a.db);
        await query("COMMIT", [], a.db);
      } finally {
        await a.close();
      }
      const b = await open();
      try {
        expect((await recover(r, b.db)).rows[0]).toMatchObject({
          state: "settled",
          did_transition: stage !== "settle",
        });
      } finally {
        await b.close();
      }
      const before = await snapshot(r);
      await recover(r);
      expect(await snapshot(r)).toEqual(before);
    },
  );
  it("keeps dispatched uncertainty when outcome transaction rolls back", async () => {
    const r = await started(),
      before = await snapshot(r),
      a = await open();
    try {
      await query("BEGIN", [], a.db);
      await write(r, a.db);
    } finally {
      await a.close();
    }
    expect(await snapshot(r)).toEqual(before);
    await expect(recover(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    expect((await read(r)).rows[0].status).toBe("pending");
  });
  it("settles an expired payload tombstone without restoring response or resetting retention", async () => {
    const r = await started();
    await write(r);
    // Owned synthetic historical INSERT, as in accepted0069 tests; never disable immutability.
    await query(
      `WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=$1 AND org_id=$2 AND api_key_id=$3 RETURNING *)
      INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
      SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,at-INTERVAL '169 hours',at-INTERVAL '1 hour'
      FROM original CROSS JOIN (SELECT clock_timestamp() AS at) t`,
      [r.id, r.f.org, r.f.key],
    );
    await query("SELECT aiag_expire_gateway_http_result_v1($1,$2)", [
      r.f.org,
      r.id,
    ]);
    const expired = (await read(r)).rows[0];
    expect(expired.status).toBe("expired");
    expect((await recover(r)).rows[0].state).toBe("settled");
    expect((await read(r)).rows[0]).toEqual(expired);
    expect(
      (
        await query(
          "SELECT response_body,payload_expired_at IS NOT NULL AS expired FROM gateway_http_results WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0],
    ).toEqual({ response_body: null, expired: true });
  });
  it("detects mismatched supplier evidence before touching money", async () => {
    const r = await started();
    await write(r);
    await query(
      "UPDATE gateway_charge_quota_contexts SET supplier_actual_usd_micro=supplier_actual_usd_micro+1 WHERE billing_request_id=$1",
      [r.id],
    );
    const before = await snapshot(r);
    await expect(recover(r)).rejects.toThrow("HTTP_RESULT_STATE_CONFLICT");
    expect(await snapshot(r)).toEqual(before);
  });
  it("reports fixed state conflict for invalid frozen supplier evidence", async () => {
    const r = await started();
    await write(r);
    // Keep the duplicated evidence equal, but violate the authoritative frozen-count contract.
    await query(
      "UPDATE gateway_charge_admissions SET usage_snapshot=jsonb_set(usage_snapshot,'{usage,promptTokens}','-1'::jsonb) WHERE billing_request_id=$1",
      [r.id],
    );
    await query(
      "UPDATE gateway_charge_quota_contexts q SET supplier_usage_snapshot=a.usage_snapshot FROM gateway_charge_admissions a WHERE q.billing_request_id=a.billing_request_id AND a.billing_request_id=$1",
      [r.id],
    );
    const before = await snapshot(r);
    await expect(recover(r)).rejects.toMatchObject({
      code: "P0005",
      message: "HTTP_RESULT_STATE_CONFLICT",
    });
    expect(await snapshot(r)).toEqual(before);
  });
  it("reports fixed state conflict for an invalid stored completion without remapping settlement failures", async () => {
    const r = await started();
    await write(r);
    await query(
      `WITH original AS (DELETE FROM gateway_http_results WHERE billing_request_id=$1 AND org_id=$2 AND api_key_id=$3 RETURNING *)
      INSERT INTO gateway_http_results(billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,response_body,response_digest,stored_at,expires_at)
      SELECT billing_request_id,org_id,api_key_id,contract_version,http_status,content_type,'{}'::jsonb,response_digest,stored_at,expires_at FROM original`,
      [r.id, r.f.org, r.f.key],
    );
    const before = await snapshot(r);
    await expect(recover(r)).rejects.toMatchObject({
      code: "P0005",
      message: "HTTP_RESULT_STATE_CONFLICT",
    });
    expect(await snapshot(r)).toEqual(before);
  });
  it("does not expose a negative to another same-org key or a revoked credential", async () => {
    const r = request(await fixture());
    await claim(r);
    await unstarted(r);
    const key = randomUUID();
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1,$2,'same-org',$3,$4)",
      [key, r.f.org, randomUUID(), key.slice(0, 16)],
    );
    expect((await read({ ...r, f: { ...r.f, key } })).rows[0]).toMatchObject({
      status: "not_found",
      billing_request_id: null,
      response_body: null,
    });
    await query(
      "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
      [r.f.key],
    );
    await expect(read(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(admit(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    await expect(unstarted(r)).rejects.toThrow("HTTP_ACCESS_DENIED");
    expect(
      (
        await query(
          "SELECT rejection_code FROM gateway_http_rejections WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0].rejection_code,
    ).toBe("REQUEST_NOT_STARTED");
  });
  it.each(["large", "bigint_max", "zero"])(
    "preserves exact %s financial evidence and separate supplier units",
    async (kind) => {
      const r = request(await fixture()),
        p = r.quote.tokenQuote.candidates[0];
      let actual = "0",
        supplier = "0",
        count = 0;
      if (kind === "large") {
        p.prices = { inputCentsPer1k: "1", outputCentsPer1k: "1", markup: "2" };
        p.contextWindowTokens = Number.MAX_SAFE_INTEGER;
        p.maxOutputTokens = Number.MAX_SAFE_INTEGER;
        p.maxCredits = "18014398509481982";
        count = 5007450000000000;
        actual = "10014900000000000";
        supplier = "50074500000000000";
      } else if (kind === "bigint_max") {
        p.prices.markup = "1317624576693539401";
        p.maxCredits = "9223372036854775807";
        count = 30;
        actual = "3952873730080618203";
        supplier = "30";
      }
      r.quote.tokenQuote.authorizedMaxCredits = p.maxCredits;
      await query("UPDATE organizations SET payg_credits=$2 WHERE id=$1", [
        r.f.org,
        p.maxCredits,
      ]);
      await claim(r);
      await admit(r);
      await dispatch(r);
      const u = usage(r),
        b = body();
      u.usage.promptTokens = count;
      u.usage.totalTokens = count;
      b.usage.prompt_tokens = count;
      b.usage.total_tokens = count;
      await write(r, db, actual, u, b);
      expect((await recover(r)).rows[0].actual_cost_credits).toBe(actual);
      expect((await read(r)).rows[0].actual_cost_credits).toBe(actual);
      expect(
        (
          await query(
            "SELECT supplier_actual_usd_micro::text AS supplier FROM gateway_charge_quota_contexts WHERE billing_request_id=$1",
            [r.id],
          )
        ).rows[0].supplier,
      ).toBe(supplier);
      expect(
        (
          await query(
            "SELECT COALESCE(-sum(delta),0)::text AS charged FROM gateway_transactions WHERE org_id=$1",
            [r.f.org],
          )
        ).rows[0].charged,
      ).toBe(actual);
    },
  );
  it.each(["digest", "fingerprint", "version", "null_uuid"])(
    "rejects invalid %s identity at new SQL boundaries",
    async (kind) => {
      const r = request(await fixture());
      await claim(r);
      const before = await snapshot(r);
      const invalid = {
        ...r,
        ...(kind === "digest"
          ? { digest: "A".repeat(64) }
          : kind === "fingerprint"
            ? { fingerprint: "bad" }
            : {}),
      };
      if (kind === "digest" || kind === "fingerprint") {
        await expect(admit(invalid)).rejects.toThrow("INVALID_HTTP_REQUEST");
        await expect(unstarted(invalid)).rejects.toThrow(
          "INVALID_HTTP_REQUEST",
        );
        await expect(read(invalid)).rejects.toThrow("INVALID_HTTP_REQUEST");
      } else if (kind === "version")
        await expect(
          query(
            "SELECT * FROM aiag_read_gateway_http_result_v2($1,$2,'chat','stored',$3,$4,2::smallint)",
            [r.f.org, r.f.key, r.digest, r.fingerprint],
          ),
        ).rejects.toThrow("INVALID_HTTP_REQUEST");
      else
        await expect(
          query(
            "SELECT * FROM aiag_recover_gateway_http_settlement_v1($1,$2,NULL)",
            [r.f.org, r.f.key],
          ),
        ).rejects.toThrow("INVALID_HTTP_REQUEST");
      expect(await snapshot(r)).toEqual(before);
    },
  );
  it("rejects negative updates and parent deletes while preserving old FK SQLSTATE", async () => {
    const r = request(await fixture());
    await claim(r);
    await unstarted(r);
    const before = (await read(r)).rows[0];
    await expect(
      query(
        "UPDATE gateway_http_rejections SET terminal_at=terminal_at+INTERVAL '1 second' WHERE billing_request_id=$1",
        [r.id],
      ),
    ).rejects.toThrow("HTTP_IDENTITY_CONFLICT");
    await expect(
      query("DELETE FROM gateway_http_requests WHERE billing_request_id=$1", [
        r.id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    expect((await read(r)).rows[0]).toEqual(before);
    const s = await started();
    await write(s);
    await expect(
      query("DELETE FROM gateway_http_requests WHERE billing_request_id=$1", [
        s.id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("cleans only confirmed owned fixture rows and leaves an unrelated sentinel intact", async () => {
    const sentinel = request(await fixture());
    await claim(sentinel);
    await unstarted(sentinel);
    const before = await snapshot(sentinel),
      beforeRead = (await read(sentinel)).rows[0];
    const disposable = request(await fixture());
    await claim(disposable);
    await unstarted(disposable);
    await cleanup(disposable.f);
    fixtures.splice(fixtures.indexOf(disposable.f), 1);
    expect(await snapshot(sentinel)).toEqual(before);
    expect((await read(sentinel)).rows[0]).toEqual(beforeRead);
    expect(
      (
        await query(
          "SELECT billing_request_id FROM gateway_http_rejections WHERE org_id=$1",
          [disposable.f.org],
        )
      ).rows,
    ).toEqual([]);
  });
});
