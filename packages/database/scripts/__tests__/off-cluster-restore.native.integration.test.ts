import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readRestoreSnapshot,
  replayOldPaymentOnRestored,
  restoreOffCluster,
  rolesRequiredByAuthority,
} from "../off-cluster-restore";
import { settleChargeViaGatewayAuthority } from "../off-cluster-balances";
import { createPgTestClient } from "../pg-test-client";
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from "../native-migrate";

const exec = promisify(execFile);

/**
 * AG-6 Task 2: an off-CLUSTER restore, proven by real pg_dump/pg_restore.
 *
 * Two disposable PostgreSQL clusters are booted on dynamically picked ports
 * (15432/15433 are shared with other native suites). Source and destination are
 * genuinely different servers — the module proves it by comparing
 * `pg_control_system().system_identifier` — and the destination starts with no
 * application roles at all, so the restore can only succeed if the roles are
 * recreated there first. That is the ordering a real off-host recovery has to
 * follow, and it is the failure this task exists to close.
 *
 * Nothing here touches production, the shared 15432 test cluster, or real
 * money: every credit is a synthetic fixture row and the only debit is executed
 * by the already-applied settlement function.
 */

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const toolsRoot = resolve(
  __dirname,
  "../../../../.superpowers/tools/native18/root",
);
const standScript = resolve(__dirname, "../restore-stand.sh");
const toolsPresent = existsSync(
  join(toolsRoot, "usr/lib/postgresql/18/bin/postgres"),
);
const describeNative = enabled && toolsPresent ? describe : describe.skip;

const MODEL_SLUG = "openai/gpt-4o-mini";
const PROMPT_TOKENS = 30;
const GRANT = "900000";

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

async function bootCluster(port: number, pgdata: string) {
  await exec("bash", [standScript, "start"], {
    env: { PATH: process.env.PATH ?? "", PGDATA: pgdata, PGPORT: String(port) },
    timeout: 180_000,
  });
}

interface Fixture {
  orgId: string;
  apiKeyId: string;
}

async function seedOrgWithBalance(
  client: Client,
  grant = GRANT,
): Promise<Fixture> {
  const orgId = randomUUID();
  const apiKeyId = randomUUID();
  const ownerId = randomUUID();
  const user = await client.query(
    "INSERT INTO public.users(id,email) VALUES($1,$2) RETURNING id::text AS id",
    [ownerId, `off-cluster-restore-${ownerId}@example.test`],
  );
  if (user.rows[0]?.id !== ownerId)
    throw Error("OFF_CLUSTER_RESTORE_USER_NOT_CREATED");
  const org = await client.query(
    `INSERT INTO public.organizations(id,slug,name,owner_id,payg_credits)
     VALUES($1,$2,'off-cluster-restore',$3,$4::bigint) RETURNING id::text AS id`,
    [orgId, orgId, ownerId, grant],
  );
  if (org.rows[0]?.id !== orgId)
    throw Error("OFF_CLUSTER_RESTORE_ORG_NOT_CREATED");
  const key = await client.query(
    `INSERT INTO public.gateway_api_keys(id,org_id,name,key_hash,key_prefix)
     VALUES($1,$2,'off-cluster-restore',$3,$4) RETURNING id::text AS id`,
    [apiKeyId, orgId, randomUUID(), `ocr-${apiKeyId.slice(0, 12)}`],
  );
  if (key.rows[0]?.id !== apiKeyId)
    throw Error("OFF_CLUSTER_RESTORE_KEY_NOT_CREATED");
  const policy = await client.query(
    `INSERT INTO public.gateway_quota_org_policies(org_id,enforcement_version)
     VALUES($1,2) RETURNING org_id::text AS org_id`,
    [orgId],
  );
  if (policy.rows[0]?.org_id !== orgId)
    throw Error("OFF_CLUSTER_RESTORE_POLICY_NOT_CREATED");
  return { orgId, apiKeyId };
}

function chargeInput(fixture: Fixture) {
  return {
    orgId: fixture.orgId,
    apiKeyId: fixture.apiKeyId,
    billingRequestId: randomUUID(),
    attemptId: randomUUID(),
    declaredSessionId: null,
    modelSlug: MODEL_SLUG,
    promptTokens: PROMPT_TOKENS,
    deadline: new Date(Date.now() + 300_000).toISOString(),
  };
}

describeNative("off-cluster restore into an independent cluster", () => {
  let root = "";
  let sourcePort = 0;
  let destinationPort = 0;
  const ownerRole = "ag6r_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const sourceDatabase =
    "aiag_source_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const clientOptions = { ssl: false, connectionTimeoutMillis: 10_000 };

  const sourceUrl = () =>
    `postgres://${ownerRole}@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  const destinationAdminUrl = () =>
    `postgres://postgres@127.0.0.1:${destinationPort}/postgres`;

  beforeAll(async () => {
    if (process.env.AIAG_TEST_DATABASE !== "1")
      throw Error("OFF_CLUSTER_RESTORE_TEST_GUARD");
    root = await mkdtemp(join(tmpdir(), "aiag-off-cluster-restore-"));
    sourcePort = await freePort();
    destinationPort = await freePort();
    if (sourcePort === destinationPort) destinationPort = await freePort();
    await bootCluster(sourcePort, join(root, "source"));
    await bootCluster(destinationPort, join(root, "destination"));

    // The owning role exists only on the source cluster. The destination
    // cluster keeps nothing but its own superuser.
    const sourceAdmin = new Client({
      connectionString: `postgres://postgres@127.0.0.1:${sourcePort}/postgres`,
      ...clientOptions,
    });
    await sourceAdmin.connect();
    try {
      await sourceAdmin.query(
        `CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await sourceAdmin.query(
        `CREATE DATABASE "${sourceDatabase}" OWNER "${ownerRole}" TEMPLATE template0`,
      );
    } finally {
      await sourceAdmin.end();
    }

    const migrate = await createPgTestClient(sourceUrl());
    await migrate.connect();
    try {
      await runNativeMigrations(migrate, await discoverNativeMigrations());
    } finally {
      await migrate.end();
    }
  }, 600_000);

  afterAll(async () => {
    if (root === "") return;
    for (const [port, name] of [
      [destinationPort, "destination"],
      [sourcePort, "source"],
    ] as const) {
      if (!port) continue;
      await exec("bash", [standScript, "reset"], {
        env: {
          PATH: process.env.PATH ?? "",
          PGDATA: join(root, name),
          PGPORT: String(port),
        },
        timeout: 120_000,
      }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }, 300_000);

  it("recreates the roles first, then restores owners, grants and the money snapshot, and replays an old payment to the same receipt", async () => {
    const source = new Client({
      connectionString: sourceUrl(),
      ...clientOptions,
    });
    await source.connect();
    let receiptCountBefore: number;
    let billingRequestId: string;
    try {
      const fixture = await seedOrgWithBalance(source);
      // Money history that must survive the cutover: one settled charge.
      const settled = await settleChargeViaGatewayAuthority(
        source,
        chargeInput(fixture),
      );
      billingRequestId = settled.billingRequestId;
      expect(settled.state).toBe("settled");

      const before = await readRestoreSnapshot(source);
      const sourceClusterId = (
        await source.query(
          "SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()",
        )
      ).rows[0]?.id;
      receiptCountBefore = Number(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM public.gateway_transactions WHERE org_id=$1 AND metadata->>'billing_request_id'=$2",
            [fixture.orgId, billingRequestId],
          )
        ).rows[0]?.n ?? 0,
      );
      expect(receiptCountBefore).toBe(1);
      // The dump genuinely depends on a role that exists only on the source.
      const required = rolesRequiredByAuthority(before.authority);
      expect(required).toContain(ownerRole);

      const destinationAdmin = new Client({
        connectionString: destinationAdminUrl(),
        ...clientOptions,
      });
      await destinationAdmin.connect();
      const rolesBefore = (
        await destinationAdmin.query(
          "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname=$1",
          [ownerRole],
        )
      ).rows;
      await destinationAdmin.end();
      expect(rolesBefore).toHaveLength(0);

      let verifiedRestoredUrl = "";
      const proof = await restoreOffCluster({
        sourceUrl: sourceUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
        roles: [ownerRole],
        verify: async (restoredUrl) => {
          verifiedRestoredUrl = restoredUrl;
          const restored = new Client({
            connectionString: restoredUrl,
            ...clientOptions,
          });
          await restored.connect();
          try {
            // The restored cluster is a different server, not another db.
            const cluster = (
              await restored.query(
                "SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()",
              )
            ).rows[0]?.id;
            expect(cluster).not.toBe(sourceClusterId);
            // Money survived exactly.
            const after = await readRestoreSnapshot(restored);
            expect(after.financialDigest).toBe(before.financialDigest);
            expect(after.counts).toEqual(before.counts);
            // Owners and grants survived exactly, and the role is the source one.
            expect(after.authority).toEqual(before.authority);
            // Owner survived: the table owner on the restored cluster is the
            // source-only role, not the destination's superuser.
            expect(
              (
                await restored.query(
                  "SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='organizations'",
                )
              ).rows[0]?.owner,
            ).toBe(ownerRole);
            // Replay of the old payment on the restored cluster: same receipt,
            // no second debit, no state change.
            const replay = await replayOldPaymentOnRestored(
              restored,
              fixture.orgId,
              billingRequestId,
            );
            expect(replay.didTransition).toBe(false);
            expect(replay.state).toBe("settled");
            expect(replay.receipts).toBe(receiptCountBefore);
            expect(
              (
                await restored.query(
                  "SELECT payg_credits::text AS amount FROM public.organizations WHERE id=$1",
                  [fixture.orgId],
                )
              ).rows[0].amount,
            ).toBe((BigInt(GRANT) - 30n).toString());
          } finally {
            await restored.end();
          }
        },
      });

      expect(verifiedRestoredUrl).toBe(proof.restoredUrl);
      expect(proof.kind).toBe("restored_off_cluster_and_verified");
      expect(proof.ownershipAndGrantsPreserved).toBe(true);
      expect(proof.financialSnapshotIdentical).toBe(true);
      expect(proof.sourceUnchanged).toBe(true);
      expect(proof.sourceClusterId).not.toBe(proof.destinationClusterId);
      expect(proof.tablesCompared).toBeGreaterThan(100);
      expect(proof.archiveBytes).toBeGreaterThan(0);
      expect(proof.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      // The role only existed on the source; the module had to create it here.
      expect(proof.rolesRecreatedOnDestination).toContain(ownerRole);
      expect(proof.destinationDatabase).toMatch(
        /^aiag_offcluster_[a-f0-9]{32}$/,
      );

      // Source cluster untouched by the restore.
      const stillSource = await readRestoreSnapshot(source);
      expect(stillSource.financialDigest).toBe(before.financialDigest);

      // Cleanup: the destination database and the archive are gone.
      const admin = new Client({
        connectionString: destinationAdminUrl(),
        ...clientOptions,
      });
      await admin.connect();
      try {
        expect(
          (
            await admin.query(
              "SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",
              [proof.destinationDatabase],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await admin.query(
              "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname=$1",
              [ownerRole],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await admin.end();
      }
    } finally {
      await source.end();
    }
  }, 600_000);
  it("refuses a destination on the same port and any non-local connection string", async () => {
    // Same port means same cluster: an in-cluster restore is not what this
    // module rehearses, so it is refused before anything is dumped.
    await expect(
      restoreOffCluster({
        sourceUrl: sourceUrl(),
        destinationAdminUrl: `postgres://postgres@127.0.0.1:${sourcePort}/postgres`,
        sourcePort,
        destPort: sourcePort,
      }),
    ).rejects.toThrow("TON_RESTORE_SAME_CLUSTER");
    // A non-loopback host or a mismatched port is refused as well.
    await expect(
      restoreOffCluster({
        sourceUrl: sourceUrl().replace("127.0.0.1", "10.0.0.5"),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
      }),
    ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    await expect(
      restoreOffCluster({
        sourceUrl: sourceUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort: sourcePort + 1,
        destPort: destinationPort,
      }),
    ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    // The source cluster is untouched by any of those refusals.
    const check = new Client({
      connectionString: sourceUrl(),
      ...clientOptions,
    });
    await check.connect();
    try {
      expect(
        (await check.query("SELECT current_database() AS name")).rows[0].name,
      ).toBe(sourceDatabase);
    } finally {
      await check.end();
    }
  }, 120_000);
});
