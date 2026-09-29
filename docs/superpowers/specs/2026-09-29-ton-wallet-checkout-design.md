# TON wallet identity and Web checkout

Date29.09.2026; follows verified role/restore source3135690 and documentation2c75e9c. User approved complete Aggregator roadmap before Arena, continuous execution. Runtime/payment activation remains separate.

## Intent

An existing registered account links a TON wallet with a real signature, later logs in with that linked credential, and can create/pay/read a server-owned native TON testnet invoice. Signing a message or receiving a wallet broadcast acknowledgement never grants credits. Existing email/OAuth and RUB paths stay working.

## Identity design

Use official TonConnectV2 proof byte layout and Ed25519. Only native testnet wallet identities `-3`, workchain0, known V4R2/V5R1 code hashes. Bounded canonical base64, preflight BoC header count/size, one ordinary root, strict StateInit, code-specific public key position, reconstructed address and declared-key equality. Unknown contracts fail without RPC. SDK string or numeric timestamps must be exact safe integer seconds; compare against floor(issuedDBtime/1000), expiry and <=30s future tolerance. This proves wallet key control, not on-chain deployment/funding, or account ownership on another network/product.

Server challenge lasts120seconds, binds purpose(link/login), network, configured domain, browser HttpOnly secret hash and actor for link. Immutable identity; consume/record exact proof digest atomically. Rate-limit issued challenges in PostgreSQL with fixed bounded windows and cleanup expired rows in bounded batches. On link, current active user must explicitly accept binding; one active owner per network/address. Same proof/browser replay returns the same active binding, while different proof/actor conflicts. No fake Telegram ID or fabricated email.

Wallet login is additional login for a previously linked existing account. Successful verification consumes the challenge and creates one-use60second ticket, hash-at-rest and browser-bound. Raw ticket not reissued after ACK loss. NextAuth second credentials provider consumes it once in DB; wallet-origin JWT carries credential ID and callback verifies active binding/user on every session read. Credential revocation or read failure yields no wallet session. Existing providers unchanged. Unlink requires a fresh valid password on an authenticated active account with a password, rather than trusting a wallet-only session to remove its last access; OAuth-only fallback needs separately defined reauthentication, never guessed.

## Checkout design

Explicit server pricing package/rational FX/recipient policy; no default tariff or inferred TON exchange rate. Request selects package and owned linked-wallet ID; active user must own the billing organization. Idempotency key binds exact user/org/package/wallet command; immutable checkout intent maps saved quote and canonical invoice in one SQL transaction via existing domain adapter. Replay reads saved invoice before current pricing, but checks fresh ownership. No second ledger, client-controlled price/recipient or nested independent commit.

Before any wallet send, persist one dispatch claim. Only first confirmed claim permits one explicit SDK send; unknown claim/send acknowledgement is never automatic retry. Exact transaction comes from persisted invoice(amount/reference/recipient/network/expiry). Client BOC/success/refusal is advisory only. Status reads never call privileged settlement. Current verified worker path owns actual credit; dedicated deployment activation remains explicit. UI shows expired/pending/review/settled and distinguishes wallet acknowledgement from credit.

## Surface and separation

New optional TON Connect React3 UI only on wallet/billing surfaces; analytics disabled. Public manifest comes from configured origin, no domain guessing. Feature defaultoff, origin/network mandatory. No private seed, no arbitrary RPC fallback. API bodies/tickets/cookies strictly bounded, same-origin POST, no sensitive error logs.

## Tests and release limits

Independent known-vector signature tests, unknown-code/key/address/nonce/domain/time/network and oversized-BoC rejection. Native replay/concurrent link/owner/banned/revoked/ticket one-use/cookie mismatch, cutoff after locks, atomic invoice quote and no advisory credit. Browser connects synthetic wallet transport through real UI/API/DB (label synthetic), login/revoke, pending/samekey and payment not granted by wallet success. Exact provider/realtestnet acceptance separate; no mainnet, production secret or deployment write. New additive migration IDs verified before creation.
