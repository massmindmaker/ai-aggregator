import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TinkoffAcquiring,
  inspectRefundMethodContext,
  type TinkoffConfig,
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

function untrustedMethod(
  overrides: Partial<TinkoffRefundMethodContext> = {}
): TinkoffRefundMethodContext {
  return {
    paymentId: 'payment-42',
    orderId: 'order-42',
    route: 'ACQ',
    source: 'cards',
    ...overrides,
  } as TinkoffRefundMethodContext;
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    providerKey,
    paymentId: 'payment-42',
    orderId: 'order-42',
    paidKopecks: 10_000,
    refundedKopecks: 2_000,
    requestedKopecks: 3_000,
    methodContext: untrustedMethod(),
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

function successfulGetState(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function refundClient(
  cancelFetch: TinkoffFetch,
  config: Partial<TinkoffConfig> = {}
): TinkoffAcquiring {
  const fetchImpl: TinkoffFetch = async (url, init) =>
    url.endsWith('/GetState') ? response(successfulGetState()) : cancelFetch(url, init);
  return new TinkoffAcquiring(
    { terminalKey: 'terminal', secretKey: 'secret', ...config },
    fetchImpl
  );
}

async function claimFor(client: TinkoffAcquiring, overrides: Record<string, unknown> = {}) {
  const authorization = await client.getRefundMethodContext({
    paymentId: 'payment-42',
    orderId: 'order-42',
  });
  if (authorization.kind !== 'supported') throw new Error('invalid test authorization');
  return claim({ methodContext: authorization.context, ...overrides });
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
    ).toEqual({
      kind: 'supported',
      facts: {
        paymentId: 'payment-42',
        orderId: 'order-42',
        route: 'ACQ',
        source: 'cards',
      },
    });
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

describe('client-owned refund method capability', () => {
  it('performs bounded GetState and returns an immutable same-client context', async () => {
    const fetchImpl: TinkoffFetch = vi.fn(async () => response(successfulGetState()));
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      fetchImpl
    );

    const result = await client.getRefundMethodContext({
      paymentId: 'payment-42',
      orderId: 'order-42',
    });

    expect(result).toMatchObject({
      kind: 'supported',
      context: {
        paymentId: 'payment-42',
        orderId: 'order-42',
        route: 'ACQ',
        source: 'cards',
      },
    });
    if (result.kind !== 'supported') throw new Error('expected supported context');
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Reflect.ownKeys(client)).not.toContain('refundMethodContexts');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(
      'https://securepay.tinkoff.ru/v2/GetState'
    );
  });

  it('aborts an unbounded GetState at the configured deadline', async () => {
    const fetchImpl: TinkoffFetch = vi.fn(
      async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret', refundRequestTimeoutMs: 5 },
      fetchImpl
    );

    await expect(
      client.getRefundMethodContext({ paymentId: 'payment-42', orderId: 'order-42' })
    ).resolves.toEqual({ kind: 'indeterminate', code: 'NETWORK_ERROR' });
  });

  it('rejects parser output, spread and reflected copies, mutation proxies, and another issuer', async () => {
    const cancelFetch = vi.fn(async (url: string) =>
      response(url.endsWith('/GetState') ? successfulGetState() : successfulCancel())
    );
    const otherFetch = vi.fn(async (url: string) =>
      response(url.endsWith('/GetState') ? successfulGetState() : successfulCancel())
    );
    const client = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      cancelFetch as TinkoffFetch
    );
    const otherClient = new TinkoffAcquiring(
      { terminalKey: 'terminal', secretKey: 'secret' },
      otherFetch as TinkoffFetch
    );
    const issued = await client.getRefundMethodContext({
      paymentId: 'payment-42',
      orderId: 'order-42',
    });
    if (issued.kind !== 'supported') throw new Error('expected supported context');
    expect(Reflect.set(issued.context, 'paymentId', 'other-payment')).toBe(false);
    expect(issued.context.paymentId).toBe('payment-42');
    const parsed = inspectRefundMethodContext(successfulGetState(), {
      paymentId: 'payment-42',
      orderId: 'order-42',
    });
    if (parsed.kind !== 'supported') throw new Error('expected supported facts');
    const reflectedCopy = Object.fromEntries(
      Reflect.ownKeys(issued.context).map((key) => [key, Reflect.get(issued.context, key)])
    );
    const mutationProxy = new Proxy(issued.context, {
      get(target, key, receiver) {
        if (key === 'paymentId') return 'other-payment';
        return Reflect.get(target, key, receiver);
      },
    });
    const candidates = [
      JSON.parse(JSON.stringify(parsed.facts)),
      { ...issued.context },
      reflectedCopy,
      mutationProxy,
    ];

    for (const methodContext of candidates) {
      const result = await client.cancelClaimBoundRefund(
        claim({ methodContext: methodContext as TinkoffRefundMethodContext })
      );
      expect(result).toEqual({ kind: 'not_dispatched', code: 'UNSUPPORTED_METHOD' });
    }
    const crossClient = await otherClient.cancelClaimBoundRefund(
      claim({ methodContext: issued.context })
    );
    expect(crossClient).toEqual({ kind: 'not_dispatched', code: 'UNSUPPORTED_METHOD' });
    expect(cancelFetch.mock.calls.filter(([url]) => String(url).endsWith('/Cancel'))).toHaveLength(
      0
    );
    expect(otherFetch.mock.calls.filter(([url]) => String(url).endsWith('/Cancel'))).toHaveLength(
      0
    );
  });
});

describe('TinkoffAcquiring.cancelClaimBoundRefund', () => {
  it('sends unchanged persisted key and integer amount with the exact token', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: TinkoffFetch = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
      return response(successfulCancel());
    });
    const client = refundClient(fetchImpl, { apiUrl: 'https://bank.test/v2' });

    const result = await client.cancelClaimBoundRefund(await claimFor(client));

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
    const client = refundClient(fetchImpl);
    const request = await claimFor(client);

    await client.cancelClaimBoundRefund(request);
    await client.cancelClaimBoundRefund(request);

    expect(bodies.map((body) => body.ExternalRequestId)).toEqual([providerKey, providerKey]);
  });

  it('accepts and preserves a general ACQ cards key at the 255 character limit', async () => {
    const maxKey = 'k'.repeat(255);
    let sentBody: Record<string, unknown> = {};
    const fetchImpl: TinkoffFetch = vi.fn(async (_url, init) => {
      sentBody = JSON.parse(init?.body ?? '{}');
      return response(successfulCancel({ ExternalRequestId: maxKey }));
    });
    const client = refundClient(fetchImpl);

    const result = await client.cancelClaimBoundRefund(
      await claimFor(client, { providerKey: maxKey })
    );

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
    const client = refundClient(fetchImpl);

    const result = await client.cancelClaimBoundRefund(
      await claimFor(client, {
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

  it('does not dispatch a plausible verified receipt for a partial cancellation', async () => {
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
    const fetchImpl: TinkoffFetch = vi.fn();
    const client = refundClient(fetchImpl);

    const result = await client.cancelClaimBoundRefund(
      await claimFor(client, { receiptContext: { kind: 'verified_receipt', receipt } })
    );

    expect(result).toEqual({
      kind: 'not_dispatched',
      code: 'PARTIAL_RECEIPT_UNSUPPORTED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not dispatch a verified receipt whose item total differs from the requested refund', async () => {
    const fetchImpl: TinkoffFetch = vi.fn();
    const client = refundClient(fetchImpl);

    const result = await client.cancelClaimBoundRefund(
      await claimFor(client, {
        receiptContext: {
          kind: 'verified_receipt',
          receipt: {
            Taxation: 'usn_income',
            Items: [{ Name: 'Wrong total', Price: 1, Quantity: 1, Amount: 1, Tax: 'none' }],
          },
        },
      })
    );

    expect(result).toEqual({
      kind: 'not_dispatched',
      code: 'PARTIAL_RECEIPT_UNSUPPORTED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
    ['method payment mismatch', { methodContext: untrustedMethod({ paymentId: 'other' }) }],
    ['method order mismatch', { methodContext: untrustedMethod({ orderId: 'other' }) }],
    ['unsupported route', { methodContext: untrustedMethod({ route: 'BNPL' as 'ACQ' }) }],
    ['unsupported source', { methodContext: untrustedMethod({ source: 'qrsbp' as 'cards' }) }],
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
    const client = refundClient(fetchImpl);

    const result = await client.cancelClaimBoundRefund(await claimFor(client, overrides));

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
    const client = refundClient(vi.fn(async () => response(body)));

    await expect(client.cancelClaimBoundRefund(await claimFor(client))).resolves.toMatchObject({
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
    const client = refundClient(fetchImpl as TinkoffFetch);

    const result = await client.cancelClaimBoundRefund(await claimFor(client));

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
    const client = refundClient(fetchImpl, { refundRequestTimeoutMs: 5 });

    await expect(client.cancelClaimBoundRefund(await claimFor(client))).resolves.toEqual({
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
