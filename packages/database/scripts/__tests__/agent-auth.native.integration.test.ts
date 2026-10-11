import { createHash } from "node:crypto";
import { Address } from "@ton/core";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";
import { walletProofFixture } from "../../../shared/src/__tests__/ton-wallet-proof.fixture";
import { consumeAgentRegister, issueAgentChallenge } from "../../src/agent-auth";
import type { TonPaymentDatabase, TonSqlClient } from "../../src/ton-payment-types";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const DOMAIN = "app.example.test";
const SERVICE_OWNER_EMAIL = "aiag-agents@aiag.local";

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

/** One serialized client wrapped into the service transaction boundary. */
function transactionalDb(client: TestDatabaseClient): TonPaymentDatabase {
  return {
    transaction: async <T>(run: (tx: TonSqlClient) => Promise<T>): Promise<T> => {
      await client.query({ text: "BEGIN", values: [] });
      try {
        const result = await run({
          query: async (config) => client.query(config),
        });
        await client.query({ text: "COMMIT", values: [] });
        return result;
      } catch (error) {
        await client.query({ text: "ROLLBACK", values: [] });
        throw error;
      }
    },
  };
}

async function expectAgentError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "AgentAuthError", code });
}

describe.skipIf(!RUN_INTEGRATION)("agent register service layer (0104 rail)", () => {
  let client: TestDatabaseClient;
  let close: () => Promise<void>;
  let db: TonPaymentDatabase;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guardedClient) => {
        client = guardedClient;
        const applied = await client.query<{ version: string }>({
          text: "SELECT version FROM public.schema_migrations WHERE version = $1",
          values: ["migrations/0104_agent_principals.sql"],
        });
        expect(applied.rows).toHaveLength(1);

        const originalEnd = guardedClient.end.bind(guardedClient);
        guardedClient.end = async () => undefined;
        close = async () => {
          await originalEnd();
        };
        db = transactionalDb(guardedClient);
      },
    );
  });

  afterAll(async () => {
    await close?.();
  });

  const friendly = (raw: string) =>
    Address.parseRaw(raw).toString({ urlSafe: true, bounceable: true, testOnly: true });

  /** walletProofFixture derives a stable wallet per seed; each test takes a fresh seed. */

  async function cleanupByAddress(display: string) {
    const principals = await client.query<{ id: string; org_id: string }>({
      text: "SELECT id::text, org_id::text FROM public.agent_principals WHERE network='-3' AND address=$1",
      values: [display],
    });
    for (const principal of principals.rows) {
      await client.query({
        text: "DELETE FROM public.audit_log WHERE action='agent.register' AND resource_id=$1",
        values: [principal.id],
      });
    }
    await client.query({
      text: "DELETE FROM public.agent_wallet_challenges WHERE address=$1",
      values: [display],
    });
    await client.query({
      text: "DELETE FROM public.agent_principals WHERE network='-3' AND address=$1",
      values: [display],
    });
    for (const principal of principals.rows) {
      // Review wave (T-a1): registrations may now mint a first key, a
      // usage_events audit row and a quota v2 enrollment — all org-scoped,
      // all RESTRICTed or auditable, so scrub them before the org goes.
      await client.query({
        text: "DELETE FROM public.usage_events WHERE org_id=$1::uuid",
        values: [principal.org_id],
      });
      await client.query({
        text: "DELETE FROM public.gateway_quota_org_policies WHERE org_id=$1::uuid",
        values: [principal.org_id],
      });
      await client.query({
        text: "DELETE FROM public.gateway_api_keys WHERE org_id=$1::uuid",
        values: [principal.org_id],
      });
      await client.query({
        text: "DELETE FROM public.organizations WHERE id=$1::uuid",
        values: [principal.org_id],
      });
    }
  }

  it("registers a principal with a service-owned org and mints no key", async () => {
    const seed = 21;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    try {
      const challenge = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      expect(challenge.payload).toMatch(/^aiag:agent:register:-3:[0-9a-f]{64}$/);
      expect(challenge.challengeId).toMatch(/^[0-9a-f-]{36}$/);

      const proof = walletProofFixture(challenge.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      const result = await consumeAgentRegister(db, {
        challengeId: challenge.challengeId,
        address: probe.address,
        proof,
      });
      expect(Object.keys(result).sort()).toEqual(["orgId", "principalId"]);

      const org = await client.query<{
        id: string;
        slug: string;
        name: string;
        owner_email: string;
        is_active: boolean;
      }>({
        text: `
          SELECT o.id::text, o.slug, o.name, u.email AS owner_email, o.is_active
          FROM public.organizations o JOIN public.users u ON u.id = o.owner_id
          WHERE o.id = $1::uuid
        `,
        values: [result.orgId],
      });
      expect(org.rows[0]).toMatchObject({
        slug: expect.stringMatching(/^agent-[0-9a-f]{8}$/),
        name: "agent:" + display.slice(0, 8),
        owner_email: SERVICE_OWNER_EMAIL,
        is_active: true,
      });

      const principal = await client.query<{
        org_id: string;
        network: string;
        address: string;
        address_raw: string;
        status: string;
      }>({
        text: "SELECT org_id::text, network, address, address_raw, status FROM public.agent_principals WHERE id=$1::uuid",
        values: [result.principalId],
      });
      expect(principal.rows[0]).toMatchObject({
        org_id: result.orgId,
        network: "-3",
        address: display,
        address_raw: probe.address,
        status: "active",
      });

      const consumed = await client.query<{
        consumed_at: string | null;
        proof_digest: string | null;
        principal_id: string | null;
      }>({
        text: "SELECT consumed_at::text, proof_digest, principal_id::text FROM public.agent_wallet_challenges WHERE id=$1::uuid",
        values: [challenge.challengeId],
      });
      expect(consumed.rows[0]?.consumed_at).not.toBeNull();
      expect(consumed.rows[0]?.proof_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(consumed.rows[0]?.principal_id).toBe(result.principalId);

      // Controller ruling: the first key is minted by the gateway route (Task 4), never here.
      const keys = await client.query<{ n: number }>({
        text: "SELECT count(*)::int AS n FROM public.gateway_api_keys WHERE org_id=$1::uuid",
        values: [result.orgId],
      });
      expect(keys.rows[0]?.n).toBe(0);
    } finally {
      await cleanupByAddress(display);
    }
  }, 120_000);

  it("refuses challenge reuse and duplicate registration of the same address", async () => {
    const seed = 22;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    try {
      const challenge = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      const proof = walletProofFixture(challenge.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      const first = await consumeAgentRegister(db, {
        challengeId: challenge.challengeId,
        address: probe.address,
        proof,
      });

      // Replay of the consumed challenge: refused, nothing new created.
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: challenge.challengeId,
          address: probe.address,
          proof,
        }),
        "AGENT_CHALLENGE_EXPIRED",
      );

      // Fresh challenge, same address: the active principal owns it already.
      const second = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      const secondProof = walletProofFixture(second.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: second.challengeId,
          address: probe.address,
          proof: secondProof,
        }),
        "AGENT_ALREADY_REGISTERED",
      );

      const rows = await client.query<{ n: number; orgs: number }>({
        text: `
          SELECT count(*)::int AS n,
                 count(DISTINCT p.org_id)::int AS orgs
          FROM public.agent_principals p WHERE p.network='-3' AND p.address=$1
        `,
        values: [display],
      });
      expect(rows.rows[0]).toMatchObject({ n: 1, orgs: 1 });
      expect(first.principalId).toBeTruthy();
    } finally {
      await cleanupByAddress(display);
    }
  }, 120_000);

  it("refuses expired challenges and tampered proofs without consuming them", async () => {
    const seed = 23;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    try {
      // (a) Backdate the challenge while preserving the exact-120s TTL CHECK.
      const stale = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      await client.query({
        text: `
          UPDATE public.agent_wallet_challenges c
          SET issued_at = m.n - INTERVAL '130 seconds',
              expires_at = m.n - INTERVAL '10 seconds'
          FROM (SELECT clock_timestamp() AS n) m
          WHERE c.id = $1::uuid
        `,
        values: [stale.challengeId],
      });
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: stale.challengeId,
          address: probe.address,
          proof: walletProofFixture(stale.payload, DOMAIN, Math.floor(Date.now() / 1000), seed),
        }),
        "AGENT_CHALLENGE_EXPIRED",
      );

      // (b) Tampered payload inside an otherwise valid proof.
      const tampered = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: tampered.challengeId,
          address: probe.address,
          proof: walletProofFixture(tampered.payload + "x", DOMAIN, Math.floor(Date.now() / 1000), seed),
        }),
        "AGENT_PROOF_INVALID",
      );

      // (c) Proof signed for a foreign domain.
      const foreign = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: foreign.challengeId,
          address: probe.address,
          proof: walletProofFixture(foreign.payload, "other.example.test", Math.floor(Date.now() / 1000), seed),
        }),
        "AGENT_PROOF_INVALID",
      );

      const state = await client.query<{ unconsumed: number; principals: number }>({
        text: `
          SELECT
            count(*) FILTER (WHERE consumed_at IS NULL)::int AS unconsumed,
            (SELECT count(*)::int FROM public.agent_principals WHERE network='-3' AND address=$1) AS principals
          FROM public.agent_wallet_challenges WHERE address=$1
        `,
        values: [display],
      });
      expect(state.rows[0]).toMatchObject({ unconsumed: 3, principals: 0 });
    } finally {
      await cleanupByAddress(display);
    }
  }, 120_000);

  it("bounds challenge issuance per address", async () => {
    const seed = 24;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    try {
      for (let n = 0; n < 8; n++) {
        await issueAgentChallenge(db, { address: probe.address, network: "-3", domain: DOMAIN });
      }
      await expectAgentError(
        issueAgentChallenge(db, { address: probe.address, network: "-3", domain: DOMAIN }),
        "AGENT_CHALLENGE_RATE_LIMIT",
      );
    } finally {
      await cleanupByAddress(display);
    }
  }, 120_000);

  // ── Review wave (T-a1 Fix 2/3): atomic registration with the first key ────
  it("mints the first key, the mint audit and the quota v2 enrollment inside the registration transaction", async () => {
    const seed = 25;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    const keyHash = createHash("sha256").update("native-agent-primary-plaintext").digest("hex");
    try {
      const challenge = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      const proof = walletProofFixture(challenge.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      const result = await consumeAgentRegister(db, {
        challengeId: challenge.challengeId,
        address: probe.address,
        proof,
        primaryKey: { hash: keyHash, prefix: "sk_aiag_live_nat0001", name: "agent-primary" },
      });

      expect(result.primaryKey?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.primaryKey?.prefix).toBe("sk_aiag_live_nat0001");

      const key = await client.query<{
        id: string;
        key_hash: string;
        policies: { kind?: string; s2s_key_minting?: boolean };
        rpm_limit: number;
        batch_rpm_limit: number;
        expires_at: string | null;
        revoked_at: string | null;
      }>({
        text: `SELECT id::text, key_hash, policies, rpm_limit, batch_rpm_limit,
                 expires_at::text, revoked_at::text
               FROM public.gateway_api_keys WHERE org_id=$1::uuid`,
        values: [result.orgId],
      });
      expect(key.rows).toHaveLength(1);
      expect(key.rows[0]).toMatchObject({
        id: result.primaryKey?.id,
        key_hash: keyHash,
        policies: { kind: "agent", s2s_key_minting: true },
        rpm_limit: 60,
        batch_rpm_limit: 10,
        expires_at: null,
        revoked_at: null,
      });

      // Fix 3: stored admission requires enforcement_version=2 — the org is
      // enrolled at registration, in the same transaction.
      const quota = await client.query<{ enforcement_version: number }>({
        text: "SELECT enforcement_version::int FROM public.gateway_quota_org_policies WHERE org_id=$1::uuid",
        values: [result.orgId],
      });
      expect(quota.rows[0]?.enforcement_version).toBe(2);

      const audit = await client.query<{ n: number }>({
        text: "SELECT count(*)::int AS n FROM public.usage_events WHERE org_id=$1::uuid AND kind='gateway_key_minted'",
        values: [result.orgId],
      });
      expect(audit.rows[0]?.n).toBe(1);
    } finally {
      await cleanupByAddress(display);
    }
  }, 120_000);

  it("a failed mint rolls the WHOLE registration back — the wallet can register again (no keyless lock-out)", async () => {
    const seed = 26;
    const probe = walletProofFixture("probe", DOMAIN, Math.floor(Date.now() / 1000), seed);
    const display = friendly(probe.address);
    const collidingHash = createHash("sha256").update("native-mint-collision").digest("hex");
    let decoyOrgId = "";
    try {
      // A decoy key with the SAME hash makes the in-transaction mint INSERT
      // violate the global key_hash UNIQUE constraint after the org and
      // principal have already been created — the exact mid-registration
      // failure window the review wave closed.
      const decoy = await client.query<{ id: string }>({
        text: `INSERT INTO public.organizations(slug, name, owner_id)
               VALUES($1, 'agent:native-collide', public.aiag_agent_owner_user_v1())
               RETURNING id::text`,
        values: [`native-collide-${Date.now()}`],
      });
      decoyOrgId = decoy.rows[0]!.id;
      await client.query({
        text: `INSERT INTO public.gateway_api_keys(org_id, name, key_hash, key_prefix)
               VALUES($1::uuid, 'collision-decoy', $2, 'sk_aiag_live_collider')`,
        values: [decoyOrgId, collidingHash],
      });

      const challenge = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      const proof = walletProofFixture(challenge.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      await expectAgentError(
        consumeAgentRegister(db, {
          challengeId: challenge.challengeId,
          address: probe.address,
          proof,
          primaryKey: { hash: collidingHash, prefix: "sk_aiag_live_nat0002", name: "agent-primary" },
        }),
        "AGENT_AUTH_UNAVAILABLE",
      );

      // The transaction rolled back completely: no principal, no org — and
      // the challenge is unconsumed again, so a retry is not a 409.
      const state = await client.query<{ principals: number; consumed: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM public.agent_principals WHERE network='-3' AND address=$1) AS principals,
                 count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed
               FROM public.agent_wallet_challenges WHERE address=$1`,
        values: [display],
      });
      expect(state.rows[0]).toMatchObject({ principals: 0, consumed: 0 });

      // The wallet can simply register again with a fresh key material.
      const retryChallenge = await issueAgentChallenge(db, {
        address: probe.address,
        network: "-3",
        domain: DOMAIN,
      });
      const retryProof = walletProofFixture(retryChallenge.payload, DOMAIN, Math.floor(Date.now() / 1000), seed);
      const retry = await consumeAgentRegister(db, {
        challengeId: retryChallenge.challengeId,
        address: probe.address,
        proof: retryProof,
        primaryKey: { hash: createHash("sha256").update("native-agent-retry").digest("hex"), prefix: "sk_aiag_live_nat0003", name: "agent-primary" },
      });
      expect(retry.primaryKey?.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      if (decoyOrgId) {
        await client.query({
          text: "DELETE FROM public.gateway_api_keys WHERE org_id=$1::uuid",
          values: [decoyOrgId],
        });
        await client.query({
          text: "DELETE FROM public.organizations WHERE id=$1::uuid",
          values: [decoyOrgId],
        });
      }
      await cleanupByAddress(display);
    }
  }, 120_000);
});
