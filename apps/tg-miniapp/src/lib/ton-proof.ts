import { createHmac, timingSafeEqual } from 'node:crypto';
import { Address, Cell } from '@ton/core';
import { sha256_sync, signVerify } from '@ton/crypto';

// R2.1-A2 — strict server-side TON Connect ton_proof verification
// (ton-proof-item-v2, https://docs.ton.org/develop/dapps/ton-connect/sign).
// Replaces the MVP stub that always returned false. Chain verified:
// payload ours+fresh → proof timestamp fresh → domain ours → stateInit hashes
// to the claimed address → claimed pubkey sits inside the wallet's stateInit
// data (v3/v4 offset 64, v5r1 offset 65) → ed25519 signature by that pubkey.
// Only a fully verified link sets ton_wallets.is_verified = TRUE.

const PAYLOAD_TTL_S = 15 * 60;
const PROOF_TTL_S = 15 * 60;

function hmacKey(): Buffer {
  const secret = process.env.TMA_JWT_SECRET ?? '';
  // Domain-separated derivation — never use the raw JWT secret directly.
  return createHmac('sha256', 'aiag-tonproof-v1').update(secret).digest();
}

/** Stateless challenge: hex(ts_seconds_8B || hmac(ts)[0..16]). No DB row needed. */
export function generateProofPayload(): string {
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const mac = createHmac('sha256', hmacKey()).update(ts).digest().subarray(0, 16);
  return Buffer.concat([ts, mac]).toString('hex');
}

function payloadIsOursAndFresh(payloadHex: string): boolean {
  if (!/^[0-9a-f]{48}$/i.test(payloadHex)) return false;
  const buf = Buffer.from(payloadHex, 'hex');
  const ts = buf.subarray(0, 8);
  const mac = buf.subarray(8);
  const expect = createHmac('sha256', hmacKey()).update(ts).digest().subarray(0, 16);
  if (mac.length !== expect.length || !timingSafeEqual(mac, expect)) return false;
  const issued = Number(ts.readBigUInt64BE());
  const age = Math.floor(Date.now() / 1000) - issued;
  return age >= 0 && age <= PAYLOAD_TTL_S;
}

/** Does the claimed 256-bit pubkey sit in the wallet stateInit data?
 *  Known layouts: v3/v4 = seqno(32)+subwallet(32)+pubkey → offset 64;
 *  v5r1 = flag(1)+seqno(32)+wallet_id(32)+pubkey → offset 65. */
function pubkeyMatchesStateInitData(stateInit: Cell, publicKey: Buffer): boolean {
  const data = stateInit.refs[1]; // StateInit = (code, data)
  if (!data) return false;
  for (const offsetBits of [64, 65]) {
    try {
      const s = data.beginParse();
      s.skip(offsetBits);
      const pk = s.loadBuffer(32);
      if (pk.length === 32 && timingSafeEqual(pk, publicKey)) return true;
    } catch {
      // data cell too short for this layout — try the next one
    }
  }
  return false;
}

export interface TonProofPayload {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string; // base64
}

export interface TonProofInput {
  /** raw or friendly TON address the client claims */
  address: string;
  /** hex ed25519 public key the wallet reports */
  public_key: string;
  /** base64 BoC of the wallet's stateInit */
  wallet_state_init: string;
  proof: TonProofPayload;
}

export type TonProofResult = { ok: true } | { ok: false; reason: string };

export function verifyTonProof(input: TonProofInput): TonProofResult {
  const expectedDomain = process.env.TMA_TONPROOF_DOMAIN ?? 'app.ai-aggregator.ru';

  const { proof } = input;
  if (!payloadIsOursAndFresh(proof.payload)) {
    return { ok: false, reason: 'payload_invalid_or_stale' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - proof.timestamp) > PROOF_TTL_S) {
    return { ok: false, reason: 'proof_expired' };
  }
  if (proof.domain.value !== expectedDomain) {
    return { ok: false, reason: 'domain_mismatch' };
  }

  let addr: Address;
  try {
    addr = Address.parse(input.address);
  } catch {
    return { ok: false, reason: 'bad_address' };
  }

  let stateInit: Cell;
  try {
    stateInit = Cell.fromBase64(input.wallet_state_init);
  } catch {
    return { ok: false, reason: 'bad_state_init' };
  }
  // The account id IS hash(stateInit) — binds the provided stateInit to the address.
  if (!stateInit.hash().equals(addr.hash)) {
    return { ok: false, reason: 'state_init_address_mismatch' };
  }

  const publicKey = Buffer.from(input.public_key, 'hex');
  if (publicKey.length !== 32) return { ok: false, reason: 'bad_public_key' };
  if (!pubkeyMatchesStateInitData(stateInit, publicKey)) {
    return { ok: false, reason: 'unsupported_wallet_or_key_mismatch' };
  }

  // ton-proof-item-v2 message assembly.
  const domainBuf = Buffer.from(proof.domain.value, 'utf8');
  if (domainBuf.length !== proof.domain.lengthBytes) {
    return { ok: false, reason: 'domain_length_mismatch' };
  }
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(addr.workChain);
  const dl = Buffer.alloc(4);
  dl.writeUInt32LE(domainBuf.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(proof.timestamp));

  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    wc,
    addr.hash,
    dl,
    domainBuf,
    ts,
    Buffer.from(proof.payload, 'utf8'),
  ]);
  const digest = sha256_sync(
    Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from('ton-connect', 'utf8'),
      sha256_sync(message),
    ]),
  );

  const signature = Buffer.from(proof.signature, 'base64');
  if (!signVerify(digest, signature, publicKey)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
