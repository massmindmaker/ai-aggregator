import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (enabled) assertTestDatabaseEnvironment(process.env);
const formula = "db-input-output-cents-per-1k-legacy-whole-cache-v1";
const supplierFormula = "catalog-input-output-cents-per-1k-usd-micro-v2";
type Row = Record<string, unknown> & {
  billing_request_id: string;
  state: string;
  did_transition: boolean;
};
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
function candidate(
  input = "0.1",
  output = "0.1",
  context = 70,
  cap = 20,
  markup = "10",
  max = "70",
) {
  return {
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
    contextWindowTokens: context,
    maxOutputTokens: cap,
    prices: { inputCentsPer1k: input, outputCentsPer1k: output, markup },
    maxCredits: max,
  };
}
function request(
  f: Fixture,
  overrides: {
    max?: string;
    sid?: string | null;
    candidates?: ReturnType<typeof candidate>[];
    discount?: string;
    mode?: "stored" | "byok_fee";
  } = {},
) {
  const candidates = overrides.candidates ?? [candidate()];
  const max = overrides.max ?? "70";
  const quote = {
    version: 1,
    tokenQuote: {
      version: 1,
      formulaVersion: formula,
      requestedMode: "auto",
      effectiveMode: "auto",
      authorizedMaxCredits: max,
      candidates,
    },
    actualChargePolicy: {
      formulaVersion: formula,
      cachingDiscount: overrides.discount ?? "1",
    },
  };
  return {
    f,
    id: randomUUID(),
    attempt: randomUUID(),
    trace: "trace",
    max,
    sid: overrides.sid === undefined ? "SID" : overrides.sid,
    deadline: new Date(Date.now() + 120000).toISOString(),
    quote,
    supplier:
      overrides.mode === "byok_fee"
        ? { version: 2, formulaVersion: "byok-zero-v2" }
        : {
            version: 2,
            formulaVersion: supplierFormula,
            tokenQuote: quote.tokenQuote,
          },
    mode: overrides.mode ?? "stored",
  };
}
type Request = ReturnType<typeof request>;
describe.skipIf(!enabled)("native durable gateway quotas", () => {
  let db: TestDatabaseClient, close: () => Promise<void>;
  const fixtures: Fixture[] = [];
  const query = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
    c = db,
  ) => c.query<T>({ text, values });
  async function fixture(
    month: string | null = null,
    day: string | null = null,
    session: string | null = null,
  ) {
    const f = { user: randomUUID(), org: randomUUID(), key: randomUUID() };
    fixtures.push(f);
    await query("INSERT INTO users(id,email) VALUES($1,$2)", [
      f.user,
      `quota-${f.user}@example.test`,
    ]);
    await query(
      "INSERT INTO organizations(id,slug,name,owner_id,payg_credits) VALUES($1,$2,'quota',$3,1000000)",
      [f.org, f.org, f.user],
    );
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix,cost_limit_monthly_rub) VALUES($1,$2,'quota',$3,$4,$5)",
      [f.key, f.org, randomUUID(), f.key.slice(0, 16), month],
    );
    await query(
      "INSERT INTO gateway_quota_org_policies(org_id,enforcement_version,daily_supplier_usd_micro_limit_v2) VALUES($1,2,$2)",
      [f.org, day],
    );
    await query(
      "INSERT INTO gateway_quota_key_policies(api_key_id,org_id,session_microcredits_limit_v2) VALUES($1,$2,$3)",
      [f.key, f.org, session],
    );
    return f;
  }
  const admit = (r: Request, c = db, legacy = false) =>
    query<Row>(
      `SELECT * FROM ${legacy ? "aiag_admit_gateway_charge" : "aiag_admit_gateway_charge_v2"}($1::uuid,$2::uuid,$3::uuid,$4::varchar,'chat'::varchar,$5::varchar,$6::varchar,$7::bigint,$8::jsonb,$9::timestamptz${legacy ? "" : ",$10::varchar,$11::jsonb"})`,
      [
        r.f.org,
        r.id,
        r.f.key,
        r.trace,
        r.mode,
        "openai/gpt-4o-mini",
        r.max,
        JSON.stringify(r.quote),
        r.deadline,
        ...(legacy ? [] : [r.sid, JSON.stringify(r.supplier)]),
      ],
      c,
    );
  const pricing = (r: Request, index = 0) => ({
    ...r.quote.tokenQuote.candidates[index],
    actualChargePolicy: r.quote.actualChargePolicy,
  });
  const dispatch = (r: Request, c = db, p = pricing(r)) =>
    query<Row>(
      "SELECT * FROM aiag_mark_gateway_charge_dispatched($1,$2,$3,$4,$5)",
      [r.f.org, r.id, r.attempt, p.upstreamId, JSON.stringify(p)],
      c,
    );
  const usage = (
    r: Request,
    prompt = 30,
    completion = 0,
    cached = 0,
    index = 0,
  ) => {
    const p = r.quote.tokenQuote.candidates[index];
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
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        cachedInputTokens: cached,
      },
      formulaVersion: formula,
    };
  };
  const outcome = (
    r: Request,
    actual = "30",
    u: unknown = usage(r),
    c = db,
    legacy = false,
  ) =>
    query<Row>(
      `SELECT * FROM ${legacy ? "aiag_record_gateway_charge_outcome" : "aiag_record_gateway_charge_outcome_v2"}($1,$2,$3,$4,$5)`,
      [r.f.org, r.id, actual, JSON.stringify(u), "success"],
      c,
    );
  const settle = (r: Request, c = db) =>
    query<Row>(
      "SELECT * FROM aiag_settle_admitted_gateway_charge($1,$2)",
      [r.f.org, r.id],
      c,
    );
  const cancel = (r: Request, c = db) =>
    query<Row>(
      "SELECT * FROM aiag_cancel_undispatched_gateway_charge($1,$2)",
      [r.f.org, r.id],
      c,
    );
  const buckets = (f: Fixture) =>
    query(
      "SELECT kind,reserved_amount::text,settled_amount::text FROM gateway_quota_buckets WHERE org_id=$1 ORDER BY kind",
      [f.org],
    );
  beforeAll(async () => {
    ({ db, close } = await open());
  });
  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      // FK RESTRICT deliberately keeps production audit durable; only owned test fixtures are removed.
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
      await query("DELETE FROM payments WHERE topup_org_id=$1", [f.org]);
      await query("DELETE FROM organizations WHERE id=$1", [f.org]);
      await query("DELETE FROM users WHERE id=$1", [f.user]);
    }
  });
  afterAll(async () => {
    await close?.();
  });
  it("reserves three durable dimensions, retains maxima through outcome, settles exactly once", async () => {
    const f = await fixture("0.10", "100", "100"),
      r = request(f);
    expect((await admit(r)).rows[0].did_transition).toBe(true);
    expect(Object.keys((await admit(r)).rows[0])).toHaveLength(31);
    expect((await buckets(f)).rows.map((x) => x.reserved_amount)).toEqual([
      "70",
      "70",
      "70",
    ]);
    await dispatch(r);
    await outcome(r);
    expect((await buckets(f)).rows.map((x) => x.reserved_amount)).toEqual([
      "70",
      "70",
      "70",
    ]);
    expect((await settle(r)).rows[0].did_transition).toBe(true);
    expect((await settle(r)).rows[0].did_transition).toBe(false);
    expect(
      (await buckets(f)).rows.map((x) => [x.reserved_amount, x.settled_amount]),
    ).toEqual([
      ["0", "30"],
      ["0", "30"],
      ["0", "30"],
    ]);
  });
  it("rejects excess without financial or quota residue", async () => {
    const f = await fixture("0.10"),
      r = request(f);
    await admit(r);
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    expect(
      (
        await query(
          "SELECT payg_credits::text FROM organizations WHERE id=$1",
          [f.org],
        )
      ).rows[0].payg_credits,
    ).toBe("999930");
    expect(
      (
        await query(
          "SELECT count(*)::text n FROM gateway_charge_quota_reservations WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0].n,
    ).toBe("3");
  });
  async function policy(
    f: Fixture,
    changes: {
      month?: string | null;
      day?: string | null;
      session?: string | null;
      revoke?: boolean;
      version?: number;
    },
    c = db,
  ) {
    await query("BEGIN", [], c);
    try {
      await query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [f.org],
        c,
      );
      if ("day" in changes || "version" in changes)
        await query(
          "UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=CASE WHEN $2 THEN $3::bigint ELSE daily_supplier_usd_micro_limit_v2 END,enforcement_version=coalesce($4,enforcement_version),revision=revision+1 WHERE org_id=$1",
          [
            f.org,
            "day" in changes,
            changes.day ?? null,
            changes.version ?? null,
          ],
          c,
        );
      if ("session" in changes)
        await query(
          "UPDATE gateway_quota_key_policies SET session_microcredits_limit_v2=$2,revision=revision+1 WHERE api_key_id=$1",
          [f.key, changes.session],
          c,
        );
      if ("month" in changes)
        await query(
          "UPDATE gateway_api_keys SET cost_limit_monthly_rub=$2 WHERE id=$1",
          [f.key, changes.month],
          c,
        );
      if ("revoke" in changes)
        await query(
          "UPDATE gateway_api_keys SET revoked_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END WHERE id=$1",
          [f.key, changes.revoke],
          c,
        );
      await query("COMMIT", [], c);
    } catch (e) {
      await query("ROLLBACK", [], c);
      throw e;
    }
  }
  async function secondKey(f: Fixture) {
    const key = randomUUID();
    await query(
      "INSERT INTO gateway_api_keys(id,org_id,name,key_hash,key_prefix) VALUES($1,$2,'quota',$3,$4)",
      [key, f.org, randomUUID(), key.slice(0, 16)],
    );
    return { ...f, key };
  }
  async function waitBlocked(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const x = await query<{ n: string }>(
        "SELECT count(*)::text n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
        [pid],
      );
      if (Number(x.rows[0].n) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("real PostgreSQL lock barrier not reached");
  }
  async function orderedRace(
    first: (c: TestDatabaseClient) => Promise<unknown>,
    second: (c: TestDatabaseClient) => Promise<unknown>,
    afterBlocked?: () => Promise<void>,
  ) {
    const a = await open(),
      b = await open();
    let pending:
      | Promise<{ ok: boolean; value?: unknown; error?: unknown }>
      | undefined;
    try {
      await query("BEGIN", [], a.db);
      const pid = (
        await query<{ pid: number }>("SELECT pg_backend_pid() pid", [], a.db)
      ).rows[0].pid;
      const firstResult = await first(a.db);
      pending = second(b.db).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      await waitBlocked(pid);
      await afterBlocked?.();
      await query("COMMIT", [], a.db);
      return { first: firstResult, second: await pending };
    } finally {
      await query("ROLLBACK", [], a.db);
      await a.close();
      await pending;
      await b.close();
    }
  }
  it.each(["month", "day", "session"] as const)(
    "proves %s contention on independent connections and pg_blocking_pids",
    async (dimension) => {
      const f = await fixture(
        dimension === "month" ? "0.10" : null,
        dimension === "day" ? "100" : null,
        dimension === "session" ? "100" : null,
      );
      const r = request(f),
        s = request(dimension === "day" ? await secondKey(f) : f);
      const race = await orderedRace(
        (c) => admit(r, c),
        (c) => admit(s, c),
      );
      expect(race.second.ok).toBe(false);
      expect(String(race.second.error)).toContain("QUOTA_EXCEEDED");
      expect(
        (
          await query(
            "SELECT count(*)::text n FROM gateway_charge_admissions WHERE org_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe("1");
      expect(
        (
          await query(
            "SELECT count(*)::text n FROM gateway_charge_quota_events WHERE billing_request_id=$1",
            [s.id],
          )
        ).rows[0].n,
      ).toBe("0");
    },
  );
  it("uses lifetime case-sensitive key/SID owner; trace and UUID text do not dedupe", async () => {
    const f = await fixture(null, null, "100"),
      r = request(f);
    await admit(r);
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    await admit(request(f, { sid: "sid" }));
    await admit(request(await secondKey(f), { sid: "SID" }));
    await admit(request(f, { sid: r.id }));
    await admit(request(f, { sid: r.trace }));
    const sessions = await query(
      "SELECT api_key_id,declared_session_id FROM gateway_quota_buckets WHERE org_id=$1 AND kind=$2",
      [f.org, "key_session_charged_v2"],
    );
    expect(sessions.rows).toHaveLength(5);
  });
  it("tracks unlimited usage, preserves unknown across tighten/disable/re-enable, pays admitted snapshot", async () => {
    const f = await fixture(),
      r = request(f);
    await admit(r);
    await dispatch(r);
    await policy(f, { month: "0.10", day: "100", session: "100" });
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    await policy(f, { month: null, day: null, session: null });
    const s = request(f);
    await admit(s);
    await cancel(s);
    await policy(f, { month: "0.01", day: "1", session: "1" });
    await outcome(r);
    await settle(r);
    expect((await buckets(f)).rows.map((x) => x.settled_amount)).toEqual([
      "30",
      "30",
      "30",
    ]);
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    const snapshot = await query(
      "SELECT limit_snapshot FROM gateway_charge_quota_reservations WHERE billing_request_id=$1",
      [r.id],
    );
    expect(snapshot.rows.every((x) => x.limit_snapshot === null)).toBe(true);
  });
  it("uses exact monthly 10.01 ×1000; NULL/legacy0 disabled and v2 zero hard zero", async () => {
    const f = await fixture("10.01");
    const r = request(f);
    await admit(r);
    expect(
      (
        await query(
          "SELECT limit_snapshot::text FROM gateway_charge_quota_reservations WHERE billing_request_id=$1 AND kind=$2",
          [r.id, "key_month_charged_v2"],
        )
      ).rows[0].limit_snapshot,
    ).toBe("10010");
    await cancel(r);
    await policy(f, { month: "0", day: "0" });
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    await policy(f, { day: null, session: "0" });
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_EXCEEDED/);
    await policy(f, { session: null });
    await admit(request(f, { sid: null }));
    expect(
      (
        await query(
          "SELECT count(*)::text n FROM gateway_charge_quota_reservations r JOIN gateway_charge_admissions a USING(billing_request_id) WHERE a.org_id=$1",
          [f.org],
        )
      ).rows[0].n,
    ).toBe("5");
  });
  it.each(["", " SID", "SID ", "é", "a/b", "a\n", "a".repeat(129)])(
    "rejects invalid exact SID %j before hold",
    async (sid) => {
      const f = await fixture();
      await expect(admit(request(f, { sid }))).rejects.toThrow();
      expect((await buckets(f)).rows).toHaveLength(0);
    },
  );
  it("requires SID with active session policy; nullable policy has admission-time coverage", async () => {
    const f = await fixture(null, null, "100");
    await expect(admit(request(f, { sid: null }))).rejects.toThrow(
      /QUOTA_SESSION_REQUIRED/,
    );
    await policy(f, { session: null });
    await admit(request(f, { sid: null }));
    await policy(f, { session: "100" });
    await admit(request(f));
    expect(
      (
        await query(
          "SELECT reserved_amount::text FROM gateway_quota_buckets WHERE org_id=$1 AND kind='key_session_charged_v2'",
          [f.org],
        )
      ).rows[0].reserved_amount,
    ).toBe("70");
  });
  it("replays exact identity before new policy/deadline checks; changed SID/tariff/trace/key/max conflicts", async () => {
    const f = await fixture(),
      r = request(f);
    await admit(r);
    const before = await buckets(f);
    await policy(f, { revoke: true, day: "0", session: "0", version: 1 });
    expect((await admit(r)).rows[0].did_transition).toBe(false);
    for (const changed of [
      { ...r, trace: "different" },
      { ...r, sid: "different" },
      { ...r, max: "71" },
      { ...r, f: { ...f, key: randomUUID() } },
      { ...r, supplier: { ...r.supplier, version: 3 } },
    ])
      await expect(admit(changed)).rejects.toThrow(
        /ADMISSION_IDENTITY_CONFLICT/,
      );
    await expect(admit(r, db, true)).rejects.toThrow(
      /ADMISSION_IDENTITY_CONFLICT/,
    );
    expect((await buckets(f)).rows).toEqual(before.rows);
    const other = await fixture();
    await expect(
      admit({ ...r, f: { ...r.f, org: other.org } }),
    ).rejects.toThrow(/ADMISSION_IDENTITY_CONFLICT/);
  });
  it("keeps same client trace as two distinct financial admissions", async () => {
    const f = await fixture(),
      r = request(f),
      s = request(f);
    await admit(r);
    await admit(s);
    expect((await buckets(f)).rows.map((x) => x.reserved_amount)).toEqual([
      "140",
      "140",
      "140",
    ]);
  });
  it.each([
    "policy-first",
    "admit-first",
    "revoke-first",
    "admit-before-revoke",
  ] as const)("serializes current policy and key writer: %s", async (order) => {
    const f = await fixture();
    const r = request(f);
    const writer = async (c: TestDatabaseClient) => {
      await query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [f.org],
        c,
      );
      if (order.includes("revoke"))
        return query(
          "UPDATE gateway_api_keys SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.key],
          c,
        );
      return query(
        "UPDATE gateway_quota_org_policies SET daily_supplier_usd_micro_limit_v2=0,revision=revision+1 WHERE org_id=$1",
        [f.org],
        c,
      );
    };
    if (order.endsWith("first") && order !== "admit-first") {
      const race = await orderedRace(writer, (c) => admit(r, c));
      expect(race.second.ok).toBe(false);
      expect(String(race.second.error)).toMatch(
        /QUOTA_EXCEEDED|API_KEY_ORG_MISMATCH/,
      );
    } else {
      const race = await orderedRace(
        (c) => admit(r, c),
        async (c) => {
          await query("BEGIN", [], c);
          try {
            await writer(c);
            await query("COMMIT", [], c);
          } catch (e) {
            await query("ROLLBACK", [], c);
            throw e;
          }
        },
      );
      expect(race.second.ok).toBe(true);
      await dispatch(r);
      await outcome(r);
      await settle(r);
    }
  });
  it.each([
    "double-settle",
    "settle-cancel",
    "dispatch-cancel",
    "cancel-dispatch",
  ] as const)("has one transition under real %s race", async (kind) => {
    const f = await fixture(),
      r = request(f);
    await admit(r);
    if (kind.startsWith("double") || kind === "settle-cancel") {
      await dispatch(r);
      await outcome(r);
    }
    const race = await orderedRace(
      (c) =>
        kind === "cancel-dispatch"
          ? cancel(r, c)
          : kind === "dispatch-cancel"
            ? dispatch(r, c)
            : settle(r, c),
      (c) =>
        kind === "double-settle"
          ? settle(r, c)
          : kind === "cancel-dispatch"
            ? dispatch(r, c)
            : cancel(r, c),
    );
    if (kind === "double-settle") {
      expect(race.second.ok).toBe(true);
      expect(
        (race.second.value as { rows: Row[] }).rows[0].did_transition,
      ).toBe(false);
    } else expect(race.second.ok).toBe(false);
    expect(
      (
        await query(
          "SELECT count(*)::text n FROM gateway_charge_quota_events WHERE billing_request_id=$1 AND event_kind<>'reserved'",
          [r.id],
        )
      ).rows[0].n,
    ).toBe(kind === "dispatch-cancel" ? "0" : "3");
  });
  it("independently accounts zero retail with positive supplier; old outcome cannot bypass evidence", async () => {
    const f = await fixture(),
      r = request(f, { discount: "0" });
    await admit(r);
    await dispatch(r);
    await expect(
      outcome(r, "0", usage(r, 30, 0, 30), db, true),
    ).rejects.toThrow(/QUOTA_OUTCOME_VERSION_CONFLICT/);
    await outcome(r, "0", usage(r, 30, 0, 30));
    await settle(r);
    expect((await buckets(f)).rows.map((x) => x.settled_amount)).toEqual([
      "0",
      "0",
      "30",
    ]);
  });
  it("ceilings supplier once, reserves max across candidates, settles cheaper selected exact tariff", async () => {
    const expensive = candidate("0.1", "0.1", 70, 20, "10", "70");
    const cheap = candidate("0.00001", "0.00002", 70, 20, "1", "1");
    const f = await fixture(),
      r = request(f, { candidates: [expensive, cheap] });
    await admit(r);
    await dispatch(r, db, pricing(r, 1));
    await outcome(r, "0", usage(r, 1, 1, 0, 1));
    await settle(r);
    expect((await buckets(f)).rows.map((x) => x.settled_amount)).toEqual([
      "0",
      "0",
      "1",
    ]);
  });
  it.each(["profile", "tariff", "version", "tuple", "unknown-field"] as const)(
    "rejects forged selected %s before dispatch",
    async (change) => {
      const f = await fixture(),
        r = request(f);
      await admit(r);
      const p: Record<string, unknown> = pricing(r);
      if (change === "profile") p.profileRevision = 2;
      if (change === "tariff")
        p.prices = {
          ...r.quote.tokenQuote.candidates[0].prices,
          inputCentsPer1k: "0.2",
        };
      if (change === "version")
        p.actualChargePolicy = {
          formulaVersion: "unknown",
          cachingDiscount: "1",
        };
      if (change === "tuple") p.upstreamModelId = "forged";
      if (change === "unknown-field") p.version = 2;
      await expect(
        dispatch(r, db, p as ReturnType<typeof pricing>),
      ).rejects.toThrow(/SUPPLIER_DISPATCH_CONFLICT/);
      expect(
        (await buckets(f)).rows.every((x) => x.reserved_amount === "70"),
      ).toBe(true);
    },
  );
  it.each([
    "missing",
    "version",
    "profile",
    "attempt",
    "count",
    "fraction",
    "unsafe",
    "sum",
    "cap",
    "actual",
  ] as const)(
    "rejects invalid outcome %s and keeps funded unknown",
    async (change) => {
      const f = await fixture(),
        r = request(f);
      await admit(r);
      await dispatch(r);
      const u = usage(r);
      let actual = "30";
      if (change === "version") u.version = 2;
      if (change === "profile") u.profileRevision = 2;
      if (change === "attempt") u.attemptId = randomUUID();
      if (change === "count") u.usage.promptTokens = -1;
      if (change === "fraction") u.usage.promptTokens = 0.5;
      if (change === "unsafe") u.usage.promptTokens = 9007199254740992;
      if (change === "sum") u.usage.totalTokens = 1;
      if (change === "cap")
        Object.assign(u.usage, {
          promptTokens: 0,
          completionTokens: 21,
          totalTokens: 21,
        });
      if (change === "actual") actual = "71";
      await expect(
        outcome(r, actual, change === "missing" ? {} : u),
      ).rejects.toThrow();
      expect(
        (
          await query(
            "SELECT state FROM gateway_charge_admissions WHERE billing_request_id=$1",
            [r.id],
          )
        ).rows[0].state,
      ).toBe("dispatched");
      expect(
        (await buckets(f)).rows.every((x) => x.reserved_amount === "70"),
      ).toBe(true);
      await expect(cancel(r)).rejects.toThrow(/CANCELLATION_STATE_CONFLICT/);
    },
  );
  it.each(["NaN", "Infinity", "1e2", "-1", "01", "0.00000000001", "100000000"])(
    "rejects malformed/out-of-catalog supplier decimal %s",
    async (value) => {
      const f = await fixture(),
        r = request(f, { candidates: [candidate(value)] });
      await expect(admit(r)).rejects.toThrow();
      expect((await buckets(f)).rows).toHaveLength(0);
    },
  );
  it("rejects a second competing supplier tokenQuote and numeric money", async () => {
    const f = await fixture(),
      r = request(f);
    r.supplier = structuredClone(r.supplier);
    if ("tokenQuote" in r.supplier && r.supplier.tokenQuote)
      r.supplier.tokenQuote.candidates[0].prices.inputCentsPer1k = "0.2";
    await expect(admit(r)).rejects.toThrow(/INVALID_SUPPLIER_QUOTE/);
    const s = request(f);
    (
      s.quote.tokenQuote.candidates[0].prices as Record<string, unknown>
    ).inputCentsPer1k = 0.1;
    await expect(admit(s)).rejects.toThrow(/INVALID_QUOTA_NUMBER/);
  });
  async function byok(r: Request, c = db) {
    await dispatch(r, c, {
      version: 2,
      formulaVersion: "byok-fee-microcredits-v2",
      upstreamId: "own-provider",
      feeMicrocredits: r.max,
    } as unknown as ReturnType<typeof pricing>);
    await outcome(
      r,
      r.max,
      {
        version: 2,
        formulaVersion: "byok-fee-microcredits-v2",
        billingRequestId: r.id,
        attemptId: r.attempt,
        upstreamId: "own-provider",
        verified: true,
      },
      c,
    );
  }
  it.each(["9007199254740993", "9223372036854775807"])(
    "keeps BYOK %s exact, supplier zero and BIGINT accumulation bounded",
    async (max) => {
      const f = await fixture(null, "0", max);
      await query("UPDATE organizations SET payg_credits=$2 WHERE id=$1", [
        f.org,
        max,
      ]);
      const r = request(f, { max, mode: "byok_fee" });
      await admit(r);
      await byok(r);
      await settle(r);
      expect((await buckets(f)).rows.map((x) => x.settled_amount)).toEqual([
        max,
        max,
        "0",
      ]);
      await query("UPDATE organizations SET payg_credits=1000 WHERE id=$1", [
        f.org,
      ]);
      if (max === "9223372036854775807") await policy(f, { session: null });
      await expect(
        admit(request(f, { max: "1", mode: "byok_fee" })),
      ).rejects.toThrow(/QUOTA_EXCEEDED/);
      expect(
        (
          await query(
            "SELECT payg_credits::text FROM organizations WHERE id=$1",
            [f.org],
          )
        ).rows[0].payg_credits,
      ).toBe("1000");
    },
  );
  it.each([
    "daily-positive",
    "daily-negative",
    "daily-nan",
    "session-positive",
    "session-negative",
    "session-object",
    "monthly-negative",
    "monthly-nan",
  ] as const)("fails closed for unresolved legacy %s", async (kind) => {
    const f = await fixture(null, "100", "100");
    if (kind.startsWith("daily")) {
      const other = await secondKey(f);
      await query("UPDATE gateway_api_keys SET daily_usd_cap=$2 WHERE id=$1", [
        other.key,
        kind === "daily-positive"
          ? "1"
          : kind === "daily-negative"
            ? "-1"
            : "NaN",
      ]);
    } else if (kind.startsWith("monthly"))
      await query(
        "UPDATE gateway_api_keys SET cost_limit_monthly_rub=$2 WHERE id=$1",
        [f.key, kind === "monthly-negative" ? "-1" : "NaN"],
      );
    else
      await query("UPDATE gateway_api_keys SET policies=$2 WHERE id=$1", [
        f.key,
        JSON.stringify({
          per_session_budget_cap_rub:
            kind === "session-positive"
              ? 1
              : kind === "session-negative"
                ? -1
                : {},
        }),
      ]);
    await expect(admit(request(f))).rejects.toThrow(
      /QUOTA_POLICY_MIGRATION_REQUIRED|INVALID_LEGACY_QUOTA_POLICY|INVALID_QUOTA_NUMBER/,
    );
    expect((await buckets(f)).rows).toHaveLength(0);
  });
  it("preserves v1 replay and terminal recovery after enforcement2 but blocks fresh v1 and v1/v2 UUID reuse", async () => {
    const f = await fixture();
    await policy(f, { version: 1 });
    const r = request(f);
    await admit(r, db, true);
    await expect(admit(r)).rejects.toThrow(/ADMISSION_IDENTITY_CONFLICT/);
    await policy(f, { version: 2 });
    expect((await admit(r, db, true)).rows[0].did_transition).toBe(false);
    await expect(admit(request(f), db, true)).rejects.toThrow(
      /QUOTA_V2_REQUIRED/,
    );
    await dispatch(r);
    await outcome(r, "30", {}, db, true);
    await settle(r);
    expect((await buckets(f)).rows).toHaveLength(0);
  });
  it("computes UTC calendar bounds through real pure helper independent of session timezone", async () => {
    await query("SET TIME ZONE 'Pacific/Auckland'");
    try {
      for (const [at, unit, start, end] of [
        [
          "2026-12-31T23:59:59.999999Z",
          "day",
          "2026-12-31T00:00:00.000Z",
          "2027-01-01T00:00:00.000Z",
        ],
        [
          "2027-01-01T00:00:00Z",
          "month",
          "2027-01-01T00:00:00.000Z",
          "2027-02-01T00:00:00.000Z",
        ],
        [
          "2028-02-29T12:00:00Z",
          "month",
          "2028-02-01T00:00:00.000Z",
          "2028-03-01T00:00:00.000Z",
        ],
      ]) {
        const x = await query<{ period_start: Date; period_end: Date }>(
          "SELECT * FROM aiag_quota_period($1,$2)",
          [at, unit],
        );
        expect(x.rows[0].period_start.toISOString()).toBe(start);
        expect(x.rows[0].period_end.toISOString()).toBe(end);
      }
    } finally {
      await query("SET TIME ZONE 'UTC'");
    }
  });
  it("captures admitted_at after lock wait using clock time, identical to admission creation", async () => {
    const f = await fixture(),
      r = request(f);
    let lower: string | undefined;
    const result = await orderedRace(
      async (c) => {
        await query(
          "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
          [f.org],
          c,
        );
      },
      (c) => admit(r, c),
      async () => {
        lower = (
          await query<{ at: string }>("SELECT clock_timestamp()::text at")
        ).rows[0].at;
      },
    );
    expect(result.second.ok).toBe(true);
    const x = await query<{ same: boolean; after: boolean }>(
      "SELECT a.created_at=q.admitted_at same,q.admitted_at >= $2 after FROM gateway_charge_admissions a JOIN gateway_charge_quota_contexts q USING(billing_request_id) WHERE a.billing_request_id=$1",
      [r.id, lower],
    );
    expect(x.rows[0]).toEqual({ same: true, after: true });
  });
  it("settles original historical buckets, keeps old unknown and shares lifetime SID with new periods", async () => {
    const f = await fixture(),
      old = request(f),
      unknown = request(f);
    await admit(old);
    await dispatch(old);
    await admit(unknown);
    await dispatch(unknown);
    // Consistent historical fixture only; all financial and quota transitions use installed functions.
    await query(
      "UPDATE gateway_charge_quota_contexts SET admitted_at='2020-01-10T12:00Z' WHERE org_id=$1",
      [f.org],
    );
    await query(
      "UPDATE gateway_charge_admissions SET created_at='2020-01-10T12:00Z' WHERE org_id=$1",
      [f.org],
    );
    await query(
      "UPDATE gateway_quota_buckets SET period_start=CASE WHEN kind='org_day_supplier_v2' THEN '2020-01-10T00:00Z'::timestamptz ELSE '2020-01-01T00:00Z'::timestamptz END,period_end=CASE WHEN kind='org_day_supplier_v2' THEN '2020-01-11T00:00Z'::timestamptz ELSE '2020-02-01T00:00Z'::timestamptz END WHERE org_id=$1 AND kind<>'key_session_charged_v2'",
      [f.org],
    );
    old.deadline = "2020-01-10T12:01:00Z";
    unknown.deadline = old.deadline;
    await query(
      "UPDATE gateway_charge_admissions SET pre_dispatch_deadline_at=$2,dispatched_at='2020-01-10T12:00:01Z',reconcile_after='2020-01-10T12:15:01Z' WHERE org_id=$1",
      [f.org, old.deadline],
    );
    await query(
      "UPDATE gateway_charge_quota_reservations r SET policy_snapshot=r.policy_snapshot||jsonb_build_object('periodStart',b.period_start,'periodEnd',b.period_end) FROM gateway_quota_buckets b WHERE r.bucket_id=b.id AND b.org_id=$1",
      [f.org],
    );
    const fresh = request(f);
    await admit(fresh);
    await outcome(old);
    await settle(old);
    const rows = await query(
      "SELECT kind,reserved_amount::text,settled_amount::text,period_start FROM gateway_quota_buckets WHERE org_id=$1",
      [f.org],
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.filter((x) => x.settled_amount === "30")).toHaveLength(3);
    expect(
      rows.rows.find((x) => x.kind === "key_session_charged_v2")
        ?.reserved_amount,
    ).toBe("140");
    await expect(cancel(unknown)).rejects.toThrow();
    expect((await admit(old)).rows[0].did_transition).toBe(false);
  });
  async function snapshot(f: Fixture) {
    return (
      await query(
        "SELECT jsonb_build_object('org',(SELECT to_jsonb(o) FROM organizations o WHERE id=$1),'admissions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY billing_request_id),'[]') FROM gateway_charge_admissions a WHERE org_id=$1),'buckets',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM gateway_quota_buckets b WHERE org_id=$1),'contexts',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY billing_request_id),'[]') FROM gateway_charge_quota_contexts c WHERE org_id=$1),'reservations',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.billing_request_id,r.kind),'[]') FROM gateway_charge_quota_reservations r JOIN gateway_charge_admissions a USING(billing_request_id) WHERE a.org_id=$1),'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.billing_request_id,e.kind,e.event_kind),'[]') FROM gateway_charge_quota_events e JOIN gateway_charge_admissions a USING(billing_request_id) WHERE a.org_id=$1),'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM gateway_transactions t WHERE org_id=$1),'fundingAudit',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]') FROM gateway_charge_admission_events e WHERE org_id=$1)) result",
        [f.org],
      )
    ).rows[0].result;
  }
  it.each(["admit-event", "settle-counter", "cancel-event"] as const)(
    "rolls every projection back after injected %s fault",
    async (kind) => {
      const f = await fixture(),
        r = request(f);
      if (kind !== "admit-event") {
        await admit(r);
        if (kind === "settle-counter") {
          await dispatch(r);
          await outcome(r);
        }
      }
      const before = await snapshot(f);
      const target =
        kind === "settle-counter"
          ? "gateway_quota_buckets"
          : "gateway_charge_quota_events";
      await query(
        "CREATE OR REPLACE FUNCTION pg_temp.quota_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'quota injected fault'; END $$",
      );
      await query(
        `CREATE TRIGGER quota_fault BEFORE ${kind === "settle-counter" ? "UPDATE" : "INSERT"} ON ${target} FOR EACH ROW EXECUTE FUNCTION pg_temp.quota_fault()`,
      );
      try {
        await expect(
          kind === "admit-event"
            ? admit(r)
            : kind === "settle-counter"
              ? settle(r)
              : cancel(r),
        ).rejects.toThrow(/quota injected fault/);
        expect(await snapshot(f)).toEqual(before);
      } finally {
        await query(`DROP TRIGGER quota_fault ON ${target}`);
      }
      await (kind === "admit-event"
        ? admit(r)
        : kind === "settle-counter"
          ? settle(r)
          : cancel(r));
    },
  );
  it.each(["admit", "outcome", "settle"] as const)(
    "disconnects before COMMIT of real %s with no durable partial effect",
    async (stage) => {
      const f = await fixture(),
        r = request(f);
      if (stage !== "admit") {
        await admit(r);
        await dispatch(r);
      }
      if (stage === "settle") await outcome(r);
      const before = await snapshot(f),
        c = await open();
      await query("BEGIN", [], c.db);
      await (stage === "admit"
        ? admit(r, c.db)
        : stage === "outcome"
          ? outcome(r, "30", usage(r), c.db)
          : settle(r, c.db));
      await c.close();
      // A new connection waits for rollback completion by locking the same org.
      const observer = await open();
      try {
        await query(
          "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
          [f.org],
          observer.db,
        );
        expect(await snapshot(f)).toEqual(before);
      } finally {
        await observer.close();
      }
    },
  );
  it("discards committed acknowledgements and recovers held/dispatched/outcome/settled with fresh connections", async () => {
    const f = await fixture(),
      r = request(f);
    let c = await open();
    await admit(r, c.db);
    await c.close();
    c = await open();
    expect((await admit(r, c.db)).rows[0].did_transition).toBe(false);
    await dispatch(r, c.db);
    await c.close();
    c = await open();
    await expect(cancel(r, c.db)).rejects.toThrow();
    await outcome(r, "30", usage(r), c.db);
    await c.close();
    c = await open();
    expect(
      (await outcome(r, "30", usage(r), c.db)).rows[0].did_transition,
    ).toBe(false);
    await settle(r, c.db);
    await c.close();
    c = await open();
    expect((await settle(r, c.db)).rows[0].did_transition).toBe(false);
    await c.close();
    expect(
      (
        await query(
          "SELECT count(*)::text n FROM gateway_charge_quota_events WHERE billing_request_id=$1",
          [r.id],
        )
      ).rows[0].n,
    ).toBe("6");
  });
  async function refundable(f: Fixture) {
    const p = {
      paymentId: randomUUID(),
      providerPaymentId: `provider-${randomUUID()}`,
      providerOrderId: `order-${randomUUID()}`,
    };
    await query(
      "INSERT INTO payments(id,user_id,amount,status,tinkoff_payment_id,tinkoff_order_id,metadata,topup_org_id,topup_paid_kopecks,topup_grant_credits) VALUES($1,$2,'0.01','confirmed',$3,$4,$5,$6,1,100)",
      [
        p.paymentId,
        f.user,
        p.providerPaymentId,
        p.providerOrderId,
        JSON.stringify({ kind: "topup", provider: "tinkoff" }),
        f.org,
      ],
    );
    return p;
  }
  async function refund(p: Awaited<ReturnType<typeof refundable>>) {
    const refunds =
      await import("../../../../apps/web/src/lib/payments/topup-refund");
    const claim = await refunds.claimTopupRefund(p.paymentId, 1, {
      paymentId: p.providerPaymentId,
      orderId: p.providerOrderId,
      route: "ACQ",
      source: "cards",
      receiptMode: "trusted_no_receipt_required",
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("refund fixture failed");
    expect(
      (await refunds.markTopupRefundDispatched(claim.claim.claimId)).kind,
    ).toBe("marked");
    const result = await refunds.finalizeTopupRefundProof(claim.claim.claimId, {
      paymentId: p.providerPaymentId,
      orderId: p.providerOrderId,
      externalRequestId: claim.claim.providerKey,
      status: "REFUNDED",
      originalAmountKopecks: 1,
      newAmountKopecks: 0,
    });
    expect(result.kind).toBe("settled");
  }
  it.each([
    "before-settle",
    "after-settle",
    "before-cancel",
    "after-cancel",
  ] as const)("keeps refund debt and quota equalities %s", async (order) => {
    const f = await fixture();
    await query("UPDATE organizations SET payg_credits=100 WHERE id=$1", [
      f.org,
    ]);
    const p = await refundable(f),
      r = request(f);
    await admit(r);
    if (order.includes("settle")) {
      await dispatch(r);
      await outcome(r);
    }
    if (order.startsWith("before")) await refund(p);
    await (order.includes("settle") ? settle(r) : cancel(r));
    if (order.startsWith("after")) await refund(p);
    const o = await query(
      "SELECT payg_credits::text,refund_debt_credits::text FROM organizations WHERE id=$1",
      [f.org],
    );
    expect(o.rows[0]).toEqual({
      payg_credits: "0",
      refund_debt_credits: order.includes("settle") ? "30" : "0",
    });
    expect(
      (await buckets(f)).rows.map((x) => [x.reserved_amount, x.settled_amount]),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        "0",
        order.includes("settle") ? "30" : "0",
      ]),
    );
  });
  it("rolls funding/debt and quota settlement back when final quota audit fails after refund", async () => {
    const f = await fixture();
    await query("UPDATE organizations SET payg_credits=100 WHERE id=$1", [
      f.org,
    ]);
    const p = await refundable(f),
      r = request(f);
    await admit(r);
    await dispatch(r);
    await outcome(r);
    await refund(p);
    const before = await snapshot(f);
    await query(
      "CREATE OR REPLACE FUNCTION pg_temp.quota_refund_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'quota refund injected fault'; END $$",
    );
    await query(
      "CREATE TRIGGER quota_refund_fault BEFORE INSERT ON gateway_charge_quota_events FOR EACH ROW EXECUTE FUNCTION pg_temp.quota_refund_fault()",
    );
    try {
      await expect(settle(r)).rejects.toThrow(/quota refund injected fault/);
      expect(await snapshot(f)).toEqual(before);
    } finally {
      await query(
        "DROP TRIGGER quota_refund_fault ON gateway_charge_quota_events",
      );
    }
    await settle(r);
  });
  it("rejects null terminal amount at the reservation constraint and preserves its hold", async () => {
    const f = await fixture(),
      r = request(f);
    await admit(r);
    await expect(
      query(
        "UPDATE gateway_charge_quota_reservations SET state='released',actual_amount=NULL,terminal_at=clock_timestamp() WHERE billing_request_id=$1",
        [r.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await buckets(f)).rows.map((x) => x.reserved_amount)).toEqual([
      "70",
      "70",
      "70",
    ]);
  });
  it("replays cancel and outcome without extra counters and rejects changed outcome evidence", async () => {
    const f = await fixture(),
      r = request(f);
    await admit(r);
    await cancel(r);
    const cancelled = await snapshot(f);
    expect((await cancel(r)).rows[0].did_transition).toBe(false);
    expect(await snapshot(f)).toEqual(cancelled);
    const s = request(f);
    await admit(s);
    await dispatch(s);
    await outcome(s);
    const recorded = await snapshot(f);
    expect((await outcome(s)).rows[0].did_transition).toBe(false);
    expect(await snapshot(f)).toEqual(recorded);
    await expect(
      outcome(s, "30", { ...usage(s), completionId: "cmpl-other" }),
    ).rejects.toThrow(/OUTCOME_IDENTITY_CONFLICT/);
    await expect(outcome(s, "31", usage(s, 31))).rejects.toThrow(
      /OUTCOME_IDENTITY_CONFLICT/,
    );
    expect(await snapshot(f)).toEqual(recorded);
  });
  it("rejects v2 without explicit enrollment and rejects expired fresh admission without buckets", async () => {
    const f = await fixture();
    await policy(f, { version: 1 });
    await expect(admit(request(f))).rejects.toThrow(/QUOTA_V2_NOT_ENABLED/);
    await policy(f, { version: 2 });
    const r = request(f);
    r.deadline = "2020-01-01T00:00:00Z";
    await expect(admit(r)).rejects.toThrow(/ADMISSION_DEADLINE_EXPIRED/);
    expect((await buckets(f)).rows).toHaveLength(0);
  });
  it("rejects a stored non-chat route even with an otherwise valid token quote", async () => {
    const f = await fixture(),
      r = request(f);
    await expect(
      query(
        "SELECT * FROM aiag_admit_gateway_charge_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          f.org,
          r.id,
          f.key,
          r.trace,
          "media",
          r.mode,
          "openai/gpt-4o-mini",
          r.max,
          JSON.stringify(r.quote),
          r.deadline,
          r.sid,
          JSON.stringify(r.supplier),
        ],
      ),
    ).rejects.toThrow(/INVALID_SUPPLIER_QUOTE/);
    expect((await buckets(f)).rows).toHaveLength(0);
  });
});
