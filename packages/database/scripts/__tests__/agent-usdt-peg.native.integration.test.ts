import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

/** Raw form of the TON mainnet USDT master EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs. */
const USDT_MAINNET_MASTER =
  "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
/** Operator-configured testnet master (GUC aiag.usdt_testnet_master). */
const USDT_TESTNET_MASTER = `0:${"c".repeat(64)}`;
/** Placeholder default baked into 0109 when the GUC is unset. */
const USDT_PLACEHOLDER_MASTER = `0:${"0".repeat(64)}`;
const RECIPIENT = `0:${"1".repeat(64)}`;

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

/**
 * Migration 0109 proof set: network-parameterized USDT peg + allowlist seed +
 * asset-aware source identity.
 *
 * The peg pair table lives in aiag_agent_ton_payload_v1 (0106 body, 0109 jetton
 * branch): tvm:-1 accepts only the canonical mainnet USDT master; tvm:-3
 * accepts only the operator-configured testnet master read from the
 * aiag.usdt_testnet_master GUC (placeholder default when unset). Everything
 * else is AGENT_ASSET_UNSUPPORTED; a mismatched amount is AGENT_PEG_VIOLATION.
 */
describe.skipIf(!RUN_INTEGRATION)("agent usdt peg parameterization (0109)", () => {
  let client: TestDatabaseClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    await withGuardedTestDatabase(
      process.env,
      { clientFactory: createPgTestClient },
      async (guardedClient) => {
        client = guardedClient;
        const applied = await client.query<{ version: string }>({
          text: "SELECT version FROM public.schema_migrations WHERE version = $1",
          values: ["migrations/0109_usdt_jetton_reconciliation.sql"],
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

  function payload(asset: {
    network: string;
    masterAddress: string;
  }, patch: { amountAtomic?: string; numerator?: string } = {}): string {
    const jettonAsset = {
      network: asset.network,
      kind: "jetton",
      masterAddress: asset.masterAddress,
      decimals: 6,
    };
    return JSON.stringify({
      schemaVersion: 1,
      purpose: "agent_topup",
      ownerId: OWNER,
      orgId: ORG,
      idempotencyKey: "usdt-peg-proof",
      grantMicrocredits: "100000",
      priceRevision: "peg-v1",
      quote: {
        schemaVersion: 1,
        quoteId: "peg-quote-1",
        sourcePrice: { unit: "gateway_microcredits", amountAtomic: "100000" },
        asset: jettonAsset,
        fx: {
          sourceUnit: "gateway_microcredits",
          targetAsset: jettonAsset,
          numerator: patch.numerator ?? "10",
          denominator: "1",
          rounding: "floor",
          source: "usdt-peg-v1",
          observedAtMs: 2_000_000_000_000,
          expiresAtMs: 2_000_003_600_000,
        },
        additionalFeeAtomic: "0",
        amountAtomic: patch.amountAtomic ?? "1000000",
        quotedAtMs: 2_000_000_000_500,
        expiresAtMs: 2_000_003_600_000,
      },
      recipient: RECIPIENT,
      finalityPolicyId: "peg-finality",
      verifierVersion: "peg-verifier",
    });
  }

  const OWNER = randomUUID();
  const ORG = randomUUID();

  async function expectPayloadError(body: string, code: string): Promise<void> {
    try {
      await client.query({
        text: "SELECT aiag_agent_ton_payload_v1($1::jsonb,$2::uuid,$3::uuid)",
        values: [body, OWNER, ORG],
      });
    } catch (error) {
      expect((error as { message?: string }).message).toBe(code);
      return;
    }
    throw new Error(`expected ${code}`);
  }

  async function expectPayloadAccepted(body: string): Promise<void> {
    await client.query({
      text: "SELECT aiag_agent_ton_payload_v1($1::jsonb,$2::uuid,$3::uuid)",
      values: [body, OWNER, ORG],
    });
  }

  /** SET accepts no bind parameters; the literal is a test-owned raw address. */
  async function setTestnetMaster(address: string): Promise<void> {
    if (!/^(0|-1):[0-9a-f]{64}$/.test(address)) throw new Error("invalid test master");
    await client.query({
      text: `SET aiag.usdt_testnet_master = '${address}'`,
      values: [],
    });
  }
  async function resetTestnetMaster(): Promise<void> {
    await client.query({ text: "RESET aiag.usdt_testnet_master", values: [] });
  }

  it("seeds exactly the mainnet USDT jetton into the asset allowlist", async () => {
    const rows = await client.query<{
      network: string;
      asset_kind: string;
      master_address: string | null;
      asset_decimals: number;
      is_active: boolean;
    }>({
      text: `SELECT network,asset_kind,master_address,asset_decimals,is_active
        FROM public.ton_asset_allowlist WHERE asset_kind='jetton' ORDER BY network`,
      values: [],
    });
    expect(rows.rows).toEqual([
      {
        network: "tvm:-1",
        asset_kind: "jetton",
        master_address: USDT_MAINNET_MASTER,
        asset_decimals: 6,
        is_active: true,
      },
    ]);
  });

  it("accepts the canonical mainnet pair (tvm:-1 + USDT master)", async () => {
    await expectPayloadAccepted(
      payload({ network: "tvm:-1", masterAddress: USDT_MAINNET_MASTER }),
    );
  });

  it("accepts the testnet pair only against the configured testnet master", async () => {
    await setTestnetMaster(USDT_TESTNET_MASTER);
    await expectPayloadAccepted(
      payload({ network: "tvm:-3", masterAddress: USDT_TESTNET_MASTER }),
    );
    // The mainnet master is NOT a testnet master.
    await expectPayloadError(
      payload({ network: "tvm:-3", masterAddress: USDT_MAINNET_MASTER }),
      "AGENT_ASSET_UNSUPPORTED",
    );
    // A foreign mainnet master is not the canonical USDT master either.
    await expectPayloadError(
      payload({ network: "tvm:-1", masterAddress: USDT_TESTNET_MASTER }),
      "AGENT_ASSET_UNSUPPORTED",
    );
    await resetTestnetMaster();
  });

  it("falls back to the placeholder default when the testnet GUC is unset", async () => {
    await expectPayloadAccepted(
      payload({ network: "tvm:-3", masterAddress: USDT_PLACEHOLDER_MASTER }),
    );
    // The placeholder is not the mainnet master, so the cross-network pair
    // stays refused.
    await expectPayloadError(
      payload({ network: "tvm:-1", masterAddress: USDT_PLACEHOLDER_MASTER }),
      "AGENT_ASSET_UNSUPPORTED",
    );
  });

  it("keeps the peg equality amount_atomic = grant x 10 for both chains", async () => {
    await setTestnetMaster(USDT_TESTNET_MASTER);
    for (const network of ["tvm:-1", "tvm:-3"] as const) {
      // A self-consistent quote at a DIFFERENT ratio passes the generic fx
      // arithmetic and is then refused by the USDT-specific peg equality —
      // the peg is a second, asset-bound gate, not a restatement of the fx.
      await expectPayloadError(
        payload(
          {
            network,
            masterAddress:
              network === "tvm:-1" ? USDT_MAINNET_MASTER : USDT_TESTNET_MASTER,
          },
          { numerator: "20", amountAtomic: "2000000" },
        ),
        "AGENT_PEG_VIOLATION",
      );
      await expectPayloadError(
        payload(
          {
            network,
            masterAddress:
              network === "tvm:-1" ? USDT_MAINNET_MASTER : USDT_TESTNET_MASTER,
          },
          { amountAtomic: "1000001" },
        ),
        "TON_QUOTE_MISMATCH",
      );
    }
    await resetTestnetMaster();
  });

  it("canonicalizes jetton source ids case- and order-independently", async () => {
    const result = await client.query<{ same: boolean; differs: boolean }>({
      text: `SELECT
        aiag_ton_reconciliation_source_id_v1('toncenter-v3-mainnet',
          '{"network":"tvm:-1","kind":"jetton","masterAddress":"0:${"D".repeat(64)}","decimals":6}'::jsonb,
          $1::text)
        = aiag_ton_reconciliation_source_id_v1('toncenter-v3-mainnet',
          '{"decimals":6,"kind":"jetton","masterAddress":"0:${"d".repeat(64)}","network":"tvm:-1"}'::jsonb,
          $1::text) AS same,
        aiag_ton_reconciliation_source_id_v1('toncenter-v3-mainnet',
          '{"decimals":6,"kind":"jetton","masterAddress":"0:${"d".repeat(64)}","network":"tvm:-1"}'::jsonb,
          $1::text)
        <> aiag_ton_reconciliation_source_id_v1('toncenter-v3-mainnet',
          '{"decimals":9,"kind":"native","network":"tvm:-1"}'::jsonb,
          $1::text) AS differs`,
      values: [RECIPIENT],
    });
    expect(result.rows[0]).toEqual({ same: true, differs: true });
  });

  it("widens the source listing to jetton/all and still refuses unknown kinds", async () => {
    await expect(
      client.query({
        text: "SELECT aiag_list_ton_reconciliation_sources_v1(NULL,16,'jetton') AS result",
        values: [],
      }),
    ).resolves.toMatchObject({ rows: [{ result: [] }] });
    await expect(
      client.query({
        text: "SELECT aiag_list_ton_reconciliation_sources_v1(NULL,16,'all') AS result",
        values: [],
      }),
    ).resolves.toMatchObject({ rows: [{ result: [] }] });
    await expect(
      client.query({
        text: "SELECT aiag_list_ton_reconciliation_sources_v1(NULL,16,'bogus') AS result",
        values: [],
      }),
    ).rejects.toThrow("TON_INVALID_SOURCE_LIST");
  });
});
