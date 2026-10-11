import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";
import { readAgentPolicy, updateAgentPolicy } from "../../src/agent-policy";
import type {
  TonPaymentDatabase,
  TonSqlClient,
} from "../../src/ton-payment-types";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

const AGENT_OWNER_ID = "00000000-0000-0000-0000-0000000000a1";
const ADDRESS_RAW = `0:${"a5".repeat(32)}`;
/** Unique per fixture: agent_principals has a partial unique on active (network,address). */
let walletSequence = 0;
function nextWalletAddress(): string {
  walletSequence += 1;
  return (
    "B".repeat(44) + walletSequence.toString(36).padStart(4, "0")
  ).slice(0, 48);
}

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

/**
 * Migration 0108 proof set: agent quota self-service writers.
 *
 * The route layer (agent-policy seam + route) is unit-tested elsewhere; this
 * file proves the SQL contract against the real schema:
 *  - set -> set (revision bump) -> NULL (clear: policy row DELETEd, monthly
 *    column NULLed) with SELECT asserts after every step;
 *  - legacy scrub: a key carrying daily_usd_cap and a positive
 *    per_session_budget_cap_rub leaves the writer clean — exactly the fields
 *    0068:421-438 checks before raising QUOTA_POLICY_MIGRATION_REQUIRED;
 *  - 0 == clear (the 0068 NULLIF semantics);
 *  - the org writer enrolls into enforcement_version=2 on first insert,
 *    bumps revision on update and keeps enforcement when the limit clears;
 *  - authorization: dead/foreign keys and non-agent orgs are
 *    AGENT_NOT_AUTHORIZED, indistinguishable.
 *
 * Guarded canonical test database, every test wrapped in BEGIN/ROLLBACK.
 */
describe.skipIf(!RUN_INTEGRATION)("agent quota writers (0108)", () => {
  let client: TestDatabaseClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guardedClient) => {
        client = guardedClient;

        const applied = await client.query<{ version: string }>({
          text: "SELECT version FROM public.schema_migrations WHERE version = $1",
          values: ["migrations/0108_agent_quota_writers.sql"],
        });
        expect(applied.rows).toHaveLength(1);

        const originalEnd = guardedClient.end.bind(guardedClient);
        guardedClient.end = async () => undefined;
        close = async () => {
          await originalEnd();
        };
      },
    );
  });

  afterAll(async () => {
    await close?.();
  });

  /** Agent org: owned by the 0104 service user, one active principal, one key. */
  async function insertAgentOrg(patch: {
    principalStatus?: "active" | "revoked";
    keyPatch?: {
      revoked?: boolean;
      disabled?: boolean;
      expired?: boolean;
      dailyUsdCap?: string;
      sessionCapRub?: number;
    };
  } = {}): Promise<{ orgId: string; keyId: string }> {
    const orgId = randomUUID();
    const keyId = randomUUID();
    await client.query({
      text: `
        INSERT INTO public.organizations (
          id, slug, name, owner_id, subscription_credits, payg_credits
        ) VALUES ($1::uuid, $2, $3, $4::uuid, 0, 0)
      `,
      values: [
        orgId,
        `agent-policy-${orgId}`,
        "agent policy fixture",
        AGENT_OWNER_ID,
      ],
    });
    await client.query({
      text: `
        INSERT INTO public.agent_principals (org_id, network, address, address_raw)
        VALUES ($1::uuid, '-3', $2, $3)
      `,
      values: [orgId, nextWalletAddress(), ADDRESS_RAW],
    });
    if (patch.principalStatus === "revoked") {
      await client.query({
        text: `
          UPDATE public.agent_principals
          SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE org_id = $1::uuid
        `,
        values: [orgId],
      });
    }
    const key = patch.keyPatch ?? {};
    const policies =
      key.sessionCapRub === undefined
        ? JSON.stringify({ kind: "agent" })
        : JSON.stringify({
            kind: "agent",
            per_session_budget_cap_rub: key.sessionCapRub,
          });
    await client.query({
      text: `
        INSERT INTO public.gateway_api_keys (
          id, org_id, name, key_hash, key_prefix, policies, daily_usd_cap, created_at, expires_at
        ) VALUES (
          $1::uuid, $2::uuid, 'agent-policy-test', $3, $4, $5::jsonb,
          $6::numeric,
          clock_timestamp() - interval '2 seconds',
          CASE WHEN $7 THEN clock_timestamp() - interval '1 second' ELSE NULL END
        )
      `,
      values: [
        keyId,
        orgId,
        createHash("sha256").update(keyId).digest("hex"),
        `pk-${keyId.slice(0, 12)}`,
        policies,
        key.dailyUsdCap ?? null,
        key.expired === true,
      ],
    });
    if (key.revoked) {
      await client.query({
        text: "UPDATE public.gateway_api_keys SET revoked_at = clock_timestamp() WHERE id = $1::uuid",
        values: [keyId],
      });
    }
    if (key.disabled) {
      await client.query({
        text: "UPDATE public.gateway_api_keys SET disabled_at = clock_timestamp() WHERE id = $1::uuid",
        values: [keyId],
      });
    }
    return { orgId, keyId };
  }

  async function setKeyQuota(
    keyId: string,
    sessionMicro: string | null,
    monthlyCredits: string | null,
  ): Promise<Record<string, unknown>> {
    const result = await client.query<{ result: Record<string, unknown> }>({
      text: "SELECT public.aiag_set_agent_key_quota_v1($1::uuid,$2::bigint,$3::bigint) AS result",
      values: [keyId, sessionMicro, monthlyCredits],
    });
    return result.rows[0]!.result;
  }

  async function setOrgQuota(
    orgId: string,
    dailyMicro: string | null,
  ): Promise<Record<string, unknown>> {
    const result = await client.query<{ result: Record<string, unknown> }>({
      text: "SELECT public.aiag_set_agent_org_quota_v1($1::uuid,$2::bigint) AS result",
      values: [orgId, dailyMicro],
    });
    return result.rows[0]!.result;
  }

  interface KeyState {
    session_micro: string | null;
    session_revision: string | null;
    monthly_credits: string | null;
    daily_usd_cap: string | null;
    policies: Record<string, unknown>;
  }

  async function readKeyState(keyId: string): Promise<KeyState> {
    const result = await client.query<{
      session_micro: string | null;
      session_revision: string | null;
      monthly_credits: string | null;
      daily_usd_cap: string | null;
      policies: Record<string, unknown>;
    }>({
      text: `
        SELECT q.session_microcredits_limit_v2::text AS session_micro,
               q.revision::text AS session_revision,
               -- NUMERIC(10,2) renders "15000.00" as text; quota credits are
               -- integers, so cast through bigint for the canonical form.
               k.cost_limit_monthly_rub::bigint::text AS monthly_credits,
               k.daily_usd_cap::text AS daily_usd_cap,
               k.policies
        FROM public.gateway_api_keys k
        LEFT JOIN public.gateway_quota_key_policies q ON q.api_key_id = k.id
        WHERE k.id = $1::uuid
      `,
      values: [keyId],
    });
    return result.rows[0]!;
  }

  async function readOrgState(orgId: string): Promise<{
    daily_micro: string | null;
    enforcement: number | null;
    revision: string | null;
  }> {
    const result = await client.query<{
      daily_micro: string | null;
      enforcement: number | null;
      revision: string | null;
    }>({
      text: `
        SELECT daily_supplier_usd_micro_limit_v2::text AS daily_micro,
               enforcement_version AS enforcement,
               revision::text AS revision
        FROM public.gateway_quota_org_policies
        WHERE org_id = $1::uuid
      `,
      values: [orgId],
    });
    return (
      result.rows[0] ?? { daily_micro: null, enforcement: null, revision: null }
    );
  }

  async function auditCount(resourceId: string): Promise<number> {
    const result = await client.query<{ n: string }>({
      text: `
        SELECT count(*)::text AS n
        FROM public.audit_log
        WHERE action = 'agent.policy' AND resource_id = $1
      `,
      values: [resourceId],
    });
    return Number(result.rows[0]!.n);
  }

  /** Each rejection check runs in its own transaction so nothing leaks out. */
  async function expectAgentError(
    query: () => Promise<unknown>,
    message: string,
  ) {
    await client.query({ text: "BEGIN", values: [] });
    await expect(query()).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining(message),
    });
    await client.query({ text: "ROLLBACK", values: [] });
  }

  it("key quota: set -> set (revision bump) -> NULL clear, all visible in SELECTs", async () => {
    const { keyId } = await insertAgentOrg();

    // set
    let result = await setKeyQuota(keyId, "1500", "15000");
    expect(result.sessionMicrocreditsLimit).toBe("1500");
    expect(result.monthlyCreditsLimit).toBe("15000");
    let state = await readKeyState(keyId);
    expect(state.session_micro).toBe("1500");
    expect(state.session_revision).toBe("1");
    expect(state.monthly_credits).toBe("15000");

    // set again: revision bumps, values replace
    result = await setKeyQuota(keyId, "2500", "16000");
    expect(result.sessionMicrocreditsLimit).toBe("2500");
    state = await readKeyState(keyId);
    expect(state.session_micro).toBe("2500");
    expect(state.session_revision).toBe("2");
    expect(state.monthly_credits).toBe("16000");

    // clear: NULL removes the policy row and NULLs the monthly column
    result = await setKeyQuota(keyId, null, null);
    expect(result.sessionMicrocreditsLimit).toBeNull();
    expect(result.monthlyCreditsLimit).toBeNull();
    state = await readKeyState(keyId);
    expect(state.session_micro).toBeNull();
    expect(state.session_revision).toBeNull(); // row DELETEd, not zeroed
    expect(state.monthly_credits).toBeNull();
  });

  it("key quota: 0 clears like NULL (0068 NULLIF semantics)", async () => {
    const { keyId } = await insertAgentOrg();

    await setKeyQuota(keyId, "1500", "15000");
    const result = await setKeyQuota(keyId, "0", "0");
    expect(result.sessionMicrocreditsLimit).toBeNull();
    expect(result.monthlyCreditsLimit).toBeNull();
    const state = await readKeyState(keyId);
    expect(state.session_micro).toBeNull();
    expect(state.monthly_credits).toBeNull();
  });

  it("key quota: legacy fields are scrubbed so v2 admission will not raise QUOTA_POLICY_MIGRATION_REQUIRED", async () => {
    const { keyId } = await insertAgentOrg({
      keyPatch: { dailyUsdCap: "20.00", sessionCapRub: 5 },
    });

    // Precondition: the legacy fields the 0068 checks read are really set.
    let state = await readKeyState(keyId);
    expect(state.daily_usd_cap).toBe("20.00");
    expect(state.policies.per_session_budget_cap_rub).toBe(5);

    await setKeyQuota(keyId, "1500", null);

    state = await readKeyState(keyId);
    expect(state.daily_usd_cap).toBeNull();
    // 0068:434-437 accepts null, 0 and "0.0"-style; >0 is what it rejects.
    expect(state.policies.per_session_budget_cap_rub).toBe(0);
    // The scrub rewrote ONLY the legacy key: rail flags survive.
    expect(state.policies.kind).toBe("agent");
  });

  it("key quota: a clean key does not grow a per_session_budget_cap_rub entry", async () => {
    const { keyId } = await insertAgentOrg();

    await setKeyQuota(keyId, "1500", "1000");

    const state = await readKeyState(keyId);
    expect(state.policies).toEqual({ kind: "agent" });
  });

  it("key quota: bounds are enforced before any write", async () => {
    const { keyId } = await insertAgentOrg();

    await expectAgentError(() => setKeyQuota(keyId, "-1", null), "AGENT_QUOTA_OUT_OF_RANGE");
    await expectAgentError(() => setKeyQuota(keyId, null, "100000000"), "AGENT_QUOTA_OUT_OF_RANGE");
    // Nothing was written by the rejected calls.
    const state = await readKeyState(keyId);
    expect(state.session_micro).toBeNull();
    expect(state.monthly_credits).toBeNull();
  });

  it("key quota: only a LIVE key of an agent org authorizes (revoked/disabled/expired/no-principal/foreign)", async () => {
    const revoked = await insertAgentOrg({ keyPatch: { revoked: true } });
    await expectAgentError(() => setKeyQuota(revoked.keyId, "1500", null), "AGENT_NOT_AUTHORIZED");

    const disabled = await insertAgentOrg({ keyPatch: { disabled: true } });
    await expectAgentError(() => setKeyQuota(disabled.keyId, "1500", null), "AGENT_NOT_AUTHORIZED");

    const expired = await insertAgentOrg({ keyPatch: { expired: true } });
    await expectAgentError(() => setKeyQuota(expired.keyId, "1500", null), "AGENT_NOT_AUTHORIZED");

    const noPrincipal = await insertAgentOrg({ principalStatus: "revoked" });
    await expectAgentError(() => setKeyQuota(noPrincipal.keyId, "1500", null), "AGENT_NOT_AUTHORIZED");

    await expectAgentError(() => setKeyQuota(randomUUID(), "1500", null), "AGENT_NOT_AUTHORIZED");
    await expectAgentError(() => setKeyQuota(null, "1500", null), "AGENT_NOT_AUTHORIZED");
  });

  it("org quota: insert enforces v2, update bumps revision, NULL clears but keeps enforcement", async () => {
    const { orgId } = await insertAgentOrg();

    // No row initially.
    expect((await readOrgState(orgId)).enforcement).toBeNull();

    let result = await setOrgQuota(orgId, "25000");
    expect(result.dailySupplierUsdMicroLimit).toBe("25000");
    expect(result.enforcementVersion).toBe("2");
    let state = await readOrgState(orgId);
    expect(state.daily_micro).toBe("25000");
    expect(state.enforcement).toBe(2);
    expect(state.revision).toBe("1");

    result = await setOrgQuota(orgId, "30000");
    state = await readOrgState(orgId);
    expect(state.daily_micro).toBe("30000");
    expect(state.revision).toBe("2");

    result = await setOrgQuota(orgId, null);
    expect(result.dailySupplierUsdMicroLimit).toBeNull();
    expect(result.enforcementVersion).toBe("2");
    state = await readOrgState(orgId);
    expect(state.daily_micro).toBeNull();
    expect(state.enforcement).toBe(2); // un-enrolling is deliberately not a thing
    expect(state.revision).toBe("3");

    // NULL on a never-enrolled org is a clean no-op (no row appears).
    const { orgId: freshOrg } = await insertAgentOrg();
    await setOrgQuota(freshOrg, null);
    expect((await readOrgState(freshOrg)).enforcement).toBeNull();
  });

  it("org quota: 0 clears, bounds enforced, non-agent org refused", async () => {
    const { orgId } = await insertAgentOrg();

    await setOrgQuota(orgId, "25000");
    const result = await setOrgQuota(orgId, "0");
    expect(result.dailySupplierUsdMicroLimit).toBeNull();

    await expectAgentError(() => setOrgQuota(orgId, "-5"), "AGENT_QUOTA_OUT_OF_RANGE");
    await expectAgentError(() => setOrgQuota(randomUUID(), "100"), "AGENT_NOT_AUTHORIZED");
    await expectAgentError(() => setOrgQuota(null, "100"), "AGENT_NOT_AUTHORIZED");
  });

  it("both writers audit under agent.policy", async () => {
    const { orgId, keyId } = await insertAgentOrg();

    expect(await auditCount(keyId)).toBe(0);
    await setKeyQuota(keyId, "1500", null);
    expect(await auditCount(keyId)).toBe(1);
    await setKeyQuota(keyId, null, null);
    expect(await auditCount(keyId)).toBe(2);

    expect(await auditCount(orgId)).toBe(0);
    await setOrgQuota(orgId, "25000");
    expect(await auditCount(orgId)).toBe(1);
  });

  // ── Review round 1: the SEAM against real NUMERIC(10,2) rendering ────────
  // cost_limit_monthly_rub::text renders integral 15000 as "15000.00"; the
  // seam must canonicalize, not reject — otherwise the first monthly write
  // self-locks the endpoint (rowToState runs at the top of every GET and PUT).
  // This scenario drives the whole sequence through readAgentPolicy /
  // updateAgentPolicy, NOT through a raw-SQL projection.
  it("seam round-trip: PUT monthly -> GET canonical -> routing-only PUT -> PUT null (no self-lock)", async () => {
    const { orgId, keyId } = await insertAgentOrg();

    /** Single-level transaction adapter of the seam over the native client. */
    const seamDb: TonPaymentDatabase = {
      transaction: async <T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> => {
        await client.query({ text: "BEGIN", values: [] });
        try {
          const tx: TonSqlClient = {
            query: async <
              Row extends Record<string, unknown> = Record<string, unknown>,
            >(config: { text: string; values: readonly unknown[] }) =>
              client.query<Row>({ text: config.text, values: [...config.values] }),
          };
          const result = await run(tx);
          await client.query({ text: "COMMIT", values: [] });
          return result;
        } catch (error) {
          await client.query({ text: "ROLLBACK", values: [] });
          throw error;
        }
      },
    };

    // PUT monthly=15000 credits (integer credits; stored into NUMERIC(10,2)).
    const written = await updateAgentPolicy(seamDb, {
      keyId,
      patch: { monthly_credits_limit: "15000" },
    });
    expect(written.quotas.monthlyCredits).toBe("15000");

    // GET: the column renders "15000.00" — the seam must answer "15000".
    const read1 = await readAgentPolicy(seamDb, { keyId });
    expect(read1.quotas.monthlyCredits).toBe("15000");
    expect(read1.orgId).toBe(orgId);

    // Routing-only PUT re-reads the row first: pre-fix this is the 503.
    const routing = await updateAgentPolicy(seamDb, {
      keyId,
      patch: { default_mode: "ru-only" },
    });
    expect(routing.quotas.monthlyCredits).toBe("15000");
    expect(routing.policies.default_mode).toBe("ru-only");

    // Session-only PUT resolves the untouched monthly from the same row into
    // the ::bigint writer parameter — "15000.00" would be rejected by PG.
    const session = await updateAgentPolicy(seamDb, {
      keyId,
      patch: { session_micro_limit: "1500" },
    });
    expect(session.quotas.sessionMicrocredits).toBe("1500");
    expect(session.quotas.monthlyCredits).toBe("15000");

    // PUT null clears the monthly cap; a final GET confirms the full cycle.
    const cleared = await updateAgentPolicy(seamDb, {
      keyId,
      patch: { monthly_credits_limit: null },
    });
    expect(cleared.quotas.monthlyCredits).toBeNull();
    const read2 = await readAgentPolicy(seamDb, { keyId });
    expect(read2.quotas.monthlyCredits).toBeNull();
    expect(read2.quotas.sessionMicrocredits).toBe("1500");
  });

  it("seam read of a legacy fractional cap truncates toward zero, never overstating", async () => {
    const { keyId } = await insertAgentOrg();
    // Dashboard-era shape: 0061 ROUND(...,2) can leave fractional credits.
    await client.query({
      text: "UPDATE public.gateway_api_keys SET cost_limit_monthly_rub = 15000.50 WHERE id = $1::uuid",
      values: [keyId],
    });

    const seamDb: TonPaymentDatabase = {
      transaction: async <T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> => run({
        query: async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(config: { text: string; values: readonly unknown[] }) =>
          client.query<Row>({ text: config.text, values: [...config.values] }),
      }),
    };

    const state = await readAgentPolicy(seamDb, { keyId });
    expect(state.quotas.monthlyCredits).toBe("15000");
  });
});
