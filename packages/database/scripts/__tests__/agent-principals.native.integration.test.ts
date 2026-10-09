import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

const AGENT_OWNER_EMAIL = "aiag-agents@aiag.local";
const AGENT_OWNER_ID = "00000000-0000-0000-0000-0000000000a1";
const WALLET_ADDRESS = "A".repeat(48);
const ADDRESS_RAW = `0:${"a1".repeat(32)}`;
const PAYLOAD_HASH = "ab".repeat(32);
const PROOF_DIGEST = "cd".repeat(32);
const CHALLENGE_DOMAIN = "https://api.aiag.local";

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

describe.skipIf(!RUN_INTEGRATION)("agent principals identity rail (0104)", () => {
  let client: TestDatabaseClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guardedClient) => {
        client = guardedClient;

        const applied = await client.query<{ version: string }>({
          text: `
            SELECT version
            FROM public.schema_migrations
            WHERE version = $1
          `,
          values: ["migrations/0104_agent_principals.sql"],
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

  function insertFixtureOrg(): Promise<{ userId: string; orgId: string }> {
    const userId = randomUUID();
    const orgId = randomUUID();
    return (async () => {
      await client.query({
        text: `
          INSERT INTO public.users (id, email, name)
          VALUES ($1::uuid, $2, $3)
        `,
        values: [
          userId,
          `agent-rail-${orgId}@example.test`,
          "Agent rail fixture",
        ],
      });
      await client.query({
        text: `
          INSERT INTO public.organizations (
            id, slug, name, owner_id, subscription_credits, payg_credits
          ) VALUES ($1::uuid, $2, $3, $4::uuid, 0, 0)
        `,
        values: [orgId, `agent-rail-${orgId}`, "Agent rail org", userId],
      });
      return { userId, orgId };
    })();
  }

  function insertPrincipal(orgId: string) {
    return client.query({
      text: `
        INSERT INTO public.agent_principals (org_id, network, address, address_raw)
        VALUES ($1::uuid, '-3', $2, $3)
      `,
      values: [orgId, WALLET_ADDRESS, ADDRESS_RAW],
    });
  }

  async function expectQueryViolation(
    savepoint: string,
    query: () => Promise<unknown>,
    match: Record<string, unknown>,
  ) {
    await client.query({ text: `SAVEPOINT ${savepoint}`, values: [] });
    await expect(query()).rejects.toMatchObject(match);
    await client.query({ text: `ROLLBACK TO SAVEPOINT ${savepoint}`, values: [] });
  }

  it("creates service owner user once (idempotent)", async () => {
    const owner = await client.query<{
      id: string;
      email: string;
      is_active: boolean;
      is_banned: boolean;
    }>({
      text: `
        SELECT id::text, email, is_active, is_banned
        FROM public.users
        WHERE email = $1
      `,
      values: [AGENT_OWNER_EMAIL],
    });
    expect(owner.rows).toHaveLength(1);
    expect(owner.rows[0]).toMatchObject({
      id: AGENT_OWNER_ID,
      email: AGENT_OWNER_EMAIL,
      is_active: true,
      is_banned: false,
    });

    const viaFunction = await client.query<{ owner: string | null }>({
      text: "SELECT public.aiag_agent_owner_user_v1()::text AS owner",
      values: [],
    });
    expect(viaFunction.rows[0].owner).toBe(AGENT_OWNER_ID);

    // The guarded INSERT from 0104 replays without duplicating the row.
    await client.query({ text: "BEGIN", values: [] });
    try {
      await client.query({
        text: `
          INSERT INTO public.users (id, email, name, is_active, is_banned)
          VALUES ($1::uuid, $2, 'AIAG Agent Service', TRUE, FALSE)
          ON CONFLICT (email) DO NOTHING
        `,
        values: [AGENT_OWNER_ID, AGENT_OWNER_EMAIL],
      });
      const count = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM public.users
          WHERE email = $1
        `,
        values: [AGENT_OWNER_EMAIL],
      });
      expect(count.rows[0].count).toBe("1");
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("rejects second active principal for same address", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const first = await insertFixtureOrg();
      const second = await insertFixtureOrg();
      await insertPrincipal(first.orgId);

      await expectQueryViolation(
        "second_active",
        () => insertPrincipal(second.orgId),
        { code: "23505", constraint: "agent_principals_active_address" },
      );

      // Revoking the first principal frees the address for the partial index.
      await client.query({
        text: `
          UPDATE public.agent_principals
          SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE org_id = $1::uuid
        `,
        values: [first.orgId],
      });
      await insertPrincipal(second.orgId);
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("challenge TTL is exactly 120s and single-use guard columns hold", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId } = await insertFixtureOrg();

      // exactly 120 seconds — accepted (now() is stable within the statement).
      await client.query({
        text: `
          INSERT INTO public.agent_wallet_challenges (
            id, purpose, payload_hash, network, address, domain, issued_at, expires_at
          ) VALUES (
            $1::uuid, 'register', $2, '-3', $3, $4, now(), now() + INTERVAL '120 seconds'
          )
        `,
        values: [randomUUID(), PAYLOAD_HASH, WALLET_ADDRESS, CHALLENGE_DOMAIN],
      });

      // 60 seconds — rejected by the exact-TTL CHECK.
      await expectQueryViolation(
        "ttl_60s",
        () =>
          client.query({
            text: `
              INSERT INTO public.agent_wallet_challenges (
                id, purpose, payload_hash, network, address, domain, issued_at, expires_at
              ) VALUES (
                $1::uuid, 'register', $2, '-3', $3, $4, now(), now() + INTERVAL '60 seconds'
              )
            `,
            values: [
              randomUUID(),
              PAYLOAD_HASH,
              WALLET_ADDRESS,
              CHALLENGE_DOMAIN,
            ],
          }),
        { code: "23514" },
      );

      // consumed_at without proof_digest — rejected by the single-use guard.
      await expectQueryViolation(
        "consumed_without_proof",
        () =>
          client.query({
            text: `
              INSERT INTO public.agent_wallet_challenges (
                id, purpose, payload_hash, network, address, domain,
                issued_at, expires_at, consumed_at
              ) VALUES (
                $1::uuid, 'register', $2, '-3', $3, $4,
                now(), now() + INTERVAL '120 seconds', clock_timestamp()
              )
            `,
            values: [
              randomUUID(),
              PAYLOAD_HASH,
              WALLET_ADDRESS,
              CHALLENGE_DOMAIN,
            ],
          }),
        { code: "23514" },
      );

      // Full consumption with proof and principal is the accepted terminal shape.
      const principal = await client.query<{ id: string }>({
        text: `
          INSERT INTO public.agent_principals (org_id, network, address, address_raw)
          VALUES ($1::uuid, '-3', $2, $3)
          RETURNING id::text AS id
        `,
        values: [orgId, WALLET_ADDRESS, ADDRESS_RAW],
      });
      const consumed = await client.query<{ id: string }>({
        text: `
          UPDATE public.agent_wallet_challenges
          SET consumed_at = clock_timestamp(),
              proof_digest = $1,
              principal_id = $2::uuid
          WHERE consumed_at IS NULL
          RETURNING id::text AS id
        `,
        values: [PROOF_DIGEST, principal.rows[0].id],
      });
      expect(consumed.rows).toHaveLength(1);
      const terminal = await client.query<{ count: string }>({
        text: `
          SELECT COUNT(*)::text AS count
          FROM public.agent_wallet_challenges
          WHERE consumed_at IS NOT NULL AND proof_digest IS NOT NULL
        `,
        values: [],
      });
      expect(terminal.rows[0].count).toBe("1");
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });

  it("principal revocation requires status+timestamp", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId } = await insertFixtureOrg();
      await insertPrincipal(orgId);

      // Timestamp alone keeps status='active' — rejected by the table CHECK.
      await expectQueryViolation(
        "revoked_at_only",
        () =>
          client.query({
            text: `
              UPDATE public.agent_principals
              SET revoked_at = clock_timestamp()
              WHERE org_id = $1::uuid
            `,
            values: [orgId],
          }),
        { code: "23514" },
      );

      // Both columns together — the accepted revocation shape.
      await client.query({
        text: `
          UPDATE public.agent_principals
          SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE org_id = $1::uuid
        `,
        values: [orgId],
      });
      const revoked = await client.query<{
        status: string;
        revoked_at: Date;
      }>({
        text: `
          SELECT status, revoked_at
          FROM public.agent_principals
          WHERE org_id = $1::uuid
        `,
        values: [orgId],
      });
      expect(revoked.rows[0].status).toBe("revoked");
      expect(revoked.rows[0].revoked_at).toBeInstanceOf(Date);
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  });
});
