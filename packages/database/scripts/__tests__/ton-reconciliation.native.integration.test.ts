import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createQuote } from "@aiag/shared/ton-payment-contract";
import type { Asset } from "@aiag/shared/ton-payment-contract";
import {
  createTonInvoice,
  expireTonInvoice,
  settleTonInvoice,
  type CreateTonInvoiceInput,
  type TonInvoice,
  type TonPaymentDatabase,
  type VerifiedChainCredit,
} from "../../src";
import {
  advanceTonReconciliationCursor,
  bindTonReconciliationRecipient,
  claimTonReconciliationLease,
  createTonWorkerDatabase,
  findTonInvoicesForReconciliation,
  getTonInvoiceForReconciliation,
  listTonReconciliationSources,
  recordTonChainObservation,
  releaseTonReconciliationLease,
  renewTonReconciliationLease,
  type CloseableTonWorkerDatabase,
  type TonObservationInput,
  type TonReconciliationSource,
  type TonSweepCursor,
} from "../../src/ton-reconciliation-internal";
import { discoverNativeMigrations, runNativeMigrations } from "../native-migrate";
import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type QueryConfig,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN = process.env.RUN_NATIVE_DB_INTEGRATION === "1";
if (RUN) assertTestDatabaseEnvironment(process.env);

const TARGET = "ai_aggregator_ton_reconciliation_test";
const PREMARKER_TARGET = "ai_aggregator_ton_reconciliation_premarker_test";
const POSTADAPTER_TARGET = "ai_aggregator_ton_reconciliation_postadapter_test";
const NATIVE_ASSET: Asset = Object.freeze({
  network: "tvm:-3",
  kind: "native",
  decimals: 9,
});
const OWNER = randomUUID();
const ORG = randomUUID();
const SENDER = `0:${"e".repeat(64)}`;
const PROVIDER = "toncenter-v3-testnet" as const;
const openDatabases = new Set<CloseableTonWorkerDatabase>();

let target: TestDatabaseClient;
let canonicalDb: TestDatabaseClient;
let mainDb: CloseableTonWorkerDatabase;
let targetUrl: string;
let targetOid: string;
let marker: string;
let setupPromise: Promise<void>;
let releaseSetup!: () => void;

function db(): CloseableTonWorkerDatabase {
  const database = createTonWorkerDatabase(targetUrl);
  openDatabases.add(database);
  return database;
}

async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
) {
  return target.query<Row>({ text, values });
}

function rawAddress(seed = randomUUID().replaceAll("-", "")): string {
  return `0:${createHash("sha256").update(seed).digest("hex")}`;
}

function reconciliationSource(recipient: string, floor = 1_789_000_000_000): TonReconciliationSource {
  return {
    sourceId: createHash("sha256")
      .update(
        `${PROVIDER}\0{"decimals":9,"kind":"native","network":"tvm:-3"}\0${recipient}`,
      )
      .digest("hex"),
    network: "tvm:-3",
    asset: NATIVE_ASSET,
    invoiceRecipient: recipient,
    scanFloorTimeMs: floor,
  };
}

async function databaseNowMs(): Promise<number> {
  const result = await query<{ value: string }>(
    "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS value",
  );
  return Number(result.rows[0]?.value);
}

async function waitForRowLock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1::integer",
      [pid],
    );
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ton_reconciliation_lock_barrier_timeout");
}

async function runCursorBarrier(input: {
  sourceId: string;
  contender: QueryConfig;
  mutation: QueryConfig;
  expected: string;
}): Promise<void> {
  const blocker = await createPgTestClient(targetUrl);
  const contender = await createPgTestClient(targetUrl);
  await blocker.connect();
  await contender.connect();
  try {
    const backend = await contender.query<{ pid: number }>({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    });
    const pid = backend.rows[0]?.pid;
    if (!Number.isInteger(pid)) throw new Error("ton_reconciliation_backend_pid");
    await blocker.query({ text: "BEGIN", values: [] });
    await blocker.query({
      text: "SELECT source_id FROM ton_reconciliation_cursors WHERE source_id=$1 FOR UPDATE",
      values: [input.sourceId],
    });
    const resultPromise = contender.query<{ result: string }>(input.contender);
    await waitForRowLock(pid!);
    await blocker.query(input.mutation);
    await blocker.query({ text: "COMMIT", values: [] });
    const result = await resultPromise;
    expect(result.rows).toEqual([{ result: input.expected }]);
  } finally {
    await blocker.query({ text: "ROLLBACK", values: [] }).catch(() => {});
    await Promise.allSettled([blocker.end(), contender.end()]);
  }
}

async function runLeaseExpiryBarrier(input: {
  sourceId: string;
  contender: QueryConfig;
  expected: unknown;
}): Promise<string> {
  const blocker = await createPgTestClient(targetUrl);
  const contender = await createPgTestClient(targetUrl);
  await blocker.connect();
  await contender.connect();
  try {
    const backend = await contender.query<{ pid: number }>({
      text: "SELECT pg_backend_pid() AS pid",
      values: [],
    });
    const pid = backend.rows[0]?.pid;
    if (!Number.isInteger(pid)) throw new Error("ton_reconciliation_backend_pid");
    await blocker.query({ text: "BEGIN", values: [] });
    await blocker.query({
      text: "SELECT source_id FROM ton_reconciliation_cursors WHERE source_id=$1 FOR UPDATE",
      values: [input.sourceId],
    });
    const expiry = await blocker.query<{ deadline: string }>({
      text: "UPDATE ton_reconciliation_cursors SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE source_id=$1 RETURNING lease_expires_at::text AS deadline",
      values: [input.sourceId],
    });
    const deadline = expiry.rows[0]?.deadline;
    if (typeof deadline !== "string")
      throw new Error("ton_reconciliation_expiry_deadline");
    const resultPromise = contender.query<{ result: unknown }>(input.contender);
    await waitForRowLock(pid!);
    await blocker.query({
      text: "SELECT pg_sleep_until($1::timestamptz+interval '10 milliseconds')",
      values: [deadline],
    });
    await blocker.query({ text: "COMMIT", values: [] });
    const result = await resultPromise;
    expect(result.rows).toEqual([{ result: input.expected }]);
    return deadline;
  } finally {
    await blocker.query({ text: "ROLLBACK", values: [] }).catch(() => {});
    await Promise.allSettled([blocker.end(), contender.end()]);
  }
}

async function createInvoice(options: {
  recipient?: string;
  asset?: Asset;
  expiresInMs?: number;
} = {}): Promise<TonInvoice> {
  const recipient = options.recipient ?? rawAddress();
  const asset = options.asset ?? NATIVE_ASSET;
  const now = (await databaseNowMs()) - 10;
  const input: CreateTonInvoiceInput = {
    idempotencyKey: `reconcile-${randomUUID()}`,
    grantMicrocredits: "10",
    priceRevision: "reconciliation-native-v1",
    quote: createQuote(
      {
        quoteId: `quote-${randomUUID()}`,
        sourcePrice: {
          unit: "gateway_microcredits",
          amountAtomic: "10",
        },
        asset,
        fx: {
          sourceUnit: "gateway_microcredits",
          targetAsset: asset,
          numerator: "1",
          denominator: "1",
          rounding: "floor",
          source: "native-reconciliation-fixture-v1",
          observedAtMs: now - 1,
          expiresAtMs: now + 120_000,
        },
        additionalFeeAtomic: "1",
        expiresAtMs: now + (options.expiresInMs ?? 120_000),
      },
      [asset],
      now,
    ),
    recipient,
    expectedSender: SENDER,
    finalityPolicyId: "fixture-finality-v1",
    verifierVersion: "fixture-verifier-v1",
  };
  return createTonInvoice(mainDb, { actorUserId: OWNER, orgId: ORG }, input, {
    allowlist: [asset],
  });
}

function binding(source: TonReconciliationSource) {
  return {
    recipientAccount: source.invoiceRecipient,
    derivation: {
      kind: "native" as const,
      ownerAddress: source.invoiceRecipient,
    },
  };
}

async function claimedBoundSource(invoice: TonInvoice, owner = randomUUID()) {
  const source = reconciliationSource(
    invoice.recipient,
    Date.parse(invoice.createdAt),
  );
  expect(
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    }),
  ).toEqual({ kind: "claimed", cursor: null, binding: null });
  expect(
    await bindTonReconciliationRecipient(mainDb, {
      source,
      leaseOwner: owner,
      expected: null,
      binding: binding(source),
    }),
  ).toBe("bound");
  return { source, owner };
}

function observation(
  invoice: TonInvoice | null,
  source: TonReconciliationSource,
  patch: Partial<TonObservationInput> = {},
): TonObservationInput {
  return {
    schemaVersion: 1,
    invoiceId: invoice?.invoiceId ?? null,
    sourceId: source.sourceId,
    recipientAccount: source.invoiceRecipient,
    eventIdentity: {
      txHash: createHash("sha256").update(`tx-${invoice?.invoiceId ?? "unknown"}`).digest("hex"),
      messageHash: createHash("sha256").update(`message-${invoice?.invoiceId ?? "unknown"}`).digest("hex"),
      txLt: "1",
    },
    providerId: PROVIDER,
    evidenceModel: "server_trusted_indexer",
    result: {
      kind: "verified_candidate",
      reason: "verified_candidate",
      evidenceDigest: "a".repeat(64),
    },
    providerCursor: null,
    snapshot: { reference: invoice?.reference ?? `unknown-${randomUUID()}` },
    observedAtMs: 1_789_000_000_000,
    ...patch,
  };
}

function verifiedCredit(invoice: TonInvoice): VerifiedChainCredit {
  const now = 1_789_000_000_000;
  return {
    network: "tvm:-3",
    asset: invoice.asset,
    recipient: invoice.recipient,
    recipientAccount: invoice.recipient,
    sender: invoice.expectedSender ?? SENDER,
    amountAtomic: invoice.amountAtomic,
    reference: invoice.reference,
    txHash: createHash("sha256").update(`settle-tx-${invoice.invoiceId}`).digest("hex"),
    txLt: "2",
    messageHash: createHash("sha256").update(`settle-message-${invoice.invoiceId}`).digest("hex"),
    messageIndex: 0,
    chainTimeMs: now - 3,
    observedAtMs: now - 2,
    verifiedAtMs: now - 1,
    blockAnchor: "native-fixture-block",
    masterchainAnchor: "native-fixture-masterchain",
    executionPathDigest: "b".repeat(64),
    verifierVersion: invoice.verifierVersion,
    finalityPolicyId: invoice.finalityPolicyId,
    jettonCredit: null,
  };
}

function databaseDdl(
  action: "CREATE" | "DROP",
  name: typeof TARGET | typeof PREMARKER_TARGET | typeof POSTADAPTER_TARGET,
): string {
  const statements = {
    CREATE: {
      [TARGET]: "CREATE DATABASE ai_aggregator_ton_reconciliation_test TEMPLATE template0",
      [PREMARKER_TARGET]:
        "CREATE DATABASE ai_aggregator_ton_reconciliation_premarker_test TEMPLATE template0",
      [POSTADAPTER_TARGET]:
        "CREATE DATABASE ai_aggregator_ton_reconciliation_postadapter_test TEMPLATE template0",
    },
    DROP: {
      [TARGET]: "DROP DATABASE ai_aggregator_ton_reconciliation_test",
      [PREMARKER_TARGET]:
        "DROP DATABASE ai_aggregator_ton_reconciliation_premarker_test",
      [POSTADAPTER_TARGET]:
        "DROP DATABASE ai_aggregator_ton_reconciliation_postadapter_test",
    },
  } as const;
  return statements[action][name];
}

function targetDatabaseUrl(name: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

type OwnedDatabaseState = {
  name: typeof TARGET | typeof PREMARKER_TARGET | typeof POSTADAPTER_TARGET;
  created: boolean;
  oid: string;
  marker: string | null;
  markerRequired: boolean;
  client?: TestDatabaseClient;
  clientClosed: boolean;
  adapters: Set<CloseableTonWorkerDatabase>;
};

function cleanupFailure(phase: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`ton_reconciliation_cleanup_${phase}: ${detail}`);
}

async function cleanupOwnedDatabase(
  canonical: TestDatabaseClient,
  state: OwnedDatabaseState,
): Promise<Error[]> {
  const failures: Error[] = [];
  const closeResults = await Promise.allSettled(
    [...state.adapters].map((database) => database.close()),
  );
  closeResults.forEach((result) => {
    if (result.status === "rejected")
      failures.push(cleanupFailure("adapter_close", result.reason));
    else if (result.value.kind !== "closed")
      failures.push(cleanupFailure("adapter_close", result.value.kind));
  });
  state.adapters.clear();

  if (state.client && !state.clientClosed) {
    try {
      const identity = await state.client.query<{
        database_name: string;
        oid: string;
      }>({
        text: "SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid",
        values: [],
      });
      if (
        identity.rows.length !== 1 ||
        identity.rows[0]?.database_name !== state.name ||
        identity.rows[0]?.oid !== state.oid
      )
        throw new Error("target_identity_mismatch");
      if (state.markerRequired) {
        const marker = await state.client.query<{ marker: string }>({
          text: "SELECT marker FROM public._aiag_ton_reconciliation_marker",
          values: [],
        });
        if (marker.rows.length !== 1 || marker.rows[0]?.marker !== state.marker)
          throw new Error("target_marker_mismatch");
      }
    } catch (error) {
      failures.push(cleanupFailure("identity_marker", error));
    }
    try {
      await state.client.end();
    } catch (error) {
      failures.push(cleanupFailure("target_end", error));
    } finally {
      state.clientClosed = true;
    }
  }

  const proveOwnership = async (): Promise<boolean> => {
    if (!state.created || !/^[1-9][0-9]*$/.test(state.oid)) return false;
    const current = await canonical.query<{ oid: string }>({
      text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
      values: [state.name],
    });
    return current.rows.length === 1 && current.rows[0]?.oid === state.oid;
  };

  let owned = false;
  try {
    owned = await proveOwnership();
    if (state.created && !owned) throw new Error("target_ownership_unproven");
  } catch (error) {
    failures.push(cleanupFailure("ownership", error));
  }

  if (owned) {
    try {
      const sessions = await canonical.query<{ count: string }>({
        text: "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datid=$1::oid",
        values: [state.oid],
      });
      if (sessions.rows[0]?.count !== "0") {
        if (!(await proveOwnership())) throw new Error("target_ownership_lost");
        await canonical.query({
          text: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datid=$1::oid AND pid<>pg_backend_pid()",
          values: [state.oid],
        });
        const after = await canonical.query<{ count: string }>({
          text: "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datid=$1::oid",
          values: [state.oid],
        });
        if (after.rows[0]?.count !== "0") throw new Error("target_sessions_remain");
      }
    } catch (error) {
      failures.push(cleanupFailure("sessions", error));
    }

    try {
      if (!(await proveOwnership())) throw new Error("target_ownership_lost");
      await canonical.query({
        text: databaseDdl("DROP", state.name),
        values: [],
      });
    } catch (error) {
      failures.push(cleanupFailure("drop", error));
    }
  }

  try {
    const absent = await canonical.query<{ oid: string }>({
      text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
      values: [state.name],
    });
    if (absent.rows.length !== 0) throw new Error("target_database_remains");
  } catch (error) {
    failures.push(cleanupFailure("absence", error));
  }
  return failures;
}

function combinedFailure(primary: unknown, cleanup: readonly Error[]): Error {
  if (cleanup.length === 0 && primary instanceof Error) return primary;
  const message = primary instanceof Error ? primary.message : "cleanup_failed";
  return new AggregateError(
    primary === undefined ? cleanup : [primary, ...cleanup],
    message,
  );
}

async function runInjectedOwnedFixture(
  name: typeof PREMARKER_TARGET | typeof POSTADAPTER_TARGET,
  phase: "premarker" | "postadapter",
): Promise<void> {
  const state: OwnedDatabaseState = {
    name,
    created: false,
    oid: "",
    marker: null,
    markerRequired: false,
    clientClosed: false,
    adapters: new Set(),
  };
  let primary: unknown;
  try {
    const existing = await canonicalDb.query<{ oid: string }>({
      text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
      values: [name],
    });
    if (existing.rows.length !== 0) throw new Error(`${phase}_target_exists`);
    await canonicalDb.query({ text: databaseDdl("CREATE", name), values: [] });
    state.created = true;
    const owned = await canonicalDb.query<{ oid: string }>({
      text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
      values: [name],
    });
    state.oid = owned.rows[0]?.oid ?? "";
    if (!/^[1-9][0-9]*$/.test(state.oid)) throw new Error(`${phase}_target_oid`);
    state.client = await createPgTestClient(targetDatabaseUrl(name));
    await state.client.connect();
    const identity = await state.client.query<{
      database_name: string;
      oid: string;
    }>({
      text: "SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid",
      values: [],
    });
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database_name !== name ||
      identity.rows[0]?.oid !== state.oid
    )
      throw new Error(`${phase}_identity`);
    if (phase === "premarker") throw new Error("injected_premarker_failure");

    state.marker = `aiag-ton-reconciliation:${randomUUID()}`;
    await state.client.query({
      text: "CREATE TABLE public._aiag_ton_reconciliation_marker(marker text PRIMARY KEY)",
      values: [],
    });
    await state.client.query({
      text: "INSERT INTO public._aiag_ton_reconciliation_marker(marker) VALUES($1)",
      values: [state.marker],
    });
    state.markerRequired = true;
    const adapter = createTonWorkerDatabase(targetDatabaseUrl(name));
    state.adapters.add(adapter);
    await adapter.transaction(async (tx) => {
      await tx.query({ text: "SELECT 1", values: [] });
    });
    throw new Error("injected_postadapter_failure");
  } catch (error) {
    primary = error;
  }
  const cleanup = await cleanupOwnedDatabase(canonicalDb, state);
  if (primary !== undefined || cleanup.length !== 0)
    throw combinedFailure(primary, cleanup);
}

async function expectOwnedDatabaseAbsent(name: string): Promise<void> {
  const readback = await canonicalDb.query<{ oid: string | null; sessions: string }>({
    text: "SELECT (SELECT oid::text FROM pg_database WHERE datname=$1) AS oid,(SELECT count(*)::text FROM pg_stat_activity a JOIN pg_database d ON d.oid=a.datid WHERE d.datname=$1) AS sessions",
    values: [name],
  });
  expect(readback.rows).toEqual([{ oid: null, sessions: "0" }]);
}

beforeAll(async () => {
  if (!RUN) return;
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const released = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  setupPromise = withGuardedTestDatabase(
    process.env,
    { clientFactory: createPgTestClient },
    async (canonical) => {
      canonicalDb = canonical;
      const state: OwnedDatabaseState = {
        name: TARGET,
        created: false,
        oid: "",
        marker: null,
        markerRequired: true,
        clientClosed: false,
        adapters: openDatabases,
      };
      let primary: unknown;
      try {
        const existing = await canonical.query<{ oid: string }>({
          text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
          values: [TARGET],
        });
        if (existing.rows.length !== 0) throw new Error("ton_reconciliation_target_exists");
        await canonical.query({
          text: databaseDdl("CREATE", TARGET),
          values: [],
        });
        state.created = true;
        const owned = await canonical.query<{ oid: string }>({
          text: "SELECT oid::text AS oid FROM pg_database WHERE datname=$1",
          values: [TARGET],
        });
        targetOid = owned.rows[0]?.oid ?? "";
        state.oid = targetOid;
        if (!/^[1-9][0-9]*$/.test(targetOid)) throw new Error("ton_reconciliation_target_oid");
        targetUrl = targetDatabaseUrl(TARGET);
        target = await createPgTestClient(targetUrl);
        state.client = target;
        await target.connect();
        const identity = await target.query<{ database_name: string; oid: string; host: string; port: number }>({
          text: "SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,host(inet_server_addr()) AS host,inet_server_port() AS port",
          values: [],
        });
        expect(identity.rows).toEqual([
          {
            database_name: TARGET,
            oid: targetOid,
            host: "127.0.0.1",
            port: 15432,
          },
        ]);
        marker = `aiag-ton-reconciliation:${randomUUID()}`;
        state.marker = marker;
        await target.query({
          text: "CREATE TABLE public._aiag_ton_reconciliation_marker(marker text PRIMARY KEY)",
          values: [],
        });
        await target.query({
          text: "INSERT INTO public._aiag_ton_reconciliation_marker(marker) VALUES($1)",
          values: [marker],
        });
        const migrations = await discoverNativeMigrations();
        expect(migrations).toHaveLength(76);
        expect(migrations.at(-1)?.version).toBe(
          "migrations/0076_ton_reconciliation_cas_guards.sql",
        );
        const applied = await runNativeMigrations(target, migrations);
        expect(applied.applied).toHaveLength(76);
        expect(applied.skipped).toHaveLength(0);
        const replay = await runNativeMigrations(target, migrations);
        expect(replay.applied).toHaveLength(0);
        expect(replay.skipped).toHaveLength(76);
        mainDb = db();
        await query(
          "INSERT INTO users(id,email,is_active,is_banned) VALUES($1::uuid,$2,TRUE,FALSE)",
          [OWNER, `ton-reconciliation-${OWNER}@example.test`],
        );
        await query(
          "INSERT INTO organizations(id,slug,name,owner_id,is_active,subscription_credits,payg_credits,refund_debt_credits) VALUES($1::uuid,$2,$3,$4::uuid,TRUE,0,0,0)",
          [ORG, `ton-reconciliation-${ORG}`, "TON reconciliation fixture", OWNER],
        );
        readyResolve();
        await released;
      } catch (error) {
        primary = error;
        readyReject(error);
      }
      const cleanup = await cleanupOwnedDatabase(canonical, state);
      if (primary !== undefined || cleanup.length !== 0)
        throw combinedFailure(primary, cleanup);
    },
  );
  void setupPromise.catch(() => {});
  await ready;
}, 180_000);

afterEach(async () => {
  if (!RUN) return;
  for (const database of [...openDatabases]) {
    if (database === mainDb) continue;
    await database.close();
    openDatabases.delete(database);
  }
});

afterAll(async () => {
  if (!RUN) return;
  releaseSetup();
  await setupPromise;
}, 30_000);

describe.skipIf(!RUN)("native TON reconciliation persistence", () => {
  it("preserves a pre-marker failure and removes the exact owned database", async () => {
    await expect(
      runInjectedOwnedFixture(PREMARKER_TARGET, "premarker"),
    ).rejects.toThrow("injected_premarker_failure");
    await expectOwnedDatabaseAbsent(PREMARKER_TARGET);
  });

  it("preserves a post-adapter failure and removes the exact owned database", async () => {
    await expect(
      runInjectedOwnedFixture(POSTADAPTER_TARGET, "postadapter"),
    ).rejects.toThrow("injected_postadapter_failure");
    await expectOwnedDatabaseAbsent(POSTADAPTER_TARGET);
  });

  it("separates source identity mismatch from bind cursor conflict without mutation", async () => {
    const mismatched = reconciliationSource(rawAddress());
    await query(
      "INSERT INTO ton_reconciliation_cursors(source_id,schema_version,network,provider_id) VALUES($1,1,'tvm:-3','other-provider')",
      [mismatched.sourceId],
    );
    await expect(
      claimTonReconciliationLease(mainDb, {
        source: mismatched,
        providerId: PROVIDER,
        leaseOwner: randomUUID(),
        leaseMs: 90_000,
      }),
    ).resolves.toEqual({ kind: "source_identity_mismatch" });
    const mismatchRow = await query<{
      provider_id: string;
      lease_owner: string | null;
      cursor: unknown;
    }>(
      "SELECT provider_id,lease_owner,cursor FROM ton_reconciliation_cursors WHERE source_id=$1",
      [mismatched.sourceId],
    );
    expect(mismatchRow.rows).toEqual([
      { provider_id: "other-provider", lease_owner: null, cursor: null },
    ]);

    const source = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    const persisted: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "2",
      beforeTransactionHash: "2".repeat(64),
      cycleUpperLt: "3",
    };
    await query(
      "UPDATE ton_reconciliation_cursors SET cursor=$2::jsonb WHERE source_id=$1",
      [source.sourceId, JSON.stringify(persisted)],
    );
    await expect(
      bindTonReconciliationRecipient(mainDb, {
        source,
        leaseOwner: owner,
        expected: null,
        binding: binding(source),
      }),
    ).resolves.toBe("cursor_conflict");
    const bindRow = await query<{
      recipient_account: string | null;
      recipient_binding: unknown;
      cursor: TonSweepCursor;
    }>(
      "SELECT recipient_account,recipient_binding,cursor FROM ton_reconciliation_cursors WHERE source_id=$1",
      [source.sourceId],
    );
    expect(bindRow.rows).toEqual([
      {
        recipient_account: null,
        recipient_binding: null,
        cursor: persisted,
      },
    ]);
  });

  it("allows exactly one claimant, then permits expired takeover", async () => {
    const source = reconciliationSource(rawAddress());
    const first = randomUUID();
    const second = randomUUID();
    const left = db();
    const right = db();
    const results = await Promise.all([
      claimTonReconciliationLease(left, {
        source,
        providerId: PROVIDER,
        leaseOwner: first,
        leaseMs: 90_000,
      }),
      claimTonReconciliationLease(right, {
        source,
        providerId: PROVIDER,
        leaseOwner: second,
        leaseMs: 90_000,
      }),
    ]);
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
    await query(
      "UPDATE ton_reconciliation_cursors SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1",
      [source.sourceId],
    );
    const winner = results[0]?.kind === "claimed" ? first : second;
    const takeover = winner === first ? second : first;
    await expect(
      claimTonReconciliationLease(mainDb, {
        source,
        providerId: PROVIDER,
        leaseOwner: takeover,
        leaseMs: 90_000,
      }),
    ).resolves.toMatchObject({ kind: "claimed" });
  });

  it("classifies stale owners and same-owner cursor conflicts without mutation", async () => {
    const source = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    const cursor: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "4",
      beforeTransactionHash: "4".repeat(64),
      cycleUpperLt: "8",
    };
    await query(
      "UPDATE ton_reconciliation_cursors SET cursor=$2::jsonb WHERE source_id=$1",
      [source.sourceId, JSON.stringify(cursor)],
    );
    await expect(
      renewTonReconciliationLease(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: owner,
        expected: null,
        leaseMs: 90_000,
      }),
    ).resolves.toBe("cursor_conflict");
    const stale = randomUUID();
    await expect(
      renewTonReconciliationLease(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: stale,
        expected: cursor,
        leaseMs: 90_000,
      }),
    ).resolves.toBe("lease_lost");
    await expect(
      advanceTonReconciliationCursor(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: stale,
        expected: cursor,
        next: null,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("lease_lost");
    await expect(
      releaseTonReconciliationLease(mainDb, source.sourceId, stale),
    ).resolves.toBe("lease_lost");
  });

  it("renews from the database clock and supports an ACKed null cursor wrap", async () => {
    const source = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    await expect(
      renewTonReconciliationLease(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: owner,
        expected: null,
        leaseMs: 90_000,
      }),
    ).resolves.toBe("renewed");
    const lease = await query<{ remaining_ms: string }>(
      "SELECT floor(extract(epoch FROM (lease_expires_at-clock_timestamp()))*1000)::text AS remaining_ms FROM ton_reconciliation_cursors WHERE source_id=$1",
      [source.sourceId],
    );
    expect(Number(lease.rows[0]?.remaining_ms)).toBeGreaterThan(88_000);
    const cursor: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "10",
      beforeTransactionHash: "1".repeat(64),
      cycleUpperLt: "10",
    };
    await expect(
      advanceTonReconciliationCursor(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: owner,
        expected: null,
        next: cursor,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("advanced");
    await expect(
      advanceTonReconciliationCursor(mainDb, {
        sourceId: source.sourceId,
        leaseOwner: owner,
        expected: cursor,
        next: null,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("advanced");
  });

  it("recovers the exact durable cursor and binding through a fresh adapter restart", async () => {
    const source = reconciliationSource(rawAddress());
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    const cursor: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "21",
      beforeTransactionHash: "a".repeat(64),
      cycleUpperLt: "34",
    };
    const firstAdapter = db();
    await expect(
      claimTonReconciliationLease(firstAdapter, {
        source,
        providerId: PROVIDER,
        leaseOwner: firstOwner,
        leaseMs: 90_000,
      }),
    ).resolves.toEqual({ kind: "claimed", cursor: null, binding: null });
    await expect(
      bindTonReconciliationRecipient(firstAdapter, {
        source,
        leaseOwner: firstOwner,
        expected: null,
        binding: binding(source),
      }),
    ).resolves.toBe("bound");
    await expect(
      advanceTonReconciliationCursor(firstAdapter, {
        sourceId: source.sourceId,
        leaseOwner: firstOwner,
        expected: null,
        next: cursor,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("advanced");
    await expect(
      releaseTonReconciliationLease(firstAdapter, source.sourceId, firstOwner),
    ).resolves.toBe("released");
    await expect(firstAdapter.close()).resolves.toEqual({ kind: "closed" });
    openDatabases.delete(firstAdapter);

    const restarted = db();
    await expect(
      claimTonReconciliationLease(restarted, {
        source,
        providerId: PROVIDER,
        leaseOwner: secondOwner,
        leaseMs: 90_000,
      }),
    ).resolves.toEqual({
      kind: "claimed",
      cursor,
      binding: binding(source),
    });
    await expect(
      renewTonReconciliationLease(restarted, {
        sourceId: source.sourceId,
        leaseOwner: firstOwner,
        expected: cursor,
        leaseMs: 90_000,
      }),
    ).resolves.toBe("lease_lost");
    await expect(
      advanceTonReconciliationCursor(restarted, {
        sourceId: source.sourceId,
        leaseOwner: firstOwner,
        expected: cursor,
        next: null,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("lease_lost");
    await expect(
      releaseTonReconciliationLease(restarted, source.sourceId, firstOwner),
    ).resolves.toBe("lease_lost");
  });

  it("classifies bind, renew and advance under deterministic row-lock barriers", async () => {
    const renewSource = reconciliationSource(rawAddress());
    const renewOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: renewSource,
      providerId: PROVIDER,
      leaseOwner: renewOwner,
      leaseMs: 90_000,
    });
    const changedCursor: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "3",
      beforeTransactionHash: "3".repeat(64),
      cycleUpperLt: "5",
    };
    await runCursorBarrier({
      sourceId: renewSource.sourceId,
      contender: {
        text: "SELECT aiag_renew_ton_reconciliation_lease_v1($1::text,$2::uuid,$3::jsonb,$4::integer) AS result",
        values: [renewSource.sourceId, renewOwner, null, 90_000],
      },
      mutation: {
        text: "UPDATE ton_reconciliation_cursors SET cursor=$2::jsonb WHERE source_id=$1",
        values: [renewSource.sourceId, JSON.stringify(changedCursor)],
      },
      expected: "cursor_conflict",
    });

    const bindSource = reconciliationSource(rawAddress());
    const bindOwner = randomUUID();
    const takeoverOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: bindSource,
      providerId: PROVIDER,
      leaseOwner: bindOwner,
      leaseMs: 90_000,
    });
    await runCursorBarrier({
      sourceId: bindSource.sourceId,
      contender: {
        text: "SELECT aiag_bind_ton_reconciliation_recipient_v1($1::jsonb,$2::uuid,$3::jsonb,$4::jsonb) AS result",
        values: [
          JSON.stringify(bindSource),
          bindOwner,
          null,
          JSON.stringify(binding(bindSource)),
        ],
      },
      mutation: {
        text: "UPDATE ton_reconciliation_cursors SET lease_owner=$2::uuid,lease_expires_at=clock_timestamp()+interval '90 seconds' WHERE source_id=$1",
        values: [bindSource.sourceId, takeoverOwner],
      },
      expected: "lease_lost",
    });

    const advanceSource = reconciliationSource(rawAddress());
    const advanceOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: advanceSource,
      providerId: PROVIDER,
      leaseOwner: advanceOwner,
      leaseMs: 90_000,
    });
    await runCursorBarrier({
      sourceId: advanceSource.sourceId,
      contender: {
        text: "SELECT aiag_advance_ton_reconciliation_cursor_v1($1::text,$2::uuid,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text) AS result",
        values: [
          advanceSource.sourceId,
          advanceOwner,
          null,
          JSON.stringify(changedCursor),
          "success",
          null,
          null,
        ],
      },
      mutation: {
        text: "UPDATE ton_reconciliation_cursors SET cursor=$2::jsonb WHERE source_id=$1",
        values: [advanceSource.sourceId, JSON.stringify(changedCursor)],
      },
      expected: "cursor_conflict",
    });
  });

  it("uses the post-lock DB clock when leases expire during row-lock waits", async () => {
    const bindSource = reconciliationSource(rawAddress());
    const bindOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: bindSource,
      providerId: PROVIDER,
      leaseOwner: bindOwner,
      leaseMs: 90_000,
    });
    await runLeaseExpiryBarrier({
      sourceId: bindSource.sourceId,
      contender: {
        text: "SELECT aiag_bind_ton_reconciliation_recipient_v1($1::jsonb,$2::uuid,$3::jsonb,$4::jsonb) AS result",
        values: [
          JSON.stringify(bindSource),
          bindOwner,
          null,
          JSON.stringify(binding(bindSource)),
        ],
      },
      expected: "lease_lost",
    });

    const renewSource = reconciliationSource(rawAddress());
    const renewOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: renewSource,
      providerId: PROVIDER,
      leaseOwner: renewOwner,
      leaseMs: 90_000,
    });
    await runLeaseExpiryBarrier({
      sourceId: renewSource.sourceId,
      contender: {
        text: "SELECT aiag_renew_ton_reconciliation_lease_v1($1::text,$2::uuid,$3::jsonb,$4::integer) AS result",
        values: [renewSource.sourceId, renewOwner, null, 90_000],
      },
      expected: "lease_lost",
    });

    const advanceSource = reconciliationSource(rawAddress());
    const advanceOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: advanceSource,
      providerId: PROVIDER,
      leaseOwner: advanceOwner,
      leaseMs: 90_000,
    });
    await runLeaseExpiryBarrier({
      sourceId: advanceSource.sourceId,
      contender: {
        text: "SELECT aiag_advance_ton_reconciliation_cursor_v1($1::text,$2::uuid,$3::jsonb,$4::jsonb,$5::text,$6::integer,$7::text) AS result",
        values: [
          advanceSource.sourceId,
          advanceOwner,
          null,
          null,
          "success",
          null,
          null,
        ],
      },
      expected: "lease_lost",
    });

    const claimSource = reconciliationSource(rawAddress());
    await claimTonReconciliationLease(mainDb, {
      source: claimSource,
      providerId: PROVIDER,
      leaseOwner: randomUUID(),
      leaseMs: 90_000,
    });
    const takeoverOwner = randomUUID();
    const priorDeadline = await runLeaseExpiryBarrier({
      sourceId: claimSource.sourceId,
      contender: {
        text: "SELECT aiag_claim_ton_reconciliation_lease_v1($1::jsonb,$2::text,$3::uuid,$4::integer) AS result",
        values: [
          JSON.stringify(claimSource),
          PROVIDER,
          takeoverOwner,
          90_000,
        ],
      },
      expected: { kind: "claimed", cursor: null, binding: null },
    });
    const takeover = await query<{
      lease_owner: string;
      ttl_ms: string;
      timestamp_after_wait: boolean;
    }>(
      "SELECT lease_owner::text,round(extract(epoch FROM (lease_expires_at-updated_at))*1000)::text AS ttl_ms,updated_at>=$2::timestamptz AS timestamp_after_wait FROM ton_reconciliation_cursors WHERE source_id=$1",
      [claimSource.sourceId, priorDeadline],
    );
    expect(takeover.rows).toEqual([
      {
        lease_owner: takeoverOwner,
        ttl_ms: "90000",
        timestamp_after_wait: true,
      },
    ]);
  }, 15_000);

  it("lists deterministic distinct native sources and omits jetton", async () => {
    const firstRecipient = rawAddress("native-first");
    const secondRecipient = rawAddress("native-second");
    await createInvoice({ recipient: firstRecipient });
    await createInvoice({ recipient: firstRecipient });
    await createInvoice({ recipient: secondRecipient });
    await createInvoice({
      recipient: firstRecipient,
      asset: {
        network: "tvm:-3",
        kind: "jetton",
        decimals: 9,
        masterAddress: rawAddress("jetton-master"),
      },
    });
    const sources = await listTonReconciliationSources(mainDb, {
      afterSourceId: null,
      limit: 16,
      assetKind: "native",
    });
    const selected = sources.filter((source) =>
      [firstRecipient, secondRecipient].includes(source.invoiceRecipient),
    );
    expect(selected).toHaveLength(2);
    expect(selected.map((source) => source.sourceId)).toEqual(
      [...selected.map((source) => source.sourceId)].sort(),
    );
    expect(selected.every((source) => source.asset.kind === "native")).toBe(true);
  });

  it("pins the native binding and preserves it against direct replacement", async () => {
    const source = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    await expect(
      bindTonReconciliationRecipient(mainDb, {
        source,
        leaseOwner: owner,
        expected: null,
        binding: binding(source),
      }),
    ).resolves.toBe("bound");
    await expect(
      query(
        "UPDATE ton_reconciliation_cursors SET recipient_account=$2::varchar,recipient_binding=jsonb_set(recipient_binding,'{recipientAccount}',to_jsonb($2::text)) WHERE source_id=$1",
        [source.sourceId, rawAddress()],
      ),
    ).rejects.toThrow("TON_RECIPIENT_BINDING_IMMUTABLE");
    const cursor: TonSweepCursor = {
      schemaVersion: 1,
      beforeLt: "8",
      beforeTransactionHash: "8".repeat(64),
      cycleUpperLt: "13",
    };
    await query(
      "UPDATE ton_reconciliation_cursors SET cursor=$2::jsonb,consecutive_failures=4,next_attempt_at=clock_timestamp()+interval '80 seconds',last_error_code='timeout' WHERE source_id=$1",
      [source.sourceId, JSON.stringify(cursor)],
    );
    const beforeDelete = await query<{
      recipient_account: string;
      recipient_binding: unknown;
      cursor: unknown;
      consecutive_failures: number;
      lease_owner: string;
      lease_expires_at: string;
      next_attempt_at: string;
      last_error_code: string;
    }>(
      "SELECT recipient_account,recipient_binding,cursor,consecutive_failures,lease_owner::text,lease_expires_at::text,next_attempt_at::text,last_error_code FROM ton_reconciliation_cursors WHERE source_id=$1",
      [source.sourceId],
    );
    await expect(
      query("DELETE FROM ton_reconciliation_cursors WHERE source_id=$1", [
        source.sourceId,
      ]),
    ).rejects.toThrow("TON_RECONCILIATION_CURSOR_IMMUTABLE");
    const afterDelete = await query<{
      recipient_account: string;
      recipient_binding: unknown;
      cursor: unknown;
      consecutive_failures: number;
      lease_owner: string;
      lease_expires_at: string;
      next_attempt_at: string;
      last_error_code: string;
    }>(
      "SELECT recipient_account,recipient_binding,cursor,consecutive_failures,lease_owner::text,lease_expires_at::text,next_attempt_at::text,last_error_code FROM ton_reconciliation_cursors WHERE source_id=$1",
      [source.sourceId],
    );
    expect(afterDelete.rows).toEqual(beforeDelete.rows);
    expect(afterDelete.rows[0]).toMatchObject({
      recipient_account: source.invoiceRecipient,
      recipient_binding: binding(source),
      cursor,
      consecutive_failures: 4,
      lease_owner: owner,
      last_error_code: "timeout",
    });
  });

  it("deduplicates unmatched observations with nullable invoice status", async () => {
    const source = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    await bindTonReconciliationRecipient(mainDb, {
      source,
      leaseOwner: owner,
      expected: null,
      binding: binding(source),
    });
    const input = observation(null, source, {
      result: {
        kind: "unmatched",
        reason: "invoice_reference_not_found",
        evidenceDigest: "c".repeat(64),
      },
    });
    const first = await recordTonChainObservation(mainDb, input);
    const replay = await recordTonChainObservation(mainDb, {
      ...input,
      observedAtMs: input.observedAtMs + 1,
    });
    expect(first).toMatchObject({ outcome: "inserted", invoiceStatus: null });
    expect(replay).toEqual({
      ...first,
      outcome: "already_recorded",
    });
  });

  it("applies allowed observation status transitions and keeps rows immutable", async () => {
    const invoice = await createInvoice();
    const { source } = await claimedBoundSource(invoice);
    const verified = await recordTonChainObservation(
      mainDb,
      observation(invoice, source),
    );
    expect(verified).toMatchObject({ outcome: "inserted", invoiceStatus: "observed" });
    const reviewed = await recordTonChainObservation(
      mainDb,
      observation(invoice, source, {
        eventIdentity: {
          txHash: "d".repeat(64),
          messageHash: "e".repeat(64),
          txLt: "2",
        },
        result: {
          kind: "review_required",
          reason: "amount_mismatch",
          evidenceDigest: "f".repeat(64),
        },
      }),
    );
    expect(reviewed.invoiceStatus).toBe("review_required");
    await expect(
      query("UPDATE ton_chain_observations SET reason='other' WHERE id=$1::uuid", [
        verified.observationId,
      ]),
    ).rejects.toThrow("TON_RECONCILIATION_IMMUTABLE");
    await expect(
      query("DELETE FROM ton_chain_observations WHERE id=$1::uuid", [
        reviewed.observationId,
      ]),
    ).rejects.toThrow("TON_RECONCILIATION_IMMUTABLE");
  });

  it("finds exact unique references across pending, observed, expired, settled and review", async () => {
    const recipient = rawAddress();
    const pending = await createInvoice({ recipient });
    const observed = await createInvoice({ recipient });
    const expired = await createInvoice({ recipient, expiresInMs: 75 });
    const settled = await createInvoice({ recipient });
    const review = await createInvoice({ recipient });
    const { source } = await claimedBoundSource(observed);
    await recordTonChainObservation(mainDb, observation(observed, source));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await expireTonInvoice(mainDb, expired.invoiceId)).toBe("expired");
    expect((await settleTonInvoice(mainDb, settled.invoiceId, verifiedCredit(settled))).kind).toBe("settled");
    await recordTonChainObservation(
      mainDb,
      observation(review, source, {
        eventIdentity: {
          txHash: "8".repeat(64),
          messageHash: "9".repeat(64),
          txLt: "3",
        },
        snapshot: { reference: review.reference },
        result: {
          kind: "review_required",
          reason: "sender_mismatch",
          evidenceDigest: "7".repeat(64),
        },
      }),
    );
    const found = await findTonInvoicesForReconciliation(mainDb, {
      source,
      references: [
        pending.reference,
        observed.reference,
        expired.reference,
        settled.reference,
        review.reference,
      ],
    });
    expect(new Set(found.map((invoice) => invoice.status))).toEqual(
      new Set(["pending", "observed", "expired", "settled", "review_required"]),
    );
    await expect(
      getTonInvoiceForReconciliation(mainDb, settled.invoiceId),
    ).resolves.toMatchObject({ invoiceId: settled.invoiceId, status: "settled" });
  });

  it("applies exponential and Retry-After backoff and denies not-due claims", async () => {
    const exponential = reconciliationSource(rawAddress());
    const owner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: exponential,
      providerId: PROVIDER,
      leaseOwner: owner,
      leaseMs: 90_000,
    });
    const expectedDelays = [
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000,
      900_000, 900_000,
    ];
    for (const [index, expectedDelay] of expectedDelays.entries()) {
      await expect(
        advanceTonReconciliationCursor(mainDb, {
          sourceId: exponential.sourceId,
          leaseOwner: owner,
          expected: null,
          next: null,
          outcome: "source_error",
          retryAfterMs: null,
          errorCode: "timeout",
        }),
      ).resolves.toBe("advanced");
      const row = await query<{ failures: number; delay_ms: string }>(
        "SELECT consecutive_failures AS failures,round(extract(epoch FROM (next_attempt_at-updated_at))*1000)::text AS delay_ms FROM ton_reconciliation_cursors WHERE source_id=$1",
        [exponential.sourceId],
      );
      expect(row.rows).toEqual([
        { failures: index + 1, delay_ms: String(expectedDelay) },
      ]);
    }
    await expect(
      advanceTonReconciliationCursor(mainDb, {
        sourceId: exponential.sourceId,
        leaseOwner: owner,
        expected: null,
        next: null,
        outcome: "success",
        retryAfterMs: null,
        errorCode: null,
      }),
    ).resolves.toBe("advanced");
    const reset = await query<{
      failures: number;
      delay_ms: string;
      last_error_code: string | null;
    }>(
      "SELECT consecutive_failures AS failures,round(extract(epoch FROM (next_attempt_at-updated_at))*1000)::text AS delay_ms,last_error_code FROM ton_reconciliation_cursors WHERE source_id=$1",
      [exponential.sourceId],
    );
    expect(reset.rows).toEqual([
      { failures: 0, delay_ms: "0", last_error_code: null },
    ]);

    const notDue = reconciliationSource(rawAddress());
    const notDueOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: notDue,
      providerId: PROVIDER,
      leaseOwner: notDueOwner,
      leaseMs: 90_000,
    });
    await advanceTonReconciliationCursor(mainDb, {
      sourceId: notDue.sourceId,
      leaseOwner: notDueOwner,
      expected: null,
      next: null,
      outcome: "source_error",
      retryAfterMs: null,
      errorCode: "timeout",
    });
    await releaseTonReconciliationLease(mainDb, notDue.sourceId, notDueOwner);
    await expect(
      claimTonReconciliationLease(mainDb, {
        source: notDue,
        providerId: PROVIDER,
        leaseOwner: randomUUID(),
        leaseMs: 90_000,
      }),
    ).resolves.toEqual({ kind: "busy" });
    const retry = reconciliationSource(rawAddress());
    const retryOwner = randomUUID();
    await claimTonReconciliationLease(mainDb, {
      source: retry,
      providerId: PROVIDER,
      leaseOwner: retryOwner,
      leaseMs: 90_000,
    });
    const before = await databaseNowMs();
    await advanceTonReconciliationCursor(mainDb, {
      sourceId: retry.sourceId,
      leaseOwner: retryOwner,
      expected: null,
      next: null,
      outcome: "source_error",
      retryAfterMs: 1,
      errorCode: "rate_limited",
    });
    const row = await query<{ failures: number; delay_ms: string; cursor: unknown }>(
      "SELECT consecutive_failures AS failures,floor(extract(epoch FROM next_attempt_at)*1000-$2)::text AS delay_ms,cursor FROM ton_reconciliation_cursors WHERE source_id=$1",
      [retry.sourceId, before],
    );
    expect(row.rows[0]?.failures).toBe(1);
    expect(Number(row.rows[0]?.delay_ms)).toBeGreaterThanOrEqual(900);
    expect(row.rows[0]?.cursor).toBeNull();
  });
});
