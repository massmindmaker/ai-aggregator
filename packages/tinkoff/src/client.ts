import type {
  TinkoffConfig,
  InitPaymentRequest,
  InitPaymentResponse,
  GetStateResponse,
  ConfirmRequest,
  ConfirmResponse,
  CancelRequest,
  CancelResponse,
  ChargeRequest,
  ChargeResponse,
  CreatePaymentParams,
  PaymentResult,
  WebhookNotification,
} from './types';
import type {
  ClaimBoundRefundRequest,
  ClaimBoundRefundResult,
  TinkoffRefundMethodAuthorizationResult,
  TinkoffRefundMethodContext,
  TinkoffRefundMethodFacts,
} from './refund-proof';
import {
  inspectRefundMethodContext,
  validateCancelProof,
  validateClaimBoundRefundRequest,
} from './refund-proof';
import { generateToken, verifyWebhookToken, rublesToKopecks, kopecksToRubles } from './utils';

const DEFAULT_API_URL = 'https://securepay.tinkoff.ru/v2';
const DEFAULT_REFUND_REQUEST_TIMEOUT_MS = 10_000;

export type TinkoffFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

/**
 * Tinkoff Acquiring API Client
 */
export class TinkoffAcquiring {
  private readonly terminalKey: string;
  private readonly secretKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: TinkoffFetch;
  private readonly refundRequestTimeoutMs: number;
  readonly #refundMethodContexts = new WeakMap<object, TinkoffRefundMethodFacts>();

  constructor(config: TinkoffConfig, fetchImpl: TinkoffFetch = fetch as unknown as TinkoffFetch) {
    this.terminalKey = config.terminalKey;
    this.secretKey = config.secretKey;
    this.apiUrl = config.apiUrl || DEFAULT_API_URL;
    this.fetchImpl = fetchImpl;
    this.refundRequestTimeoutMs =
      Number.isSafeInteger(config.refundRequestTimeoutMs) &&
      (config.refundRequestTimeoutMs as number) > 0
        ? (config.refundRequestTimeoutMs as number)
        : DEFAULT_REFUND_REQUEST_TIMEOUT_MS;
  }

  private async post(endpoint: string, data: Record<string, unknown>, signal?: AbortSignal) {
    const url = `${this.apiUrl}/${endpoint}`;
    const token = generateToken(data, this.secretKey);
    const body = { ...data, Token: token };

    return this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * Make API request
   */
  private async request<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    const response = await this.post(endpoint, data);

    if (!response.ok) {
      throw new Error(`Tinkoff API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private async requestWithRefundDeadline(
    endpoint: string,
    data: Record<string, unknown>
  ): Promise<
    | { kind: 'response'; body: unknown }
    | {
        kind: 'indeterminate';
        code: 'NETWORK_ERROR' | 'HTTP_ERROR' | 'MALFORMED_RESPONSE';
      }
  > {
    const abortController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error('refund request deadline exceeded'));
      }, this.refundRequestTimeoutMs);
    });

    try {
      const response = await Promise.race([
        this.post(endpoint, data, abortController.signal),
        deadline,
      ]);

      if (!response.ok) {
        return { kind: 'indeterminate', code: 'HTTP_ERROR' };
      }

      try {
        return {
          kind: 'response',
          body: await Promise.race([response.json(), deadline]),
        };
      } catch {
        return abortController.signal.aborted
          ? { kind: 'indeterminate', code: 'NETWORK_ERROR' }
          : { kind: 'indeterminate', code: 'MALFORMED_RESPONSE' };
      }
    } catch {
      return { kind: 'indeterminate', code: 'NETWORK_ERROR' };
    } finally {
      clearTimeout(deadlineTimer!);
    }
  }

  /**
   * Initialize payment (low-level)
   */
  async init(params: Omit<InitPaymentRequest, 'TerminalKey' | 'Token'>): Promise<InitPaymentResponse> {
    return this.request<InitPaymentResponse>('Init', {
      TerminalKey: this.terminalKey,
      ...params,
    });
  }

  /**
   * Get payment state
   */
  async getState(paymentId: string): Promise<GetStateResponse> {
    return this.request<GetStateResponse>('GetState', {
      TerminalKey: this.terminalKey,
      PaymentId: paymentId,
    });
  }

  /**
   * Verify the payment method through T-Bank and mint a capability owned by
   * this client instance. Pure parsers and serialized data cannot mint it.
   */
  async getRefundMethodContext(expected: {
    paymentId: string;
    orderId: string;
  }): Promise<TinkoffRefundMethodAuthorizationResult> {
    if (
      typeof expected.paymentId !== 'string' ||
      expected.paymentId.trim().length === 0 ||
      typeof expected.orderId !== 'string' ||
      expected.orderId.trim().length === 0
    ) {
      return { kind: 'unsupported', code: 'GET_STATE_UNVERIFIED' };
    }

    const state = await this.requestWithRefundDeadline('GetState', {
      TerminalKey: this.terminalKey,
      PaymentId: expected.paymentId,
    });
    if (state.kind === 'indeterminate') {
      return state;
    }

    const inspection = inspectRefundMethodContext(state.body, expected);
    if (inspection.kind === 'unsupported') {
      return inspection;
    }

    const context = Object.freeze({ ...inspection.facts }) as TinkoffRefundMethodContext;
    this.#refundMethodContexts.set(context, inspection.facts);
    return { kind: 'supported', context };
  }

  /**
   * Confirm authorized payment (two-stage)
   */
  async confirm(params: Omit<ConfirmRequest, 'TerminalKey' | 'Token'>): Promise<ConfirmResponse> {
    return this.request<ConfirmResponse>('Confirm', {
      TerminalKey: this.terminalKey,
      ...params,
    });
  }

  /**
   * Cancel or refund payment
   */
  async cancel(params: Omit<CancelRequest, 'TerminalKey' | 'Token'>): Promise<CancelResponse> {
    return this.request<CancelResponse>('Cancel', {
      TerminalKey: this.terminalKey,
      ...params,
    });
  }

  /**
   * Dispatch a refund tied to a persisted claim key and validate the bank proof.
   * Ambiguous provider outcomes deliberately remain indeterminate.
   */
  async cancelClaimBoundRefund(params: ClaimBoundRefundRequest): Promise<ClaimBoundRefundResult> {
    const methodContext = params?.methodContext;
    const methodFacts =
      typeof methodContext === 'object' && methodContext !== null
        ? this.#refundMethodContexts.get(methodContext)
        : undefined;
    const validation = validateClaimBoundRefundRequest(params, methodFacts);
    if (validation.kind === 'not_dispatched') {
      return validation;
    }

    const response = await this.requestWithRefundDeadline('Cancel', {
      TerminalKey: this.terminalKey,
      PaymentId: params.paymentId,
      Amount: params.requestedKopecks,
      ExternalRequestId: params.providerKey,
    });
    if (response.kind === 'indeterminate') {
      return response;
    }

    return validateCancelProof(response.body, params, validation.remainingKopecks);
  }

  /**
   * Charge recurring payment
   */
  async charge(params: Omit<ChargeRequest, 'TerminalKey' | 'Token'>): Promise<ChargeResponse> {
    return this.request<ChargeResponse>('Charge', {
      TerminalKey: this.terminalKey,
      ...params,
    });
  }

  /**
   * Create payment (high-level API)
   */
  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    const amountKopecks = rublesToKopecks(params.amount);

    const initParams: Omit<InitPaymentRequest, 'TerminalKey' | 'Token'> = {
      Amount: amountKopecks,
      OrderId: params.orderId,
      Description: params.description,
      CustomerKey: params.customerKey,
      SuccessURL: params.successUrl,
      FailURL: params.failUrl,
      NotificationURL: params.notificationUrl,
      Recurrent: params.recurrent ? 'Y' : undefined,
      DATA: params.metadata,
    };

    // Add receipt if provided
    if (params.receipt) {
      initParams.Receipt = {
        Items: params.receipt.items.map((item) => ({
          Name: item.name,
          Price: rublesToKopecks(item.price),
          Quantity: item.quantity,
          Amount: rublesToKopecks(item.price * item.quantity),
          Tax: item.tax,
        })),
        Taxation: params.receipt.taxation,
        Email: params.email,
        Phone: params.phone,
      };
    }

    const response = await this.init(initParams);

    return {
      success: response.Success,
      paymentId: response.PaymentId,
      orderId: response.OrderId,
      status: response.Status,
      amount: kopecksToRubles(response.Amount),
      paymentUrl: response.PaymentURL,
      errorCode: response.ErrorCode !== '0' ? response.ErrorCode : undefined,
      errorMessage: response.Message,
    };
  }

  /**
   * Get payment status (high-level API)
   */
  async getPaymentStatus(paymentId: string): Promise<PaymentResult> {
    const response = await this.getState(paymentId);

    return {
      success: response.Success,
      paymentId: response.PaymentId,
      orderId: response.OrderId,
      status: response.Status,
      amount: kopecksToRubles(response.Amount),
      errorCode: response.ErrorCode !== '0' ? response.ErrorCode : undefined,
      errorMessage: response.Message,
    };
  }

  /**
   * Refund payment (full or partial)
   */
  async refundPayment(paymentId: string, amount?: number): Promise<PaymentResult> {
    const cancelParams: Omit<CancelRequest, 'TerminalKey' | 'Token'> = {
      PaymentId: paymentId,
      Amount: amount ? rublesToKopecks(amount) : undefined,
    };

    const response = await this.cancel(cancelParams);

    return {
      success: response.Success,
      paymentId: response.PaymentId,
      orderId: response.OrderId,
      status: response.Status,
      amount: kopecksToRubles(response.NewAmount),
      errorCode: response.ErrorCode !== '0' ? response.ErrorCode : undefined,
      errorMessage: response.Message,
    };
  }

  /**
   * Charge recurring payment (high-level API)
   * First, you need to init a new payment, then charge it using rebillId
   */
  async chargeRecurrent(
    orderId: string,
    rebillId: string,
    amount: number,
    description?: string
  ): Promise<PaymentResult> {
    // First, init a new payment
    const initResponse = await this.init({
      Amount: rublesToKopecks(amount),
      OrderId: orderId,
      Description: description,
    });

    if (!initResponse.Success) {
      return {
        success: false,
        paymentId: initResponse.PaymentId,
        orderId: initResponse.OrderId,
        status: initResponse.Status,
        amount: kopecksToRubles(initResponse.Amount),
        errorCode: initResponse.ErrorCode,
        errorMessage: initResponse.Message,
      };
    }

    // Then charge using rebillId
    const chargeResponse = await this.charge({
      PaymentId: initResponse.PaymentId,
      RebillId: rebillId,
    });

    return {
      success: chargeResponse.Success,
      paymentId: chargeResponse.PaymentId,
      orderId: chargeResponse.OrderId,
      status: chargeResponse.Status,
      amount: kopecksToRubles(chargeResponse.Amount),
      errorCode: chargeResponse.ErrorCode !== '0' ? chargeResponse.ErrorCode : undefined,
      errorMessage: chargeResponse.Message,
    };
  }

  /**
   * Verify webhook signature
   */
  verifyWebhook(payload: WebhookNotification): boolean {
    const { Token, ...rest } = payload;
    return verifyWebhookToken(rest as Record<string, unknown>, Token, this.secretKey);
  }

  /**
   * Parse webhook notification
   */
  parseWebhook(payload: WebhookNotification): {
    isValid: boolean;
    orderId: string;
    paymentId: string;
    status: string;
    amount: number;
    success: boolean;
    rebillId?: string;
    cardPan?: string;
    errorCode: string;
  } {
    return {
      isValid: this.verifyWebhook(payload),
      orderId: payload.OrderId,
      paymentId: String(payload.PaymentId),
      status: payload.Status,
      amount: kopecksToRubles(payload.Amount),
      success: payload.Success,
      rebillId: payload.RebillId,
      cardPan: payload.Pan,
      errorCode: payload.ErrorCode,
    };
  }
}

/**
 * Create Tinkoff Acquiring client
 */
export function createTinkoffClient(
  config: TinkoffConfig,
  fetchImpl?: TinkoffFetch
): TinkoffAcquiring {
  return new TinkoffAcquiring(config, fetchImpl);
}
