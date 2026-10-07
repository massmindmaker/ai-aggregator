import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Asset } from '@aiag/shared/ton-payment-contract';
import { createTonInvoice, type CreateTonInvoiceInput, type TonInvoice, type VerifiedChainCredit } from '../../src';
import { settleTonInvoice } from '../../src/ton-reconciliation-internal';
import { withWalletAuthDb } from './ton-wallet-auth.native.fixture';

const MAINNET_NATIVE: Asset = Object.freeze({ network: 'tvm:-1', kind: 'native', decimals: 9 });
const RECIPIENT = `0:${'1'.repeat(64)}`;
const SENDER = `0:${'2'.repeat(64)}`;

/**
 * Migration 0098 proof set (plan AG-TON-L task 1.2): the mainnet network id is
 * accepted end to end, the server-side asset allowlist gates every created
 * invoice, and the testnet behaviour is unchanged. Runs on the fully migrated
 * baseline database — unlike the 0072-pure ton-core child.
 */
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === '1')('TON mainnet network and asset allowlist (0098)', () => {
  async function mainnetFixture(run: (f: {
    db: Parameters<typeof settleTonInvoice>[0];
    query: (text: string, values?: unknown[]) => Promise<any[]>;
    ctx: { actorUserId: string; orgId: string };
    now: number;
    makeInput: (asset: Asset, grant?: string) => Promise<CreateTonInvoiceInput>;
  }) => Promise<void>) {
    await withWalletAuthDb(async (f) => {
      const orgId = randomUUID();
      await f.query(
        "INSERT INTO organizations(id,name,slug,owner_id,payg_credits) VALUES($1::uuid,'mainnet fixture',$1::text,$2::uuid,0)",
        [orgId, f.user],
      );
      const now = Number((await f.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0].now_ms);
      const makeInput = async (asset: Asset, grant = '1000000000'): Promise<CreateTonInvoiceInput> => {
        const contract = await import('@aiag/shared/ton-payment-contract');
        const quote = contract.createQuote({
          quoteId: `quote-${randomUUID()}`,
          sourcePrice: { unit: 'gateway_microcredits', amountAtomic: grant },
          asset,
          fx: { sourceUnit: 'gateway_microcredits', targetAsset: asset, numerator: '1', denominator: '1', rounding: 'floor', source: 'mainnet-fixture-v1', observedAtMs: now - 1, expiresAtMs: now + 120_000 },
          additionalFeeAtomic: '0',
          expiresAtMs: now + 120_000,
        }, [asset], now);
        return {
          idempotencyKey: `mainnet-${randomUUID()}`,
          grantMicrocredits: grant,
          priceRevision: 'mainnet-fixture-v1',
          quote,
          recipient: RECIPIENT,
          expectedSender: SENDER,
          finalityPolicyId: 'mainnet-fixture-finality-v1',
          verifierVersion: 'mainnet-fixture-verifier-v1',
        };
      };
      await run({ db: f.db, query: f.query, ctx: { actorUserId: f.user, orgId }, now, makeInput });
    });
  }

  function mainnetCredit(invoice: TonInvoice, now: number): VerifiedChainCredit {
    const seed = invoice.invoiceId.replaceAll('-', '');
    return {
      network: 'tvm:-1',
      asset: MAINNET_NATIVE,
      recipient: invoice.recipient,
      recipientAccount: invoice.recipient,
      sender: invoice.expectedSender ?? SENDER,
      amountAtomic: invoice.amountAtomic,
      reference: invoice.reference,
      txHash: `${seed}${seed}`,
      txLt: '1',
      messageHash: `${seed.split('').reverse().join('')}${seed.split('').reverse().join('')}`,
      messageIndex: 0,
      chainTimeMs: now - 3,
      observedAtMs: now - 2,
      verifiedAtMs: now - 1,
      blockAnchor: 'mainnet-fixture-block-v1',
      masterchainAnchor: 'mainnet-fixture-mc-v1',
      executionPathDigest: '7'.repeat(64),
      verifierVersion: invoice.verifierVersion,
      finalityPolicyId: invoice.finalityPolicyId,
      jettonCredit: null,
    };
  }

  it('creates and settles a native mainnet invoice end to end', async () => {
    await mainnetFixture(async (f) => {
      const invoice = await createTonInvoice(f.db, f.ctx, await f.makeInput(MAINNET_NATIVE), { allowlist: [MAINNET_NATIVE] });
      expect(invoice.network).toBe('tvm:-1');
      expect(invoice.asset).toEqual(MAINNET_NATIVE);
      const row = (await f.query('SELECT network::text AS network, status FROM ton_invoices WHERE id=$1::uuid', [invoice.invoiceId]))[0];
      expect(row).toEqual({ network: 'tvm:-1', status: 'pending' });

      const result = await settleTonInvoice(f.db, invoice.invoiceId, mainnetCredit(invoice, f.now));
      expect(result).toMatchObject({ kind: 'settled' });
      const receipt = (result as { kind: 'settled'; receipt: { network: string; amountAtomic: string } }).receipt;
      expect(receipt.network).toBe('tvm:-1');
      const event = (await f.query('SELECT network::text AS network FROM ton_chain_events WHERE recipient_account=$1', [RECIPIENT]))[0];
      expect(event).toEqual({ network: 'tvm:-1' });
      const grant = (await f.query('SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid', [f.ctx.orgId]))[0];
      expect(grant).toEqual({ payg: invoice.grantMicrocredits });
    });
  }, 120_000);

  it('seeds the allowlist read function with native rows for both networks', async () => {
    await mainnetFixture(async (f) => {
      for (const network of ['tvm:-3', 'tvm:-1'] as const) {
        const rows = await f.query('SELECT network::text AS network,asset_kind,master_address,asset_decimals::int AS asset_decimals FROM aiag_ton_allowlisted_assets_v1($1)', [network]);
        expect(rows).toEqual([{ network, asset_kind: 'native', master_address: null, asset_decimals: 9 }]);
      }
    });
  }, 120_000);

  it('rejects assets that are not in the server-side allowlist', async () => {
    await mainnetFixture(async (f) => {
      const mainnetJetton: Asset = { network: 'tvm:-1', kind: 'jetton', masterAddress: `0:${'3'.repeat(64)}`, decimals: 6 };
      await expect(createTonInvoice(f.db, f.ctx, await f.makeInput(mainnetJetton), { allowlist: [mainnetJetton] }))
        .rejects.toThrow('TON_ASSET_NOT_ALLOWLISTED');
      const testnetJetton: Asset = { network: 'tvm:-3', kind: 'jetton', masterAddress: `0:${'4'.repeat(64)}`, decimals: 6 };
      await expect(createTonInvoice(f.db, f.ctx, await f.makeInput(testnetJetton), { allowlist: [testnetJetton] }))
        .rejects.toThrow('TON_ASSET_NOT_ALLOWLISTED');
      expect((await f.query('SELECT count(*)::int AS n FROM ton_invoices'))[0].n).toBe(0);
    });
  }, 120_000);
});
