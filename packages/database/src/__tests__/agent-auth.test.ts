import { createHash } from "node:crypto";
import { Address } from "@ton/core";
import { describe, expect, it } from "vitest";

import { walletProofFixture } from "../../../shared/src/__tests__/ton-wallet-proof.fixture";
import {
  consumeAgentRegister,
  issueAgentChallenge,
  type AgentChallengeRow,
} from "../agent-auth";
import type { TonPaymentDatabase, TonSqlClient } from "../ton-payment-types";

const DOMAIN = "app.example.test";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const friendly = (raw: string) =>
  Address.parseRaw(raw).toString({ urlSafe: true, bounceable: true, testOnly: true });

/** Scripted SQL boundary: each entry is the next statement's rows, or an error to throw. */
function recordingDatabase(script: (unknown[] | Error)[] = []) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const tx: TonSqlClient = {
    query: async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(config: { text: string; values: readonly unknown[] }) => {
      calls.push(config);
      const next = script.shift();
      if (next instanceof Error) throw next;
      const rows = (next ?? []) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
  return {
    db: {
      transaction: <T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> => run(tx),
    } satisfies TonPaymentDatabase,
    calls,
  };
}

function challengeRow(patch: Partial<AgentChallengeRow> = {}): AgentChallengeRow {
  const now = Date.now();
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    purpose: "register",
    payload_hash: "ab".repeat(32),
    network: "-3",
    address: "A".repeat(48),
    domain: DOMAIN,
    issued_ms: String(now - 60_000),
    expires_ms: String(now + 60_000),
    consumed_at: null,
    ...patch,
  };
}

describe("agent register challenge issuance", () => {
  it("issues a single-purpose 120s challenge with prepared values and a service-side id", async () => {
    const { db, calls } = recordingDatabase([
      [], // advisory lock
      [{ global_n: 0, address_n: 0 }],
      [], // expired-challenge sweep
      [{ expires_at: "2026-10-09 12:00:00+00" }],
    ]);
    const result = await issueAgentChallenge(db, {
      address: `0:${"a1".repeat(32)}`,
      network: "-3",
      domain: DOMAIN,
    });
    expect(result.challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.payload).toMatch(/^aiag:agent:register:-3:[0-9a-f]{64}$/);
    expect(result.expiresAt).toBe("2026-10-09 12:00:00+00");
    expect(calls[3]?.text).toContain("INSERT INTO public.agent_wallet_challenges");
    expect(calls[3]?.text).toContain("'register'");
    expect(calls[3]?.text).toContain("interval '120 seconds'");
    expect(calls[3]?.values[0]).toBe(result.challengeId);
    expect(calls[3]?.values[1]).toBe(digest(result.payload));
    expect(calls[3]?.values[2]).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(calls[3]?.values[3]).toBe(DOMAIN);
  });

  it("stores the canonical friendly form of the raw wallet address", async () => {
    const raw = `0:${"b2".repeat(32)}`;
    const { db, calls } = recordingDatabase([
      [],
      [{ global_n: 0, address_n: 0 }],
      [],
      [{ expires_at: "x" }],
    ]);
    await issueAgentChallenge(db, { address: raw, network: "-3", domain: DOMAIN });
    expect(calls[3]?.values[2]).toBe(friendly(raw));
  });

  it("rejects malformed inputs before any SQL", async () => {
    const raw = `0:${"c3".repeat(32)}`;
    for (const patch of [
      { network: "-23" as const },
      { domain: "no-dot-domain" },
      { domain: "a".repeat(301) },
      { address: "EQAA" },
      { address: `1:${"c3".repeat(32)}` },
      { address: `0:${"C3".repeat(32)}` },
    ]) {
      const { db, calls } = recordingDatabase();
      await expect(
        issueAgentChallenge(db, { address: raw, network: "-3", domain: DOMAIN, ...patch } as Parameters<typeof issueAgentChallenge>[1]),
      ).rejects.toThrow("AGENT_AUTH_INVALID");
      expect(calls).toHaveLength(0);
    }
  });

  it("bounds issuance by global and per-address rates", async () => {
    for (const counters of [{ global_n: 200, address_n: 0 }, { global_n: 0, address_n: 8 }]) {
      const { db, calls } = recordingDatabase([[], [counters]]);
      await expect(
        issueAgentChallenge(db, { address: `0:${"d4".repeat(32)}`, network: "-3", domain: DOMAIN }),
      ).rejects.toThrow("AGENT_CHALLENGE_RATE_LIMIT");
      expect(calls).toHaveLength(2);
    }
  });
});

describe("agent register consumption", () => {
  function proofPair(patch: { payload?: string; domain?: string } = {}) {
    const payload = patch.payload ?? `aiag:agent:register:-3:${"e5".repeat(32)}`;
    const proof = walletProofFixture(payload, patch.domain ?? DOMAIN);
    return { payload, proof, address: friendly(proof.address) };
  }

  function happyScript(pair: ReturnType<typeof proofPair>, now = Date.now()) {
    const rows: (unknown[] | Error)[] = [
      [challengeRow({
        payload_hash: digest(pair.payload),
        address: pair.address,
        issued_ms: String(now - 30_000),
        expires_ms: String(now + 90_000),
      })],
      [{ now_ms: String(now) }],
      [],
      [],
      [{ owner: "00000000-0000-0000-0000-0000000000a1" }],
      [{ id: "00000000-0000-4000-8000-0000000000b1" }],
      [{ id: "00000000-0000-4000-8000-0000000000c1" }],
      [{ id: challengeRow().id }],
      [],
    ];
    return {
      rows,
      orgId: "00000000-0000-4000-8000-0000000000b1",
      principalId: "00000000-0000-4000-8000-0000000000c1",
      challengeId: challengeRow().id,
    };
  }

  it("registers org and principal in one guarded transaction without minting a key", async () => {
    const pair = proofPair();
    const script = happyScript(pair);
    const { db, calls } = recordingDatabase(script.rows);
    const result = await consumeAgentRegister(db, {
      challengeId: script.challengeId,
      address: pair.proof.address,
      proof: pair.proof,
    });
    // Controller ruling: no key material leaves the database package.
    expect(result).toEqual({ principalId: script.principalId, orgId: script.orgId });
    expect(Object.keys(result).sort()).toEqual(["orgId", "principalId"]);

    const texts = calls.map((call) => call.text);
    expect(texts[0]).toContain("FOR UPDATE");
    expect(texts[2]).toContain("pg_advisory_xact_lock");
    expect(texts[3]).toContain("agent_principals");
    expect(texts[3]).toContain("status='active'");
    expect(texts[4]).toContain("aiag_agent_owner_user_v1()");
    expect(texts[5]).toContain("INSERT INTO public.organizations");
    expect(texts[5]).toContain("ON CONFLICT (slug) DO NOTHING");
    expect(texts[6]).toContain("INSERT INTO public.agent_principals");
    expect(calls[6]?.values[0]).toBe(script.orgId);
    expect(calls[6]?.values[1]).toBe(pair.address);
    expect(calls[6]?.values[2]).toBe(pair.proof.address);
    expect(texts[7]).toContain("UPDATE public.agent_wallet_challenges");
    expect(texts[7]).toContain("consumed_at IS NULL");
    expect(texts[7]).toContain("expires_at>n");
    expect(calls[7]?.values[0]).toBe(script.challengeId);
    expect(texts.every((text) => !text.includes("gateway_api_keys"))).toBe(true);
  });

  it("regenerates the slug on a collision instead of failing the registration", async () => {
    const pair = proofPair();
    const script = happyScript(pair);
    const rows = [...script.rows];
    rows.splice(5, 0, []); // first slug collides (ON CONFLICT DO NOTHING → no row)
    const { db, calls } = recordingDatabase(rows);
    const result = await consumeAgentRegister(db, {
      challengeId: script.challengeId,
      address: pair.proof.address,
      proof: pair.proof,
    });
    expect(result.orgId).toBe(script.orgId);
    const orgInserts = calls.filter((call) =>
      call.text.includes("INSERT INTO public.organizations"),
    );
    expect(orgInserts).toHaveLength(2);
    expect(orgInserts[0]?.values[0]).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(orgInserts[1]?.values[0]).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(orgInserts[0]?.values[0]).not.toBe(orgInserts[1]?.values[0]);
    expect(orgInserts[0]?.values[1]).toBe(pair.address.slice(0, 8));
    expect(orgInserts[0]?.values[2]).toBe("00000000-0000-0000-0000-0000000000a1");
  });

  it("refuses an already-registered address before any write", async () => {
    const pair = proofPair();
    const rows = happyScript(pair).rows;
    rows[3] = [{ id: "00000000-0000-4000-8000-0000000000d1" }];
    const { db, calls } = recordingDatabase(rows);
    await expect(
      consumeAgentRegister(db, {
        challengeId: happyScript(pair).challengeId,
        address: pair.proof.address,
        proof: pair.proof,
      }),
    ).rejects.toThrow("AGENT_ALREADY_REGISTERED");
    expect(calls.filter((call) => call.text.includes("INSERT"))).toHaveLength(0);
  });

  it("maps the concurrent active-address unique violation to AGENT_ALREADY_REGISTERED", async () => {
    const pair = proofPair();
    const script = happyScript(pair);
    const rows = [...script.rows];
    const uniqueViolation = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "agent_principals_active_address",
    });
    rows[6] = uniqueViolation;
    const { db } = recordingDatabase(rows);
    await expect(
      consumeAgentRegister(db, {
        challengeId: script.challengeId,
        address: pair.proof.address,
        proof: pair.proof,
      }),
    ).rejects.toThrow("AGENT_ALREADY_REGISTERED");
  });

  it("refuses expired and reused challenges without writes", async () => {
    const pair = proofPair();
    const now = Date.now();
    const expired = challengeRow({
      payload_hash: digest(pair.payload),
      address: pair.address,
      issued_ms: String(now - 130_000),
      expires_ms: String(now - 10_000),
    });
    const reused = challengeRow({
      payload_hash: digest(pair.payload),
      address: pair.address,
      consumed_at: "2026-10-09 11:59:00+00",
    });
    for (const row of [expired, reused]) {
      const { db, calls } = recordingDatabase([[row], [{ now_ms: String(now) }]]);
      await expect(
        consumeAgentRegister(db, {
          challengeId: row.id,
          address: pair.proof.address,
          proof: pair.proof,
        }),
      ).rejects.toThrow("AGENT_CHALLENGE_EXPIRED");
      expect(
        calls.filter((call) => call.text.includes("INSERT INTO") || call.text.includes("UPDATE public.")),
      ).toHaveLength(0);
    }
  });

  it("refuses tampered proofs and address mismatches without writes", async () => {
    const good = proofPair();
    const script = happyScript(good);
    const baseRow = challengeRow({
      id: script.challengeId,
      payload_hash: digest(good.payload),
      address: good.address,
    });

    // Proof signed for a different payload than the challenge holds.
    const otherPayload = proofPair({ payload: `aiag:agent:register:-3:${"f6".repeat(32)}` });
    await expect(
      consumeAgentRegister(recordingDatabase([[baseRow]]).db, {
        challengeId: script.challengeId,
        address: otherPayload.proof.address,
        proof: otherPayload.proof,
      }),
    ).rejects.toThrow("AGENT_PROOF_INVALID");

    // Proof for a different domain than the challenge holds.
    const foreignDomain = proofPair({ domain: "other.example.test" });
    await expect(
      consumeAgentRegister(recordingDatabase([[baseRow], [{ now_ms: String(Date.now()) }]]).db, {
        challengeId: script.challengeId,
        address: foreignDomain.proof.address,
        proof: { ...foreignDomain.proof, address: good.proof.address },
      }),
    ).rejects.toThrow("AGENT_PROOF_INVALID");

    // Broken signature.
    await expect(
      consumeAgentRegister(
        recordingDatabase([[baseRow], [{ now_ms: String(Date.now()) }]]).db,
        {
          challengeId: script.challengeId,
          address: good.proof.address,
          proof: {
            ...good.proof,
            proof: { ...good.proof.proof, signature: Buffer.alloc(64).toString("base64") },
          },
        },
      ),
    ).rejects.toThrow("AGENT_PROOF_INVALID");

    // Challenge bound to another address.
    const boundElsewhere = challengeRow({
      id: script.challengeId,
      payload_hash: digest(good.payload),
      address: "B".repeat(48),
    });
    await expect(
      consumeAgentRegister(recordingDatabase([[boundElsewhere]]).db, {
        challengeId: script.challengeId,
        address: good.proof.address,
        proof: good.proof,
      }),
    ).rejects.toThrow("AGENT_CHALLENGE_INVALID");

    // Unknown challenge id.
    await expect(
      consumeAgentRegister(recordingDatabase([[]]).db, {
        challengeId: script.challengeId,
        address: good.proof.address,
        proof: good.proof,
      }),
    ).rejects.toThrow("AGENT_CHALLENGE_INVALID");
  });

  it("rejects malformed consume inputs before SQL", async () => {
    const pair = proofPair();
    for (const patch of [
      { challengeId: "not-a-uuid" },
      { address: "EQAA" },
      { proof: null },
      { proof: { address: "EQAA" } },
    ]) {
      const { db, calls } = recordingDatabase();
      await expect(
        consumeAgentRegister(db, {
          challengeId: "00000000-0000-4000-8000-0000000000aa",
          address: pair.proof.address,
          proof: pair.proof,
          ...patch,
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });
});
