import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  firstDebitAfterRestore,
  openingBalancesIdentical,
  readOpeningSnapshot,
  reconcileOpeningBalances,
  settleChargeViaGatewayAuthority,
  type BalanceBaseline,
  type BalanceSqlClient,
  type ChargeInput,
} from "../off-cluster-balances";
import { createPgTestClient } from "../pg-test-client";
import {
  discoverNativeMigrations,
  runNativeMigrations,
} from "../native-migrate";

const exec = promisify(execFile);

/**
 * AG-6 Task 3: opening balances at cutover, on top of the off-cluster stand.
 *
 * Two disposable PostgreSQL clusters are booted on dynamically picked ports
 * (15432/15433 are shared with other native suites), the schema and money
 * history live on the source cluster, and the restore lands on the destination
 * cluster AFTER the owning roles have been recreated there — the order a real
 * off-host recovery has to follow.
 *
 * Nothing here touches production, the shared 15432 test cluster, or real
 * money: every credit is a synthetic fixture row, and the only debits are
 * executed by the already-applied settlement functions.
 */

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const toolsRoot = resolve(
  __dirname,
  "../../../../.superpowers/tools/native18/root",
);
const bin = join(toolsRoot, "usr/lib/postgresql/18/bin");
const standScript = resolve(__dirname, "../restore-stand.sh");
const libPath = join(toolsRoot, "usr/lib/x86_64-linux-gnu");
const toolsPresent = existsSync(join(bin, "postgres"));
const describeNative = enabled && toolsPresent ? describe : describe.skip;

const MODEL_SLUG = "openai/gpt-4o-mini";
const PROMPT_TOKENS = 30;
/** 0.1 cents/1k prompt x 30 tokens x markup 10 = 30 credits. */
const EXPECTED_COST = 30n;
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
    env: {
      PATH: process.env.PATH ?? "",
      PGDATA: pgdata,
      PGPORT: String(port),
    },
    timeout: 180_000,
  });
}

interface Fixture {
  orgId: string;
  apiKeyId: string;
}

/** Every fixture is created explicitly and its insert must be acknowledged. */
async function seedOrgWithBalance(
  client: Client,
  grant: string = GRANT,
): Promise<Fixture> {
  const orgId = randomUUID();
  const apiKeyId = randomUUID();
  const ownerId = randomUUID();
  const user = await client.query(
    "INSERT INTO public.users(id,email) VALUES($1,$2) RETURNING id::text AS id",
    [ownerId, `off-cluster-${ownerId}@example.test`],
  );
  if (user.rows[0]?.id !== ownerId)
    throw Error("OFF_CLUSTER_BALANCES_USER_NOT_CREATED");
  const org = await client.query(
    `INSERT INTO public.organizations(id,slug,name,owner_id,payg_credits)
     VALUES($1,$2,'off-cluster',$3,$4::bigint) RETURNING id::text AS id`,
    [orgId, orgId, ownerId, grant],
  );
  if (org.rows[0]?.id !== orgId)
    throw Error("OFF_CLUSTER_BALANCES_ORG_NOT_CREATED");
  const key = await client.query(
    `INSERT INTO public.gateway_api_keys(id,org_id,name,key_hash,key_prefix)
     VALUES($1,$2,'off-cluster',$3,$4) RETURNING id::text AS id`,
    [apiKeyId, orgId, randomUUID(), `oc-${apiKeyId.slice(0, 12)}`],
  );
  if (key.rows[0]?.id !== apiKeyId)
    throw Error("OFF_CLUSTER_BALANCES_KEY_NOT_CREATED");
  const policy = await client.query(
    `INSERT INTO public.gateway_quota_org_policies(org_id,enforcement_version)
     VALUES($1,2) RETURNING org_id::text AS org_id`,
    [orgId],
  );
  if (policy.rows[0]?.org_id !== orgId)
    throw Error("OFF_CLUSTER_BALANCES_POLICY_NOT_CREATED");
  return { orgId, apiKeyId };
}

function chargeInput(
  fixture: Fixture,
  overrides: Partial<ChargeInput> = {},
): ChargeInput {
  return {
    orgId: fixture.orgId,
    apiKeyId: fixture.apiKeyId,
    billingRequestId: randomUUID(),
    attemptId: randomUUID(),
    declaredSessionId: null,
    modelSlug: MODEL_SLUG,
    promptTokens: PROMPT_TOKENS,
    deadline: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

describeNative("opening balances across an off-cluster cutover", () => {
  let root = "";
  let sourcePort = 0;
  let destinationPort = 0;
  const ownerRole = "ag6_" + randomUUID().replaceAll("-", "");
  const sourceDatabase = "aiag_source_" + randomUUID().replaceAll("-", "");
  const destinationDatabase = "aiag_dest_" + randomUUID().replaceAll("-", "");
  const clientOptions = { ssl: false, connectionTimeoutMillis: 10_000 };

  const sourceUrl = () =>
    `postgres://${ownerRole}@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  const destinationUrl = () =>
    `postgres://${ownerRole}@127.0.0.1:${destinationPort}/${destinationDatabase}`;

  beforeAll(async () => {
    if (process.env.AIAG_TEST_DATABASE !== "1")
      throw Error("OFF_CLUSTER_BALANCES_TEST_GUARD");
    root = await mkdtemp(join(tmpdir(), "aiag-off-cluster-balances-"));
    sourcePort = await freePort();
    destinationPort = await freePort();
    await bootCluster(sourcePort, join(root, "source"));
    await bootCluster(destinationPort, join(root, "destination"));

    // The owning role exists only on the source cluster until we recreate it
    // on the destination — exactly the off-host ordering failure mode.
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

  it(
    "carries the balance and its ledger across restore and debits the first spend from it",
    async () => {
      const source = new Client({
        connectionString: sourceUrl(),
        ...clientOptions,
      });
      await source.connect();
      try {
        const fixture = await seedOrgWithBalance(source);

        // Money history that must survive the cutover: one fully settled
        // charge, producing a receipt, a settlement event and quota buckets.
        const history = await settleChargeViaGatewayAuthority(
          source,
          chargeInput(fixture),
        );
        expect(history.state).toBe("settled");
        expect(history.actualCostCredits).toBe(EXPECTED_COST.toString());

        const client: BalanceSqlClient = source;
        const before = await readOpeningSnapshot(client, [fixture.orgId]);
        const baseline: Record<string, BalanceBaseline> = {
          [fixture.orgId]: { payg: GRANT, subscription: "0" },
        };
        // Ledger and balance agree before the cutover, on the source cluster.
        expect(reconcileOpeningBalances(before, baseline).consistent).toBe(true);
        expect(before.balances[0].balancePayg).toBe(
          (BigInt(GRANT) - EXPECTED_COST).toString(),
        );
        expect(before.balances[0].paygDebits).toBe(EXPECTED_COST.toString());

        // --- off-host restore, roles first -------------------------------
        const destinationAdmin = new Client({
          connectionString: `postgres://postgres@127.0.0.1:${destinationPort}/postgres`,
          ...clientOptions,
        });
        await destinationAdmin.connect();
        const archive = join(root, "source.dump");
        try {
          const env = {
            PATH: process.env.PATH ?? "",
            LANG: "C.UTF-8",
            LD_LIBRARY_PATH: libPath,
            PGHOST: "127.0.0.1",
            PGUSER: ownerRole,
            PGPASSFILE: "/dev/null",
            PGCONNECT_TIMEOUT: "5",
          };
          await exec(
            join(bin, "pg_dump"),
            [
              "--format=custom",
              "--no-password",
              "--file",
              archive,
              "--dbname",
              sourceUrl(),
            ],
            { env: { ...env, PGPORT: String(sourcePort) }, timeout: 180_000 },
          );
          expect((await stat(archive)).size).toBeGreaterThan(0);

          await destinationAdmin.query(
            `CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
          );
          await destinationAdmin.query(
            `CREATE DATABASE "${destinationDatabase}" OWNER "${ownerRole}" TEMPLATE template0`,
          );
          await exec(
            join(bin, "pg_restore"),
            [
              "--exit-on-error",
              "--single-transaction",
              "--no-password",
              "--dbname",
              destinationUrl(),
              archive,
            ],
            {
              env: { ...env, PGPORT: String(destinationPort) },
              timeout: 180_000,
            },
          );
        } finally {
          await destinationAdmin.end();
        }

        const restored = new Client({
          connectionString: destinationUrl(),
          ...clientOptions,
        });
        await restored.connect();
        try {
          const after = await readOpeningSnapshot(restored, [fixture.orgId]);
          // Opening balances at cutover: identical, down to the ledger digest.
          expect(openingBalancesIdentical(before, after)).toBe(true);
          expect(after.balances[0].balancePayg).toBe(
            (BigInt(GRANT) - EXPECTED_COST).toString(),
          );
          expect(reconcileOpeningBalances(after, baseline).consistent).toBe(
            true,
          );

          // The first spend after the cutover must come out of that balance.
          const debit = await firstDebitAfterRestore(
            restored,
            chargeInput(fixture),
          );
          expect(debit.balanceBefore).toBe(
            (BigInt(GRANT) - EXPECTED_COST).toString(),
          );
          expect(debit.balanceAfter).toBe(
            (BigInt(GRANT) - 2n * EXPECTED_COST).toString(),
          );
          expect(debit.balanceAfter).toBe(debit.balanceExpected);
          expect(debit.receiptRows).toBe(1);
          expect(debit.settlementEventRows).toBe(1);
          expect(debit.replayDidTransition).toBe(false);
          expect(debit.receiptAfterReplay).toBe(1);
          expect(debit.quotaReservedAfter).toBe("0");

          // ledger/quota/receipt stay consistent after the restored debit.
          const postDebit = await readOpeningSnapshot(restored, [
            fixture.orgId,
          ]);
          expect(
            reconcileOpeningBalances(postDebit, baseline).consistent,
          ).toBe(true);
          expect(postDebit.balances[0].paygDebits).toBe(
            (2n * EXPECTED_COST).toString(),
          );
        } finally {
          await restored.end();
        }

        // The source cluster is untouched by the restore and the restored debit.
        const stillSource = await readOpeningSnapshot(source, [fixture.orgId]);
        expect(openingBalancesIdentical(before, stillSource)).toBe(true);
      } finally {
        await source.end();
      }
    },
    900_000,
  );

  it(
    "refuses to fund the first debit from a balance the restore did not carry",
    async () => {
      // Own fixture: the guard must hold on its own, not by inheriting rows
      // another test happens to have left behind.
      const source = new Client({
        connectionString: sourceUrl(),
        ...clientOptions,
      });
      await source.connect();
      try {
        const fixture = await seedOrgWithBalance(source, "0");
        const before = await readOpeningSnapshot(source, [fixture.orgId]);
        expect(before.balances[0].balancePayg).toBe("0");

        await expect(
          firstDebitAfterRestore(source, {
            ...chargeInput(fixture),
            rejectHoldAboveBalance: true,
          }),
        ).rejects.toThrow("OFF_CLUSTER_BALANCE_HOLD_EXCEEDS_RESTORED");

        // A refused debit leaves no admission, no hold and no receipt behind.
        expect(
          (
            await source.query(
              `SELECT count(*)::int AS n FROM public.gateway_charge_admissions
               WHERE org_id=$1 AND client_request_id='off-cluster-cutover'`,
              [fixture.orgId],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (await readOpeningSnapshot(source, [fixture.orgId])).balances[0]
            .balancePayg,
        ).toBe("0");
      } finally {
        await source.end();
      }
    },
    300_000,
  );
});
