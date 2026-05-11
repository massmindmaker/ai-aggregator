/**
 * Startonus NFT minter API client.
 * Docs: https://bot.startonus.com/docs
 * Auth: secret in body (generate via @startonus_bot /createMinterSecret)
 */

const BASE_URL = process.env.STARTONUS_BASE_URL ?? 'https://bot.startonus.com/api';

export interface GenerateInvoiceParams {
  /** Startonus minter secret (env: STARTONUS_SECRET) */
  secret: string;
  /** Startonus collection id (from /createCollection bot command) */
  collectionId: string;
  /** Mint price in nano TON (must be >= collection min) */
  priceNanoTon: bigint | string;
  /** Recipient wallet address (TON, raw or user-friendly) */
  recipient: string;
  /** Opaque data for webhook matching — мы кладём purchase_id UUID */
  userData: string;
  /** Callback URL для async mint notification */
  callbackUrl?: string;
}

export interface InvoiceResponse {
  id: string;
  /** Destination contract address для TON Connect transaction */
  to: string;
  /** Amount in nano TON */
  value: string;
  /** TON Connect payload (base64) */
  payload: string;
  /** Unix seconds */
  validUntil: number;
}

export async function generateInvoice(params: GenerateInvoiceParams): Promise<InvoiceResponse> {
  const res = await fetch(`${BASE_URL}/minter/generate-invoice/custom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secret: params.secret,
      collectionId: params.collectionId,
      price: String(params.priceNanoTon),
      recipient: params.recipient,
      userData: params.userData,
      ...(params.callbackUrl ? { callbackUrl: params.callbackUrl } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Startonus generate-invoice failed: ${res.status} ${text}`);
  }
  return (await res.json()) as InvoiceResponse;
}

/** 1 TON = 1e9 nano TON */
export const NANO_PER_TON = 1_000_000_000n;

export function tonToNano(amount: number | string): bigint {
  const [intPart, fracPart = ''] = String(amount).split('.');
  const frac = (fracPart + '000000000').slice(0, 9);
  return BigInt(intPart) * NANO_PER_TON + BigInt(frac);
}

export function nanoToTon(nano: bigint | string | number): string {
  const n = typeof nano === 'bigint' ? nano : BigInt(nano);
  const int = n / NANO_PER_TON;
  const frac = n % NANO_PER_TON;
  if (frac === 0n) return int.toString();
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${int}.${fracStr}`;
}
