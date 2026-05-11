/**
 * TON Connect proof verification (MVP).
 *
 * Spec: https://docs.ton.org/develop/dapps/ton-connect/sign
 *
 * Full strict verification requires Ed25519 signature check against the wallet's
 * publicKey, with hashing of `ton-proof-item-v2/<workchain>/<address>/<domain>/<ts>/<payload>`
 * followed by `ton-connect`-prefix SHA256.
 *
 * TODO: implement strict proof verify (use @ton/crypto.signVerify).
 *
 * For MVP we accept the address from `useTonAddress()` as advisory — an attacker
 * has no incentive to lie about *their own* address for a top-up (the funds go
 * to OUR wallet anyway; we credit by `comment_tag` match in reconciliation).
 * Linked wallet rows therefore start with is_verified=false.
 */

export interface TonProofPayload {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
  state_init?: string;
}

export function verifyTonProof(
  _proof: TonProofPayload,
  _address: string,
  _domain: string,
): boolean {
  // MVP: not implemented. See note above.
  return false;
}
