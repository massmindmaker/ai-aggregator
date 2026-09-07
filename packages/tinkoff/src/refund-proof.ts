import type { Receipt } from './types';

const DOCUMENTED_PARAM_KEYS = new Set([
  'Route',
  'Source',
  'CreditAmount',
  'EndCoolingPeriod',
  'DrPaymentId',
  'DrPaymentSettlementDate',
  'ParticipantWalletId',
]);

declare const REFUND_METHOD_PROOF: unique symbol;

export interface TinkoffRefundMethodFacts {
  readonly paymentId: string;
  readonly orderId: string;
  readonly route: 'ACQ';
  readonly source: 'cards';
}

export interface TinkoffRefundMethodContext extends TinkoffRefundMethodFacts {
  readonly [REFUND_METHOD_PROOF]: never;
}

export type TinkoffRefundMethodInspection =
  | { kind: 'supported'; facts: TinkoffRefundMethodFacts }
  | {
      kind: 'unsupported';
      code: 'GET_STATE_UNVERIFIED' | 'METHOD_PARAMS_UNSUPPORTED';
    };

export type TinkoffRefundMethodAuthorizationResult =
  | { kind: 'supported'; context: TinkoffRefundMethodContext }
  | Extract<TinkoffRefundMethodInspection, { kind: 'unsupported' }>
  | {
      kind: 'indeterminate';
      code: 'NETWORK_ERROR' | 'HTTP_ERROR' | 'MALFORMED_RESPONSE';
    };

export type TinkoffRefundReceiptContext =
  | { kind: 'verified_receipt'; receipt: Receipt }
  | { kind: 'trusted_no_receipt_required' };

export interface ClaimBoundRefundRequest {
  providerKey: string;
  paymentId: string;
  orderId: string;
  paidKopecks: number;
  refundedKopecks: number;
  requestedKopecks: number;
  methodContext: TinkoffRefundMethodContext;
  receiptContext?: TinkoffRefundReceiptContext;
}

export interface TinkoffRefundProof {
  paymentId: string;
  orderId: string;
  externalRequestId: string;
  status: 'PARTIAL_REFUNDED' | 'REFUNDED';
  originalAmountKopecks: number;
  newAmountKopecks: number;
}

export type ClaimBoundRefundResult =
  | { kind: 'settled'; proof: TinkoffRefundProof }
  | {
      kind: 'not_dispatched';
      code:
        | 'INVALID_REQUEST'
        | 'UNSUPPORTED_METHOD'
        | 'PARTIAL_RECEIPT_CONTEXT_REQUIRED'
        | 'PARTIAL_RECEIPT_UNSUPPORTED';
    }
  | {
      kind: 'indeterminate';
      code:
        | 'NETWORK_ERROR'
        | 'HTTP_ERROR'
        | 'MALFORMED_RESPONSE'
        | 'PROVIDER_REJECTED'
        | 'UNVERIFIED_RESPONSE';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown, maxLength?: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    (maxLength === undefined || value.length <= maxLength)
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function inspectRefundMethodContext(
  response: unknown,
  expected: { paymentId: string; orderId: string }
): TinkoffRefundMethodInspection {
  if (
    !isRecord(response) ||
    !isNonemptyString(expected.paymentId) ||
    !isNonemptyString(expected.orderId) ||
    !isNonemptyString(response.PaymentId) ||
    !isNonemptyString(response.OrderId) ||
    response.Success !== true ||
    response.ErrorCode !== '0' ||
    response.PaymentId !== expected.paymentId ||
    response.OrderId !== expected.orderId ||
    !Array.isArray(response.Params)
  ) {
    return { kind: 'unsupported', code: 'GET_STATE_UNVERIFIED' };
  }

  const params = new Map<string, string>();
  for (const param of response.Params) {
    if (
      !isRecord(param) ||
      typeof param.Key !== 'string' ||
      typeof param.Value !== 'string' ||
      !DOCUMENTED_PARAM_KEYS.has(param.Key) ||
      params.has(param.Key)
    ) {
      return { kind: 'unsupported', code: 'METHOD_PARAMS_UNSUPPORTED' };
    }
    params.set(param.Key, param.Value);
  }

  if (params.get('Route') !== 'ACQ' || params.get('Source') !== 'cards') {
    return { kind: 'unsupported', code: 'METHOD_PARAMS_UNSUPPORTED' };
  }

  return {
    kind: 'supported',
    facts: Object.freeze({
      paymentId: expected.paymentId,
      orderId: expected.orderId,
      route: 'ACQ',
      source: 'cards',
    }),
  };
}

export function validateClaimBoundRefundRequest(
  request: ClaimBoundRefundRequest,
  methodFacts?: TinkoffRefundMethodFacts
):
  | { kind: 'valid'; remainingKopecks: number }
  | Extract<ClaimBoundRefundResult, { kind: 'not_dispatched' }> {
  if (
    !isNonemptyString(request.providerKey, 255) ||
    !isNonemptyString(request.paymentId) ||
    !isNonemptyString(request.orderId) ||
    !Number.isSafeInteger(request.paidKopecks) ||
    request.paidKopecks <= 0 ||
    !isNonnegativeSafeInteger(request.refundedKopecks) ||
    !Number.isSafeInteger(request.requestedKopecks) ||
    request.requestedKopecks <= 0 ||
    request.refundedKopecks > request.paidKopecks
  ) {
    return { kind: 'not_dispatched', code: 'INVALID_REQUEST' };
  }

  const remainingKopecks = request.paidKopecks - request.refundedKopecks;
  if (request.requestedKopecks > remainingKopecks) {
    return { kind: 'not_dispatched', code: 'INVALID_REQUEST' };
  }

  if (
    !methodFacts ||
    methodFacts.paymentId !== request.paymentId ||
    methodFacts.orderId !== request.orderId ||
    methodFacts.route !== 'ACQ' ||
    methodFacts.source !== 'cards'
  ) {
    return { kind: 'not_dispatched', code: 'UNSUPPORTED_METHOD' };
  }

  if (request.requestedKopecks < remainingKopecks) {
    if (request.receiptContext?.kind === 'trusted_no_receipt_required') {
      return { kind: 'valid', remainingKopecks };
    }
    if (request.receiptContext?.kind === 'verified_receipt') {
      return {
        kind: 'not_dispatched',
        code: 'PARTIAL_RECEIPT_UNSUPPORTED',
      };
    }
    return { kind: 'not_dispatched', code: 'PARTIAL_RECEIPT_CONTEXT_REQUIRED' };
  }

  return { kind: 'valid', remainingKopecks };
}

export function validateCancelProof(
  response: unknown,
  request: ClaimBoundRefundRequest,
  remainingKopecks: number
): ClaimBoundRefundResult {
  if (!isRecord(response)) {
    return { kind: 'indeterminate', code: 'MALFORMED_RESPONSE' };
  }
  if (response.Success !== true || response.ErrorCode !== '0') {
    return { kind: 'indeterminate', code: 'PROVIDER_REJECTED' };
  }

  const originalAmount = response.OriginalAmount;
  const newAmount = response.NewAmount;
  if (
    response.PaymentId !== request.paymentId ||
    response.OrderId !== request.orderId ||
    response.ExternalRequestId !== request.providerKey ||
    !isNonnegativeSafeInteger(originalAmount) ||
    !isNonnegativeSafeInteger(newAmount) ||
    originalAmount !== remainingKopecks ||
    originalAmount - newAmount !== request.requestedKopecks ||
    (response.Status !== 'REFUNDED' && response.Status !== 'PARTIAL_REFUNDED') ||
    (response.Status === 'REFUNDED' && newAmount !== 0) ||
    (response.Status === 'PARTIAL_REFUNDED' && newAmount === 0)
  ) {
    return { kind: 'indeterminate', code: 'UNVERIFIED_RESPONSE' };
  }

  return {
    kind: 'settled',
    proof: {
      paymentId: response.PaymentId,
      orderId: response.OrderId,
      externalRequestId: response.ExternalRequestId,
      status: response.Status,
      originalAmountKopecks: originalAmount,
      newAmountKopecks: newAmount,
    },
  };
}
