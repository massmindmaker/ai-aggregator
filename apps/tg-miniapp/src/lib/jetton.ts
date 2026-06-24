// Resolve the SENDER's jetton-wallet address from a jetton master + owner.
// Used by the USDT-on-TON top-up flow: a TEP-74 `transfer` must be sent to the
// owner's OWN jetton wallet (not the master), so we call the master's
// `get_wallet_address(owner_slice)` get-method via TonCenter v3 `/runGetMethod`.
// Public, key-less call (rate-limited) — fine for the client; the money truth
// still lives in the reconciler over the verified on-chain deposit.
import { Address, beginCell, Cell } from '@ton/core';

const TONCENTER_BASE =
  process.env.NEXT_PUBLIC_TONCENTER_API_URL ?? 'https://toncenter.com/api/v3';

/**
 * Returns the friendly (bounceable) jetton-wallet address that `owner` controls
 * on `jettonMaster`. Throws on RPC/parse failure so the caller can surface a
 * soft error instead of sending a malformed transaction.
 */
export async function resolveJettonWallet(
  jettonMaster: string,
  owner: string,
): Promise<string> {
  const ownerCell = beginCell().storeAddress(Address.parse(owner)).endCell();
  const ownerBoc = ownerCell.toBoc().toString('base64');

  const url = `${TONCENTER_BASE.replace(/\/$/, '')}/runGetMethod`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      address: jettonMaster,
      method: 'get_wallet_address',
      stack: [['tvm.Slice', ownerBoc]],
    }),
  });
  if (!res.ok) throw new Error(`jetton_wallet_rpc_${res.status}`);

  const j = (await res.json()) as {
    exit_code?: number;
    stack?: Array<{ type?: string; value?: string; cell?: string }>;
  };
  if (j.exit_code !== undefined && j.exit_code !== 0) {
    throw new Error(`jetton_wallet_exit_${j.exit_code}`);
  }
  const item = j.stack?.[0];
  const boc = item?.value ?? item?.cell;
  if (!boc) throw new Error('jetton_wallet_empty');

  // The get-method returns the wallet address as a single-cell BOC holding an
  // address slice. Parse the cell and read the MsgAddress out of it.
  const addr = Cell.fromBase64(boc).beginParse().loadAddress();
  return addr.toString({ urlSafe: true, bounceable: true });
}
