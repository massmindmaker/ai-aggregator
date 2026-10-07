import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Asset } from '@aiag/shared/ton-payment-contract';
import {
  createTonInvoice,
  listTonReviewRequired,
  resolveTonReviewDecision,
  settleTonInvoice,
  type CreateTonInvoiceInput,
  type TonInvoice,
  type TonPaymentDatabase,
  type VerifiedChainCredit,
} from '../../src/ton-payments';
import { withWalletAuthDb } from './ton-wallet-auth.native.fixture';

const TESTNET_NATIVE: Asset = Object.freeze({ network: 'tvm:-3', kind: 'native', decimals: 9 });
const RECIPIENT = `0:${'1'.repeat(64)}`;
const SENDER = `0:${'2'.repeat(64)}`;

/**
 * Migration 0101 proof set (plan AG-TON-L task 4.1): review decisions are
 * durable but NOT terminal — a re-settle after the cause clears settles; an
 * explicit operator acknowledgement IS terminal and never credits.
 */
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === '1')('TON review contour (0100/0101)', () => {
  interface Fixture {
    db: TonPaymentDatabase;
    query: (text: string, values?: unknown[]) => Promise<any[]>;
    ctx: { actorUserId: string; orgId: string };
    now: number;
    makeInvoice: (grant?: string) => Promise<TonInvoice>;
    credit: (invoice: TonInvoice) => VerifiedChainCredit;
    raiseRefundBlock: () => Promise<unknown>;
    clearRefundBlock: () => Promise<unknown>;
  }

  async function reviewFixture(run: (f: Fixture) => Promise<void>) {
      await withWalletAuthDb(async (f) => {
      const orgId = randomUUID();
      // refund debt starts at zero: invoice creation refuses indebted orgs.
      await f.query(
        "INSERT INTO organizations(id,name,slug,owner_id,payg_credits,refund_debt_credits) VALUES($1::uuid,'review fixture',$1::text,$2::uuid,0,0)",
        [orgId, f.user],
      );
      const now = Number((await f.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0].now_ms);
      const contract = await import('@aiag/shared/ton-payment-contract');
      const makeInvoice = async (grant = '400000000') => {
        const quote = contract.createQuote({
          quoteId: `quote-${randomUUID()}`,
          sourcePrice: { unit: 'gateway_microcredits', amountAtomic: grant },
          asset: TESTNET_NATIVE,
          fx: { sourceUnit: 'gateway_microcredits', targetAsset: TESTNET_NATIVE, numerator: '1', denominator: '1', rounding: 'floor', source: 'review-fixture-v1', observedAtMs: now - 1, expiresAtMs: now + 300_000 },
          additionalFeeAtomic: '0',
          expiresAtMs: now + 300_000,
        }, [TESTNET_NATIVE], now);
        const input: CreateTonInvoiceInput = {
          idempotencyKey: `review-${randomUUID()}`,
          grantMicrocredits: grant,
          priceRevision: 'review-fixture-v1',
          quote,
          recipient: RECIPIENT,
          expectedSender: SENDER,
          finalityPolicyId: 'review-fixture-finality-v1',
          verifierVersion: 'review-fixture-verifier-v1',
        };
        return createTonInvoice(f.db, { actorUserId: f.user, orgId }, input, { allowlist: [TESTNET_NATIVE] });
      };
      const credit = (invoice: TonInvoice): VerifiedChainCredit => {
        const seed = invoice.invoiceId.replaceAll('-', '');
        return {
          network: 'tvm:-3', asset: TESTNET_NATIVE, recipient: invoice.recipient, recipientAccount: invoice.recipient, sender: SENDER,
          amountAtomic: invoice.amountAtomic, reference: invoice.reference,
          txHash: `${seed}${seed}`, txLt: '1', messageHash: `${seed.split('').reverse().join('')}${seed.split('').reverse().join('')}`,
          messageIndex: 0, chainTimeMs: now - 3, observedAtMs: now - 2, verifiedAtMs: now - 1,
          blockAnchor: 'review-block-v1', masterchainAnchor: 'review-mc-v1', executionPathDigest: 'b'.repeat(64),
          verifierVersion: invoice.verifierVersion, finalityPolicyId: invoice.finalityPolicyId, jettonCredit: null,
        };
      };
      const raiseRefundBlock = () =>
        f.query('UPDATE organizations SET refund_debt_credits=1000 WHERE id=$1::uuid', [orgId]);
      const clearRefundBlock = () =>
        f.query('UPDATE organizations SET refund_debt_credits=0 WHERE id=$1::uuid', [orgId]);
      await run({ db: f.db, query: f.query, ctx: { actorUserId: f.user, orgId }, now, makeInvoice, credit, raiseRefundBlock, clearRefundBlock });
    });
  }

  it('re-settles after a refund_block is cleared, exactly once', async () => {
    await reviewFixture(async (f) => {
      const invoice = await f.makeInvoice();
      await f.raiseRefundBlock();
      const blocked = await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      expect(blocked).toMatchObject({ kind: 'review_required', reason: 'refund_blocked' });
      await f.clearRefundBlock();
      const settled = await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      expect(settled).toMatchObject({ kind: 'settled' });
      const again = await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      expect(again).toMatchObject({ kind: 'already_settled' });
      const payg = (await f.query('SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid', [f.ctx.orgId]))[0];
      expect(payg).toEqual({ payg: invoice.grantMicrocredits });
    });
  }, 120_000);

  it('keeps an operator acknowledgement terminal: no credit, no re-settle', async () => {
    await reviewFixture(async (f) => {
      const invoice = await f.makeInvoice();
      await f.raiseRefundBlock();
      await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      const listed = await listTonReviewRequired(f.db, 10);
      const target = listed.find((entry) => entry.invoiceId === invoice.invoiceId);
      expect(target).toBeDefined();
      expect(target).toMatchObject({ reviewReason: 'refund_blocked' });
      const ack = await resolveTonReviewDecision(f.db, {
        invoiceId: invoice.invoiceId,
        eventId: target!.eventId,
        actor: 'operator@example.test',
        action: 'acknowledge_no_credit',
      });
      expect(ack).toBe('acknowledged');
      await f.clearRefundBlock();
      const afterAck = await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      expect(afterAck).toMatchObject({ kind: 'review_required' });
      const payg = (await f.query('SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid', [f.ctx.orgId]))[0];
      expect(payg).toEqual({ payg: '0' });
    });
  }, 120_000);

  it('records a retry request as an append-only decision audit row', async () => {
    await reviewFixture(async (f) => {
      const invoice = await f.makeInvoice();
      await f.raiseRefundBlock();
      await settleTonInvoice(f.db, invoice.invoiceId, f.credit(invoice));
      const [target] = (await listTonReviewRequired(f.db, 10)).filter((entry) => entry.invoiceId === invoice.invoiceId);
      const retry = await resolveTonReviewDecision(f.db, {
        invoiceId: invoice.invoiceId,
        eventId: target.eventId,
        actor: 'operator@example.test',
        action: 'retry_settle',
      });
      expect(retry).toBe('retry_scheduled');
      const rows = await f.query(
        "SELECT decision::text AS decision FROM ton_invoice_event_decisions WHERE invoice_id=$1::uuid AND event_id=$2::uuid ORDER BY created_at",
        [invoice.invoiceId, target.eventId],
      );
      expect(rows.map((row) => row.decision)).toEqual(['review_required', 'retry_requested']);
    });
  }, 120_000);
});
