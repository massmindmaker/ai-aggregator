import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TonInvoice } from '@aiag/database';
import { describe, expect, it } from 'vitest';
import nativeFixture from '../__fixtures__/ton/synthetic-native-success.json';
import jettonFixture from '../__fixtures__/ton/synthetic-jetton-success.json';
import {
  TON_EVIDENCE_LIMITS,
  normalizeCanonicalTonEvidence,
  type NormalizedTonEvidence,
  type TonNormalizationFailure,
} from '../ton-payment-evidence.js';
import {
  TON_FINALITY_POLICY_ID,
  TON_PROVIDER_ID,
  TON_PROVIDER_ORIGIN,
  TON_EVIDENCE_MODEL,
  TON_VERIFIER_POLICY,
  TON_VERIFIER_VERSION,
  verifyChainCredit,
} from '../ton-payment-verifier.js';

type JsonObject = Record<string, unknown>;

const RECIPIENT = `0:${'1'.repeat(64)}`;
const SENDER = `0:${'2'.repeat(64)}`;
const JETTON_MASTER = `0:${'3'.repeat(64)}`;
const MERCHANT_JETTON_WALLET = `0:${'5'.repeat(64)}`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalized(input: unknown): NormalizedTonEvidence {
  const result = normalizeCanonicalTonEvidence(input, TON_EVIDENCE_LIMITS);
  expect(result).not.toHaveProperty('kind', 'source_error');
  if ('kind' in result) throw new Error(`fixture normalization failed: ${result.code}`);
  return result;
}

function normalizationFailure(input: unknown): TonNormalizationFailure {
  const result = normalizeCanonicalTonEvidence(input, TON_EVIDENCE_LIMITS);
  expect(result).toHaveProperty('kind', 'source_error');
  if (!('kind' in result)) throw new Error('expected normalization failure');
  return result;
}

function makeInvoice(kind: 'native' | 'jetton'): TonInvoice {
  const asset = kind === 'native'
    ? ({ network: 'tvm:-3', kind: 'native', decimals: 9 } as const)
    : ({ network: 'tvm:-3', kind: 'jetton', masterAddress: JETTON_MASTER, decimals: 6 } as const);
  const amountAtomic = kind === 'native' ? '1000000000' : '2500000';
  const reference = kind === 'native' ? 'AIAG-NATIVE-TEST-001' : 'AIAG-JETTON-TEST-001';
  return {
    schemaVersion: 1,
    product: 'aggregator',
    purpose: 'gateway_topup',
    invoiceId: '10000000-0000-4000-8000-000000000001',
    ownerId: '10000000-0000-4000-8000-000000000002',
    orgId: '10000000-0000-4000-8000-000000000003',
    orderId: '10000000-0000-4000-8000-000000000004',
    idempotencyKey: `synthetic-${kind}`,
    quoteId: `quote-${kind}`,
    quote: {
      schemaVersion: 1,
      quoteId: `quote-${kind}`,
      sourcePrice: { unit: 'gateway_microcredits', amountAtomic: '1000' },
      asset,
      fx: {
        sourceUnit: 'gateway_microcredits',
        targetAsset: asset,
        numerator: amountAtomic,
        denominator: '1000',
        rounding: 'floor',
        source: 'synthetic-test',
        observedAtMs: 1699999990000,
        expiresAtMs: 1700001000000,
      },
      additionalFeeAtomic: '0',
      amountAtomic,
      quotedAtMs: 1699999995000,
      expiresAtMs: 1700001000000,
    },
    grantMicrocredits: '1000',
    priceRevision: 'synthetic-v1',
    network: 'tvm:-3',
    asset,
    amountAtomic,
    recipient: RECIPIENT,
    reference,
    expectedSender: SENDER,
    finalityPolicyId: TON_FINALITY_POLICY_ID,
    verifierVersion: TON_VERIFIER_VERSION,
    expiresAt: '2026-09-13T12:00:00.000Z',
    createdAt: '2026-09-13T11:00:00.000Z',
    status: 'pending',
    reviewReason: null,
  };
}

function changeEvidence(
  base: NormalizedTonEvidence,
  change: (draft: NormalizedTonEvidence) => void,
): NormalizedTonEvidence {
  const draft = clone(base);
  change(draft);
  return draft;
}

const native = normalized(nativeFixture.evidence);
const jetton = normalized(jettonFixture.evidence);
const nativeInvoice = makeInvoice('native');
const jettonInvoice = makeInvoice('jetton');

describe('normalizeCanonicalTonEvidence', () => {
  it('loads bounded explicitly synthetic fixtures and returns only the frozen canonical keys', async () => {
    for (const [filename, fixture] of [
      ['synthetic-native-success.json', nativeFixture],
      ['synthetic-jetton-success.json', jettonFixture],
    ] as const) {
      const fixturePath = fileURLToPath(new URL(`../__fixtures__/ton/${filename}`, import.meta.url));
      expect(Buffer.byteLength(await readFile(fixturePath))).toBeLessThanOrEqual(1_048_576);
      expect(Object.keys(fixture).sort()).toEqual(['evidence', 'evidenceClass', 'realProvider']);
      expect(fixture.evidenceClass).toBe('synthetic');
      expect(fixture.realProvider).toBe(false);
    }

    expect(Object.keys(native).sort()).toEqual([
      'asset', 'creditPath', 'latestIndexedMasterchain', 'network', 'schemaVersion',
      'source', 'trace', 'transactions',
    ]);
    expect(Object.keys(native.source).sort()).toEqual([
      'evidenceModel', 'fetchedAtMs', 'origin', 'providerId',
    ]);
    expect(Object.keys(native.transactions[0]!).sort()).toEqual([
      'aborted', 'account', 'actionSuccess', 'blockRef', 'chainTimeMs', 'computeSuccess',
      'emulated', 'hash', 'inMessage', 'lt', 'outMessages',
    ]);
    expect(Object.keys(native.transactions[0]!.blockRef).sort()).toEqual([
      'fileHash', 'masterchainSeqno', 'rootHash', 'seqno', 'shard', 'workchain',
    ]);
    expect(Object.keys(native.transactions[0]!.inMessage).sort()).toEqual([
      'amountAtomic', 'bounced', 'decodedPayload', 'destination', 'hash', 'index', 'opcode', 'source',
    ]);
    expect(Object.keys(native.creditPath).sort()).toEqual([
      'creditMessageHash', 'kind', 'recipientTransactionHash',
    ]);
  });

  it('canonicalizes uppercase hashes, raw addresses and opcodes once', () => {
    const input = clone(nativeFixture.evidence) as JsonObject;
    const transactions = input.transactions as JsonObject[];
    const tx = transactions[0]!;
    tx.hash = (tx.hash as string).toUpperCase();
    tx.account = (tx.account as string).toUpperCase();
    const message = tx.inMessage as JsonObject;
    message.hash = (message.hash as string).toUpperCase();
    message.source = (message.source as string).toUpperCase();
    message.opcode = (message.opcode as string).toUpperCase();
    (input.trace as JsonObject).orderedTransactionHashes = [tx.hash];
    (input.creditPath as JsonObject).recipientTransactionHash = tx.hash;
    (input.creditPath as JsonObject).creditMessageHash = message.hash;

    const result = normalized(input);
    expect(result.transactions[0]!.hash).toBe('a'.repeat(64));
    expect(result.transactions[0]!.account).toBe(RECIPIENT);
    expect(result.transactions[0]!.inMessage.hash).toBe('3'.repeat(64));
    expect(result.transactions[0]!.inMessage.source).toBe(SENDER);
    expect(result.transactions[0]!.inMessage.opcode).toBe('0x00000000');
  });

  it('returns response_too_large before structural normalization', () => {
    const input = { padding: 'x'.repeat(TON_EVIDENCE_LIMITS.maxBundleBytes) };
    expect(normalizationFailure(input)).toEqual({
      kind: 'source_error',
      code: 'response_too_large',
    });
  });

  it('rejects accessor-backed unknown input without invoking the getter', () => {
    const input = clone(nativeFixture.evidence) as JsonObject;
    const transactions = input.transactions;
    let reads = 0;
    Object.defineProperty(input, 'transactions', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1
          ? transactions
          : Array.from({ length: TON_EVIDENCE_LIMITS.maxTraceTransactions + 1 }, () => transactions);
      },
    });

    expect(normalizationFailure(input)).toEqual({
      kind: 'source_error', code: 'provider_schema_invalid',
    });
    expect(reads).toBe(0);
  });

  it('stops at a low byte limit without invoking nested toJSON hooks', () => {
    let calls = 0;
    const input = Array.from({ length: 8 }, () => ({
      toJSON: () => {
        calls += 1;
        return 0;
      },
    }));

    expect(normalizeCanonicalTonEvidence(input, {
      ...TON_EVIDENCE_LIMITS,
      maxBundleBytes: 1,
    })).toEqual({ kind: 'source_error', code: 'response_too_large' });
    expect(calls).toBe(0);
  });

  it('accepts arrays at the configured bound and rejects bound plus one', () => {
    const transactionBound = clone(nativeFixture.evidence) as JsonObject;
    transactionBound.transactions = Array.from(
      { length: TON_EVIDENCE_LIMITS.maxTraceTransactions },
      () => clone((nativeFixture.evidence.transactions as JsonObject[])[0]!),
    );
    expect(normalizeCanonicalTonEvidence(transactionBound, TON_EVIDENCE_LIMITS)).not.toHaveProperty('kind');

    (transactionBound.transactions as JsonObject[]).push(
      clone((nativeFixture.evidence.transactions as JsonObject[])[0]!),
    );
    expect(normalizationFailure(transactionBound)).toEqual({
      kind: 'source_error', code: 'provider_schema_invalid',
    });

    const orderedHashBound = clone(nativeFixture.evidence) as JsonObject;
    (orderedHashBound.trace as JsonObject).orderedTransactionHashes = Array.from(
      { length: TON_EVIDENCE_LIMITS.maxTraceTransactions + 1 },
      () => 'a'.repeat(64),
    );
    expect(normalizationFailure(orderedHashBound)).toEqual({
      kind: 'source_error', code: 'provider_schema_invalid',
    });

    const messageBound = clone(nativeFixture.evidence) as JsonObject;
    const tx = (messageBound.transactions as JsonObject[])[0]!;
    const template = clone(tx.inMessage as JsonObject);
    tx.outMessages = Array.from(
      { length: TON_EVIDENCE_LIMITS.maxMessagesPerTransaction - 1 },
      () => clone(template),
    );
    expect(normalizeCanonicalTonEvidence(messageBound, TON_EVIDENCE_LIMITS)).not.toHaveProperty('kind');
    (tx.outMessages as JsonObject[]).push(clone(template));
    expect(normalizationFailure(messageBound)).toEqual({
      kind: 'source_error', code: 'provider_schema_invalid',
    });
  });

  it.each([
    ['unknown evidence key', (value: JsonObject) => { value.unexpected = true; }],
    ['noncanonical decimal', (value: JsonObject) => {
      (((value.transactions as JsonObject[])[0]!.inMessage as JsonObject)).amountAtomic = '01';
    }],
    ['decimal over 78 digits', (value: JsonObject) => {
      (((value.transactions as JsonObject[])[0]!.inMessage as JsonObject)).amountAtomic = '1'.repeat(79);
    }],
    ['invalid raw address', (value: JsonObject) => {
      ((value.transactions as JsonObject[])[0]!).account = 'EQ-friendly-address';
    }],
    ['invalid hash', (value: JsonObject) => {
      ((value.transactions as JsonObject[])[0]!).hash = 'z'.repeat(64);
    }],
    ['unsafe timestamp', (value: JsonObject) => {
      ((value.source as JsonObject)).fetchedAtMs = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['wrong native decimals', (value: JsonObject) => {
      ((value.asset as JsonObject)).decimals = 8;
    }],
  ])('rejects %s as provider_schema_invalid', (_name, mutate) => {
    const input = clone(nativeFixture.evidence) as JsonObject;
    mutate(input);
    expect(normalizationFailure(input)).toEqual({
      kind: 'source_error', code: 'provider_schema_invalid',
    });
  });
});

describe('verifyChainCredit', () => {
  it('constructs a pinned native credit only from the full synthetic trace', () => {
    const result = verifyChainCredit(nativeInvoice, native, TON_VERIFIER_POLICY);
    expect(result).toEqual({
      kind: 'verified',
      evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      credit: {
        network: 'tvm:-3',
        asset: nativeInvoice.asset,
        recipient: RECIPIENT,
        recipientAccount: RECIPIENT,
        sender: SENDER,
        amountAtomic: '1000000000',
        reference: 'AIAG-NATIVE-TEST-001',
        txHash: 'a'.repeat(64),
        txLt: '1000',
        messageHash: '3'.repeat(64),
        messageIndex: 0,
        chainTimeMs: 1700000000000,
        observedAtMs: 1700000005000,
        verifiedAtMs: 1700000005000,
        blockAnchor: expect.stringMatching(/^[0-9a-f]{64}$/),
        masterchainAnchor: expect.stringMatching(/^[0-9a-f]{64}$/),
        executionPathDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        verifierVersion: TON_VERIFIER_VERSION,
        finalityPolicyId: TON_FINALITY_POLICY_ID,
        jettonCredit: null,
      },
    });
    if (result.kind === 'verified') {
      expect(result.credit.executionPathDigest).toBe(result.evidenceDigest);
      expect(result.credit.verifierVersion).toBe(nativeInvoice.verifierVersion);
      expect(result.credit.finalityPolicyId).toBe(nativeInvoice.finalityPolicyId);
    }
  });

  it('constructs a jetton credit only from the linked transfer/internal/credit/notification path', () => {
    const result = verifyChainCredit(jettonInvoice, jetton, TON_VERIFIER_POLICY);
    expect(result).toMatchObject({
      kind: 'verified',
      credit: {
        asset: jettonInvoice.asset,
        recipient: RECIPIENT,
        recipientAccount: MERCHANT_JETTON_WALLET,
        sender: SENDER,
        amountAtomic: '2500000',
        reference: 'AIAG-JETTON-TEST-001',
        txHash: 'd'.repeat(64),
        messageHash: 'c'.repeat(64),
        messageIndex: 0,
        jettonCredit: {
          masterAddress: JETTON_MASTER,
          merchantJettonWallet: MERCHANT_JETTON_WALLET,
        },
      },
    });
  });

  it('never promotes missing full-path or provider-attested finality', () => {
    expect(verifyChainCredit(nativeInvoice, changeEvidence(native, (value) => {
      value.trace.complete = false;
    }), TON_VERIFIER_POLICY)).toMatchObject({ kind: 'observed', reason: 'trace_incomplete' });

    expect(verifyChainCredit(nativeInvoice, changeEvidence(native, (value) => {
      value.latestIndexedMasterchain.seqno = value.trace.masterchainSeqno + 1;
    }), TON_VERIFIER_POLICY)).toMatchObject({ kind: 'observed', reason: 'finality_pending' });

    expect(verifyChainCredit(nativeInvoice, changeEvidence(native, (value) => {
      value.transactions[0]!.emulated = true;
    }), TON_VERIFIER_POLICY)).toMatchObject({ kind: 'review_required', reason: 'trace_emulated' });
  });

  it.each([
    ['native dangling output', nativeInvoice, native, (value: NormalizedTonEvidence) => {
      value.transactions[0]!.outMessages.push({
        hash: '9'.repeat(64),
        index: 0,
        source: RECIPIENT,
        destination: `0:${'9'.repeat(64)}`,
        bounced: false,
        opcode: null,
        amountAtomic: '0',
        decodedPayload: { kind: 'other' },
      });
    }],
    ['native disconnected input', nativeInvoice, native, (value: NormalizedTonEvidence) => {
      const transaction = clone(value.transactions[0]!);
      transaction.hash = '9'.repeat(64);
      transaction.inMessage.hash = '8'.repeat(64);
      transaction.chainTimeMs += 1;
      transaction.blockRef.seqno += 1;
      value.transactions.push(transaction);
      value.trace.orderedTransactionHashes.push(transaction.hash);
    }],
    ['jetton dangling output', jettonInvoice, jetton, (value: NormalizedTonEvidence) => {
      value.transactions[2]!.outMessages.push({
        hash: '9'.repeat(64),
        index: 0,
        source: RECIPIENT,
        destination: `0:${'9'.repeat(64)}`,
        bounced: false,
        opcode: null,
        amountAtomic: '0',
        decodedPayload: { kind: 'other' },
      });
    }],
    ['jetton disconnected input', jettonInvoice, jetton, (value: NormalizedTonEvidence) => {
      const transaction = clone(value.transactions[2]!);
      transaction.hash = '9'.repeat(64);
      transaction.inMessage.hash = '8'.repeat(64);
      transaction.chainTimeMs += 1;
      transaction.blockRef.seqno += 1;
      value.transactions.push(transaction);
      value.trace.orderedTransactionHashes.push(transaction.hash);
    }],
  ])('rejects %s from a trace marked complete', (_name, invoice, base, mutate) => {
    const evidence = changeEvidence(base, mutate);
    expect(verifyChainCredit(invoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'message_linkage_invalid',
    });
  });

  it('rejects conflicting hashes for the same connected block coordinate', () => {
    const evidence = changeEvidence(native, (value) => {
      const message = {
        hash: '9'.repeat(64),
        index: 0,
        source: RECIPIENT,
        destination: `0:${'9'.repeat(64)}`,
        bounced: false,
        opcode: null,
        amountAtomic: '0',
        decodedPayload: { kind: 'other' as const },
      };
      value.transactions[0]!.outMessages.push(message);
      const transaction = clone(value.transactions[0]!);
      transaction.account = message.destination;
      transaction.hash = 'b'.repeat(64);
      transaction.lt = '1001';
      transaction.chainTimeMs += 1;
      transaction.inMessage = clone(message);
      transaction.outMessages = [];
      transaction.blockRef.rootHash = 'b'.repeat(64);
      transaction.blockRef.fileHash = 'c'.repeat(64);
      value.transactions.push(transaction);
      value.trace.orderedTransactionHashes.push(transaction.hash);
    });

    expect(verifyChainCredit(nativeInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'inclusion_mismatch',
    });
  });

  it('applies network and immutable policy pins before later evidence defects', () => {
    const contradictory = changeEvidence(native, (value) => {
      value.network = 'tvm:mainnet';
      value.transactions[0]!.emulated = true;
    });
    expect(verifyChainCredit(nativeInvoice, contradictory, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'network_mismatch',
    });

    expect(verifyChainCredit(
      { ...nativeInvoice, verifierVersion: 'unapproved-history' },
      native,
      TON_VERIFIER_POLICY,
    )).toMatchObject({ kind: 'review_required', reason: 'policy_mismatch' });

    expect(verifyChainCredit(nativeInvoice, native, {
      ...TON_VERIFIER_POLICY,
      providerId: 'other-provider' as typeof TON_PROVIDER_ID,
    })).toMatchObject({ kind: 'review_required', reason: 'policy_mismatch' });
  });

  it('rejects a native payload whose opcode is not a comment opcode', () => {
    const evidence = changeEvidence(native, (value) => {
      value.transactions[0]!.inMessage.opcode = '0x7362d09c';
    });
    expect(verifyChainCredit(nativeInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'message_linkage_invalid',
    });
  });

  it.each([
    ['transaction bound+1', 'trace_oversized', (value: NormalizedTonEvidence) => {
      value.transactions = Array.from(
        { length: TON_VERIFIER_POLICY.maxTraceTransactions + 1 },
        () => clone(value.transactions[0]!),
      );
    }],
    ['aborted execution', 'trace_aborted', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.aborted = true;
    }],
    ['bounced input', 'trace_bounced', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.inMessage.bounced = true;
    }],
    ['bounced output', 'trace_bounced', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.outMessages.push({ ...value.transactions[0]!.inMessage, bounced: true });
    }],
    ['failed compute', 'trace_failed', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.computeSuccess = false;
    }],
    ['failed action', 'trace_failed', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.actionSuccess = false;
    }],
    ['broken credit message hash', 'message_linkage_invalid', (value: NormalizedTonEvidence) => {
      if (value.creditPath.kind === 'native') value.creditPath.creditMessageHash = '9'.repeat(64);
    }],
    ['duplicate output message identity', 'message_linkage_invalid', (value: NormalizedTonEvidence) => {
      const message = { ...value.transactions[0]!.inMessage, hash: '9'.repeat(64) };
      value.transactions[0]!.outMessages = [message, clone(message)];
    }],
    ['duplicate transaction path', 'message_linkage_invalid', (value: NormalizedTonEvidence) => {
      value.transactions.push(clone(value.transactions[0]!));
      value.trace.orderedTransactionHashes.push(value.transactions[0]!.hash);
    }],
    ['inconsistent block anchor', 'inclusion_mismatch', (value: NormalizedTonEvidence) => {
      value.transactions[0]!.blockRef.masterchainSeqno = value.trace.masterchainSeqno + 1;
    }],
  ])('rejects %s with %s', (_name, reason, mutate) => {
    const evidence = changeEvidence(native, mutate);
    expect(verifyChainCredit(nativeInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason,
    });
  });

  it.each([
    ['asset decimals', 'asset_mismatch', (invoice: TonInvoice) => {
      invoice.asset = { network: 'tvm:-3', kind: 'native', decimals: 8 as 9 };
    }],
    ['recipient', 'recipient_mismatch', (_invoice: TonInvoice, value: NormalizedTonEvidence) => {
      value.transactions[0]!.account = `0:${'9'.repeat(64)}`;
      value.transactions[0]!.inMessage.destination = `0:${'9'.repeat(64)}`;
    }],
    ['sender', 'sender_mismatch', (invoice: TonInvoice) => {
      invoice.expectedSender = `0:${'9'.repeat(64)}`;
    }],
    ['reference', 'reference_mismatch', (invoice: TonInvoice) => {
      invoice.reference = 'OTHER-REFERENCE';
    }],
    ['amount', 'amount_mismatch', (invoice: TonInvoice) => {
      invoice.amountAtomic = '999';
    }],
  ])('rejects wrong invoice %s with %s', (_name, reason, mutate) => {
    const invoice = clone(nativeInvoice);
    const evidence = clone(native);
    mutate(invoice, evidence);
    expect(verifyChainCredit(invoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason,
    });
  });

  it.each([
    ['fake master', 'jetton_master_mismatch', (value: NormalizedTonEvidence) => {
      if (value.creditPath.kind === 'jetton') value.creditPath.masterAddress = `0:${'9'.repeat(64)}`;
    }],
    ['wrong derived wallet', 'jetton_wallet_mismatch', (value: NormalizedTonEvidence) => {
      if (value.creditPath.kind === 'jetton') value.creditPath.derivedMerchantWallet = `0:${'9'.repeat(64)}`;
    }],
    ['wrong notification opcode', 'jetton_notification_invalid', (value: NormalizedTonEvidence) => {
      value.transactions[1]!.outMessages[0]!.opcode = '0x00000000';
      value.transactions[2]!.inMessage.opcode = '0x00000000';
    }],
    ['notification-only evidence', 'message_linkage_invalid', (value: NormalizedTonEvidence) => {
      value.transactions = [value.transactions[2]!];
      value.trace.orderedTransactionHashes = [value.transactions[0]!.hash];
    }],
    ['reordered path', 'message_linkage_invalid', (value: NormalizedTonEvidence) => {
      value.transactions = [value.transactions[1]!, value.transactions[0]!, value.transactions[2]!];
      value.trace.orderedTransactionHashes = value.transactions.map((transaction) => transaction.hash);
    }],
  ])('rejects jetton %s with %s', (_name, reason, mutate) => {
    const evidence = changeEvidence(jetton, mutate);
    expect(verifyChainCredit(jettonInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason,
    });
  });

  it('binds jetton sender across the transfer, internal transfer and notification', () => {
    const evidence = changeEvidence(jetton, (value) => {
      value.transactions[0]!.inMessage.source = `0:${'9'.repeat(64)}`;
    });
    expect(verifyChainCredit(jettonInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'sender_mismatch',
    });
  });

  it('keeps recipient mismatch ahead of amount mismatch for a wrong derivation owner', () => {
    const evidence = changeEvidence(jetton, (value) => {
      if (value.creditPath.kind === 'jetton') {
        value.creditPath.walletDerivationOwner = `0:${'9'.repeat(64)}`;
      }
      value.transactions[1]!.outMessages[0]!.decodedPayload = {
        kind: 'jetton_notification',
        amountAtomic: '999',
        sender: SENDER,
        forwardReference: jettonInvoice.reference,
      };
      value.transactions[2]!.inMessage = clone(value.transactions[1]!.outMessages[0]!);
    });
    expect(verifyChainCredit(jettonInvoice, evidence, TON_VERIFIER_POLICY)).toMatchObject({
      kind: 'review_required', reason: 'recipient_mismatch',
    });
  });

  it('binds the verifier to the exact server-trusted source identity', () => {
    expect(TON_PROVIDER_ID).toBe('toncenter-v3-testnet');
    expect(TON_PROVIDER_ORIGIN).toBe('https://testnet.toncenter.com');
    expect(TON_EVIDENCE_MODEL).toBe('server_trusted_indexer');
    expect(TON_VERIFIER_VERSION).toBe('aiag-toncenter-v3-verifier-v1');
    expect(TON_FINALITY_POLICY_ID).toBe('toncenter-v3-testnet-provider-attested-mc-depth-2-v1');
    expect(TON_VERIFIER_POLICY).toEqual({
      network: 'tvm:-3',
      providerId: TON_PROVIDER_ID,
      evidenceModel: TON_EVIDENCE_MODEL,
      verifierVersion: TON_VERIFIER_VERSION,
      finalityPolicyId: TON_FINALITY_POLICY_ID,
      minIndexedMasterchainDepth: 2,
      maxBundleBytes: 1_048_576,
      maxTraceTransactions: 128,
      maxMessagesPerTransaction: 64,
    });
  });
});
