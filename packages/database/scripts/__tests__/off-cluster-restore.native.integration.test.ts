import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readRestoreSnapshot,
  replayOldPaymentOnRestored,
  restoreOffCluster,
  rolesRequiredByAuthority,
} from "../off-cluster-restore";
// Task 2 depends on Task 3: the settled charge this suite replays after the
// cutover is produced by the Task 3 settlement helper. Both files live in this
// repository, but Task 2 does not build without Task 3.
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
 * `pg_control_system().system_identifier` plus data directory and postmaster
 * start time — and the destination starts with no application roles at all, so
 * the restore can only succeed if the roles are recreated there first. That is
 * the ordering a real off-host recovery has to follow, and it is the failure
 * this task exists to close.
 *
 * The source fixture deliberately includes a NOLOGIN role that OWNS a table:
 * `CREATE ROLE ... LOGIN ... NOLOGIN` is rejected by PostgreSQL as
 * `conflicting or redundant options`, so a rehearsal that always creates a
 * LOGIN role proves nothing about the NOLOGIN function owner this project
 * really uses.
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
        probe.close(() => reject(Error("no free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * A second TCP port in front of an already-running cluster. This is what
 * "one cluster, two ports" actually looks like on the wire, and it is the
 * headline guard of this module: the two URLs differ, yet they address the
 * same server, so the module has to notice rather than rehearse a restore into
 * itself.
 */
async function tcpProxy(
  targetPort: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server: Server = createServer((down) => {
    const up = connect(targetPort, "127.0.0.1");
    open.add(down);
    open.add(up);
    down.on("error", () => up.destroy());
    up.on("error", () => down.destroy());
    down.on("close", () => {
      open.delete(down);
      up.destroy();
    });
    up.on("close", () => {
      open.delete(up);
      down.destroy();
    });
    down.pipe(up).pipe(down);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("proxy has no port");
  return {
    port: address.port,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function bootCluster(port: number, pgdata: string) {
  await exec("bash", [standScript, "start"], {
    env: { PATH: process.env.PATH ?? "", PGDATA: pgdata, PGPORT: String(port) },
    timeout: 180_000,
  });
}

/**
 * A real physical clone of a running cluster on its own port, via
 * `pg_basebackup`.
 *
 * This is the only way to reach `TON_RESTORE_CLUSTER_LINEAGE_SAME` honestly.
 * The two cheap guards that stand in for it do not: naming the same cluster
 * twice is cut by `sourcePort === destPort`, and a TCP proxy is cut by the
 * declared-port check, because PostgreSQL reports its own real port in
 * `inet_server_port()` no matter which port was dialled. A basebackup clone
 * passes BOTH of those — different port, and the proxy's port would report the
 * master's — while inheriting `system_identifier` and living in a different
 * data directory. That is exactly the clone topology the branch exists for.
 */
async function basebackupClone(
  sourcePort: number,
  pgdata: string,
  port: number,
): Promise<void> {
  const bin = join(toolsRoot, "usr/lib/postgresql/18/bin");
  const lib = join(toolsRoot, "usr/lib/x86_64-linux-gnu");
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    LD_LIBRARY_PATH: lib,
    PGHOST: "127.0.0.1",
    PGPORT: String(sourcePort),
    PGUSER: "postgres",
    PGPASSFILE: "/dev/null",
    PGCONNECT_TIMEOUT: "5",
  };
  await rm(pgdata, { recursive: true, force: true });
  await mkdir(pgdata, { recursive: true });
  await chmod(pgdata, 0o700);
  await exec(join(bin, "pg_basebackup"), ["--no-password", "-D", pgdata], {
    env,
    timeout: 300_000,
    maxBuffer: 1048576,
  });
  // pg_basebackup creates the target at 0750, and this PostgreSQL build
  // refuses to start a data directory that is not 0700 (`data directory ... has
  // invalid permissions`) — measured here, not assumed. The stand script does
  // the same chmod after initdb.
  await chmod(pgdata, 0o700);
  // The stand script starts a cluster with its own socket dir and a fixed
  // set of options; reuse it for the clone so both clusters are configured the
  // same way and the ONLY difference is the data directory and the port.
  try {
    await exec(
      join(bin, "pg_ctl"),
      [
        "-D",
        pgdata,
        "-l",
        join(pgdata, "server.log"),
        "-o",
        `-p ${port} -h 127.0.0.1 -c listen_addresses=127.0.0.1 -c fsync=off -c unix_socket_directories='${pgdata}'`,
        "-w",
        "start",
      ],
      { env, timeout: 180_000, maxBuffer: 1048576 },
    );
  } catch (error) {
    // pg_ctl says only "examine the log"; include it, or a start failure in
    // CI is undiagnosable.
    const log = await readFile(join(pgdata, "server.log"), "utf8").catch(
      () => "(no server.log)",
    );
    throw Error(
      `OFF_CLUSTER_CLONE_START_FAILED\n${String((error as Error).message)}\n${log}`,
    );
  }
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
  // A NOLOGIN role that owns a table: the NOLOGIN function owner this project
  // actually uses. Its attributes are the ones CREATE ROLE must reproduce.
  const nologinRole = "ag6n_" + randomUUID().replaceAll("-", "").slice(0, 12);
  // A role that appears ONLY in a GRANT and never as an owner. This is the
  // case the grantee parse exists for: the owner column cannot see it, so if
  // the ACL surface is not read correctly it is missing from the required set,
  // never created on the destination, and pg_restore dies on `role does not
  // exist` — the exact failure this module exists to prevent.
  const granteeRole = "ag6g_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const nologinTable = "ag6n_owned_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const sourceDatabase =
    "aiag_source_" + randomUUID().replaceAll("-", "").slice(0, 20);
  const clientOptions = { ssl: false, connectionTimeoutMillis: 10_000 };

  const sourceUrl = () =>
    `postgres://${ownerRole}@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  /**
   * The module now requires a superuser on the SOURCE as well: pg_class and
   * pg_proc are filtered for ordinary roles, so a snapshot taken through the
   * application login would omit every foreign-owned object and then compare
   * "equal" to an equally blind destination snapshot.
   */
  const sourceAdminUrl = () =>
    `postgres://postgres@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  const destinationAdminUrl = () =>
    `postgres://postgres@127.0.0.1:${destinationPort}/postgres`;

  async function destinationAdmin(): Promise<Client> {
    const c = new Client({
      connectionString: destinationAdminUrl(),
      ...clientOptions,
    });
    await c.connect();
    return c;
  }

  /**
   * A plain `pg` client. `createPgTestClient` wraps queries in a
   * `{text, values}` config and exposes no positional form, which neither
   * `readRestoreSnapshot` nor the ad-hoc catalog reads below can use.
   */
  async function pgClient(url: string): Promise<Client> {
    const c = new Client({ connectionString: url, ...clientOptions });
    await c.connect();
    return c;
  }

  async function destinationRoleAttributes(
    names: readonly string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const admin = await destinationAdmin();
    try {
      const rows = (
        await admin.query(
          `SELECT rolname::text AS name,rolsuper AS superuser,rolinherit AS inherit,
                  rolcreaterole AS "createRole",rolcreatedb AS createdb,
                  rolcanlogin AS canlogin,rolreplication AS replication,
                  rolbypassrls AS bypassrls,rolconnlimit AS connlimit
             FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`,
          [[...names]],
        )
      ).rows;
      return new Map(rows.map((r) => [String(r.name), r]));
    } finally {
      await admin.end();
    }
  }

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
      // NOLOGIN, CREATEDB, NOINHERIT, CONNECTION LIMIT 7: several attribute
      // pairs that CREATE ROLE has to emit exactly once each.
      await sourceAdmin.query(
        `CREATE ROLE "${nologinRole}" NOLOGIN NOINHERIT CREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 7`,
      );
      // A plain LOGIN role that will own nothing and only ever appear as a
      // grantee. Created in beforeAll so it is part of the shared fixture.
      await sourceAdmin.query(
        `CREATE ROLE "${granteeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
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

    // A table owned by the NOLOGIN role, so the dump references a role whose
    // recreation has to succeed with NOLOGIN. Both statements run as the
    // cluster superuser: an ordinary role cannot hand a table to a NOLOGIN
    // owner it is not a member of.
    const owner = await pgClient(sourceAdminUrl());
    try {
      await owner.query(
        `CREATE TABLE public."${nologinTable}"(id int primary key)`,
      );
      await owner.query(
        `ALTER TABLE public."${nologinTable}" OWNER TO "${nologinRole}"`,
      );
      // The grantee-only role, reached through a GRANT. It owns nothing, so
      // the ONLY way it can enter the required set is a correct ACL read.
      await owner.query(
        `GRANT SELECT ON public."${nologinTable}" TO "${granteeRole}"`,
      );
    } finally {
      await owner.end();
    }
  }, 600_000);

  afterAll(async () => {
    if (root === "") return;
    // The lineage test stops its clone itself, but a failure before that
    // point would leave a postmaster running and its port bound.
    await exec(
      join(toolsRoot, "usr/lib/postgresql/18/bin/pg_ctl"),
      ["-D", join(root, "clone"), "-m", "immediate", "-w", "stop"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          LANG: "C.UTF-8",
          LD_LIBRARY_PATH: join(toolsRoot, "usr/lib/x86_64-linux-gnu"),
        },
        timeout: 120_000,
      },
    ).catch(() => undefined);
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

      // The snapshot is read through a SUPERUSER, exactly as the module reads
      // it: an application-role view is filtered to the objects that role may
      // see and would not describe the database being restored.
      const admin = new Client({
        connectionString: sourceAdminUrl(),
        ...clientOptions,
      });
      await admin.connect();
      const before = await readRestoreSnapshot(admin);
      const sourceClusterId = (
        await admin.query(
          "SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()",
        )
      ).rows[0]?.id;
      await admin.end();
      receiptCountBefore = Number(
        (
          await source.query(
            "SELECT count(*)::int AS n FROM public.gateway_transactions WHERE org_id=$1 AND metadata->>'billing_request_id'=$2",
            [fixture.orgId, billingRequestId],
          )
        ).rows[0]?.n ?? 0,
      );
      expect(receiptCountBefore).toBe(1);
      // The dump genuinely depends on roles that exist only on the source,
      // including a NOLOGIN one.
      const required = rolesRequiredByAuthority(before.authority);
      expect(required).toContain(ownerRole);
      expect(required).toContain(nologinRole);
      // The grantee-only role is NOT passed through `roles:` below, so it can
      // only be in this set if the `text[]` grantee column was actually read.
      // The column arrives from node-pg as a decoded string[]; parsing it as a
      // JSON string returned [] and silently dropped exactly this role.
      expect(required).toContain(granteeRole);
      // Assert the raw decoded shape directly, so a driver or pg-types change
      // that turns the column back into a string fails here with a clear
      // message instead of surfacing much later as a missing role.
      const shape = await pgClient(sourceAdminUrl());
      try {
        const row = (
          await shape.query(
            `SELECT s.grantees FROM (
               SELECT array_agg(DISTINCT pg_catalog.pg_get_userbyid(g.grantee))::text[] AS grantees
                 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) g
                WHERE c.oid = $1::regclass AND g.grantee <> 0) s`,
            [`public."${nologinTable}"`],
          )
        ).rows[0] as { grantees: unknown };
        expect(Array.isArray(row.grantees)).toBe(true);
        expect(row.grantees).toContain(granteeRole);
      } finally {
        await shape.end();
      }

      const destination = await destinationAdmin();
      const rolesBefore = (
        await destination.query(
          "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [[ownerRole, nologinRole, granteeRole]],
        )
      ).rows;
      await destination.end();
      expect(rolesBefore).toHaveLength(0);

      let verifiedRestoredUrl = "";
      const proof = await restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
        // Deliberately NOT passing granteeRole: it must be discovered from the
        // ACL surface, exactly as it would be in a real recovery.
        roles: [ownerRole, nologinRole],
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
            // Owners and grants survived exactly, and the roles are the source ones.
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
            // The NOLOGIN role was recreated as a NOLOGIN role, with its
            // CONNECTION LIMIT and CREATEDB/NOCREATEDB choices intact. This is
            // the assertion the old unconditional-LOGIN build could not make:
            // `CREATE ROLE ... LOGIN ... NOLOGIN` aborts the whole rehearsal.
            const nologinOnRestored = (
              await restored.query(
                "SELECT rolcanlogin AS canlogin,rolcreatedb AS createdb,rolinherit AS inherit,rolconnlimit::text AS connlimit FROM pg_catalog.pg_roles WHERE rolname=$1",
                [nologinRole],
              )
            ).rows[0];
            expect(nologinOnRestored).toBeTruthy();
            expect(nologinOnRestored.canlogin).toBe(false);
            expect(nologinOnRestored.createdb).toBe(true);
            expect(nologinOnRestored.inherit).toBe(false);
            expect(nologinOnRestored.connlimit).toBe("7");
            // And it really owns the restored table.
            expect(
              (
                await restored.query(
                  "SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1",
                  [nologinTable],
                )
              ).rows[0]?.owner,
            ).toBe(nologinRole);
            // The grantee-only role exists on the restored cluster and really
            // holds the GRANT that put it in the required set. This is the
            // assertion the old build could not make: with the ACL parse dead,
            // the role was never created and the restore never got this far.
            expect(
              (
                await restored.query(
                  "SELECT has_table_privilege($1,$2,'SELECT') AS granted",
                  [granteeRole, `public."${nologinTable}"`],
                )
              ).rows[0]?.granted,
            ).toBe(true);
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
      expect(proof.roleAttributesVerified).toBe(true);
      expect(proof.membershipsIdentical).toBe(true);
      expect(proof.sourceClusterId).not.toBe(proof.destinationClusterId);
      expect(proof.tablesCompared).toBeGreaterThan(100);
      expect(proof.archiveBytes).toBeGreaterThan(0);
      expect(proof.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      // The roles only existed on the source; the module had to create them here.
      expect(proof.rolesRecreatedOnDestination).toContain(ownerRole);
      expect(proof.rolesRecreatedOnDestination).toContain(nologinRole);
      // The grantee-only role, created with no help from `roles:`. If the ACL
      // parse were dead this role would be absent here AND pg_restore would
      // have aborted with `role does not exist` before the proof was built.
      expect(proof.rolesRecreatedOnDestination).toContain(granteeRole);
      expect(proof.destinationDatabase).toMatch(
        /^aiag_offcluster_[a-f0-9]{32}$/,
      );

      // Source cluster untouched by the restore.
      const stillSource = new Client({
        connectionString: sourceAdminUrl(),
        ...clientOptions,
      });
      await stillSource.connect();
      try {
        expect(
          (await readRestoreSnapshot(stillSource)).financialDigest,
        ).toBe(before.financialDigest);
      } finally {
        await stillSource.end();
      }

      // Cleanup: the destination database and the created roles are gone.
      const destinationCheck = await destinationAdmin();
      try {
        expect(
          (
            await destinationCheck.query(
              "SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",
              [proof.destinationDatabase],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await destinationCheck.query(
              "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
              [[ownerRole, nologinRole, granteeRole]],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await destinationCheck.end();
      }
    } finally {
      await source.end();
    }
  }, 600_000);

  it("refuses one cluster reached on two ports, and any non-local connection string", async () => {
    // Two URLs, one server. The ports differ and both are loopback, so only
    // comparing the actual cluster identity can catch this — the headline
    // guard of the module, and the case that used to be unchecked.
    const proxy = await tcpProxy(sourcePort);
    try {
      // A second port in front of the SAME server. PostgreSQL reports its own
      // real port in `inet_server_port()` regardless of the port the client
      // dialled, so a port-forward is caught one step earlier than the
      // cluster-identity comparison — as a declared-port mismatch, not as a
      // cluster-identity match. Either way the rehearsal is refused before
      // anything is dumped, which is the property that matters: the guard is
      // not "different URL, therefore different cluster".
      await expect(
        restoreOffCluster({
          sourceUrl: sourceAdminUrl(),
          destinationAdminUrl: `postgres://postgres@127.0.0.1:${proxy.port}/postgres`,
          sourcePort,
          destPort: proxy.port,
        }),
      ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    } finally {
      await proxy.close();
    }
    // The same cluster named directly on the same port.
    await expect(
      restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: `postgres://postgres@127.0.0.1:${sourcePort}/postgres`,
        sourcePort,
        destPort: sourcePort,
      }),
    ).rejects.toThrow("TON_RESTORE_SAME_CLUSTER");
    // A non-loopback host or a mismatched port is refused as well.
    await expect(
      restoreOffCluster({
        sourceUrl: sourceAdminUrl().replace("127.0.0.1", "10.0.0.5"),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
      }),
    ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    await expect(
      restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort: sourcePort + 1,
        destPort: destinationPort,
      }),
    ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    // An arbitrary local database name is not a rehearsal target: with a
    // permissive pattern and AIAG_TEST_DATABASE=1 this would dump whatever
    // database the caller names, including a developer's own postgres.
    await expect(
      restoreOffCluster({
        sourceUrl: `postgres://postgres@127.0.0.1:${sourcePort}/postgres`,
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
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
  }, 300_000);

  it("refuses a physical clone of the source, which inherits its system identifier", async () => {
    // The other half of the cluster-identity guard. SAME_CLUSTER covers one
    // server on two ports; this covers a basebackup/PITR stand, which is the
    // NORMAL off-host topology: it INHERITS system_identifier, so a naive
    // identifier comparison would call two separate lineages "the same
    // cluster" and send the operator to the wrong runbook. The module
    // distinguishes them by data directory and postmaster start time.
    //
    // A real pg_basebackup clone is used, not a stub, because the two cheap
    // guards cannot reach this branch: the same port twice is cut by
    // `sourcePort === destPort`, and a TCP proxy is cut by the declared-port
    // check because PostgreSQL reports its own real port whatever was dialled.
    // The clone satisfies both of those and still inherits the identifier, so
    // this is the only arrangement that actually reaches the comparison.
    const clonePort = await freePort();
    const cloneData = join(root, "clone");
    await basebackupClone(sourcePort, cloneData, clonePort);
    const cloneUrl = `postgres://postgres@127.0.0.1:${clonePort}/postgres`;
    try {
      // Precondition, asserted rather than assumed: the clone really does
      // carry the source's identifier, and really is a different data
      // directory on a different port. Without this the expected failure code
      // below would prove nothing — a genuinely independent cluster would also
      // fail the rehearsal, just with a different code.
      const master = await pgClient(`postgres://postgres@127.0.0.1:${sourcePort}/postgres`);
      const clone = await pgClient(cloneUrl);
      try {
        const probe = `SELECT system_identifier::text AS id,current_setting('data_directory') AS dir,inet_server_port()::int AS port FROM pg_catalog.pg_control_system()`;
        const a = (await master.query(probe)).rows[0] as {
          id: string;
          dir: string;
          port: number;
        };
        const b = (await clone.query(probe)).rows[0] as {
          id: string;
          dir: string;
          port: number;
        };
        expect(b.id).toBe(a.id);
        expect(b.dir).not.toBe(a.dir);
        expect(b.port).toBe(clonePort);
      } finally {
        await master.end();
        await clone.end();
      }

      await expect(
        restoreOffCluster({
          sourceUrl: sourceAdminUrl(),
          destinationAdminUrl: cloneUrl,
          sourcePort,
          destPort: clonePort,
        }),
      ).rejects.toThrow("TON_RESTORE_CLUSTER_LINEAGE_SAME");
    } finally {
      await exec(
        join(toolsRoot, "usr/lib/postgresql/18/bin/pg_ctl"),
        ["-D", cloneData, "-m", "immediate", "-w", "stop"],
        {
          env: {
            PATH: process.env.PATH ?? "",
            LANG: "C.UTF-8",
            LD_LIBRARY_PATH: join(toolsRoot, "usr/lib/x86_64-linux-gnu"),
          },
          timeout: 120_000,
        },
      ).catch(() => undefined);
      await rm(cloneData, { recursive: true, force: true });
    }
  }, 600_000);

  it("refuses a non-superuser source, whose catalog view would silently skip foreign objects", async () => {
    // pg_class/pg_proc are filtered for an ordinary role, so a snapshot taken
    // through the application login cannot see the objects that the NOLOGIN
    // role owns — it cannot even count that table's rows. Comparing two such
    // blind snapshots would "verify" happily while never having looked at
    // those objects.
    const owner = await pgClient(sourceUrl());
    try {
      // The blind view really does fail on the NOLOGIN-owned table.
      await expect(readRestoreSnapshot(owner)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await owner.end();
    }
    const admin = await pgClient(sourceAdminUrl());
    try {
      const complete = await readRestoreSnapshot(admin);
      expect(
        complete.authority.some((r: { name: string }) =>
          r.name.endsWith("." + nologinTable),
        ),
      ).toBe(true);
    } finally {
      await admin.end();
    }
    await expect(
      restoreOffCluster({
        sourceUrl: sourceUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
        roles: [ownerRole],
      }),
    ).rejects.toThrow("TON_RESTORE_SOURCE_NOT_SUPERUSER");
  }, 300_000);

  it("refuses a role that exists on the destination with different attributes", async () => {
    // The role already exists on the destination, so the recreation loop skips
    // it and never checks its attributes. A CREATEDB/CONNECTION LIMIT difference
    // is a privilege change across the cutover and must be an explicit error,
    // not a silent pass.
    const existing = "ag6x_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const sourceAdmin = await pgClient(sourceAdminUrl());
    try {
      await sourceAdmin.query(
        `CREATE ROLE "${existing}" NOLOGIN NOINHERIT NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 7`,
      );
    } finally {
      await sourceAdmin.end();
    }
    const admin = await destinationAdmin();
    try {
      // Same name, different attributes: LOGIN instead of NOLOGIN.
      await admin.query(
        `CREATE ROLE "${existing}" LOGIN INHERIT NOCREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 7`,
      );
    } finally {
      await admin.end();
    }
    await expect(
      restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
        roles: [existing],
      }),
    ).rejects.toThrow("TON_RESTORE_ROLE_ATTRIBUTES_MISMATCH");
    // The pre-existing role is NOT this run's to drop: cleanup must leave it.
    const after = await destinationAdmin();
    try {
      const rows = (
        await after.query(
          "SELECT rolname::text AS name FROM pg_catalog.pg_roles WHERE rolname=$1",
          [existing],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      await after.query(`DROP ROLE "${existing}"`);
    } finally {
      await after.end();
    }
  }, 300_000);

  it("accepts a role that already matches on the destination, without recreating or dropping it", async () => {
    // Same name, same attributes: the pre-existing role is reused as is, must
    // not be reported as recreated, and must survive cleanup untouched.
    const existing = "ag6y_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const create = `CREATE ROLE "${existing}" NOLOGIN NOINHERIT CREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 7`;
    const sourceAdmin = await pgClient(sourceAdminUrl());
    try {
      await sourceAdmin.query(create);
    } finally {
      await sourceAdmin.end();
    }
    const admin = await destinationAdmin();
    try {
      await admin.query(create);
    } finally {
      await admin.end();
    }
    const proof = await restoreOffCluster({
      sourceUrl: sourceAdminUrl(),
      destinationAdminUrl: destinationAdminUrl(),
      sourcePort,
      destPort: destinationPort,
      roles: [existing],
    });
    expect(proof.roleAttributesVerified).toBe(true);
    expect(proof.rolesRecreatedOnDestination).not.toContain(existing);
    const after = await destinationRoleAttributes([existing]);
    expect(after.get(existing)?.canlogin).toBe(false);
    expect(after.get(existing)?.createdb).toBe(true);
    const cleanup = await destinationAdmin();
    try {
      await cleanup.query(`DROP ROLE "${existing}"`);
    } finally {
      await cleanup.end();
    }
  }, 600_000);

  it("ignores a membership between roles the restore does not depend on", async () => {
    // Scope check for the membership comparison. Comparing the WHOLE cluster
    // made the rehearsal fail on any destination that has a membership of its
    // own, which on a real destination is nearly always true — a monitoring
    // group, a vendor login — so operators would learn to ignore a hard stop.
    // A membership touching NEITHER required role is now out of scope.
    //
    // The other direction is unchanged and is asserted by the test above: a
    // membership that names a role the dump depends on still fails, because
    // pg_dump cannot carry it and effective rights would vanish at cutover.
    const outsiderGroup = "ag6og_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const outsiderMember = "ag6om_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const admin = await destinationAdmin();
    try {
      await admin.query(`CREATE ROLE "${outsiderGroup}" NOLOGIN`);
      await admin.query(`CREATE ROLE "${outsiderMember}" LOGIN`);
      await admin.query(`GRANT "${outsiderGroup}" TO "${outsiderMember}"`);
    } finally {
      await admin.end();
    }
    try {
      const proof = await restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
      });
      expect(proof.membershipsIdentical).toBe(true);
    } finally {
      for (const url of [sourceAdminUrl(), destinationAdminUrl()]) {
        const c = new Client({ connectionString: url, ...clientOptions });
        await c.connect();
        try {
          await c.query(`DROP ROLE IF EXISTS "${outsiderMember}"`);
          await c.query(`DROP ROLE IF EXISTS "${outsiderGroup}"`);
        } finally {
          await c.end();
        }
      }
    }
  }, 600_000);

  it("refuses when a required role is missing from the source", async () => {
    await expect(
      restoreOffCluster({
        sourceUrl: sourceAdminUrl(),
        destinationAdminUrl: destinationAdminUrl(),
        sourcePort,
        destPort: destinationPort,
        roles: ["ag6_absent_" + randomUUID().replaceAll("-", "").slice(0, 8)],
      }),
    ).rejects.toThrow("TON_RESTORE_ROLES_MISSING");
  }, 300_000);


  it("keeps the destination database and the archive when asked", async () => {
    const proof = await restoreOffCluster({
      sourceUrl: sourceAdminUrl(),
      destinationAdminUrl: destinationAdminUrl(),
      sourcePort,
      destPort: destinationPort,
      keepDestination: true,
    });
    expect(proof.destinationRemoved).toBe(false);
    expect(proof.archiveRemoved).toBe(false);
    const admin = await destinationAdmin();
    try {
      expect(
        (
          await admin.query(
            "SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",
            [proof.destinationDatabase],
          )
        ).rows,
      ).toHaveLength(1);
      await admin.query(
        'DROP DATABASE "' + proof.destinationDatabase + '" WITH (FORCE)',
      );
    } finally {
      await admin.end();
    }
  }, 600_000);

  it("refuses to replay a payment without the test-database flag", async () => {
    // replayOldPaymentOnRestored calls the settlement function, the one place
    // in this module that moves money. It must carry the same guards as every
    // other connection here.
    const source = new Client({
      connectionString: sourceAdminUrl(),
      ...clientOptions,
    });
    await source.connect();
    const previous = process.env.AIAG_TEST_DATABASE;
    try {
      delete process.env.AIAG_TEST_DATABASE;
      await expect(
        replayOldPaymentOnRestored(
          source,
          randomUUID(),
          randomUUID(),
        ),
      ).rejects.toThrow("TON_RESTORE_LOCAL_ONLY");
    } finally {
      if (previous !== undefined) process.env.AIAG_TEST_DATABASE = previous;
      await source.end();
    }
  }, 120_000);

  it("refuses a role membership that the dump cannot carry", async () => {
    // pg_dump emits no cluster-global grants, so a membership is invisible to
    // the owner/ACL and row-count comparisons yet decides the effective rights
    // after cutover. Money loses access rather than double-spending, so the
    // rehearsal fails loudly instead of proving a false success.
    const group = "ag6g_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const member = "ag6m_" + randomUUID().replaceAll("-", "").slice(0, 12);
    const sourceAdmin = await pgClient(sourceAdminUrl());
    try {
      await sourceAdmin.query(`CREATE ROLE "${group}" NOLOGIN`);
      await sourceAdmin.query(`CREATE ROLE "${member}" LOGIN`);
      await sourceAdmin.query(`GRANT "${group}" TO "${member}"`);
    } finally {
      await sourceAdmin.end();
    }
    try {
      await expect(
        restoreOffCluster({
          sourceUrl: sourceAdminUrl(),
          destinationAdminUrl: destinationAdminUrl(),
          sourcePort,
          destPort: destinationPort,
          roles: [group, member],
        }),
      ).rejects.toThrow("TON_RESTORE_MEMBERSHIP_MISMATCH");
    } finally {
      // Both clusters. The membership lives on the SOURCE, so leaving it there
      // would make every later test in this file fail the same comparison.
      // Dropping the member role takes its membership rows with it, so there is
      // no REVOKE to issue — and these roles may never have reached the
      // destination at all, which REVOKE would error on.
      for (const url of [sourceAdminUrl(), destinationAdminUrl()]) {
        const admin = new Client({ connectionString: url, ...clientOptions });
        await admin.connect();
        try {
          await admin.query(`DROP ROLE IF EXISTS "${member}"`);
          await admin.query(`DROP ROLE IF EXISTS "${group}"`);
        } finally {
          await admin.end();
        }
      }
    }
  }, 600_000);

});
