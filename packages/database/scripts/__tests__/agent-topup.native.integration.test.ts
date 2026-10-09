import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgTestClient } from "../pg-test-client";
import {
  assertTestDatabaseEnvironment,
  withGuardedTestDatabase,
  type TestDatabaseClient,
} from "../test-db-guard";

const RUN_INTEGRATION = process.env.RUN_NATIVE_DB_INTEGRATION === "1";

const AGENT_OWNER_ID = "00000000-0000-0000-0000-0000000000a1";
const ADDRESS_RAW = `0:${"a1".repeat(32)}`;
/** Unique per fixture: agent_principals has a partial unique on active (network,address). */
let walletSequence = 0;
function nextWalletAddress(): string {
  walletSequence += 1;
  return (
    "A".repeat(44) + walletSequence.toString(36).padStart(4, "0")
  ).slice(0, 48);
}
const RECIPIENT = `0:${"1".repeat(64)}`;
const ARBITRARY_SENDER = `0:${"7".repeat(64)}`;
/** Raw form of the TON mainnet USDT jetton master EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs. */
const USDT_MASTER_RAW =
  "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

if (RUN_INTEGRATION) {
  assertTestDatabaseEnvironment(process.env);
}

/**
 * Migration 0106 proof set: headless agent topup invoices.
 *
 * Task 1/3 harness (guarded canonical test database, every test wrapped in
 * BEGIN/ROLLBACK). The settle cases run through the real
 * aiag_settle_ton_invoice_v1 and flush the deferred consistency triggers with
 * SET CONSTRAINTS ALL IMMEDIATE, so no fixture is ever committed.
 */
describe.skipIf(!RUN_INTEGRATION)("agent topup invoices (0106)", () => {
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
          values: ["migrations/0106_agent_topup_core.sql"],
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

  async function dbNow(): Promise<number> {
    const result = await client.query<{ now_ms: string }>({
      text: "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms",
      values: [],
    });
    const now = Number(result.rows[0]?.now_ms);
    if (!Number.isSafeInteger(now)) throw new Error("fixture_database_clock");
    return now;
  }

  /** Agent org: owned by the 0104 service user, one active principal, one key. */
  async function insertAgentOrg(patch: {
    principalStatus?: "active" | "revoked";
    keyPatch?: { revoked?: boolean; disabled?: boolean; expired?: boolean };
  } = {}): Promise<{ orgId: string; keyId: string; principalId: string }> {
    const orgId = randomUUID();
    const keyId = randomUUID();
    await client.query({
      text: `
        INSERT INTO public.organizations (
          id, slug, name, owner_id, subscription_credits, payg_credits
        ) VALUES ($1::uuid, $2, $3, $4::uuid, 0, 0)
      `,
      values: [
        orgId,
        `agent-topup-${orgId}`,
        "agent topup fixture",
        AGENT_OWNER_ID,
      ],
    });
    const principal = await client.query<{ id: string }>({
      text: `
        INSERT INTO public.agent_principals (org_id, network, address, address_raw)
        VALUES ($1::uuid, '-3', $2, $3)
        RETURNING id::text AS id
      `,
      values: [orgId, nextWalletAddress(), ADDRESS_RAW],
    });
    if (patch.principalStatus === "revoked") {
      await client.query({
        text: `
          UPDATE public.agent_principals
          SET status = 'revoked', revoked_at = clock_timestamp()
          WHERE org_id = $1::uuid
        `,
        values: [orgId],
      });
    }
    const key = patch.keyPatch ?? {};
    await client.query({
      text: `
        INSERT INTO public.gateway_api_keys (
          id, org_id, name, key_hash, key_prefix, policies, created_at, expires_at
        ) VALUES (
          $1::uuid, $2::uuid, 'agent-test', $3, $4, $5::jsonb,
          clock_timestamp() - interval '2 seconds',
          CASE WHEN $6 THEN clock_timestamp() - interval '1 second' ELSE NULL END
        )
      `,
      values: [
        keyId,
        orgId,
        createHash("sha256").update(keyId).digest("hex"),
        `pk-${keyId.slice(0, 12)}`,
        JSON.stringify({ kind: "agent" }),
        key.expired === true,
      ],
    });
    if (key.revoked) {
      await client.query({
        text: "UPDATE public.gateway_api_keys SET revoked_at = clock_timestamp() WHERE id = $1::uuid",
        values: [keyId],
      });
    }
    if (key.disabled) {
      await client.query({
        text: "UPDATE public.gateway_api_keys SET disabled_at = clock_timestamp() WHERE id = $1::uuid",
        values: [keyId],
      });
    }
    return { orgId, keyId, principalId: principal.rows[0]!.id };
  }

  interface PayloadOptions {
    orgId: string;
    ownerId?: string;
    grant?: string;
    now: number;
    kind?: "native" | "jetton";
    idemKey?: string;
    /** Overrides amountAtomic to force a peg violation (fee must cover it). */
    pegAmount?: string;
    fee?: string;
    masterOverride?: string;
    networkOverride?: string;
  }

  function agentPayload(opts: PayloadOptions): {
    payload: Record<string, unknown>;
    fingerprint: string;
  } {
    const kind = opts.kind ?? "native";
    const grant = opts.grant ?? "1000000";
    const asset =
      kind === "native"
        ? {
            network: opts.networkOverride ?? "tvm:-3",
            kind: "native",
            decimals: 9,
          }
        : {
            network: opts.networkOverride ?? "tvm:-1",
            kind: "jetton",
            decimals: 6,
            masterAddress: opts.masterOverride ?? USDT_MASTER_RAW,
          };
    const numerator = kind === "native" ? "1" : "10";
    const fee = opts.fee ?? "0";
    const amount =
      opts.pegAmount ??
      (BigInt(grant) * (kind === "native" ? 1n : 10n) + BigInt(fee)).toString();
    const payload = {
      schemaVersion: 1,
      purpose: "agent_topup",
      ownerId: opts.ownerId ?? AGENT_OWNER_ID,
      orgId: opts.orgId,
      idempotencyKey: opts.idemKey ?? `agent-topup-${randomUUID()}`,
      grantMicrocredits: grant,
      priceRevision: "agent-topup-price-v1",
      quote: {
        schemaVersion: 1,
        quoteId: `quote-${randomUUID()}`,
        sourcePrice: { unit: "gateway_microcredits", amountAtomic: grant },
        asset,
        fx: {
          sourceUnit: "gateway_microcredits",
          targetAsset: asset,
          numerator,
          denominator: "1",
          rounding: "floor",
          source: "agent-topup-fixture-v1",
          observedAtMs: opts.now - 1,
          expiresAtMs: opts.now + 300_000,
        },
        additionalFeeAtomic: fee,
        expiresAtMs: opts.now + 300_000,
        amountAtomic: amount,
        quotedAtMs: opts.now - 1,
      },
      recipient: RECIPIENT,
      finalityPolicyId: "agent-topup-finality-v1",
      verifierVersion: "agent-topup-verifier-v1",
    };
    return {
      payload,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
    };
  }

  async function createInvoice(
    keyId: string,
    built: { payload: Record<string, unknown>; fingerprint: string },
  ): Promise<Record<string, unknown>> {
    const result = await client.query<{ result: Record<string, unknown> }>({
      text: "SELECT public.aiag_create_agent_ton_invoice_v1($1::uuid,$2::jsonb,$3::text) AS result",
      values: [keyId, JSON.stringify(built.payload), built.fingerprint],
    });
    return result.rows[0]!.result;
  }

  async function readInvoice(
    keyId: string,
    invoiceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await client.query<{ result: Record<string, unknown> }>({
      text: "SELECT public.aiag_read_agent_ton_invoice_v1($1::uuid,$2::uuid) AS result",
      values: [keyId, invoiceId],
    });
    return result.rows[0]?.result;
  }

  async function expectAgentError(
    savepoint: string,
    query: () => Promise<unknown>,
    message: string,
  ) {
    await client.query({ text: `SAVEPOINT ${savepoint}`, values: [] });
    await expect(query()).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining(message),
    });
    await client.query({ text: `ROLLBACK TO SAVEPOINT ${savepoint}`, values: [] });
  }

  /** Settle credit for an invoice, patched like the ton-core fixtures. */
  function settleCredit(
    invoice: Record<string, unknown>,
    now: number,
    patch: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const invoiceId = invoice.invoiceId as string;
    const seed = invoiceId.replaceAll("-", "");
    const asset = invoice.asset as Record<string, unknown>;
    const jetton = asset.kind === "jetton";
    return {
      network: invoice.network,
      asset,
      recipient: invoice.recipient,
      recipientAccount: invoice.recipient,
      sender: ARBITRARY_SENDER,
      amountAtomic: invoice.amountAtomic,
      reference: invoice.reference,
      txHash: `${seed}${seed}`,
      txLt: "1",
      messageHash: `${seed.split("").reverse().join("")}${seed
        .split("")
        .reverse()
        .join("")}`,
      messageIndex: 0,
      chainTimeMs: now - 3,
      observedAtMs: now - 2,
      verifiedAtMs: now - 1,
      blockAnchor: "agent-topup-block-v1",
      masterchainAnchor: "agent-topup-mc-v1",
      executionPathDigest: "4".repeat(64),
      verifierVersion: invoice.verifierVersion,
      finalityPolicyId: invoice.finalityPolicyId,
      jettonCredit: jetton
        ? {
            masterAddress: asset.masterAddress,
            merchantJettonWallet: invoice.recipient,
          }
        : null,
      ...patch,
    };
  }

  it("creates and reads a gram invoice with a NULL expected sender", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const built = agentPayload({ orgId, now: await dbNow() });
      const invoice = await createInvoice(keyId, built);

      expect(invoice).toMatchObject({
        purpose: "agent_topup",
        ownerId: AGENT_OWNER_ID,
        orgId,
        expectedSender: null,
        status: "pending",
        amountAtomic: built.payload.grantMicrocredits,
      });

      // Same key + same payload + same fingerprint replays the SAME invoice.
      const replay = await createInvoice(keyId, built);
      expect(replay.invoiceId).toBe(invoice.invoiceId);

      // Read via the key-scoped entrypoint; a foreign key sees nothing.
      const read = await readInvoice(keyId, invoice.invoiceId as string);
      expect(read?.invoiceId).toBe(invoice.invoiceId);
      const other = await insertAgentOrg();
      const foreignRead = await client.query<{ result: unknown }>({
        text: "SELECT public.aiag_read_agent_ton_invoice_v1($1::uuid,$2::uuid) AS result",
        values: [other.keyId, invoice.invoiceId],
      });
      // Scalar SQL function: no matching row renders as a single NULL result.
      expect(foreignRead.rows[0]?.result).toBeNull();
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("creates a USDT invoice at the exact 100-credit peg once allowlisted", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const now = await dbNow();
      const built = agentPayload({
        orgId,
        now,
        kind: "jetton",
        grant: "2000000",
      });

      // Admission still runs through ton_asset_allowlist (0098); the USDT
      // seed belongs to a later plan task, so pre-seed it reads as rejected.
      await expectAgentError(
        "usdt_not_seeded",
        () => createInvoice(keyId, built),
        "TON_ASSET_NOT_ALLOWLISTED",
      );
      await client.query({
        text: `
          INSERT INTO public.ton_asset_allowlist (network,asset_kind,master_address,asset_decimals)
          VALUES ('tvm:-1','jetton',$1,6)
        `,
        values: [USDT_MASTER_RAW],
      });

      const invoice = await createInvoice(keyId, built);
      expect(invoice).toMatchObject({
        purpose: "agent_topup",
        expectedSender: null,
        amountAtomic: "20000000",
        network: "tvm:-1",
      });
      expect(invoice.asset).toEqual({
        network: "tvm:-1",
        kind: "jetton",
        decimals: 6,
        masterAddress: USDT_MASTER_RAW,
      });

      // Peg violations survive the generic FX math only via the fee field.
      const offPeg = agentPayload({
        orgId,
        now,
        kind: "jetton",
        grant: "2000000",
        pegAmount: "20000005",
        fee: "5",
      });
      await expectAgentError(
        "usdt_peg",
        () => createInvoice(keyId, offPeg),
        "AGENT_PEG_VIOLATION",
      );

      // Wrong master / wrong network are structurally rejected before the peg.
      const wrongMaster = agentPayload({
        orgId,
        now,
        kind: "jetton",
        masterOverride: `0:${"b".repeat(64)}`,
      });
      await expectAgentError(
        "usdt_master",
        () => createInvoice(keyId, wrongMaster),
        "AGENT_ASSET_UNSUPPORTED",
      );
      const testnetUsdt = agentPayload({
        orgId,
        now,
        kind: "jetton",
        networkOverride: "tvm:-3",
      });
      await expectAgentError(
        "usdt_network",
        () => createInvoice(keyId, testnetUsdt),
        "AGENT_ASSET_UNSUPPORTED",
      );
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("rejects idempotency conflicts for the same agent key", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const now = await dbNow();
      const idemKey = `agent-topup-${randomUUID()}`;
      const first = agentPayload({ orgId, now, idemKey });
      const created = await createInvoice(keyId, first);
      expect(created.status).toBe("pending");

      const diverged = agentPayload({
        orgId,
        now,
        idemKey,
        grant: "1500000",
      });
      await expectAgentError(
        "agent_idem",
        () => createInvoice(keyId, diverged),
        "TON_IDEMPOTENCY_CONFLICT",
      );
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("refuses every dead or foreign key with AGENT_NOT_AUTHORIZED", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const now = await dbNow();

      // Unknown key id.
      const ghost = agentPayload({ orgId: randomUUID(), now });
      await expectAgentError(
        "agent_key_unknown",
        () => createInvoice(randomUUID(), ghost),
        "AGENT_NOT_AUTHORIZED",
      );

      // Revoked key.
      const revoked = await insertAgentOrg({ keyPatch: { revoked: true } });
      await expectAgentError(
        "agent_key_revoked",
        () => createInvoice(revoked.keyId, agentPayload({ orgId: revoked.orgId, now })),
        "AGENT_NOT_AUTHORIZED",
      );

      // Disabled key.
      const disabled = await insertAgentOrg({ keyPatch: { disabled: true } });
      await expectAgentError(
        "agent_key_disabled",
        () => createInvoice(disabled.keyId, agentPayload({ orgId: disabled.orgId, now })),
        "AGENT_NOT_AUTHORIZED",
      );

      // Expired key (0105 TTL).
      const expired = await insertAgentOrg({ keyPatch: { expired: true } });
      await expectAgentError(
        "agent_key_expired",
        () => createInvoice(expired.keyId, agentPayload({ orgId: expired.orgId, now })),
        "AGENT_NOT_AUTHORIZED",
      );

      // Revoked principal.
      const deadPrincipal = await insertAgentOrg({
        principalStatus: "revoked",
      });
      await expectAgentError(
        "agent_principal_revoked",
        () =>
          createInvoice(
            deadPrincipal.keyId,
            agentPayload({ orgId: deadPrincipal.orgId, now }),
          ),
        "AGENT_NOT_AUTHORIZED",
      );

      // Live key of a human org without any principal.
      const userId = randomUUID();
      const orgId = randomUUID();
      const keyId = randomUUID();
      await client.query({
        text: "INSERT INTO public.users (id, email, name) VALUES ($1::uuid, $2, 'human fixture')",
        values: [userId, `human-${userId}@example.test`],
      });
      await client.query({
        text: `
          INSERT INTO public.organizations (id, slug, name, owner_id, subscription_credits, payg_credits)
          VALUES ($1::uuid, $2, 'human org', $3::uuid, 0, 0)
        `,
        values: [orgId, `human-${orgId}`, userId],
      });
      await client.query({
        text: `
          INSERT INTO public.gateway_api_keys (id, org_id, name, key_hash, key_prefix, policies)
          VALUES ($1::uuid, $2::uuid, 'human-key', $3, $4, '{}'::jsonb)
        `,
        values: [
          keyId,
          orgId,
          createHash("sha256").update(keyId).digest("hex"),
          `pk-${keyId.slice(0, 12)}`,
        ],
      });
      await expectAgentError(
        "agent_no_principal",
        () => createInvoice(keyId, agentPayload({ orgId, now })),
        "AGENT_NOT_AUTHORIZED",
      );
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("refuses grants under 100 credits", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const tiny = agentPayload({
        orgId,
        now: await dbNow(),
        grant: "99999",
      });
      await expectAgentError(
        "agent_grant_small",
        () => createInvoice(keyId, tiny),
        "AGENT_GRANT_TOO_SMALL",
      );
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("settles a NULL-sender gram invoice and keeps review reasons", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const now = await dbNow();
      const invoice = await createInvoice(
        keyId,
        agentPayload({ orgId, now, grant: "1500000" }),
      );
      const invoiceId = invoice.invoiceId as string;

      // SETTLE through the production function: a sender the invoice never
      // expected must be accepted because expected_sender IS NULL.
      const settled = await client.query<{ result: Record<string, unknown> }>({
        text: "SELECT public.aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
        values: [
          invoiceId,
          JSON.stringify(settleCredit(invoice, now)),
        ],
      });
      expect(settled.rows[0]!.result).toMatchObject({ kind: "settled" });
      // Flush the deferred consistency triggers inside this transaction.
      await client.query({ text: "SET CONSTRAINTS ALL IMMEDIATE", values: [] });

      const state = await client.query<{
        status: string;
        expected_sender: string | null;
        payg: string;
        receipts: string;
      }>({
        text: `
          SELECT i.status, i.expected_sender, o.payg_credits::text AS payg,
                 (SELECT count(*)::text FROM public.gateway_transactions g
                   WHERE g.request_id = 'ton:invoice:' || i.id::text
                     AND g.type = 'topup' AND g.source = 'ton') AS receipts
          FROM public.ton_invoices i
          JOIN public.organizations o ON o.id = i.org_id
          WHERE i.id = $1::uuid
        `,
        values: [invoiceId],
      });
      expect(state.rows[0]).toEqual({
        status: "settled",
        expected_sender: null,
        payg: "1500000",
        receipts: "1",
      });

      // Review contour intact: an underpaid transfer to the same invoice
      // shape lands in review_required with the 0072 reason vocabulary.
      const second = await createInvoice(
        keyId,
        agentPayload({ orgId, now, grant: "1200000" }),
      );
      const shortCredit = settleCredit(second, now, {
        amountAtomic: (BigInt(second.amountAtomic as string) - 1n).toString(),
      });
      const reviewed = await client.query<{ result: Record<string, unknown> }>({
        text: "SELECT public.aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
        values: [second.invoiceId as string, JSON.stringify(shortCredit)],
      });
      expect(reviewed.rows[0]!.result).toMatchObject({
        kind: "review_required",
        reason: "underpayment",
      });
      await client.query({ text: "SET CONSTRAINTS ALL IMMEDIATE", values: [] });
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);

  it("settles a USDT invoice end to end at the peg", async () => {
    await client.query({ text: "BEGIN", values: [] });
    try {
      const { orgId, keyId } = await insertAgentOrg();
      const now = await dbNow();
      await client.query({
        text: `
          INSERT INTO public.ton_asset_allowlist (network,asset_kind,master_address,asset_decimals)
          VALUES ('tvm:-1','jetton',$1,6)
        `,
        values: [USDT_MASTER_RAW],
      });
      const invoice = await createInvoice(
        keyId,
        agentPayload({ orgId, now, kind: "jetton", grant: "3000000" }),
      );
      expect(invoice.amountAtomic).toBe("30000000");

      const settled = await client.query<{ result: Record<string, unknown> }>({
        text: "SELECT public.aiag_settle_ton_invoice_v1($1::uuid,$2::jsonb) AS result",
        values: [
          invoice.invoiceId as string,
          JSON.stringify(settleCredit(invoice, now)),
        ],
      });
      expect(settled.rows[0]!.result).toMatchObject({ kind: "settled" });
      await client.query({ text: "SET CONSTRAINTS ALL IMMEDIATE", values: [] });

      const state = await client.query<{ payg: string }>({
        text: "SELECT payg_credits::text AS payg FROM public.organizations WHERE id = $1::uuid",
        values: [orgId],
      });
      expect(state.rows[0]).toEqual({ payg: "3000000" });
    } finally {
      await client.query({ text: "ROLLBACK", values: [] });
    }
  }, 120_000);
});
