# Wallet-based auth + action-gating for our TMA — research & mechanic (2026-06-26)

> Goal: the smoothest, clearest mechanic for "browse free → connect wallet → can HIRE agents"
> using ONLY building blocks we already have (Telegram-identity JWT, TON Connect + ton-proof,
> USD-pegged credits, free-first-run grant, hire/agent_sessions). **No new product features** —
> only wiring + polish + a forward research list.
>
> Scope check vs our build (verified in code):
> - Auth today = Telegram `initData` → HS256 JWT, `iss:aiag-tma / aud:aiag-gateway`, jti, 24h
>   (`apps/tg-miniapp/app/api/tma/auth/verify/route.ts`).
> - ton-proof verification is real and strict (`apps/tg-miniapp/src/lib/ton-proof.ts`);
>   sets `ton_wallets.is_verified=TRUE` only on a full chain pass.
> - Free-first-run grant = one-time, idempotent, +credit only (`grantFreeFirstRun`, default 30000¢=$300).
> - Hire = `agent_sessions` upsert, hirer = authed `x-tma-user-id`, **no wallet requirement today**
>   (`apps/tg-miniapp/app/api/tma/agents/[id]/hire/route.ts`).
> - Wallet GET returns linked wallets + `balance_credits` (`app/api/tma/wallet/route.ts`).

---

## 1. Best-practice findings (with URLs)

### A. Telegram identity is the base; wallet is a payment/asset gate, NOT login
The dominant 2026 pattern for TON Mini Apps is a **two-layer identity**: Telegram `initData`
identifies *who* (free, zero-friction, automatic on open), and the TON wallet is connected
**later, only when an on-chain or value action is needed**. Wallet-as-login (wallet replaces
Telegram identity) is NOT the norm in Mini Apps — the app already knows the user from Telegram,
so forcing a wallet to *enter* is pure friction. This is exactly our current shape.

- TON Connect keeps private keys in the wallet, never exposed to the app — it is a connection/
  signing protocol, not an account system.
  https://help.wallet.tg/article/281-ton-connect-and-how-to-connect-apps
- "The moment of interest can also be the moment of onboarding, funding, or engagement" —
  just-in-time connection beats upfront. Telegram login + TON Connect reduce steps-before-
  meaningful-action.
  https://medium.com/@ellie_43405/miniapps-on-telegram-are-becoming-the-fastest-user-acquisition-channel-for-web3-projects-707a81525d40
- Recommended flow shape: "one-tap auth → clear value → wallet prompt → instant receipt …
  wallet integration should enhance rather than complicate the user journey, remaining
  invisible to users who don't need it."
  https://www.nadcab.com/blog/ton-wallet-integration-telegram-mini-apps
- TON is the mandatory chain for Mini Apps and TON Connect the mandatory connector (since Feb 2025).
  https://core.telegram.org/bots/blockchain-guidelines
- General 2026 overview / ecosystem scale (≈500M MAU Mini Apps, 400M wallets):
  https://magnetto.com/blog/everything-you-need-to-know-about-telegram-mini-apps

### B. When to prompt connect — LAZY, at point-of-action
Top funnels (Hamster Kombat, Notcoin, DEXs like STON.fi / DeDust) let users **play / browse
first** and only ask for a wallet at the exact moment it is required — claim tokens, swap, or
withdraw. Wallet connection is a *task in the flow*, not a gate at the door.

- Hamster Kombat: users play the whole game; connecting a TON wallet is a discrete *task*
  ("Airdrop Task 1: link your TON wallet") surfaced only when claiming.
  https://www.kucoin.com/learn/web3/hamster-kombat-airdrop-task-1-link-your-ton-wallet
- DEXs (STON.fi / DeDust): browse pools / quotes freely; connect Tonkeeper only at the swap step.
  https://ston.fi/tokens-dex
- Friction principle: "move from first touch to meaningful action with almost no user education
  while preserving secure wallet flows."
  https://onchain.org/magazine/what-are-telegram-mini-apps-and-why-you-should-care/

**Friction cliffs** the literature flags: (1) asking for a wallet before any value is shown;
(2) dead-ending into a "you need to top up" wall with no in-context path; (3) blocking the whole
app behind connect. The fix is always **defer + contextualize**.

### C. ton-proof as auth: bind a wallet to identity, keep it a linked ATTRIBUTE
Best practice for proving wallet ownership = ton-proof (TON Connect `ton_proof-item-v2`): the
backend issues a **fresh, server-bound payload (nonce)**, the wallet signs it, the backend
verifies signature + domain + freshness + that the pubkey belongs to the address's stateInit.
Replay defense for any challenge-signature scheme = **server-issued nonce + short TTL +
single-use tracking + timestamp window**.

- TON Connect sign/ton-proof spec (message assembly, domain, payload):
  https://docs.ton.org/develop/dapps/ton-connect/sign
- Reference dApp implementing connect + ton-proof:
  https://github.com/ton-connect/demo-dapp-with-wallet
- Replay-defense generally (nonce + timestamp window + single-use store):
  https://dev.to/raselmahmuddev/protecting-api-requests-using-nonce-redis-and-time-based-validation-11nd
  https://www.cube.exchange/what-is/replay-attack

**Should the wallet become part of the auth claim?** No. Best practice (and the lower-risk
choice for us) is: **Telegram identity stays the auth subject; the verified wallet is a linked
attribute** of that identity (`ton_wallets(tg_user_id, address, is_verified)`). Reasons:
- A user may have 0, 1, or many wallets; the *person* is the stable principal.
- Putting the wallet inside the JWT means re-minting tokens on every wallet change and
  complicates the gateway's `aud` contract — unnecessary.
- Gating reads "does this authed user have a verified wallet?" server-side at the action — same
  security, no token churn.

**Replay/security notes on OUR implementation (already correct):**
- Our payload is a **stateless HMAC nonce**: `ts(8B) || HMAC(secret, ts)[0..16]`, domain-
  separated key (`aiag-tonproof-v1`), 15-min TTL — server-issued and unforgeable. Good.
- We verify domain == `app.ai-aggregator.ru`, proof timestamp freshness, stateInit hashes to
  the claimed address, pubkey sits in stateInit (v3/v4/v5r1), and the ed25519 signature. Good.
- **One residual gap vs strict best practice:** the payload is replay-safe *only by its 15-min
  window* — within that window the same proof could in principle be re-submitted. For
  *wallet-link* this is low-risk (idempotent upsert, `is_verified` never downgrades, no value
  moves). If we ever use ton-proof for *login* or *transfer authorization*, add single-use
  tracking (the same Redis `SET NX EX` pattern already used for initData replay in
  `claimInitDataNonce`). Note this; do not over-build it for linking.

---

## 2. Recommended mechanic for US (existing blocks only, no new features)

**"Telegram-identity base + verified-wallet gates hire, prompted lazily at the hire tap, with
free-run as the bridge."**

The funnel, end to end, reusing what exists:

1. **Open → identified for free.** `initData → JWT` runs on open (built). Everyone browses the
   whole market, agent pages, run-traces, prices — no wallet, no friction. (Matches best-practice A/B.)
2. **First open also drops free credits.** `grantFreeFirstRun` already grants a one-time welcome
   balance (built). Surface it as a small "300 кр на старт" toast (the API already returns
   `freeGrant`/`freeGrantCredits`). This means the *first* hire can happen with **zero wallet and
   zero top-up** — the smoothest possible first value.
3. **Hire tap = the single decision point.** On "Нанять", check server-side, in order:
   - **(a) Verified wallet?** If the user has no `is_verified` wallet → open the TON Connect
     sheet *in context* (with ton-proof challenge from `/api/tma/wallet/proof-payload`). This is
     the "connect wallet to unlock hiring" gate, prompted exactly at point-of-action.
   - **(b) Enough credits?** If verified but `balance_credits` < est. cost → show inline top-up
     (TON/USDT, built) — never a dead-end wall; the free grant often covers the first hire so new
     users skip this entirely.
   - **(c) Hire.** Call the existing hire endpoint; `agent_sessions` upsert; hirer = authed user.
4. **Receipt.** Show the run/hire confirmation + new balance (wallet GET already returns balance).

Why this is the right mechanic for us: it changes **nothing** about identity, billing, or hire
logic — it only *orders* the three checks (wallet → credits → hire) behind one button and prompts
the wallet **lazily**. It keeps Telegram identity as the principal and the wallet as a linked
attribute (best-practice C). The free grant is the friction-softener the literature calls for:
browse free → try free (grant) → connect wallet only when committing to ongoing/paid use.

**Decision to confirm with founder (cheap, reversible):** does the wallet gate fire at the
**first hire** (strict: even the free-grant hire needs a wallet) or only when **topping up /
when the grant runs out** (loosest: free-grant hire needs no wallet at all)? The looser variant
maximizes the viral free-first-run and still gates all *paid* economic activity behind a verified
wallet. Recommendation: **loose** — free grant needs no wallet; verified wallet required to top up
and to hire once the grant is spent. This best matches "browse free → connect wallet → can hire
(for real)".

---

## 3. What's ALREADY built vs THIN wiring missing

### Already satisfied (do not rebuild)
- **Free, automatic Telegram identity** for browse — JWT on open. ✅
- **Strict ton-proof wallet verification** + `is_verified` flag + idempotent link. ✅
- **Stateless server-issued nonce** (HMAC payload) + domain + freshness checks — matches
  replay best practice for linking. ✅
- **USD-pegged credit balance** + read endpoint + **multi-crypto top-up** (TON/USDT). ✅
- **Free-first-run grant** (one-time, idempotent, additive-only) = the friction bridge. ✅
- **Hire** = isolated session, hirer-debited, per-hirer memory scope. ✅
- **Replay single-use pattern already in repo** (`claimInitDataNonce`, Redis `SET NX EX`) —
  reusable verbatim if we ever harden ton-proof to single-use. ✅

### Thin wiring missing (NOT new features — just connect existing parts)
1. **Hire is not gated on a verified wallet.** `hire/route.ts` checks only `x-tma-user-id`.
   Add a server-side pre-check: require ≥1 `ton_wallets` row with `is_verified=TRUE` for the
   authed user (per the loose/strict decision above) → else return a typed `wallet_required`
   error the client turns into the TON Connect prompt. ~10 lines, one SELECT.
2. **No single "hire" funnel state on the client.** The button doesn't sequence
   wallet→credits→hire; the pieces (connect sheet, balance, top-up, hire call) exist but aren't
   chained behind the CTA. Wire the ordered check + contextual prompts (no new screens — reuse
   the existing wallet/top-up UI inline).
3. **Free-grant + wallet-requirement aren't reconciled in copy/logic.** Decide & encode the
   loose-vs-strict rule (above) so the gate doesn't accidentally block the free-first-run hire
   the grant was designed to enable. Pure logic/branching, no new feature.

(Optional, low-priority hardening — note, don't build now: make ton-proof single-use via the
existing Redis nonce pattern *if* ton-proof is ever reused for login/transfer auth.)

---

## 4. Forward research list (open questions for later)

1. **Telegram Wallet (`@wallet`) vs raw TON Connect** as the *default* connect target — the
   in-Telegram custodial wallet is the lowest-friction path for non-crypto deployers; does it
   support ton-proof the same way, and should it be the suggested first option in the sheet?
2. **Wallet abstraction / gasless / sponsored connect** — can we remove the "user needs gas to do
   anything" cliff for first-time users (relevant only if we ever move credits/top-up on-chain;
   today credits are off-chain so this is forward-looking).
3. **Multi-wallet per user** — UX + rules when a user links several wallets (which is "primary"
   for payouts/identity; do we ever need to gate on a *specific* wallet vs *any* verified one).
4. **ton-proof as a full login / step-up auth** — if we later want wallet-signed step-up for
   high-value actions (transfer-iNFT, author payouts), design single-use nonce + how it composes
   with the Telegram JWT (step-up claim vs separate token). Reuse `claimInitDataNonce` pattern.
5. **Withdrawal / payout binding** — when authors withdraw earnings, must payouts go *only* to a
   ton-proof-verified address? (Anti-fraud: bind payout target to a proven wallet.) Research the
   right verification cadence (every withdraw vs once).
6. **Session-lifetime of wallet trust** — should `is_verified` ever expire / require re-proof
   (e.g. after N days or on suspicious change)? Most apps treat link as durable; confirm.

---

## Summary (for the report)

**Recommended mechanic:** keep Telegram `initData`→JWT as the always-on, free identity (the
principal), and treat the ton-proof-verified wallet as a *linked attribute* that gates economic
action — never as login. Let users browse the entire marketplace free, give them the existing
free-first-run credits so their *first* hire can happen with no wallet and no top-up, and prompt
TON Connect **lazily, at the hire tap**, in one ordered sequence: verified-wallet? → enough-credits?
→ hire. This reuses every block we already shipped (JWT, strict ton-proof, credits, multi-crypto
top-up, free grant, hire/agent_sessions) and only *orders* them behind one CTA. Recommend the
"loose" rule: free-grant hire needs no wallet; a verified wallet is required to top up and to hire
once the grant is spent — maximizing the viral free-first-run while gating all real paid activity.

**Top 3 thin-wiring gaps:** (1) `hire/route.ts` doesn't require a verified wallet — add a ~10-line
server pre-check returning a typed `wallet_required`; (2) the hire CTA doesn't sequence
wallet→credits→hire — chain the existing connect/top-up/hire pieces, no new screens; (3) the
free-grant vs wallet-gate rule isn't encoded — pick loose-vs-strict so the gate never blocks the
free-first-run hire.

**Top 3 future-research items:** (1) Telegram `@wallet` vs raw TON Connect as the default connect
target for non-crypto users; (2) ton-proof single-use hardening + step-up auth for high-value
actions (transfer-iNFT, payouts) — reuse the existing Redis `SET NX EX` nonce pattern; (3) binding
author payouts/withdrawals to a ton-proof-verified address (anti-fraud).
