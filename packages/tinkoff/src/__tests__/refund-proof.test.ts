import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TinkoffAcquiring,
  inspectRefundMethodContext,
  type TinkoffFetch,
  type TinkoffRefundMethodContext,
} from '../index';

const providerKey = '0f4f3b3e-34a3-4d51-8ebf-403a3e249f73';

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    json: async () => body,
  };
}

function supportedMethod(
  overrides: Partial<TinkoffRefundMethodContext> = {}
): TinkoffRefundMethodContext {
  const inspection = inspectRefundMethodContext(
    {
      Success: true,
      ErrorCode: '0',
      PaymentId: 'payment-42',
      OrderId: 'order-42',
      Params: [
        { Key: 'Route', Value: 'ACQ' },
        { Key: 'Source', Value: 'cards' },
      ],
    },
    { paymentId: 'payment-42', orderId: 'order-42' }
  );
  if (inspection.kind !== 'supported') {
    throw new Error('invalid test fixture');
  }
  return { ...inspection.context, ...overrides };
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    providerKey,
    paymentId: 'payment-42',
    orderId: 'order-42',
    paidKopecks: 10_000,
    refundedKopecks: 2_000,
    requestedKopecks: 3_000,
    methodContext: supportedMethod(),
    receiptContext: { kind: 'trusted_no_receipt_required' as const },
    ...overrides,
  };
}

function successfulCancel(overrides: Record<string, unknown> = {}) {
  return {
    Success: true,
    ErrorCode: '0',
    TerminalKey: 'terminal',
    Status: 'PARTIAL_REFUNDED',
    PaymentId: 'payment-42',
    OrderId: 'order-42',
    ExternalRequestId: providerKey,
    OriginalAmount: 8_000,
    NewAmount: 5_000,
    ...overrides,
  };
}

describe('inspectRefundMethodContext', () => {
  const getState = {
    Success: true,
    ErrorCode: '0',
    TerminalKey: 'terminal',
    Status: 'CONFIRMED',
    PaymentId: 'payment-42',
    OrderId: 'order-42',
    Amount: 10_000,
    Params: [
      { Key: 'Route', Value: 'ACQ' },
      { Key: 'Source', Value: 'cards' },
    ],
  };

  it('returns supported context only for an exact successful ACQ cards state', () => {
    expect(
      inspectRefundMethodContext(getState, {
        paymentId: 'payment-42',
        orderId: 'order-42',
      })
    ).toEqual({ kind: 'supported', context: supportedMethod() });
  });

  it.each([
    { name: 'failed state', body: { ...getState, Success: false } },
    { name: 'wrong error code', body: { ...getState, ErrorCode: '7' } },
    { name: 'wrong payment', body: { ...getState, PaymentId: 'other' } },
    { name: 'wrong order', body: { ...getState, OrderId: 'other' } },
    {
      name: 'empty expected identity',
      body: getState,
      expected: { paymentId: '', orderId: 'order-42' },
    },
    {
      name: 'empty identity even when expected matches',
      body: { ...getState, PaymentId: '' },
      expected: { paymentId: '', orderId: 'order-42' },
    },
    { name: 'missing params', body: { ...getState, Params: undefined } },
    {
      name: 'duplicate param',
      body: {
        ...getState,
        Params: [...getState.Params, { Key: 'Route', Value: 'ACQ' }],
      },
    },
    {
      name: 'unknown param',
      body: {
        ...getState,
        Params: [...getState.Params, { Key: 'Mystery', Value: 'x' }],
      },
    },
    {
      name: 'unknown route',
      body: {
        ...getState,
        Params: [{ Key: 'Route', Value: 'UNKNOWN' }, getState.Params[1]],
      },
    },
    {
      name: 'unsupported source',
      body: {
        ...getState,
        Params: [getState.Params[0], { Key: 'Source', Value: 'qrsbp' }],
      },
    },
  ])('rejects $name without guessing', ({ body, expected }) => {
    expect(
      inspectRefundMethodContext(body, expected ?? { paymentId: 'payment-42', orderId: 'order-42' })
    ).toMatchObject({ kind: 'unsupported' });
  });
});

describe('TinkoffAcquiring.cancelClaimBoundRefund', () => {
  it('sends unchanged persisted key and integer amount with the exact token', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: TinkoffFetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return response(successfulCancel());
    });
    const client = new TinkoffAcquiring(
      {
        terminalKey: 'terminal',
        secretKey: 'secret',
        apiUrl: 'https://bank.test/v2',
      },
      fetchImpl
    );

    const result = await client.cancelClaimBoundRefund(claim());

    const expectedToken = createHash('sha256')
      .update(`3000${providerKey}secretpayment-42terminal`)
      .digest('hex');
    expect(calls).toEqual([
      {
        url: 'https://bank.test/v2/Cancel',
        body: {
          TerminalKey: 'terminal',
          PaymentId: 'payment-42',
          Amount: 3_000,
          ExternalRequestId: providerKey,
          Token: expectedToken,
        },
      },
    ]);
    expect(result).toEqual({
      kind: 'settled',
      proof: {
        paymentId: 'payment-42',
        orderId: 'order-42',
        externalRequestId: providerKey,
        status: 'PARTIAL_REFUNDED',
        originalAmountKopecks: 8_000,
        newAmountKopecks: 5_000,
      },
    });
  });

  it('reuses the same persisted key on duplicate invocation', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return response(successfulCancel());
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    await client.cancelClaimBoundRefund(claim());
    await client.cancelClaimBoundRefund(claim());

    expect(bodies.map((body) => body.ExternalRequestId)).toEqual([providerKey, providerKey]);
  });

  it('accepts and preserves a general ACQ cards key at the 255 character limit', async () => {
    const maxKey = 'k'.repeat(255);
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(successfulCancel({ ExternalRequestId: maxKey }));
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    const result = await client.cancelClaimBoundRefund(claim({ providerKey: maxKey }));

    expect(sentBody.ExternalRequestId).toBe(maxKey);
    expect(result).toMatchObject({
      kind: 'settled',
      proof: { externalRequestId: maxKey },
    });
  });

  it('omits Receipt for a full cancellation even if a verified receipt is present', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(
        successfulCancel({
          Status: 'REFUNDED',
          OriginalAmount: 8_000,
          NewAmount: 0,
        })
      );
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    const result = await client.cancelClaimBoundRefund(
      claim({
        requestedKopecks: 8_000,
        receiptContext: {
          kind: 'verified_receipt',
          receipt: {
            Taxation: 'usn_income',
            Items: [
              {
                Name: 'Top-up',
                Price: 8_000,
                Quantity: 1,
                Amount: 8_000,
                Tax: 'none',
              },
            ],
          },
        },
      })
    );

    expect(sentBody).not.toHaveProperty('Receipt');
    expect(result).toMatchObject({
      kind: 'settled',
      proof: { status: 'REFUNDED' },
    });
  });

  it('passes a verified receipt for a partial cancellation', async () => {
    let sentBody: Record<string, unknown> = {};
    const receipt = {
      Taxation: 'usn_income' as const,
      Items: [
        {
          Name: 'Top-up part',
          Price: 3_000,
          Quantity: 1,
          Amount: 3_000,
          Tax: 'none' as const,
        },
      ],
    };
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(successfulCancel());
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    await client.cancelClaimBoundRefund(
      claim({ receiptContext: { kind: 'verified_receipt', receipt } })
    );

    expect(sentBody.Receipt).toEqual(receipt);
  });

  it.each([
    ['empty provider key', { providerKey: '' }],
    ['whitespace provider key', { providerKey: '   ' }],
    ['provider key over 255 chars', { providerKey: 'k'.repeat(256) }],
    ['empty payment id', { paymentId: '' }],
    ['non-string payment id', { paymentId: 42 }],
    ['empty order id', { orderId: '  ' }],
    ['unsafe paid amount', { paidKopecks: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional refunded amount', { refundedKopecks: 0.5 }],
    ['zero requested amount', { requestedKopecks: 0 }],
    ['string requested amount', { requestedKopecks: '3000' }],
    ['request above remaining amount', { requestedKopecks: 8_001 }],
    ['method payment mismatch', { methodContext: supportedMethod({ paymentId: 'other' }) }],
    ['method order mismatch', { methodContext: supportedMethod({ orderId: 'other' }) }],
    ['unsupported route', { methodContext: supportedMethod({ route: 'BNPL' as 'ACQ' }) }],
    ['unsupported source', { methodContext: supportedMethod({ source: 'qrsbp' as 'cards' }) }],
    [
      'unproven structural method context',
      {
        methodContext: {
          paymentId: 'payment-42',
          orderId: 'order-42',
          route: 'ACQ',
          source: 'cards',
        } as TinkoffRefundMethodContext,
      },
    ],
    ['unknown partial receipt policy', { receiptContext: undefined }],
    [
      'invalid verified receipt',
      {
        receiptContext: {
          kind: 'verified_receipt',
          receipt: {
            Taxation: 'invented',
            Items: [
              {
                Name: 'Top-up',
                Price: 3_000,
                Quantity: 1,
                Amount: 3_000,
                Tax: 'invented',
              },
            ],
          },
        },
      },
    ],
  ])('returns not_dispatched for %s and never calls Cancel', async (_name, overrides) => {
    const fetchImpl: TinkoffFetch = vi.fn();
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    const result = await client.cancelClaimBoundRefund(claim(overrides));

    expect(result).toMatchObject({ kind: 'not_dispatched' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['success false', successfulCancel({ Success: false, ErrorCode: '12' })],
    ['wrong error code', successfulCancel({ ErrorCode: '12' })],
    ['non-boolean success', successfulCancel({ Success: 'true' })],
    ['non-string error code', successfulCancel({ ErrorCode: 0 })],
    ['wrong payment', successfulCancel({ PaymentId: 'other' })],
    ['non-string payment', successfulCancel({ PaymentId: 42 })],
    ['wrong order', successfulCancel({ OrderId: 'other' })],
    ['missing key echo', successfulCancel({ ExternalRequestId: undefined })],
    ['wrong key echo', successfulCancel({ ExternalRequestId: 'other' })],
    ['fractional original amount', successfulCancel({ OriginalAmount: 8_000.5 })],
    ['string original amount', successfulCancel({ OriginalAmount: '8000' })],
    ['wrong original amount', successfulCancel({ OriginalAmount: 7_000 })],
    ['wrong delta', successfulCancel({ NewAmount: 4_999 })],
    ['negative new amount', successfulCancel({ NewAmount: -1 })],
    ['unfinished status', successfulCancel({ Status: 'REFUNDING' })],
    ['full status with remainder', successfulCancel({ Status: 'REFUNDED' })],
    [
      'partial status with zero remainder',
      successfulCancel({ Status: 'PARTIAL_REFUNDED', NewAmount: 0 }),
    ],
  ])('keeps %s indeterminate', async (_name, body) => {
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      vi.fn(async () => response(body))
    );

    await expect(client.cancelClaimBoundRefund(claim())).resolves.toMatchObject({
      kind: 'indeterminate',
    });
  });

  it.each([
    [
      'timeout',
      vi.fn(async () => {
        throw new Error('secret timeout body');
      }),
      'NETWORK_ERROR',
    ],
    ['non-2xx', vi.fn(async () => response({ sensitive: 'raw' }, 503)), 'HTTP_ERROR'],
    [
      'malformed JSON',
      vi.fn(async () => ({
        ...response(null),
        json: async () => {
          throw new SyntaxError('secret raw');
        },
      })),
      'MALFORMED_RESPONSE',
    ],
  ])('maps %s to a safe indeterminate result', async (_name, fetchImpl, code) => {
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl as TinkoffFetch
    );

    const result = await client.cancelClaimBoundRefund(claim());

    expect(result).toEqual({ kind: 'indeterminate', code });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('aborts an unbounded Cancel request at the configured refund deadline', async () => {
    const fetchImpl: TinkoffFetch = vi.fn(
      async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const client = new TinkoffAcquiring(
      {
        terminalKey: 'terminal',
        secretKey: 'secret',
        refundRequestTimeoutMs: 5,
      },
      fetchImpl
    );

    await expect(client.cancelClaimBoundRefund(claim())).resolves.toEqual({
      kind: 'indeterminate',
      code: 'NETWORK_ERROR',
    });
  });
});

describe('legacy Tinkoff client compatibility', () => {
  it('keeps refundPayment ruble conversion and result shape', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(successfulCancel());
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    const result = await client.refundPayment('payment-42', 30);

    expect(sentBody).toMatchObject({ PaymentId: 'payment-42', Amount: 3_000 });
    expect(result).toEqual({
      success: true,
      paymentId: 'payment-42',
      orderId: 'order-42',
      status: 'PARTIAL_REFUNDED',
      amount: 50,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it('keeps init request and raw response behavior', async () => {
    const raw = {
      Success: true,
      ErrorCode: '0',
      TerminalKey: 'terminal',
      Status: 'NEW',
      PaymentId: 'payment-new',
      OrderId: 'order-new',
      Amount: 1_234,
    };
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(raw);
    });
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    await expect(client.init({ Amount: 1_234, OrderId: 'order-new' })).resolves.toEqual(raw);
    expect(sentBody).toMatchObject({
      TerminalKey: 'terminal',
      Amount: 1_234,
      OrderId: 'order-new',
    });
  });
});
