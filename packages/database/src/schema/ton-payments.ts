/** Constraints, state-machine and append-only guards are authoritative in migration 0072. */
import {
  pgTable,
  uuid,
  text,
  varchar,
  char,
  jsonb,
  bigint,
  smallint,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { TonQuote } from "@aiag/shared/ton-payment-contract";
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
