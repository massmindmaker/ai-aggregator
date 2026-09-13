import type { TonInvoice } from '@aiag/database';

export const TON_PROVIDER_ID = 'toncenter-v3-testnet' as const;
export const TON_PROVIDER_ORIGIN = 'https://testnet.toncenter.com' as const;
export const TON_EVIDENCE_MODEL = 'server_trusted_indexer' as const;

export interface TonEvidenceLimits {
  maxBundleBytes: number;
  maxTraceTransactions: number;
  maxMessagesPerTransaction: number;
}

export const TON_EVIDENCE_LIMITS: Readonly<TonEvidenceLimits> = Object.freeze({
  maxBundleBytes: 1_048_576,
  maxTraceTransactions: 128,
  maxMessagesPerTransaction: 64,
});

export interface NormalizedTonMessage {
  hash: string;
  index: number;
  source: string | null;
  destination: string;
  bounced: boolean;
  opcode: string | null;
  amountAtomic: string;
  decodedPayload:
    | { kind: 'native_comment'; reference: string }
    | { kind: 'jetton_transfer'; amountAtomic: string; destination: string; forwardReference: string }
    | { kind: 'jetton_internal_transfer'; amountAtomic: string; sender: string; responseDestination: string }
    | { kind: 'jetton_notification'; amountAtomic: string; sender: string; forwardReference: string }
    | { kind: 'other' };
}

export interface NormalizedTonTransaction {
  account: string;
  hash: string;
  lt: string;
  chainTimeMs: number;
  emulated: boolean;
  aborted: boolean;
  computeSuccess: boolean;
  actionSuccess: boolean;
  blockRef: {
    workchain: number;
    shard: string;
    seqno: number;
    rootHash: string;
    fileHash: string;
    masterchainSeqno: number;
  };
  inMessage: NormalizedTonMessage;
  outMessages: NormalizedTonMessage[];
}

export interface NormalizedTonEvidence {
  schemaVersion: 1;
  source: {
    providerId: typeof TON_PROVIDER_ID;
    origin: typeof TON_PROVIDER_ORIGIN;
    evidenceModel: typeof TON_EVIDENCE_MODEL;
    fetchedAtMs: number;
  };
  network: string;
  asset: TonInvoice['asset'];
  trace: {
    id: string;
    complete: boolean;
    masterchainSeqno: number;
    orderedTransactionHashes: string[];
  };
  latestIndexedMasterchain: { seqno: number; rootHash: string; fileHash: string };
  transactions: NormalizedTonTransaction[];
  creditPath:
    | { kind: 'native'; recipientTransactionHash: string; creditMessageHash: string }
    | {
        kind: 'jetton';
        masterAddress: string;
        walletDerivationOwner: string;
        derivedMerchantWallet: string;
        transferMessageHash: string;
        internalTransferMessageHash: string;
        creditTransactionHash: string;
        notificationMessageHash: string;
      };
}

export type TonNormalizationFailure = {
  kind: 'source_error';
  code: 'response_too_large' | 'provider_schema_invalid';
};

const MAX_TIME_MS = 8_640_000_000_000_000;
const MAX_INDEX = 2_147_483_647;
const HASH = /^[0-9a-fA-F]{64}$/;
const RAW_ADDRESS = /^(?:0|-1):[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const OPCODE = /^0[xX][0-9a-fA-F]{8}$/;
const SHARD = /^[0-9a-fA-F]{16}$/;

class InvalidEvidence extends Error {}

function plainObject(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new InvalidEvidence();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new InvalidEvidence();
  }
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidEvidence();
  return value;
}

function nonnegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new InvalidEvidence();
  }
  return value as number;
}

function time(value: unknown): number {
  return nonnegativeInteger(value, MAX_TIME_MS);
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new InvalidEvidence();
  return value.toLowerCase();
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !RAW_ADDRESS.test(value)) throw new InvalidEvidence();
  return value.toLowerCase();
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 78 || !DECIMAL.test(value)) {
    throw new InvalidEvidence();
  }
  return value;
}

function label(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 96 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidEvidence();
  }
  return value;
}

function opcode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !OPCODE.test(value)) throw new InvalidEvidence();
  return value.toLowerCase();
}

function asset(value: unknown): TonInvoice['asset'] {
  const candidate = plainObject(value);
  if (candidate.kind === 'native') {
    exactKeys(candidate, ['network', 'kind', 'decimals']);
    if (candidate.network !== 'tvm:-3' || candidate.decimals !== 9) throw new InvalidEvidence();
    return { network: 'tvm:-3', kind: 'native', decimals: 9 };
  }
  exactKeys(candidate, ['network', 'kind', 'masterAddress', 'decimals']);
  if (
    candidate.network !== 'tvm:-3' ||
    candidate.kind !== 'jetton' ||
    !Number.isInteger(candidate.decimals) ||
    (candidate.decimals as number) < 0 ||
    (candidate.decimals as number) > 18
  ) {
    throw new InvalidEvidence();
  }
  return {
    network: 'tvm:-3',
    kind: 'jetton',
    masterAddress: address(candidate.masterAddress),
    decimals: candidate.decimals as number,
  };
}

function decodedPayload(value: unknown): NormalizedTonMessage['decodedPayload'] {
  const payload = plainObject(value);
  switch (payload.kind) {
    case 'native_comment':
      exactKeys(payload, ['kind', 'reference']);
      return { kind: 'native_comment', reference: label(payload.reference) };
    case 'jetton_transfer':
      exactKeys(payload, ['kind', 'amountAtomic', 'destination', 'forwardReference']);
      return {
        kind: 'jetton_transfer',
        amountAtomic: decimal(payload.amountAtomic),
        destination: address(payload.destination),
        forwardReference: label(payload.forwardReference),
      };
    case 'jetton_internal_transfer':
      exactKeys(payload, ['kind', 'amountAtomic', 'sender', 'responseDestination']);
      return {
        kind: 'jetton_internal_transfer',
        amountAtomic: decimal(payload.amountAtomic),
        sender: address(payload.sender),
        responseDestination: address(payload.responseDestination),
      };
    case 'jetton_notification':
      exactKeys(payload, ['kind', 'amountAtomic', 'sender', 'forwardReference']);
      return {
        kind: 'jetton_notification',
        amountAtomic: decimal(payload.amountAtomic),
        sender: address(payload.sender),
        forwardReference: label(payload.forwardReference),
      };
    case 'other':
      exactKeys(payload, ['kind']);
      return { kind: 'other' };
    default:
      throw new InvalidEvidence();
  }
}

function message(value: unknown): NormalizedTonMessage {
  const candidate = plainObject(value);
  exactKeys(candidate, [
    'hash', 'index', 'source', 'destination', 'bounced', 'opcode', 'amountAtomic', 'decodedPayload',
  ]);
  return {
    hash: hash(candidate.hash),
    index: nonnegativeInteger(candidate.index, MAX_INDEX),
    source: candidate.source === null ? null : address(candidate.source),
    destination: address(candidate.destination),
    bounced: boolean(candidate.bounced),
    opcode: opcode(candidate.opcode),
    amountAtomic: decimal(candidate.amountAtomic),
    decodedPayload: decodedPayload(candidate.decodedPayload),
  };
}

function transaction(value: unknown, limits: TonEvidenceLimits): NormalizedTonTransaction {
  const candidate = plainObject(value);
  exactKeys(candidate, [
    'account', 'hash', 'lt', 'chainTimeMs', 'emulated', 'aborted', 'computeSuccess',
    'actionSuccess', 'blockRef', 'inMessage', 'outMessages',
  ]);
  if (!Array.isArray(candidate.outMessages)) throw new InvalidEvidence();
  if (candidate.outMessages.length + 1 > limits.maxMessagesPerTransaction) {
    throw new InvalidEvidence();
  }
  const block = plainObject(candidate.blockRef);
  exactKeys(block, ['workchain', 'shard', 'seqno', 'rootHash', 'fileHash', 'masterchainSeqno']);
  if (block.workchain !== 0 && block.workchain !== -1) throw new InvalidEvidence();
  if (typeof block.shard !== 'string' || !SHARD.test(block.shard)) throw new InvalidEvidence();
  return {
    account: address(candidate.account),
    hash: hash(candidate.hash),
    lt: decimal(candidate.lt),
    chainTimeMs: time(candidate.chainTimeMs),
    emulated: boolean(candidate.emulated),
    aborted: boolean(candidate.aborted),
    computeSuccess: boolean(candidate.computeSuccess),
    actionSuccess: boolean(candidate.actionSuccess),
    blockRef: {
      workchain: block.workchain,
      shard: block.shard.toLowerCase(),
      seqno: nonnegativeInteger(block.seqno, MAX_INDEX),
      rootHash: hash(block.rootHash),
      fileHash: hash(block.fileHash),
      masterchainSeqno: nonnegativeInteger(block.masterchainSeqno, MAX_INDEX),
    },
    inMessage: message(candidate.inMessage),
    outMessages: candidate.outMessages.map(message),
  };
}

function creditPath(value: unknown): NormalizedTonEvidence['creditPath'] {
  const path = plainObject(value);
  if (path.kind === 'native') {
    exactKeys(path, ['kind', 'recipientTransactionHash', 'creditMessageHash']);
    return {
      kind: 'native',
      recipientTransactionHash: hash(path.recipientTransactionHash),
      creditMessageHash: hash(path.creditMessageHash),
    };
  }
  exactKeys(path, [
    'kind', 'masterAddress', 'walletDerivationOwner', 'derivedMerchantWallet',
    'transferMessageHash', 'internalTransferMessageHash', 'creditTransactionHash',
    'notificationMessageHash',
  ]);
  if (path.kind !== 'jetton') throw new InvalidEvidence();
  return {
    kind: 'jetton',
    masterAddress: address(path.masterAddress),
    walletDerivationOwner: address(path.walletDerivationOwner),
    derivedMerchantWallet: address(path.derivedMerchantWallet),
    transferMessageHash: hash(path.transferMessageHash),
    internalTransferMessageHash: hash(path.internalTransferMessageHash),
    creditTransactionHash: hash(path.creditTransactionHash),
    notificationMessageHash: hash(path.notificationMessageHash),
  };
}

function validLimits(limits: TonEvidenceLimits): boolean {
  return Number.isInteger(limits.maxBundleBytes) && limits.maxBundleBytes > 0
    && limits.maxBundleBytes <= TON_EVIDENCE_LIMITS.maxBundleBytes
    && Number.isInteger(limits.maxTraceTransactions) && limits.maxTraceTransactions > 0
    && limits.maxTraceTransactions <= TON_EVIDENCE_LIMITS.maxTraceTransactions
    && Number.isInteger(limits.maxMessagesPerTransaction) && limits.maxMessagesPerTransaction > 0
    && limits.maxMessagesPerTransaction <= TON_EVIDENCE_LIMITS.maxMessagesPerTransaction;
}

export function normalizeCanonicalTonEvidence(
  input: unknown,
  limits: TonEvidenceLimits,
): NormalizedTonEvidence | TonNormalizationFailure {
  if (!validLimits(limits)) return { kind: 'source_error', code: 'provider_schema_invalid' };

  let serialized: string;
  try {
    const candidate = JSON.stringify(input);
    if (candidate === undefined) throw new InvalidEvidence();
    serialized = candidate;
  } catch {
    return { kind: 'source_error', code: 'provider_schema_invalid' };
  }
  if (Buffer.byteLength(serialized) > limits.maxBundleBytes) {
    return { kind: 'source_error', code: 'response_too_large' };
  }

  try {
    const evidence = plainObject(JSON.parse(serialized) as unknown);
    exactKeys(evidence, [
      'schemaVersion', 'source', 'network', 'asset', 'trace',
      'latestIndexedMasterchain', 'transactions', 'creditPath',
    ]);
    if (evidence.schemaVersion !== 1 || typeof evidence.network !== 'string') {
      throw new InvalidEvidence();
    }

    const source = plainObject(evidence.source);
    exactKeys(source, ['providerId', 'origin', 'evidenceModel', 'fetchedAtMs']);
    if (
      source.providerId !== TON_PROVIDER_ID ||
      source.origin !== TON_PROVIDER_ORIGIN ||
      source.evidenceModel !== TON_EVIDENCE_MODEL
    ) {
      throw new InvalidEvidence();
    }

    const trace = plainObject(evidence.trace);
    exactKeys(trace, ['id', 'complete', 'masterchainSeqno', 'orderedTransactionHashes']);
    if (!Array.isArray(trace.orderedTransactionHashes)) throw new InvalidEvidence();
    if (trace.orderedTransactionHashes.length > limits.maxTraceTransactions) {
      throw new InvalidEvidence();
    }

    const latest = plainObject(evidence.latestIndexedMasterchain);
    exactKeys(latest, ['seqno', 'rootHash', 'fileHash']);

    if (!Array.isArray(evidence.transactions)) throw new InvalidEvidence();
    if (evidence.transactions.length > limits.maxTraceTransactions) throw new InvalidEvidence();

    return {
      schemaVersion: 1,
      source: {
        providerId: TON_PROVIDER_ID,
        origin: TON_PROVIDER_ORIGIN,
        evidenceModel: TON_EVIDENCE_MODEL,
        fetchedAtMs: time(source.fetchedAtMs),
      },
      network: label(evidence.network),
      asset: asset(evidence.asset),
      trace: {
        id: hash(trace.id),
        complete: boolean(trace.complete),
        masterchainSeqno: nonnegativeInteger(trace.masterchainSeqno, MAX_INDEX),
        orderedTransactionHashes: trace.orderedTransactionHashes.map(hash),
      },
      latestIndexedMasterchain: {
        seqno: nonnegativeInteger(latest.seqno, MAX_INDEX),
        rootHash: hash(latest.rootHash),
        fileHash: hash(latest.fileHash),
      },
      transactions: evidence.transactions.map((entry) => transaction(entry, limits)),
      creditPath: creditPath(evidence.creditPath),
    };
  } catch {
    return { kind: 'source_error', code: 'provider_schema_invalid' };
  }
}
