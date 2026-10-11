import { describe, expect, it } from "vitest";

import {
  mergeKeyPolicies,
  readAgentPolicy,
  updateAgentPolicy,
  type AgentPolicyPatch,
} from "../agent-policy";
import type { TonPaymentDatabase, TonSqlClient } from "../ton-payment-types";

const KEY_ID = "55555555-5555-4555-8555-5555555555aa";
const ORG_ID = "41000000-0000-4000-8000-0000000000a1";

/**
 * Scripted SQL boundary. Each entry is the next statement's outcome: an
 * array (rows, rowCount = rows.length), an explicit {rows, rowCount} (UPDATEs
 * report rowCount without rows), or an Error to throw.
 */
function recordingDatabase(script: (unknown[] | { rows: unknown[]; rowCount: number } | Error)[] = []) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const tx: TonSqlClient = {
    query: async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(config: { text: string; values: readonly unknown[] }) => {
      calls.push(config);
      const next = script.shift();
      if (next instanceof Error) throw next;
      if (Array.isArray(next)) {
        const rows = next as Row[];
        return { rows, rowCount: rows.length };
      }
      const outcome = next ?? { rows: [], rowCount: 0 };
      return {
        rows: outcome.rows as Row[],
        rowCount: outcome.rowCount,
      };
    },
  };
  return {
    db: {
      transaction: <T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> => run(tx),
    } satisfies TonPaymentDatabase,
    calls,
  };
}

function policyRow(patch: Record<string, unknown> = {}) {
  return {
    org_id: ORG_ID,
    policies: { kind: "agent", s2s_key_minting: true },
    model_whitelist: ["gpt-x"],
    monthly_credits: "15000",
    session_micro: null,
    daily_org_usd_micro: null,
    ...patch,
  };
}

function expectAgentPolicyError(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ name: "AgentPolicyError", code });
}

describe("mergeKeyPolicies", () => {
  it("sets, removes and preserves unknown rail flags", () => {
    const current = { kind: "agent", s2s_key_minting: true, default_mode: "auto" };
    const merged = mergeKeyPolicies(current, {
      default_mode: null,
      allowed_providers: ["openai"],
      forbid_non_ru: true,
    });
    expect(merged).toEqual({
      kind: "agent",
      s2s_key_minting: true,
      allowed_providers: ["openai"],
      forbid_non_ru: true,
    });
    // The source object is not mutated (the merge works on a copy).
    expect(current.default_mode).toBe("auto");
  });

  it("leaves everything untouched for an empty patch", () => {
    const current = { kind: "agent", default_mode: "ru-only" };
    expect(mergeKeyPolicies(current, {} as AgentPolicyPatch)).toEqual(current);
  });
});

describe("readAgentPolicy", () => {
  it("projects the row into state with string quotas", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow({ session_micro: "1500", daily_org_usd_micro: "25000" })],
    ]);

    const state = await readAgentPolicy(db, { keyId: KEY_ID });

    expect(state.orgId).toBe(ORG_ID);
    expect(state.policies).toEqual({ kind: "agent", s2s_key_minting: true });
    expect(state.modelWhitelist).toEqual(["gpt-x"]);
    expect(state.quotas).toEqual({
      sessionMicrocredits: "1500",
      monthlyCredits: "15000",
      dailyOrgUsdMicro: "25000",
    });
    // Prepared read with the live-key + active-principal predicate.
    expect(calls[0]!.values).toEqual([KEY_ID]);
    expect(calls[0]!.text).not.toContain("FOR UPDATE OF k"); // GET must not lock
    expect(calls[0]!.text).toContain("agent_principals");
    expect(calls[0]!.text).toContain("revoked_at IS NULL");
  });

  it("fails AGENT_NOT_AUTHORIZED when no live agent row matches", async () => {
    const { db } = recordingDatabase([[]]);
    await expectAgentPolicyError(readAgentPolicy(db, { keyId: KEY_ID }), "AGENT_NOT_AUTHORIZED");
  });

  // ── Real NUMERIC(10,2) rendering (review round 1) ─────────────────────────
  // ::text renders integral 15000 as "15000.00"; the seam must canonicalize,
  // not reject — otherwise the endpoint self-locks after the first monthly
  // write (every GET and every PUT re-reads the row first).
  it("canonicalizes the NUMERIC(10,2) render of cost_limit_monthly_rub (\"15000.00\" -> \"15000\")", async () => {
    const { db } = recordingDatabase([
      [policyRow({ monthly_credits: "15000.00" })],
    ]);
    const state = await readAgentPolicy(db, { keyId: KEY_ID });
    expect(state.quotas.monthlyCredits).toBe("15000");
  });

  it("truncates a legacy fractional cap toward zero (\"0.50\" -> \"0\"), never overstating it", async () => {
    const { db } = recordingDatabase([[policyRow({ monthly_credits: "0.50" })]]);
    const state = await readAgentPolicy(db, { keyId: KEY_ID });
    expect(state.quotas.monthlyCredits).toBe("0");
  });

  it("still rejects garbage in the monthly column (3 decimals / negative / non-numeric)", async () => {
    for (const garbage of ["15000.000", "-1", "1e4", "15,000"]) {
      const { db } = recordingDatabase([[policyRow({ monthly_credits: garbage })]]);
      await expectAgentPolicyError(readAgentPolicy(db, { keyId: KEY_ID }), "AGENT_POLICY_UNAVAILABLE");
    }
  });

  it("fails AGENT_POLICY_UNAVAILABLE on a malformed policies column", async () => {
    const { db } = recordingDatabase([[policyRow({ policies: "nope" })]]);
    await expectAgentPolicyError(readAgentPolicy(db, { keyId: KEY_ID }), "AGENT_POLICY_UNAVAILABLE");
  });

  it("rejects a malformed key id before any SQL", async () => {
    const { db, calls } = recordingDatabase();
    await expectAgentPolicyError(readAgentPolicy(db, { keyId: "not-a-uuid" }), "AGENT_POLICY_INVALID");
    expect(calls).toHaveLength(0);
  });
});

describe("updateAgentPolicy — routing only", () => {
  it("merges onto policies, rewrites the whitelist, audits; quota writers untouched", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow()], // locked read
      { rows: [], rowCount: 1 }, // guarded UPDATE
      [], // usage_events audit INSERT
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { default_mode: "ru-only", model_whitelist: [" gpt-y ", "gpt-y"] },
    });

    // Unknown rail flags survived the merge; the whitelist was trimmed+deduped.
    expect(state.policies).toEqual({ kind: "agent", s2s_key_minting: true, default_mode: "ru-only" });
    expect(state.modelWhitelist).toEqual(["gpt-y"]);
    expect(state.quotas.monthlyCredits).toBe("15000");

    const read = calls[0]!;
    expect(read.text).toContain("FOR UPDATE OF k");
    const update = calls[1]!;
    expect(update.text).toContain("UPDATE public.gateway_api_keys");
    expect(update.text).toContain("SET policies=$3::jsonb, model_whitelist=$4::jsonb");
    // Guarded by the locked row's own org and liveness — never a body value.
    expect(update.text).toContain("WHERE id=$1::uuid AND org_id=$2::uuid AND revoked_at IS NULL AND disabled_at IS NULL");
    expect(update.values[0]).toBe(KEY_ID);
    expect(update.values[1]).toBe(ORG_ID);
    const audit = calls[2]!;
    expect(audit.text).toContain("'gateway_key_policy_updated'");
    // The quota entrypoints were never called.
    expect(calls.some((call) => call.text.includes("aiag_set_agent_"))).toBe(false);
  });

  it("clears the whitelist with null and removes routing keys with null", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow()],
      { rows: [], rowCount: 1 },
      [],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { allowed_providers: null, model_whitelist: null },
    });

    expect(state.policies).toEqual({ kind: "agent", s2s_key_minting: true });
    expect(state.modelWhitelist).toEqual([]);
    const update = calls[1]!;
    expect(JSON.parse(update.values[2] as string)).toEqual({ kind: "agent", s2s_key_minting: true });
    expect(JSON.parse(update.values[3] as string)).toEqual([]);
  });

  it("fails AGENT_NOT_AUTHORIZED when the guarded UPDATE matches zero rows", async () => {
    const { db } = recordingDatabase([
      [policyRow()],
      { rows: [], rowCount: 0 },
    ]);
    await expectAgentPolicyError(
      updateAgentPolicy(db, { keyId: KEY_ID, patch: { forbid_non_ru: true } }),
      "AGENT_NOT_AUTHORIZED",
    );
  });
});

describe("updateAgentPolicy — quotas", () => {
  it("calls aiag_set_agent_key_quota_v1 with present values and current for absent ones", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow()], // locked read: monthly already 15000, session NULL
      [{ result: { sessionMicrocreditsLimit: "1500", monthlyCreditsLimit: "15000" } }],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { session_micro_limit: "1500" },
    });

    expect(state.quotas).toEqual({
      sessionMicrocredits: "1500",
      monthlyCredits: "15000",
      dailyOrgUsdMicro: null,
    });
    const call = calls[1]!;
    expect(call.text).toContain("aiag_set_agent_key_quota_v1($1::uuid,$2::bigint,$3::bigint)");
    expect(call.values).toEqual([KEY_ID, "1500", "15000"]);
    // No routing UPDATE, no audit row: the quota path owns its own audit_log.
    expect(calls.some((entry) => entry.text.includes("UPDATE public.gateway_api_keys"))).toBe(false);
    expect(calls.some((entry) => entry.text.includes("usage_events"))).toBe(false);
  });

  it("clears limits with explicit null (NULL travels to the SQL writer)", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow({ session_micro: "1500" })],
      [{ result: { sessionMicrocreditsLimit: null, monthlyCreditsLimit: null } }],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { session_micro_limit: null, monthly_credits_limit: null },
    });

    expect(state.quotas.sessionMicrocredits).toBeNull();
    expect(state.quotas.monthlyCredits).toBeNull();
    expect(calls[1]!.values).toEqual([KEY_ID, null, null]);
  });

  // ── Self-lock regression (review round 1) ─────────────────────────────────
  // rowToState runs at the top of EVERY updateAgentPolicy call; with the real
  // NUMERIC(10,2) render in the row, a fractional-looking monthly must neither
  // 503 the read NOR leak a non-integer into the $n::bigint writer parameter
  // (PG would reject "15000.00"::bigint outright).
  it("session-only patch over a \"15000.00\" current: writer gets the canonical integer, no self-lock", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow({ monthly_credits: "15000.00" })],
      [{ result: { sessionMicrocreditsLimit: "1500", monthlyCreditsLimit: "15000" } }],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { session_micro_limit: "1500" },
    });

    expect(state.quotas.monthlyCredits).toBe("15000");
    expect(calls[1]!.values).toEqual([KEY_ID, "1500", "15000"]);
  });

  it("monthly null-clear over a \"15000.00\" current resolves without failing the read", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow({ monthly_credits: "15000.00" })],
      [{ result: { sessionMicrocreditsLimit: null, monthlyCreditsLimit: null } }],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { monthly_credits_limit: null },
    });

    expect(state.quotas.monthlyCredits).toBeNull();
    expect(calls[1]!.values).toEqual([KEY_ID, null, null]);
  });

  it("routes the org daily limit to aiag_set_agent_org_quota_v1 with the key's org", async () => {
    const { db, calls } = recordingDatabase([
      [policyRow()],
      [{ result: { dailySupplierUsdMicroLimit: "25000", enforcementVersion: "2" } }],
    ]);

    const state = await updateAgentPolicy(db, {
      keyId: KEY_ID,
      patch: { daily_org_usd_micro_limit: "25000" },
    });

    expect(state.quotas.dailyOrgUsdMicro).toBe("25000");
    const call = calls[1]!;
    expect(call.text).toContain("aiag_set_agent_org_quota_v1($1::uuid,$2::bigint)");
    expect(call.values).toEqual([ORG_ID, "25000"]);
  });

  it("maps SQL RAISE codes to AgentPolicyError and rethrows nothing else", async () => {
    const { db } = recordingDatabase([[policyRow()], new Error("AGENT_QUOTA_OUT_OF_RANGE")]);
    await expectAgentPolicyError(
      updateAgentPolicy(db, { keyId: KEY_ID, patch: { monthly_credits_limit: "1" } }),
      "AGENT_QUOTA_OUT_OF_RANGE",
    );
  });

  it("fails AGENT_POLICY_UNAVAILABLE on a malformed 0108 result", async () => {
    const { db } = recordingDatabase([[policyRow()], [{ result: { nonsense: true } }]]);
    await expectAgentPolicyError(
      updateAgentPolicy(db, { keyId: KEY_ID, patch: { session_micro_limit: "10" } }),
      "AGENT_POLICY_UNAVAILABLE",
    );
  });

  it("rejects a non-numeric limit coming back from the rail", async () => {
    const { db } = recordingDatabase([
      [policyRow()],
      [{ result: { sessionMicrocreditsLimit: 1500 } }], // JSON number, not a string
    ]);
    await expectAgentPolicyError(
      updateAgentPolicy(db, { keyId: KEY_ID, patch: { session_micro_limit: "1500" } }),
      "AGENT_POLICY_UNAVAILABLE",
    );
  });
});
