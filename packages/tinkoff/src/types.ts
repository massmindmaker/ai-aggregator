/**
 * Tinkoff Acquiring API Types
 * API Documentation: https://www.tinkoff.ru/kassa/develop/api/payments/
 */

// Payment statuses
export type PaymentStatus =
  | 'NEW'
  | 'FORM_SHOWED'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'REVERSING'
  | 'PARTIAL_REVERSED'
  | 'REVERSED'
  | 'REFUNDING'
  | 'PARTIAL_REFUNDED'
  | 'REFUNDED'
  | 'REJECTED'
  | 'CANCELED'
  | 'DEADLINE_EXPIRED'
  | 'AUTH_FAIL';

// Tax types for FZ-54
export type TaxationType = 'osn' | 'usn_income' | 'usn_income_outcome' | 'envd' | 'esn' | 'patent';

// VAT codes
export type VatCode = 'none' | 'vat0' | 'vat10' | 'vat20' | 'vat110' | 'vat120';

// Payment method
export type PaymentMethod = 'full_prepayment' | 'prepayment' | 'advance' | 'full_payment' | 'partial_payment' | 'credit' | 'credit_payment';

// Payment object
export type PaymentObject = 'commodity' | 'excise' | 'job' | 'service' | 'gambling_bet' | 'gambling_prize' | 'lottery' | 'lottery_prize' | 'intellectual_activity' | 'payment' | 'agent_commission' | 'composite' | 'another';

// Receipt item for FZ-54
export interface ReceiptItem {
  Name: string;
  Price: number; // In kopecks
  Quantity: number;
  Amount: number; // In kopecks
  Tax: VatCode;
  PaymentMethod?: PaymentMethod;
  PaymentObject?: PaymentObject;
  Ean13?: string;
  ShopCode?: string;
}

// Receipt for FZ-54
export interface Receipt {
  Items: ReceiptItem[];
  Email?: string;
  Phone?: string;
  Taxation: TaxationType;
}

// Init payment request
export interface InitPaymentRequest {
  TerminalKey: string;
  Amount: number; // In kopecks
  OrderId: string;
  Description?: string;
  CustomerKey?: string;
  Recurrent?: 'Y';
  PayType?: 'O' | 'T'; // O - one-stage, T - two-stage
  Language?: 'ru' | 'en';
  NotificationURL?: string;
  SuccessURL?: string;
  FailURL?: string;
  Receipt?: Receipt;
  DATA?: Record<string, string>;
  Token?: string;
}

// Init payment response
export interface InitPaymentResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey: string;
  Status: PaymentStatus;
  PaymentId: string;
  OrderId: string;
  Amount: number;
  PaymentURL?: string;
  Message?: string;
  Details?: string;
}

// Get state request
export interface GetStateRequest {
  TerminalKey: string;
  PaymentId: string;
  Token?: string;
}

// Get state response
export interface GetStateResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey: string;
  Status: PaymentStatus;
  PaymentId: string;
  OrderId: string;
  Amount: number;
  RebillId?: string;
  Params?: GetStateParam[];
  Message?: string;
  Details?: string;
}

export type GetStateParamKey =
  | 'Route'
  | 'Source'
  | 'CreditAmount'
  | 'EndCoolingPeriod'
  | 'DrPaymentId'
  | 'DrPaymentSettlementDate'
  | 'ParticipantWalletId';

export interface GetStateParam {
  Key: GetStateParamKey;
  Value: string;
}

// Confirm request (for two-stage payments)
export interface ConfirmRequest {
  TerminalKey: string;
  PaymentId: string;
  Amount?: number; // In kopecks, can be less than original
  Receipt?: Receipt;
  Token?: string;
}

// Confirm response
export interface ConfirmResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey: string;
  Status: PaymentStatus;
  PaymentId: string;
  OrderId: string;
  Amount: number;
  Message?: string;
  Details?: string;
}

// Cancel request
export interface CancelRequest {
  TerminalKey: string;
  PaymentId: string;
  Amount?: number; // In kopecks, partial refund if specified
  Receipt?: Receipt;
  ExternalRequestId?: string;
  Token?: string;
}

// Cancel response
export interface CancelResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey: string;
  Status: PaymentStatus;
  PaymentId: string;
  OrderId: string;
  OriginalAmount: number;
  NewAmount: number;
  ExternalRequestId?: string;
  Message?: string;
  Details?: string;
}

// Charge request (recurring payment)
export interface ChargeRequest {
  TerminalKey: string;
  PaymentId: string;
  RebillId: string;
  Token?: string;
}

// Charge response
export interface ChargeResponse {
  Success: boolean;
  ErrorCode: string;
  TerminalKey: string;
  Status: PaymentStatus;
  PaymentId: string;
  OrderId: string;
  Amount: number;
  Message?: string;
  Details?: string;
}

// Webhook notification
export interface WebhookNotification {
  TerminalKey: string;
  OrderId: string;
  Success: boolean;
  Status: PaymentStatus;
  PaymentId: number;
  ErrorCode: string;
  Amount: number;
  CardId?: number;
  Pan?: string;
  ExpDate?: string;
  RebillId?: string;
  Token: string;
  DATA?: Record<string, string>;
}

// Client configuration
export interface TinkoffConfig {
  terminalKey: string;
  secretKey: string;
  apiUrl?: string;
  refundRequestTimeoutMs?: number;
}

// Payment parameters for high-level API
export interface CreatePaymentParams {
  orderId: string;
  amount: number; // In rubles (will be converted to kopecks)
  description?: string;
  customerKey?: string;
  email?: string;
  phone?: string;
  successUrl?: string;
  failUrl?: string;
  notificationUrl?: string;
  recurrent?: boolean;
  receipt?: {
    items: Array<{
      name: string;
      price: number; // In rubles
      quantity: number;
      tax: VatCode;
    }>;
    taxation: TaxationType;
  };
  metadata?: Record<string, string>;
}

// Payment result
export interface PaymentResult {
  success: boolean;
  paymentId: string;
  orderId: string;
  status: PaymentStatus;
  amount: number; // In rubles
  paymentUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}
