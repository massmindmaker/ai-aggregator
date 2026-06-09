/**
 * Startonus NFT minter API client.
 * Docs: https://bot.startonus.com/docs
 * Auth: secret in body (generate via @startonus_bot /createMinterSecret)
 *
 * Internal client — "Startonus" must NEVER appear in any user-facing response.
 * Callers must map errors to generic labels (e.g. `minter_unavailable`).
 * The `secret` field is sent ONLY in the outbound request body to Startonus
 * and is NEVER returned to any client (T-16-16).
 */

const BASE_URL = process.env.STARTONUS_BASE_URL ?? 'https://bot.startonus.com/api';

/** Recipient / new owner — an OBJECT, not a bare string (live API shape). */
export interface StartonusOwner {
  tgId: number;
  userName?: string;
  /** TON wallet address (raw or user-friendly) */
  wallet: string;
}

/** Per-item NFT metadata — sets the collectible card data at mint time. */
export interface StartonusNftData {
  name: string;
  description: string;
  /** Image URL — MUST be our S3/CDN URL (white-label; never a third-party URL). */
  image: string;
  /** Optional mp4 video URL */
  content?: string;
  attributes?: { type: string; value: string }[];
  buttons?: { label: string; uri: string }[];
}

export interface GenerateInvoiceParams {
  /** Startonus minter secret (env: STARTONUS_SECRET) — server-side only, never returned. */
  secret: string;
  /** Mint-set template id (from /mintStats or admin panel). Posted as body `id`. */
  templateId: number;
  /** Collection contract address (the ONE shared "Агенты" collection). Posted as body `address`. */
  address: string;
  /** Recipient — an OBJECT with tgId + wallet. Replaces the old bare string recipient field. */
  owner: StartonusOwner;
  /** Mint price in nano TON (optional; stringified before sending). Was `priceNanoTon`. */
  nftPrice?: bigint | string;
  /** Number of NFT items to mint (optional). */
  nftAmount?: number;
  /** Per-item NFT metadata (name/description/image/attributes/buttons). Sets collectible card at mint time. */
  nftData?: StartonusNftData;
  /** Callback URL for async mint notification (Startonus POSTs to this on success). */
  callbackUrl?: string;
  /** Opaque data echoed on the success callback — we put transfer_charges.id (UUID). */
  userData?: string;
}

export interface InvoiceResponse {
  id: string;
  /** Destination contract address for TON Connect transaction */
  to: string;
  /** Amount in nano TON */
  value: string;
  /** TON Connect payload (base64) */
  payload: string;
  /** Unix seconds */
  validUntil: number;
}

/**
 * Webhook payload POSTed by Startonus to `callbackUrl` on successful mint.
 * Consumed by the transfer webhook to read the minted `item` address
 * and match `userData` (= transfer_charges.id UUID).
 */
export interface StartonusCallback {
  success: boolean;
  /** Minted NFT item address on TON */
  item?: string;
  owner?: StartonusOwner;
  referrers?: unknown[];
  mint?: unknown;
  /** Echoed from `GenerateInvoiceParams.userData` */
  userData?: string;
}

export async function generateInvoice(params: GenerateInvoiceParams): Promise<InvoiceResponse> {
  const body: Record<string, unknown> = {
    id: params.templateId,
    address: params.address,
    secret: params.secret,
    owner: params.owner,
  };

  if (params.nftPrice !== undefined) {
    body.nftPrice = String(params.nftPrice);
  }
  if (params.nftAmount !== undefined) {
    body.nftAmount = params.nftAmount;
  }
  if (params.nftData !== undefined) {
    body.nftData = params.nftData;
  }
  if (params.callbackUrl !== undefined) {
    body.callbackUrl = params.callbackUrl;
  }
  if (params.userData !== undefined) {
    body.userData = params.userData;
  }

  const res = await fetch(`${BASE_URL}/minter/generate-invoice/custom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Keep raw message server-side; callers map to generic labels (T-16-17).
    const text = await res.text().catch(() => '');
    throw new Error(`minter generate-invoice failed: ${res.status} ${text}`);
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
