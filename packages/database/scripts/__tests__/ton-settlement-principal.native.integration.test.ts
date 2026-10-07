import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Asset } from '@aiag/shared/ton-payment-contract';
import { createTonInvoice, type CreateTonInvoiceInput, type TonInvoice, type VerifiedChainCredit } from '../../src';
import { withWalletAuthDb } from './ton-wallet-auth.native.fixture';

const TESTNET_NATIVE: Asset = Object.freeze({ network: 'tvm:-3', kind: 'native', decimals: 9 });
const RECIPIENT = `0:${'1'.repeat(64)}`;
const SENDER = `0:${'2'.repeat(64)}`;

/**
 * Migration 0099 proof set (plan AG-TON-L task 3.1): the settlement principal
 * exists exactly as the runtime contract expects — a NOLOGIN authority owner
 * and a LOGIN worker role whose ONLY settlement path is the
 * aiag_ton_worker.settle_invoice_v1 wrapper; every other role is refused.
 */
describe.runIf(process.env.RUN_NATIVE_DB_INTEGRATION === '1')('worker-only settlement principal (0099)', () => {
  async function connectAs(url: string, username: string): Promise<Client> {
    const u = new URL(url);
    u.username = username;
    u.password = '';
    const client = new Client({ connectionString: u.href, ssl: false });
    await client.connect();
    return client;
  }

  it('installs the exact principal surface on a fully migrated database', async () => {
    await withWalletAuthDb(async (f) => {
      const roles = (await f.query(
        `SELECT rolname::text AS rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
        [['aiag_ton_worker', 'aiag_ton_worker_owner']],
      )) as Array<Record<string, unknown>>;
      expect(roles).toEqual([
        { rolname: 'aiag_ton_worker', rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
        { rolname: 'aiag_ton_worker_owner', rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      ]);
      const wrapper = (await f.query(
        `SELECT p.prosecdef AS definer,pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
          pg_catalog.has_function_privilege('aiag_ton_worker',p.oid,'EXECUTE') AS worker_execute,
          EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
          p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='aiag_ton_worker' AND p.proname='settle_invoice_v1'`,
      ))[0];
      expect(wrapper).toMatchObject({
        definer: true,
        owner: 'aiag_ton_worker_owner',
        worker_execute: true,
        public_execute: false,
        config: ['search_path=pg_catalog, public, pg_temp'],
      });
      // The worker holds the owner-authority surface through the definer, not directly.
      expect((await f.query(`SELECT has_table_privilege('aiag_ton_worker','public.organizations','UPDATE') AS ok`))[0].ok).toBe(false);
      expect((await f.query(`SELECT has_column_privilege('aiag_ton_worker_owner','public.organizations','payg_credits','UPDATE') AS ok`))[0].ok).toBe(true);
      expect((await f.query(`SELECT has_table_privilege('aiag_ton_worker_owner','public.organizations','INSERT') AS ok`))[0].ok).toBe(false);
      expect((await f.query(`SELECT has_schema_privilege('aiag_ton_worker','aiag_ton_worker','USAGE') AS ok`))[0].ok).toBe(true);
      expect((await f.query(`SELECT has_schema_privilege('public','aiag_ton_worker','USAGE') AS ok`))[0].ok).toBe(false);
    });
  }, 120_000);

  it('retries a refund-blocked review through the worker retry wrapper (0103)', async () => {
    await withWalletAuthDb(async (f) => {
      const orgId = randomUUID();
      await f.query(
        "INSERT INTO organizations(id,name,slug,owner_id,payg_credits,refund_debt_credits) VALUES($1::uuid,'retry fixture',$1::text,$2::uuid,0,0)",
        [orgId, f.user],
      );
      const now = Number((await f.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0].now_ms);
      const contract = await import('@aiag/shared/ton-payment-contract');
      const quote = contract.createQuote({
        quoteId: `quote-${randomUUID()}`,
        sourcePrice: { unit: 'gateway_microcredits', amountAtomic: '300000000' },
        asset: TESTNET_NATIVE,
        fx: { sourceUnit: 'gateway_microcredits', targetAsset: TESTNET_NATIVE, numerator: '1', denominator: '1', rounding: 'floor', source: 'retry-fixture-v1', observedAtMs: now - 1, expiresAtMs: now + 300_000 },
        additionalFeeAtomic: '0',
        expiresAtMs: now + 300_000,
      }, [TESTNET_NATIVE], now);
      const invoice: TonInvoice = await createTonInvoice(f.db, { actorUserId: f.user, orgId }, {
        idempotencyKey: `retry-${randomUUID()}`,
        grantMicrocredits: '300000000',
        priceRevision: 'retry-fixture-v1',
        quote,
        recipient: RECIPIENT,
        expectedSender: SENDER,
        finalityPolicyId: 'retry-fixture-finality-v1',
        verifierVersion: 'retry-fixture-verifier-v1',
      }, { allowlist: [TESTNET_NATIVE] });
      const seed = invoice.invoiceId.replaceAll('-', '');
      const credit: VerifiedChainCredit = {
        network: 'tvm:-3', asset: TESTNET_NATIVE, recipient: invoice.recipient, recipientAccount: invoice.recipient, sender: SENDER,
        amountAtomic: invoice.amountAtomic, reference: invoice.reference,
        txHash: `${seed}${seed}`, txLt: '1', messageHash: `${seed.split('').reverse().join('')}${seed.split('').reverse().join('')}`,
        messageIndex: 0, chainTimeMs: now - 3, observedAtMs: now - 2, verifiedAtMs: now - 1,
        blockAnchor: 'retry-block-v1', masterchainAnchor: 'retry-mc-v1', executionPathDigest: '8'.repeat(64),
        verifierVersion: invoice.verifierVersion, finalityPolicyId: invoice.finalityPolicyId, jettonCredit: null,
      };
      await f.query('UPDATE organizations SET refund_debt_credits=500 WHERE id=$1::uuid', [orgId]);
      const worker = await connectAs(f.url, 'aiag_ton_worker');
      try {
        const blocked = (await worker.query(
          'SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result',
          [invoice.invoiceId, JSON.stringify(credit)],
        )).rows[0].result;
        expect(blocked).toMatchObject({ kind: 'review_required', reason: 'refund_blocked' });
        await f.query('UPDATE organizations SET refund_debt_credits=0 WHERE id=$1::uuid', [orgId]);
        const event = (await f.query('SELECT e.id::text AS id FROM ton_chain_events e JOIN ton_invoice_event_decisions d ON d.event_id=e.id WHERE d.invoice_id=$1::uuid', [invoice.invoiceId]))[0];
        const retried = (await worker.query(
          'SELECT aiag_ton_worker.retry_reviewed_invoice_v1($1::uuid,$2::uuid) AS result',
          [invoice.invoiceId, event.id],
        )).rows[0].result;
        expect(retried).toMatchObject({ kind: 'settled' });
        const payg = (await f.query('SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid', [orgId]))[0];
        expect(payg).toEqual({ payg: invoice.grantMicrocredits });
      } finally {
        await worker.end();
      }
    });
  }, 120_000);

  it('settles as the worker login only, refusing every other role', async () => {
    await withWalletAuthDb(async (f) => {
      const orgId = randomUUID();
      await f.query(
        "INSERT INTO organizations(id,name,slug,owner_id,payg_credits) VALUES($1::uuid,'principal fixture',$1::text,$2::uuid,0)",
        [orgId, f.user],
      );
      const now = Number((await f.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms'))[0].now_ms);
      const contract = await import('@aiag/shared/ton-payment-contract');
      const quote = contract.createQuote({
        quoteId: `quote-${randomUUID()}`,
        sourcePrice: { unit: 'gateway_microcredits', amountAtomic: '500000000' },
        asset: TESTNET_NATIVE,
        fx: { sourceUnit: 'gateway_microcredits', targetAsset: TESTNET_NATIVE, numerator: '1', denominator: '1', rounding: 'floor', source: 'principal-fixture-v1', observedAtMs: now - 1, expiresAtMs: now + 120_000 },
        additionalFeeAtomic: '0',
        expiresAtMs: now + 120_000,
      }, [TESTNET_NATIVE], now);
      const input: CreateTonInvoiceInput = {
        idempotencyKey: `principal-${randomUUID()}`,
        grantMicrocredits: '500000000',
        priceRevision: 'principal-fixture-v1',
        quote,
        recipient: RECIPIENT,
        expectedSender: SENDER,
        finalityPolicyId: 'principal-fixture-finality-v1',
        verifierVersion: 'principal-fixture-verifier-v1',
      };
      const invoice: TonInvoice = await createTonInvoice(f.db, { actorUserId: f.user, orgId }, input, { allowlist: [TESTNET_NATIVE] });
      const seed = invoice.invoiceId.replaceAll('-', '');
      const credit: VerifiedChainCredit = {
        network: 'tvm:-3',
        asset: TESTNET_NATIVE,
        recipient: invoice.recipient,
        recipientAccount: invoice.recipient,
        sender: SENDER,
        amountAtomic: invoice.amountAtomic,
        reference: invoice.reference,
        txHash: `${seed}${seed}`,
        txLt: '1',
        messageHash: `${seed.split('').reverse().join('')}${seed.split('').reverse().join('')}`,
        messageIndex: 0,
        chainTimeMs: now - 3,
        observedAtMs: now - 2,
        verifiedAtMs: now - 1,
        blockAnchor: 'principal-block-v1',
        masterchainAnchor: 'principal-mc-v1',
        executionPathDigest: '9'.repeat(64),
        verifierVersion: invoice.verifierVersion,
        finalityPolicyId: invoice.finalityPolicyId,
        jettonCredit: null,
      };

      const foreignName = 'principal_probe_' + randomUUID().replaceAll('-', '').slice(0, 16);
      await f.query(`CREATE ROLE "${foreignName}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      try {
        const worker = await connectAs(f.url, 'aiag_ton_worker');
        try {
          const settled = (await worker.query(
            'SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result',
            [invoice.invoiceId, JSON.stringify(credit)],
          )).rows[0].result;
          expect(settled).toMatchObject({ kind: 'settled' });
          const replay = (await worker.query(
            'SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result',
            [invoice.invoiceId, JSON.stringify(credit)],
          )).rows[0].result;
          expect(replay).toMatchObject({ kind: 'already_settled' });
        } finally {
          await worker.end();
        }
        const foreign = await connectAs(f.url, foreignName);
        try {
          await expect(foreign.query(
            'SELECT aiag_ton_worker.settle_invoice_v1($1::uuid,$2::jsonb) AS result',
            [invoice.invoiceId, JSON.stringify(credit)],
          )).rejects.toThrow(/permission denied/i);
        } finally {
          await foreign.end();
        }
        const payg = (await f.query('SELECT payg_credits::text AS payg FROM organizations WHERE id=$1::uuid', [orgId]))[0];
        expect(payg).toEqual({ payg: invoice.grantMicrocredits });
      } finally {
        await f.query(`DROP OWNED BY "${foreignName}" CASCADE`);
        await f.query(`DROP ROLE "${foreignName}"`);
      }
    });
  }, 120_000);
});
