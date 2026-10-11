import { describe, expect, it } from 'vitest';

import {
  jettonForwardReference,
  jettonInternalTransferPayload,
  jettonNotificationPayload,
  jettonTransferPayload,
  parseJettonTransferRow,
} from '../ton-jetton-evidence.js';

/**
 * Row shape captured live from toncenter.com /api/v3/jetton/transfers
 * (2026-10-11); addresses/hashes rewritten to synthetic constants. The field
 * set and types are exactly what TonCenter v3 returns.
 */
const MASTER = `0:${'3'.repeat(64)}`;
const SENDER_OWNER = `0:${'2'.repeat(64)}`;
const OWNER = `0:${'1'.repeat(64)}`;
const SENDER_WALLET = `0:${'4'.repeat(64)}`;
const REFERENCE = 'aiag-ton:1a2b3c4d-1111-4222-8333-444455556666';

function txHash(seed: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(seed, 28);
  return bytes.toString('base64');
}

function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query_id: '37187300',
    source: SENDER_OWNER.toUpperCase(),
    destination: OWNER.toUpperCase(),
    amount: '2500000',
    source_wallet: SENDER_WALLET.toUpperCase(),
    jetton_master: MASTER.toUpperCase(),
    transaction_hash: txHash(1),
    transaction_lt: '109307457000011',
    transaction_now: 1_791_740_218,
    transaction_aborted: false,
    response_destination: SENDER_OWNER.toUpperCase(),
    custom_payload: null,
    decoded_custom_payload: null,
    forward_ton_amount: '1',
    forward_payload: null,
    decoded_forward_payload: { '@type': 'text_comment', comment: REFERENCE, type: 'text_comment' },
    trace_id: txHash(2),
    ...patch,
  };
}

describe('parseJettonTransferRow', () => {
  it('extracts the reference and canonical facts from a live-shape row', () => {
    const result = parseJettonTransferRow(row(), { masterAddress: MASTER, ownerAddress: OWNER });
    expect(result).toEqual({
      kind: 'facts',
      transactionHash: Buffer.from(txHash(1), 'base64').toString('hex'),
      transactionLt: '109307457000011',
      transactionTimeMs: 1_791_740_218_000,
      traceId: Buffer.from(txHash(2), 'base64').toString('hex'),
      amountAtomic: '2500000',
      forwardText: REFERENCE,
      reference: REFERENCE,
      sourceOwner: SENDER_OWNER,
      destinationOwner: OWNER,
      masterAddress: MASTER,
      sourceWallet: SENDER_WALLET,
    });
  });

  it('yields a NULL reference when the transfer carries no forward payload', () => {
    const result = parseJettonTransferRow(
      row({ decoded_forward_payload: null, forward_payload: null }),
      { masterAddress: MASTER, ownerAddress: OWNER },
    );
    expect(result).toMatchObject({ reference: null, forwardText: '' });
  });

  it('yields a NULL reference for a non-reference text comment but keeps the raw text', () => {
    const result = parseJettonTransferRow(
      row({ decoded_forward_payload: { '@type': 'text_comment', comment: 'not-a-reference', type: 'text_comment' } }),
      { masterAddress: MASTER, ownerAddress: OWNER },
    );
    expect(result).toMatchObject({ reference: null, forwardText: 'not-a-reference' });
  });

  it('routes whitespace-padded and control-character comments to the unmatched path (no wedge)', () => {
    // The normalized-evidence label demands trim-stability and no control
    // characters; a legal-but-dirty chain comment must surface as an EMPTY
    // forward text (unmatched path), never as a provider_schema_invalid page
    // failure that wedges the source forever.
    const dirty = (comment: string) => parseJettonTransferRow(
      row({ decoded_forward_payload: { '@type': 'text_comment', comment, type: 'text_comment' } }),
      { masterAddress: MASTER, ownerAddress: OWNER },
    );
    expect(dirty(`${REFERENCE}\n`)).toMatchObject({ kind: 'facts', forwardText: '', reference: null });
    expect(dirty(` ${REFERENCE}`)).toMatchObject({ kind: 'facts', forwardText: '', reference: null });
    expect(dirty(`${REFERENCE}\u0007`)).toMatchObject({ kind: 'facts', forwardText: '', reference: null });
    expect(dirty('thanks\u001f for the models')).toMatchObject({ kind: 'facts', forwardText: '', reference: null });
  });

  it('keeps a clean reference comment untouched through the hygiene gate', () => {
    expect(jettonForwardReference({ '@type': 'text_comment', comment: REFERENCE, type: 'text_comment' }))
      .toBe(REFERENCE);
    expect(jettonForwardReference({ '@type': 'second_from_either', value: { '@type': 'text_comment', text: 'thanks for the models' } }))
      .toBe('thanks for the models');
  });

  // Semantic rejections still carry the credit-transaction anchor so the
  // scanner can continue below a page of rejected rows.
  const REJECTION_ANCHOR = {
    transactionLt: '109307457000011',
    transactionHash: Buffer.from(txHash(1), 'base64').toString('hex'),
  };

  it('rejects a foreign jetton master', () => {
    expect(parseJettonTransferRow(row(), { masterAddress: `0:${'9'.repeat(64)}`, ownerAddress: OWNER }))
      .toEqual({ kind: 'row_rejected', reason: 'master_mismatch', ...REJECTION_ANCHOR });
  });

  it('rejects a row addressed to another owner', () => {
    expect(parseJettonTransferRow(row(), { masterAddress: MASTER, ownerAddress: `0:${'8'.repeat(64)}` }))
      .toEqual({ kind: 'row_rejected', reason: 'owner_mismatch', ...REJECTION_ANCHOR });
  });

  it('rejects an aborted credit transaction (the transfer never landed)', () => {
    expect(parseJettonTransferRow(row({ transaction_aborted: true }), { masterAddress: MASTER, ownerAddress: OWNER }))
      .toEqual({ kind: 'row_rejected', reason: 'aborted_transaction', ...REJECTION_ANCHOR });
  });

  it('fails closed on a fractional amount string', () => {
    expect(parseJettonTransferRow(row({ amount: '2500000.5' }), { masterAddress: MASTER, ownerAddress: OWNER }))
      .toEqual({ kind: 'schema_invalid' });
  });

  it('fails closed on malformed rows', () => {
    expect(parseJettonTransferRow(null, { masterAddress: MASTER, ownerAddress: OWNER })).toEqual({ kind: 'schema_invalid' });
    expect(parseJettonTransferRow(row({ transaction_hash: 'zz' }), { masterAddress: MASTER, ownerAddress: OWNER }))
      .toEqual({ kind: 'schema_invalid' });
    expect(parseJettonTransferRow(row({ transaction_now: '1791740218' }), { masterAddress: MASTER, ownerAddress: OWNER }))
      .toEqual({ kind: 'schema_invalid' });
  });
});

/** addr_std / var_uint / forward_payload wrappers exactly as TonCenter decodes them. */
function addrStd(address: string): Record<string, unknown> {
  return {
    '@type': 'addr_std',
    anycast: { '@type': 'nothing_from_maybe' },
    workchain_id: '0',
    address: address.split(':')[1]!.toUpperCase(),
  };
}
function varUint(value: string): Record<string, unknown> {
  return { '@type': 'var_uint', len: '4', value };
}
function textPayload(text: string): Record<string, unknown> {
  return { '@type': 'second_from_either', value: { '@type': 'text_comment', text } };
}

describe('jetton decoded body mappers', () => {
  it('maps a transfer_notification body (opcode 0x7362d09c) with its forward reference', () => {
    expect(jettonNotificationPayload({
      '@type': 'jetton_notify',
      query_id: '37187300',
      amount: varUint('2500000'),
      sender: addrStd(SENDER_OWNER),
      forward_payload: textPayload(REFERENCE),
    })).toEqual({
      kind: 'jetton_notification',
      amountAtomic: '2500000',
      sender: SENDER_OWNER,
      forwardReference: REFERENCE,
    });
  });

  it('maps an empty forward payload to an empty reference string', () => {
    expect(jettonNotificationPayload({
      '@type': 'jetton_notify',
      query_id: '0',
      amount: varUint('2500000'),
      sender: addrStd(SENDER_OWNER),
      forward_payload: { '@type': 'first_from_either', value: { '@type': 'empty_cell' } },
    })).toEqual({
      kind: 'jetton_notification',
      amountAtomic: '2500000',
      sender: SENDER_OWNER,
      forwardReference: '',
    });
  });

  it('maps jetton_transfer and jetton_internal_transfer bodies', () => {
    expect(jettonTransferPayload({
      '@type': 'jetton_transfer',
      query_id: '0',
      amount: varUint('2500000'),
      destination: addrStd(OWNER),
      response_destination: addrStd(SENDER_OWNER),
      custom_payload: { '@type': 'nothing_from_maybe' },
      forward_ton_amount: varUint('1'),
      forward_payload: textPayload(REFERENCE),
    })).toEqual({
      kind: 'jetton_transfer',
      amountAtomic: '2500000',
      destination: OWNER,
      forwardReference: REFERENCE,
    });
    expect(jettonInternalTransferPayload({
      '@type': 'jetton_internal_transfer',
      query_id: '0',
      amount: varUint('2500000'),
      from: addrStd(SENDER_OWNER),
      response_address: addrStd(SENDER_OWNER),
      forward_ton_amount: varUint('1'),
      forward_payload: textPayload(REFERENCE),
    })).toEqual({
      kind: 'jetton_internal_transfer',
      amountAtomic: '2500000',
      sender: SENDER_OWNER,
      responseDestination: SENDER_OWNER,
    });
  });

  it('maps response_destination addr_none to a NULL responseDestination (TEP-74)', () => {
    const body = {
      '@type': 'jetton_internal_transfer',
      query_id: '0',
      amount: varUint('2500000'),
      from: addrStd(SENDER_OWNER),
      forward_ton_amount: varUint('1'),
      forward_payload: textPayload(REFERENCE),
    };
    expect(jettonInternalTransferPayload({ ...body, response_address: { '@type': 'addr_none' } }))
      .toEqual({ kind: 'jetton_internal_transfer', amountAtomic: '2500000', sender: SENDER_OWNER, responseDestination: null });
    expect(jettonInternalTransferPayload({ ...body, response_address: null }))
      .toEqual({ kind: 'jetton_internal_transfer', amountAtomic: '2500000', sender: SENDER_OWNER, responseDestination: null });
  });

  it('still fails closed on an addr_none transfer destination (a burn is not a credit)', () => {
    expect(() => jettonTransferPayload({
      '@type': 'jetton_transfer',
      query_id: '0',
      amount: varUint('2500000'),
      destination: { '@type': 'addr_none' },
      response_destination: addrStd(SENDER_OWNER),
      custom_payload: { '@type': 'nothing_from_maybe' },
      forward_ton_amount: varUint('1'),
      forward_payload: textPayload(REFERENCE),
    })).toThrow('JETTON_BODY_INVALID');
    // A junk response_address wrapper (neither addr_std nor addr_none) fails too.
    expect(() => jettonInternalTransferPayload({
      '@type': 'jetton_internal_transfer',
      query_id: '0',
      amount: varUint('2500000'),
      from: addrStd(SENDER_OWNER),
      response_address: 42,
      forward_ton_amount: varUint('1'),
      forward_payload: textPayload(REFERENCE),
    })).toThrow('JETTON_BODY_INVALID');
  });

  it('rejects malformed decoded bodies', () => {
    expect(() => jettonNotificationPayload({ '@type': 'jetton_notify', amount: varUint('x') })).toThrow('JETTON_BODY_INVALID');
    expect(() => jettonTransferPayload({ '@type': 'jetton_transfer', destination: { '@type': 'addr_std', workchain_id: '5', address: 'ff'.repeat(32) } })).toThrow('JETTON_BODY_INVALID');
  });

  it('jettonForwardReference accepts the row rendering (comment field) and null payloads', () => {
    expect(jettonForwardReference({ '@type': 'text_comment', comment: REFERENCE, type: 'text_comment' })).toBe(REFERENCE);
    expect(jettonForwardReference(null)).toBe('');
    expect(jettonForwardReference({ '@type': 'first_from_either', value: { '@type': 'empty_cell' } })).toBe('');
  });
});
