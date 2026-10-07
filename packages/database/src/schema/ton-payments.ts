/** Constraints, state-machine and append-only guards are authoritative in migration 0072. */
import {
  pgTable,
  uuid,
  text,
  varchar,
  char,
  jsonb,
  bigint,
  boolean,
  smallint,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { TonQuote } from "@aiag/shared/ton-payment-contract";
import type {
  TonProviderCursor,
  TonRecipientBinding,
} from "../ton-payment-types";
import { users } from "./users";
import { organizations } from "./organizations";
import { gatewayTransactions } from "./gateway";
export const tonChainEvents = pgTable(
  "ton_chain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    network: text("network").notNull(),
    recipientAccount: varchar("recipient_account", { length: 67 }).notNull(),
    txHash: char("tx_hash", { length: 64 }).notNull(),
    messageHash: char("message_hash", { length: 64 }).notNull(),
    txLt: varchar("tx_lt", { length: 78 }).notNull(),
    messageIndex: integer("message_index").notNull(),
    factSnapshot: jsonb("fact_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    identity: uniqueIndex(
      "ton_chain_events_network_recipient_account_tx_hash_message_hash_key",
    ).on(t.network, t.recipientAccount, t.txHash, t.messageHash),
  }),
);
export const tonInvoices = pgTable(
  "ton_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").notNull().unique().defaultRandom(),
    purpose: text("purpose").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    requestPayload: jsonb("request_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    priceRevision: varchar("price_revision", { length: 96 }).notNull(),
    grantMicrocredits: bigint("grant_microcredits", {
      mode: "bigint",
    }).notNull(),
    sourcePriceUnit: text("source_price_unit").notNull(),
    sourcePriceAtomic: bigint("source_price_atomic", {
      mode: "bigint",
    }).notNull(),
    quoteId: varchar("quote_id", { length: 96 }).notNull(),
    quoteSnapshot: jsonb("quote_snapshot").$type<TonQuote>().notNull(),
    network: text("network").notNull(),
    assetKind: text("asset_kind").notNull(),
    masterAddress: varchar("master_address", { length: 67 }),
    assetDecimals: smallint("asset_decimals").notNull(),
    amountAtomic: bigint("amount_atomic", { mode: "bigint" }).notNull(),
    recipient: varchar("recipient", { length: 67 }).notNull(),
    expectedSender: varchar("expected_sender", { length: 67 }),
    reference: varchar("reference", { length: 64 })
      .notNull()
      .unique()
      .default(sql`'aiag-ton:' || gen_random_uuid()::text`),
    finalityPolicyId: varchar("finality_policy_id", { length: 96 }).notNull(),
    verifierVersion: varchar("verifier_version", { length: 96 }).notNull(),
    quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    reviewReason: varchar("review_reason", { length: 64 }),
    settledEventId: uuid("settled_event_id")
      .unique()
      .references((): AnyPgColumn => tonChainEvents.id, {
        onDelete: "restrict",
      }),
    receiptId: uuid("receipt_id")
      .unique()
      .references(() => gatewayTransactions.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    ownerKey: uniqueIndex(
      "ton_invoices_owner_user_id_org_id_idempotency_key_key",
    ).on(t.ownerUserId, t.orgId, t.idempotencyKey),
    idOrg: uniqueIndex("ton_invoices_id_org_id_key").on(t.id, t.orgId),
    ownerRead: index("ton_invoices_owner_read").on(
      t.ownerUserId,
      t.orgId,
      t.createdAt,
      t.id,
    ),
    pendingExpiry: index("ton_invoices_pending_expiry")
      .on(t.expiresAt, t.id)
      .where(sql`${t.status} IN ('pending','observed')`),
    reconciliationSource: index("ton_invoices_reconciliation_source").on(
      t.network,
      t.assetKind,
      t.masterAddress,
      t.assetDecimals,
      t.recipient,
      t.createdAt,
      t.id,
    ),
  }),
);
export const tonChainObservations = pgTable(
  "ton_chain_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id").references(() => tonInvoices.id, {
      onDelete: "restrict",
    }),
    sourceId: varchar("source_id", { length: 96 }).notNull(),
    recipientAccount: varchar("recipient_account", { length: 67 }).notNull(),
    txHash: char("tx_hash", { length: 64 }),
    messageHash: char("message_hash", { length: 64 }),
    txLt: varchar("tx_lt", { length: 78 }),
    providerId: varchar("provider_id", { length: 96 }).notNull(),
    evidenceModel: text("evidence_model").notNull(),
    resultKind: text("result_kind").notNull(),
    reason: varchar("reason", { length: 64 }).notNull(),
    observationKey: char("observation_key", { length: 64 }).notNull().unique(),
    evidenceDigest: char("evidence_digest", { length: 64 }),
    providerCursor: jsonb("provider_cursor").$type<TonProviderCursor | null>(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    invoiceCreated: index("ton_chain_observations_invoice_created").on(
      t.invoiceId,
      t.createdAt,
      t.id,
    ),
    eventIdentity: check(
      "ton_chain_observations_event_identity_check",
      sql`((${t.txHash} IS NULL AND ${t.messageHash} IS NULL AND ${t.txLt} IS NULL) OR (${t.txHash} ~ '\\A[0-9a-f]{64}\\Z' AND ${t.messageHash} ~ '\\A[0-9a-f]{64}\\Z' AND ${t.txLt} ~ '\\A(0|[1-9][0-9]{0,77})\\Z'))`,
    ),
  }),
);
export const tonReconciliationCursors = pgTable(
  "ton_reconciliation_cursors",
  {
    sourceId: varchar("source_id", { length: 96 }).primaryKey(),
    schemaVersion: smallint("schema_version").notNull(),
    network: text("network").notNull(),
    providerId: varchar("provider_id", { length: 96 }).notNull(),
    cursor: jsonb("cursor").$type<TonProviderCursor | null>(),
    recipientAccount: varchar("recipient_account", { length: 67 }),
    recipientBinding: jsonb("recipient_binding").$type<TonRecipientBinding | null>(),
    leaseOwner: uuid("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    leasePair: check(
      "ton_reconciliation_cursors_lease_pair_check",
      sql`(${t.leaseOwner} IS NULL)=(${t.leaseExpiresAt} IS NULL)`,
    ),
    bindingPair: check(
      "ton_reconciliation_cursors_binding_pair_check",
      sql`(${t.recipientAccount} IS NULL)=(${t.recipientBinding} IS NULL)`,
    ),
  }),
);
export const tonInvoiceEventDecisions = pgTable(
  "ton_invoice_event_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => tonInvoices.id, { onDelete: "restrict" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => tonChainEvents.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reason: varchar("reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    pair: uniqueIndex("ton_invoice_event_decisions_invoice_id_event_id_key").on(
      t.invoiceId,
      t.eventId,
    ),
    oneEvent: uniqueIndex("ton_event_one_settlement")
      .on(t.eventId)
      .where(sql`${t.decision}='settled'`),
    oneInvoice: uniqueIndex("ton_invoice_one_settlement")
      .on(t.invoiceId)
      .where(sql`${t.decision}='settled'`),
    review: index("ton_invoice_reviews")
      .on(t.createdAt, t.id)
      .where(sql`${t.decision}='review_required'`),
  }),
);
/** Server-owned TON asset admission (migration 0098); read via aiag_ton_allowlisted_assets_v1. */
export const tonAssetAllowlist = pgTable(
  "ton_asset_allowlist",
  {
    network: text("network").notNull(),
    assetKind: text("asset_kind").notNull(),
    masterAddress: varchar("master_address", { length: 67 }),
    assetDecimals: smallint("asset_decimals").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => ({
    assetKey: uniqueIndex("ton_asset_allowlist_asset_key").on(
      t.network,
      sql`COALESCE(${t.masterAddress},'')`,
    ),
    shape: check(
      "ton_asset_allowlist_shape_check",
      sql`((${t.assetKind}='native' AND ${t.masterAddress} IS NULL AND ${t.assetDecimals}=9) OR (${t.assetKind}='jetton' AND ${t.masterAddress} IS NOT NULL))`,
    ),
  }),
);
