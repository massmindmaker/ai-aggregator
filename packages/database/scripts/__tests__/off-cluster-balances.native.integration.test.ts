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
  firstDebitAfterRestore,
  openingBalancesIdentical,
  readOpeningSnapshot,
  reconcileOpeningBalances,
  settleChargeViaGatewayAuthority,
  type BalanceBaseline,
  type BalanceSqlClient,
  type ChargeInput,
} from "../off-cluster-balances";
import { restoreOffCluster } from "../off-cluster-restore";
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
 * The cutover is executed by `restoreOffCluster` (Task 2's shipped module),
 * NOT by a hand-rolled pg_dump/pg_restore here. A local dump proves nothing
 * about the module the runbook actually ships: a regression inside
 * `off-cluster-restore.ts` — a dead grantee branch, a skipped role-attribute
 * comparison — is invisible to a test that never calls it. Two consequences
 * the module's contract imposes on this fixture, both satisfied below:
 *
 *   - the SOURCE side must be a superuser (`TON_RESTORE_SOURCE_NOT_SUPERUSER`,
 *     off-cluster-restore.ts:504): `pg_class`/`pg_proc` are filtered for an
 *     ordinary role, so a snapshot taken through the app login is blind and
 *     would "verify" equal while missing whole objects. Hence `sourceAdminUrl`.
 *   - the destination database name must match `^aiag_offcluster_[a-f0-9]{32}$`
 *     (off-cluster-restore.ts:455). The previous fixture used `aiag_dest_*`,
 *     which the module rejects with `TON_RESTORE_OPTIONS_INVALID`. The module
 *     also creates the destination database AND the roles itself, so the
 *     fixture must NOT pre-create either — that ordering is the whole point.
 *
 * Nothing here touches production, the shared 15432 test cluster, or real
 * money: every credit is a synthetic fixture row, and the only debits are
 * executed by the already-applied settlement functions.
 */

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const standScript = resolve(__dirname, "../restore-stand.sh");
const toolsPresent = existsSync(
  join(
    resolve(__dirname, "../../../../.superpowers/tools/native18/root"),
    "usr/lib/postgresql/18/bin/postgres",
  ),
);
const describeNative = enabled && toolsPresent ? describe : describe.skip;

const MODEL_SLUG = "openai/gpt-4o-mini";
const PROMPT_TOKENS = 30;
/** 0.1 cents/1k prompt x 30 tokens x markup 10 = 30 credits. */
const EXPECTED_COST = 30n;
const GRANT = "900000";
/**
 * TON grant for the fixture that must reconcile with a top-up in the ledger.
 *
 * A STRING, deliberately. `aiag_ton_text_v1` (0072:195-202) raises
 * TON_INVALID_STRING unless `jsonb_typeof(_j) = 'string'`, and
 * `aiag_ton_atomic_v1` (0072:210-215) routes every amount through it — so a
 * JSON number here is rejected before the invoice is even created. The working
 * TON fixture passes `"9007199254740991"` as a string for the same reason
 * (ton-payments.native.fixture.ts:118).
 */
const TON_GRANT = "12345";
const TON_GRANT_NUMBER = Number(TON_GRANT);
const TON_RECIPIENT = `0:${"1".repeat(64)}`;
const TON_SENDER = `0:${"2".repeat(64)}`;
const TON_ASSET = { network: "tvm:-3", kind: "native", decimals: 9 };

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
  /** Owner of the org; also the TON invoice actor. */
  ownerId: string;
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
  return { orgId, apiKeyId, ownerId };
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

/**
 * A REAL TON top-up, driven through the two authoritative SQL functions
 * (`aiag_create_ton_invoice_v1`, `aiag_settle_ton_invoice_v1`) rather than by
 * inserting a `gateway_transactions` row directly.
 *
 * This matters: the reason `source='ton'` had to be attributed to the PAYG
 * credits bucket is that migration 0072 moves `payg_credits` and writes the
 * receipt in ONE transaction. A hand-written ledger row would prove only that
 * the arithmetic in `readOpeningBalances` tolerates a positive delta — not that
 * an authoritative top-up reconciles. Here the balance really is raised by the
 * TON path, so `reconcileOpeningBalances` has to agree with money that moved
 * for real.
 */
async function settleTonTopup(
  client: Client,
  fixture: Fixture & { ownerId: string },
): Promise<number> {
  const now = Number(
    (
      await client.query(
        "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now",
      )
    ).rows[0]?.now,
  );
  const expiresAtMs = now + 600_000;
  const quote = {
    schemaVersion: 1,
    quoteId: `off-cluster-quote-${randomUUID()}`,
    sourcePrice: { unit: "gateway_microcredits", amountAtomic: TON_GRANT },
    asset: TON_ASSET,
    fx: {
      sourceUnit: "gateway_microcredits",
      targetAsset: TON_ASSET,
      numerator: "1",
      denominator: "1",
      rounding: "floor",
      source: "off-cluster-fixture-v1",
      observedAtMs: now - 1000,
      expiresAtMs,
    },
    additionalFeeAtomic: "0",
    amountAtomic: TON_GRANT,
    quotedAtMs: now,
    expiresAtMs,
  };
  const payload = {
    schemaVersion: 1,
    purpose: "gateway_topup",
    ownerId: fixture.ownerId,
    orgId: fixture.orgId,
    idempotencyKey: randomUUID(),
    grantMicrocredits: TON_GRANT,
    priceRevision: "off-cluster-fixture-v1",
    quote,
    recipient: TON_RECIPIENT,
    expectedSender: TON_SENDER,
    finalityPolicyId: "off-cluster-fixture-v1",
    verifierVersion: "off-cluster-fixture-v1",
  };
  const created = (
    await client.query(
      "SELECT aiag_create_ton_invoice_v1($1::uuid,$2::uuid,$3::jsonb,$4::text) AS result",
      [
        fixture.ownerId,
        fixture.orgId,
        JSON.stringify(payload),
        "0".repeat(64),
      ],
    )
  ).rows[0]?.result as { invoiceId: string; reference: string } | undefined;
  if (typeof created?.invoiceId !== "string")
    throw Error("OFF_CLUSTER_BALANCES_TON_INVOICE_NOT_CREATED");

  const seed = created.invoiceId.replaceAll("-", "");
  const credit = {
    network: "tvm:-3",
    asset: TON_ASSET,
    recipient: TON_RECIPIENT,
    recipientAccount: TON_RECIPIENT,
    sender: TON_SENDER,
    amountAtomic: TON_GRANT,
    reference: created.reference,
    txHash: `${seed}${seed}`,
    txLt: "1",
    messageHash: `${seed.split("").reverse().join("")}${seed.split("").reverse().join("")}`,
    messageIndex: 0,
    chainTimeMs: now - 3,
    observedAtMs: now - 2,
    verifiedAtMs: now - 1,
    blockAnchor: "off-cluster-block-v1",
    masterchainAnchor: "off-cluster-masterchain-v1",
    executionPathDigest: "5".repeat(64),
    verifierVersion: "off-cluster-fixture-v1",
    finalityPolicyId: "off-cluster-fixture-v1",
    jettonCredit: null,
  };
  const settled = (
    await client.query(
      "SELECT aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
      [created.invoiceId, JSON.stringify(credit)],
    )
  ).rows[0]?.result as { kind: string } | undefined;
  if (settled?.kind !== "settled")
    throw Error("OFF_CLUSTER_BALANCES_TON_NOT_SETTLED");
  return TON_GRANT_NUMBER;
}

describeNative("opening balances across an off-cluster cutover", () => {
  let root = "";
  let sourcePort = 0;
  let destinationPort = 0;
  const ownerRole = "ag6_" + randomUUID().replaceAll("-", "");
  const sourceDatabase = "aiag_source_" + randomUUID().replaceAll("-", "");
  // The module mints the destination name itself when `destinationDatabase` is
  // omitted, and then validates it against `^aiag_offcluster_[a-f0-9]{32}$`
  // (off-cluster-restore.ts:455). Letting it mint is the only way this fixture
  // stays in step with the module's contract: a hard-coded `aiag_dest_*` name
  // is rejected outright, which is exactly the mismatch this fixture used to
  // hide by not calling the module at all.
  const clientOptions = { ssl: false, connectionTimeoutMillis: 10_000 };

  const sourceUrl = () =>
    `postgres://${ownerRole}@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  /**
   * `restoreOffCluster` requires a superuser on the SOURCE too, not only on the
   * destination (`TON_RESTORE_SOURCE_NOT_SUPERUSER`, off-cluster-restore.ts:504):
   * `pg_class`/`pg_proc` are filtered to objects an ordinary role holds a
   * privilege on, so a snapshot taken through the app login silently omits
   * foreign-owned objects and then compares equal to an equally blind
   * destination snapshot. Fixtures are still seeded through `sourceUrl()` as
   * the owning role — that is what makes the module recreate it.
   */
  const sourceAdminUrl = () =>
    `postgres://postgres@127.0.0.1:${sourcePort}/${sourceDatabase}`;
  const destinationAdminUrl = () =>
    `postgres://postgres@127.0.0.1:${destinationPort}/postgres`;

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

        // --- off-host restore through the SHIPPED module ------------------
        // Not a local pg_dump/pg_restore: the runbook tells the operator to run
        // `restoreOffCluster`, so that is what has to be exercised here. The
        // module also creates the destination database and every required role
        // itself, in the order a real off-host recovery requires — so this
        // fixture must not pre-create either. `keepDestination` hands the
        // restored database back for the first-debit assertions below; the
        // destination cluster is a disposable stand, reset in afterAll.
        const proof = await restoreOffCluster({
          sourceUrl: sourceAdminUrl(),
          destinationAdminUrl: destinationAdminUrl(),
          sourcePort,
          destPort: destinationPort,
          // Not passed: the module must discover ownerRole from the owner/ACL
          // surface, exactly as it would in a real recovery.
          keepDestination: true,
        });
        expect(proof.kind).toBe("restored_off_cluster_and_verified");
        expect(proof.rolesRecreatedOnDestination).toContain(ownerRole);
        expect(proof.destinationDatabase).toMatch(
          /^aiag_offcluster_[a-f0-9]{32}$/,
        );

        const restored = new Client({
          connectionString: proof.restoredUrl,
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
    "reconciles an authoritative TON top-up, and still refuses a real divergence",
    async () => {
      const source = new Client({
        connectionString: sourceUrl(),
        ...clientOptions,
      });
      await source.connect();
      try {
        // A TON top-up moves payg_credits and writes its receipt in one
        // transaction (0072:393-399). If the reconciliation treated
        // `source='ton'` as unattributed movement, EVERY real database that
        // ever took a TON payment would report `consistent=false` — the
        // runbook reads that as "the balance moved outside the gateway
        // authority, stop the cutover", so the procedure would refuse a
        // perfectly healthy balance forever.
        const fixture = await seedOrgWithBalance(source, "0");
        const grant = await settleTonTopup(source, fixture);
        expect(grant).toBe(TON_GRANT_NUMBER);

        const tonRow = (
          await source.query(
            `SELECT count(*)::int AS n,coalesce(sum(delta),0)::text AS amount
               FROM public.gateway_transactions
              WHERE org_id=$1 AND type='topup' AND source='ton'`,
            [fixture.orgId],
          )
        ).rows[0];
        expect(tonRow).toEqual({ n: 1, amount: TON_GRANT });

        const baseline: Record<string, BalanceBaseline> = {
          [fixture.orgId]: { payg: "0", subscription: "0" },
        };
        const snapshot = await readOpeningSnapshot(source, [fixture.orgId]);
        // The grant is in the credits bucket and NOT in unattributedDelta.
        expect(snapshot.balances[0].paygCredits).toBe(TON_GRANT);
        expect(snapshot.balances[0].unattributedDelta).toBe("0");
        expect(reconcileOpeningBalances(snapshot, baseline).consistent).toBe(
          true,
        );

        // ...and the guard is not weakened: a real divergence still stops.
        // (a) a ledger movement with no bucket at all (an unknown source, the
        // shape `unattributedDelta` exists for) trips the reconciliation;
        await source.query(
          `INSERT INTO public.gateway_transactions(org_id,request_id,type,source,delta,metadata)
           VALUES($1,'off-cluster-unknown-source','topup','webhook',7,'{}'::jsonb)`,
          [fixture.orgId],
        );
        const unknownSource = await readOpeningSnapshot(source, [
          fixture.orgId,
        ]);
        expect(unknownSource.balances[0].unattributedDelta).toBe("7");
        expect(
          reconcileOpeningBalances(unknownSource, baseline).consistent,
        ).toBe(false);
        await source.query(
          `DELETE FROM public.gateway_transactions
            WHERE org_id=$1 AND request_id='off-cluster-unknown-source'`,
          [fixture.orgId],
        );

        // (b) a credit in the ledger that the balance does not reflect also
        // stops: attributing `source='ton'` to the credits bucket must not
        // become a way to make an unbalanced organisation look consistent.
        await source.query(
          "UPDATE public.organizations SET payg_credits=payg_credits+500 WHERE id=$1",
          [fixture.orgId],
        );
        const drifted = await readOpeningSnapshot(source, [fixture.orgId]);
        expect(reconcileOpeningBalances(drifted, baseline).consistent).toBe(
          false,
        );
        const line = reconcileOpeningBalances(drifted, baseline).lines[0];
        expect(line.expectedPayg).toBe(TON_GRANT);
        expect(line.observedPayg).toBe(String(TON_GRANT_NUMBER + 500));
      } finally {
        await source.end();
      }
    },
    300_000,
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
