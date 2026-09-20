import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({
  createPool: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: function Pool(config: unknown) {
    return pgMock.createPool(config);
  },
}));

import type {
  TonInvoice,
  TonObservationInput,
  TonPaymentDatabase,
  TonReconciliationSource,
  TonSqlClient,
} from "../ton-payment-types";
import {
  TON_DB_CONNECT_TIMEOUT_MS,
  TON_DB_LOCK_TIMEOUT_MS,
  TON_DB_OPERATION_DEADLINE_MS,
  TON_DB_QUERY_TIMEOUT_MS,
  TON_DB_STATEMENT_TIMEOUT_MS,
  TON_POOL_CLOSE_DEADLINE_MS,
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
} from "../ton-reconciliation-internal";

const RECIPIENT = `0:${"1".repeat(64)}`;
const OWNER = "00000000-0000-4000-8000-000000000001";
const INVOICE = "00000000-0000-4000-8000-000000000002";
const CURSOR = {
  schemaVersion: 1,
  beforeLt: "12",
  beforeTransactionHash: "2".repeat(64),
  cycleUpperLt: "15",
} as const;

function source(recipient = RECIPIENT): TonReconciliationSource {
  const asset = {
    decimals: 9,
    kind: "native",
    network: "tvm:-3",
  } as const;
  return {
    sourceId: createHash("sha256")
      .update(
        `toncenter-v3-testnet\0{"decimals":9,"kind":"native","network":"tvm:-3"}\0${recipient}`,
      )
      .digest("hex"),
    network: "tvm:-3",
    asset,
    invoiceRecipient: recipient,
    scanFloorTimeMs: 1_789_000_000_000,
  };
}

function recordingDatabase(results: unknown[] = []) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const tx: TonSqlClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      config: { text: string; values: readonly unknown[] },
    ) {
      calls.push(config);
      const result = results.shift();
      return {
        rows: [{ result }] as unknown as Row[],
        rowCount: 1,
      };
    },
  };
  return {
    db: {
      transaction: <T>(run: (client: TonSqlClient) => Promise<T>) => run(tx),
    } satisfies TonPaymentDatabase,
    calls,
  };
}

function observation(
  patch: Partial<TonObservationInput> = {},
): TonObservationInput {
  return {
    schemaVersion: 1,
    invoiceId: INVOICE,
    sourceId: source().sourceId,
    recipientAccount: RECIPIENT,
    eventIdentity: {
      txHash: "3".repeat(64),
      messageHash: "4".repeat(64),
      txLt: "9",
    },
    providerId: "toncenter-v3-testnet",
    evidenceModel: "server_trusted_indexer",
    result: {
      kind: "verified_candidate",
      reason: "verified_candidate",
      evidenceDigest: "5".repeat(64),
    },
    providerCursor: CURSOR,
    snapshot: { reference: "aiag-ton:00000000-0000-4000-8000-000000000003" },
    observedAtMs: 1_789_000_000_001,
    ...patch,
  };
}

function invoice(patch: Partial<TonInvoice> = {}): TonInvoice {
  const asset = source().asset;
  return {
    schemaVersion: 1,
    product: "aggregator",
    purpose: "gateway_topup",
    invoiceId: INVOICE,
    ownerId: OWNER,
    orgId: "00000000-0000-4000-8000-000000000003",
    orderId: "00000000-0000-4000-8000-000000000004",
    idempotencyKey: "reconciliation-result",
    quoteId: "quote-reconciliation-result",
    quote: {
      schemaVersion: 1,
      quoteId: "quote-reconciliation-result",
      sourcePrice: { unit: "gateway_microcredits", amountAtomic: "10" },
      asset,
      fx: {
        sourceUnit: "gateway_microcredits",
        targetAsset: asset,
        numerator: "1",
        denominator: "1",
        rounding: "floor",
        source: "unit-fixture",
        observedAtMs: 1_789_000_000_000,
        expiresAtMs: 1_789_000_120_000,
      },
      additionalFeeAtomic: "1",
      expiresAtMs: 1_789_000_120_000,
      amountAtomic: "11",
      quotedAtMs: 1_789_000_000_001,
    },
    grantMicrocredits: "10",
    priceRevision: "unit-v1",
    network: "tvm:-3",
    asset,
    amountAtomic: "11",
    recipient: RECIPIENT,
    reference: "aiag-ton:00000000-0000-4000-8000-000000000005",
    expectedSender: null,
    finalityPolicyId: "finality-v1",
    verifierVersion: "verifier-v1",
    expiresAt: "2026-09-13T18:02:00+00:00",
    createdAt: "2026-09-13T18:00:00+00:00",
    status: "pending",
    reviewReason: null,
    ...patch,
  };
}

describe("TON reconciliation wrapper validation", () => {
  it("lists only bounded native sources using a prepared query", async () => {
    const expected = source();
    const { db, calls } = recordingDatabase([[expected]]);
    await expect(
      listTonReconciliationSources(db, {
        afterSourceId: null,
        limit: 16,
        assetKind: "native",
      }),
    ).resolves.toEqual([expected]);
    expect(calls).toEqual([
      {
        text: "SELECT aiag_list_ton_reconciliation_sources_v1($1::text,$2::integer,$3::text) AS result",
        values: [null, 16, "native"],
      },
    ]);
  });

  it.each([0, 17, 1.5])("rejects list limit %s before SQL", async (limit) => {
    const { db, calls } = recordingDatabase();
    await expect(
      listTonReconciliationSources(db, {
        afterSourceId: null,
        limit,
        assetKind: "native",
      }),
    ).rejects.toThrow("TON_INVALID_LIMIT");
    expect(calls).toHaveLength(0);
  });

  it("recomputes the source ID and rejects jetton or noncanonical identities", async () => {
    const { db, calls } = recordingDatabase();
    await expect(
      claimTonReconciliationLease(db, {
        source: { ...source(), sourceId: "0".repeat(64) },
        providerId: "toncenter-v3-testnet",
        leaseOwner: OWNER,
        leaseMs: 90_000,
      }),
    ).rejects.toThrow("TON_INVALID_SOURCE");
    await expect(
      claimTonReconciliationLease(db, {
        source: {
          ...source(),
          asset: {
            network: "tvm:-3",
            kind: "jetton",
            decimals: 9,
            masterAddress: RECIPIENT,
          },
        },
        providerId: "toncenter-v3-testnet",
        leaseOwner: OWNER,
        leaseMs: 90_000,
      }),
    ).rejects.toThrow("TON_INVALID_FIELDS");
    expect(calls).toHaveLength(0);
  });

  it("validates claimed cursor and pinned native binding returned by SQL", async () => {
    const binding = {
      recipientAccount: RECIPIENT,
      derivation: { kind: "native", ownerAddress: RECIPIENT },
    } as const;
    const { db, calls } = recordingDatabase([
      { kind: "claimed", cursor: CURSOR, binding },
    ]);
    await expect(
      claimTonReconciliationLease(db, {
        source: source(),
        providerId: "toncenter-v3-testnet",
        leaseOwner: OWNER,
        leaseMs: 90_000,
      }),
    ).resolves.toEqual({ kind: "claimed", cursor: CURSOR, binding });
    expect(calls[0]?.values[1]).toBe("toncenter-v3-testnet");
    expect(calls[0]?.values[2]).toBe(OWNER);
    expect(calls[0]?.values[3]).toBe(90_000);
  });

  it("rejects forged cursor and binding keys before bind/renew SQL", async () => {
    const { db, calls } = recordingDatabase();
    await expect(
      bindTonReconciliationRecipient(db, {
        source: source(),
        leaseOwner: OWNER,
        expected: { ...CURSOR, legacy: true } as typeof CURSOR,
        binding: {
          recipientAccount: RECIPIENT,
          derivation: { kind: "native", ownerAddress: RECIPIENT },
        },
      }),
    ).rejects.toThrow("TON_INVALID_FIELDS");
    await expect(
      bindTonReconciliationRecipient(db, {
        source: source(),
        leaseOwner: OWNER,
        expected: null,
        binding: {
          recipientAccount: `0:${"6".repeat(64)}`,
          derivation: { kind: "native", ownerAddress: RECIPIENT },
        },
      }),
    ).rejects.toThrow("TON_INVALID_BINDING");
    expect(calls).toHaveLength(0);
  });

  it("uses the exact expected cursor in bind, renew and advance CAS calls", async () => {
    const { db, calls } = recordingDatabase(["bound", "renewed", "advanced"]);
    await bindTonReconciliationRecipient(db, {
      source: source(),
      leaseOwner: OWNER,
      expected: CURSOR,
      binding: {
        recipientAccount: RECIPIENT,
        derivation: { kind: "native", ownerAddress: RECIPIENT },
      },
    });
    await renewTonReconciliationLease(db, {
      sourceId: source().sourceId,
      leaseOwner: OWNER,
      expected: CURSOR,
      leaseMs: 90_000,
    });
    await advanceTonReconciliationCursor(db, {
      sourceId: source().sourceId,
      leaseOwner: OWNER,
      expected: CURSOR,
      next: CURSOR,
      outcome: "source_error",
      retryAfterMs: 999_999 > 900_000 ? null : 999_999,
      errorCode: "timeout",
    });
    expect(calls.map((call) => call.values)).toEqual([
      [
        expect.any(String),
        OWNER,
        '{"beforeLt":"12","beforeTransactionHash":"2222222222222222222222222222222222222222222222222222222222222222","cycleUpperLt":"15","schemaVersion":1}',
        expect.any(String),
      ],
      [
        source().sourceId,
        OWNER,
        '{"beforeLt":"12","beforeTransactionHash":"2222222222222222222222222222222222222222222222222222222222222222","cycleUpperLt":"15","schemaVersion":1}',
        90_000,
      ],
      [
        source().sourceId,
        OWNER,
        expect.any(String),
        expect.any(String),
        "source_error",
        null,
        "timeout",
      ],
    ]);
  });

  it("rejects cursor-skipping source errors and unbounded Retry-After", async () => {
    const { db, calls } = recordingDatabase();
    await expect(
      advanceTonReconciliationCursor(db, {
        sourceId: source().sourceId,
        leaseOwner: OWNER,
        expected: CURSOR,
        next: null,
        outcome: "source_error",
        retryAfterMs: null,
        errorCode: "timeout",
      }),
    ).rejects.toThrow("TON_INVALID_ADVANCE");
    await expect(
      advanceTonReconciliationCursor(db, {
        sourceId: source().sourceId,
        leaseOwner: OWNER,
        expected: CURSOR,
        next: CURSOR,
        outcome: "source_error",
        retryAfterMs: 900_001,
        errorCode: "rate_limited",
      }),
    ).rejects.toThrow("TON_INVALID_ADVANCE");
    expect(calls).toHaveLength(0);
  });

  it("binds exact references and bounds reconciliation lookup inputs", async () => {
    const reference = "aiag-ton:00000000-0000-4000-8000-000000000003";
    const { db, calls } = recordingDatabase([[]]);
    await expect(
      findTonInvoicesForReconciliation(db, {
        source: source(),
        references: [reference],
      }),
    ).resolves.toEqual([]);
    expect(calls[0]?.text).toContain("$1::jsonb,$2::text[]");
    expect(calls[0]?.values[1]).toEqual([reference]);
    const invalid = recordingDatabase();
    await expect(
      findTonInvoicesForReconciliation(invalid.db, {
        source: source(),
        references: Array.from({ length: 9 }, (_, index) =>
          `aiag-ton:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      }),
    ).rejects.toThrow("TON_INVALID_REFERENCES");
    expect(invalid.calls).toHaveLength(0);
  });

  it("parses the exact invoice projection in both reconciliation read wrappers", async () => {
    const expected = invoice();
    const listed = recordingDatabase([[expected]]);
    await expect(
      findTonInvoicesForReconciliation(listed.db, {
        source: source(),
        references: [expected.reference],
      }),
    ).resolves.toEqual([expected]);
    const single = recordingDatabase([expected]);
    await expect(
      getTonInvoiceForReconciliation(single.db, expected.invoiceId),
    ).resolves.toEqual(expected);
  });

  it("binds the single invoice result to the requested invoice ID", async () => {
    const { db } = recordingDatabase([
      invoice({ invoiceId: "00000000-0000-4000-8000-000000000006" }),
    ]);
    await expect(getTonInvoiceForReconciliation(db, INVOICE)).rejects.toThrow(
      "TON_INVALID_DATABASE_RESULT",
    );
  });

  it("preserves PostgreSQL timestamp offset and microsecond precision", async () => {
    const expected = invoice({
      createdAt: "2026-09-13T23:30:00.123456+05:30",
      expiresAt: "2026-09-13T18:02:00.1+00:00",
    });
    const { db } = recordingDatabase([expected]);
    await expect(
      getTonInvoiceForReconciliation(db, expected.invoiceId),
    ).resolves.toEqual(expected);
  });

  it.each([
    ["extra key", { ...invoice(), legacy: true }],
    [
      "missing key",
      Object.fromEntries(
        Object.entries(invoice()).filter(([key]) => key !== "quoteId"),
      ),
    ],
    ["invalid status", { ...invoice(), status: "paid" }],
    ["noncanonical address", { ...invoice(), recipient: `0:${"A".repeat(64)}` }],
    ["invalid time", { ...invoice(), createdAt: "yesterday" }],
    ["non-PostgreSQL UTC suffix", { ...invoice(), createdAt: "2026-09-13T18:00:00Z" }],
    ["noncanonical fraction", { ...invoice(), createdAt: "2026-09-13T18:00:00.120+00:00" }],
    ["invalid calendar date", { ...invoice(), createdAt: "2026-02-29T18:00:00+00:00" }],
  ])("rejects a %s from the invoice result boundary", async (_label, value) => {
    const { db } = recordingDatabase([value]);
    await expect(
      getTonInvoiceForReconciliation(db, INVOICE),
    ).rejects.toThrow("TON_INVALID_DATABASE_RESULT");
  });

  it.each([
    [
      "wrong recipient",
      [{ ...invoice(), recipient: `0:${"6".repeat(64)}` }],
    ],
    [
      "wrong asset",
      [{ ...invoice(), asset: { network: "tvm:-3", kind: "native", decimals: 8 } }],
    ],
    [
      "unrequested reference",
      [
        {
          ...invoice(),
          reference: "aiag-ton:00000000-0000-4000-8000-000000000006",
        },
      ],
    ],
    ["excess rows", [invoice(), invoice({ invoiceId: OWNER })]],
    ["duplicate rows", [invoice(), invoice()]],
  ])("rejects %s in an invoice list result", async (_label, rows) => {
    const expected = invoice();
    const secondReference = "aiag-ton:00000000-0000-4000-8000-000000000006";
    const { db } = recordingDatabase([rows]);
    await expect(
      findTonInvoicesForReconciliation(db, {
        source: source(),
        references:
          _label === "duplicate rows"
            ? [expected.reference, secondReference]
            : [expected.reference],
      }),
    ).rejects.toThrow("TON_INVALID_DATABASE_RESULT");
  });

  it("validates observation kind/reason/identity pairings before SQL", async () => {
    const malformed: TonObservationInput[] = [
      observation({
        result: {
          kind: "verified_candidate",
          reason: "wrong" as "verified_candidate",
          evidenceDigest: "5".repeat(64),
        },
      }),
      observation({ eventIdentity: null }),
      observation({
        invoiceId: null,
        eventIdentity: null,
        result: {
          kind: "unmatched",
          reason: "invoice_reference_not_found",
          evidenceDigest: "5".repeat(64),
        },
      }),
      observation({ snapshot: { reference: "unknown" } }),
    ];
    const { db, calls } = recordingDatabase();
    for (const input of malformed) {
      await expect(recordTonChainObservation(db, input)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized snapshots before observation serialization and SQL", async () => {
    const { db, calls } = recordingDatabase();
    await expect(
      recordTonChainObservation(
        db,
        observation({
          snapshot: {
            reference: "aiag-ton:00000000-0000-4000-8000-000000000003",
            payload: "x".repeat(32_768),
          },
        }),
      ),
    ).rejects.toThrow("TON_SNAPSHOT_TOO_LARGE");
    expect(calls).toHaveLength(0);
  });

  it("records a canonical observation through one prepared transaction", async () => {
    const { db, calls } = recordingDatabase([
      {
        observationId: "00000000-0000-4000-8000-000000000004",
        outcome: "inserted",
        invoiceStatus: "observed",
      },
    ]);
    await expect(recordTonChainObservation(db, observation())).resolves.toEqual({
      observationId: "00000000-0000-4000-8000-000000000004",
      outcome: "inserted",
      invoiceStatus: "observed",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(
      "SELECT aiag_record_ton_chain_observation_v1($1::jsonb) AS result",
    );
    expect(calls[0]?.values).toEqual([expect.any(String)]);
  });

  it("uses prepared get and release calls", async () => {
    const { db, calls } = recordingDatabase([null, "released"]);
    await expect(getTonInvoiceForReconciliation(db, INVOICE)).resolves.toBeNull();
    await expect(
      releaseTonReconciliationLease(db, source().sourceId, OWNER),
    ).resolves.toBe("released");
    expect(calls.map((call) => call.values)).toEqual([
      [INVOICE],
      [source().sourceId, OWNER],
    ]);
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakePool(options: {
  connect?: Promise<ReturnType<typeof fakeClient>>;
  end?: Promise<void>;
} = {}) {
  const client = fakeClient();
  return {
    client,
    pool: {
      connect: vi.fn(() => options.connect ?? Promise.resolve(client)),
      end: vi.fn(() => options.end ?? Promise.resolve()),
    },
  };
}

function fakeClient() {
  return {
    query: vi.fn(async (config: { text: string; values: readonly unknown[] }) => ({
      rows: config.text === "SELECT 1" ? [{ value: 1 }] : [],
      rowCount: config.text === "SELECT 1" ? 1 : 0,
    })),
    release: vi.fn(),
  };
}

describe("bounded TON native database adapter", () => {
  beforeEach(() => {
    pgMock.createPool.mockReset();
    vi.useRealTimers();
  });

  it.each([
    "connect_timeout",
    "STATEMENT_TIMEOUT",
    "query_timeout",
    "Lock_Timeout",
    "idle_in_transaction_session_timeout",
    "OPTIONS",
  ])("rejects caller-owned %s before constructing a pool", (setting) => {
    expect(() =>
      createTonWorkerDatabase(
        `postgresql://user:secret@127.0.0.1:5432/db?${setting}=999999`,
      ),
    ).toThrow("TON_DATABASE_URL_OWNED_SETTING");
    expect(pgMock.createPool).not.toHaveBeenCalled();
  });

  it("constructs one pg pool with fixed owned limits", async () => {
    const fake = fakePool();
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase(
      "postgresql://user:secret@127.0.0.1:5432/db?sslmode=disable",
    );
    expect(pgMock.createPool).toHaveBeenCalledWith({
      connectionString:
        "postgresql://user:secret@127.0.0.1:5432/db?sslmode=disable",
      connectionTimeoutMillis: TON_DB_CONNECT_TIMEOUT_MS,
      statement_timeout: TON_DB_STATEMENT_TIMEOUT_MS,
      query_timeout: TON_DB_QUERY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: TON_DB_OPERATION_DEADLINE_MS,
      options: `-c lock_timeout=${TON_DB_LOCK_TIMEOUT_MS}`,
    });
    await db.close();
  });

  it("owns BEGIN/COMMIT and always releases the checked-out client", async () => {
    const fake = fakePool();
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
    await expect(
      db.transaction(async (tx) => {
        const result = await tx.query<{ value: number }>({
          text: "SELECT 1",
          values: [],
        });
        return result.rows[0]?.value;
      }),
    ).resolves.toBe(1);
    expect(fake.client.query.mock.calls.map(([config]) => config.text)).toEqual([
      "BEGIN",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back callback failures and preserves the original error", async () => {
    const fake = fakePool();
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
    await expect(
      db.transaction(async () => {
        throw new Error("callback_failed");
      }),
    ).rejects.toThrow("callback_failed");
    expect(fake.client.query.mock.calls.map(([config]) => config.text)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("bounds hung checkout and suppresses its late fulfillment", async () => {
    vi.useFakeTimers();
    const checkout = deferred<ReturnType<typeof fakeClient>>();
    const fake = fakePool({ connect: checkout.promise });
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
    const operation = db.transaction(async () => "unused");
    const assertion = expect(operation).rejects.toThrow(
      "TON_DB_OPERATION_DEADLINE_EXCEEDED",
    );
    await vi.advanceTimersByTimeAsync(TON_DB_OPERATION_DEADLINE_MS);
    await assertion;
    checkout.resolve(fake.client);
    await vi.runAllTimersAsync();
    expect(fake.client.release).toHaveBeenCalledOnce();
    expect(fake.client.query).not.toHaveBeenCalled();
  });

  it.each(["SELECT HANG", "COMMIT", "ROLLBACK"])(
    "bounds a hung %s phase without claiming rollback",
    async (phase) => {
      vi.useFakeTimers();
      const never = deferred<{ rows: []; rowCount: number }>();
      const fake = fakePool();
      fake.client.query.mockImplementation(async (config) => {
        if (config.text === phase) return never.promise;
        return { rows: [], rowCount: 0 };
      });
      pgMock.createPool.mockReturnValue(fake.pool);
      const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
      const operation = db.transaction(async (tx) => {
        if (phase === "ROLLBACK") throw new Error("trigger_rollback");
        await tx.query({ text: "SELECT HANG", values: [] });
        return "done";
      });
      const assertion = expect(operation).rejects.toThrow(
        "TON_DB_OPERATION_DEADLINE_EXCEEDED",
      );
      await vi.advanceTimersByTimeAsync(TON_DB_OPERATION_DEADLINE_MS);
      await assertion;
      expect(fake.client.query).toHaveBeenCalledWith({
        text: "ROLLBACK",
        values: [],
      });
    },
  );

  it("rejects every late callback query and releases once after the deadline", async () => {
    vi.useFakeTimers();
    const callbackGate = deferred<void>();
    const fake = fakePool();
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
    const operation = db.transaction(async (tx) => {
      await callbackGate.promise;
      await tx.query({ text: "MUTATE LATE", values: [] });
      return "late";
    });
    await vi.advanceTimersByTimeAsync(0);
    const assertion = expect(operation).rejects.toThrow(
      "TON_DB_OPERATION_DEADLINE_EXCEEDED",
    );
    await vi.advanceTimersByTimeAsync(TON_DB_OPERATION_DEADLINE_MS);
    await assertion;
    expect(fake.client.query.mock.calls.map(([config]) => config.text)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
    expect(fake.client.release).toHaveBeenCalledOnce();

    callbackGate.resolve();
    await vi.runAllTimersAsync();
    expect(fake.client.query).not.toHaveBeenCalledWith({
      text: "MUTATE LATE",
      values: [],
    });
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("memoizes close and bounds a hung pool end", async () => {
    vi.useFakeTimers();
    const ending = deferred<void>();
    const fake = fakePool({ end: ending.promise });
    pgMock.createPool.mockReturnValue(fake.pool);
    const db = createTonWorkerDatabase("postgresql://user:secret@db.test/db");
    const first = db.close();
    const second = db.close();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(TON_POOL_CLOSE_DEADLINE_MS);
    await expect(first).resolves.toEqual({
      kind: "deadline_exceeded",
      phase: "pool",
    });
    expect(fake.pool.end).toHaveBeenCalledOnce();
    ending.resolve();
    await vi.runAllTimersAsync();
  });
});
