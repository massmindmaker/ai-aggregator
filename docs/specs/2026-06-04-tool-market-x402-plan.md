# Tool Market + x402 — architecture & plan (2026-06-04)

> Screens 27/28 «Маркет тулзов». Founder adopted: TON Agentic Wallets (front) + Coinbase
> CDP/x402 (back). This doc fixes the architecture and the v1→v2 build plan.

## The money architecture — TON → credits → x402 (the credit ledger is the bridge)

TON Agentic Wallets (TON chain) and Coinbase x402 (USDC on Base / EVM) are **different
blockchains** — an agent's TON wallet cannot DIRECTLY pay a USDC-on-Base x402 invoice.
They compose through OUR USD-credit ledger:

```
User funds the agent  →  TON  (Telegram-native, one tap)
        ↓
   AIAG USD-credits   (the universal unit + budget enforcement — already live: D-1 ledger,
        ↓               daily caps, settleRun)
Agent calls an x402 tool  →  WE (broker, Coinbase CDP + USDC-on-Base) pay the invoice
        ↓                     and DEBIT the agent's credits (tool cost × markup, integer ¢)
```

- **TON = front** (funding, budget caps, revocable — the TON Agentic Wallet primitive).
- **AIAG credits = middle** (one unit; the user never sees two chains).
- **Coinbase/USDC = back** (we settle x402 tool calls on Base). No TON→Base bridge needed.

This is a strength: we abstract the chains. The per-call tool cost already flows through the
existing run accounting (`ToolExecResult.cost_credits` → `toolFeesCredits` → `settleRun`),
so the billing rail is ALREADY built (see `image_gen` = 8 credits/call today).

## What the founder must obtain from Coinbase (the "key")

To let us PAY x402 invoices on users' behalf (we are the BUYER/payer):
1. **CDP Secret API Key** — in the CDP portal (cdp.coinbase.com, you're already in as «bob
   vader»): create a **Secret API Key** (account menu / «API Keys»). It yields a **Key ID** +
   a **private key** → our backend env `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. **Do NOT paste
   it in chat** — it goes on the VPS `.env` (or paste + rotate, like the Gonka key).
2. **A server wallet to pay from** — CDP **Server Wallet** (Wallets section), funded with a
   little **USDC on Base**. For the spike: **Base Sepolia testnet + the CDP Faucet = FREE**.
3. The **CDP hosted facilitator** (`api.cdp.coinbase.com/platform/v2/x402`) does the on-chain
   part — we do NOT build our own facilitator.
- Custody note (mirror the eval-sandbox caution): do NOT hold a hot MAINNET USDC wallet on the
  2GB prod box; use CDP's managed server wallet or a separate host. Testnet first = $0 risk.

## Build plan

**v1 — true-today, NO Coinbase key needed (ship now):**
- The «Маркет тулзов» catalog screen (27/28): browse tools with a per-call price; built-in
  tools (web_search/calc/memory = 0, image_gen = 8 кр) shown as the first paid tool, billed
  through the EXISTING ledger. Honest «x402-платные тулзы — скоро (через Coinbase)» for the
  external paid layer. No crypto, no custody.

**v2 — real x402 micropayments (needs the CDP key above):**
- A tool-broker: agent calls an x402-priced external tool → 402 + price → we pay via x402-fetch
  + the CDP facilitator (Server Wallet, testnet first) → debit the agent's credits (cost ×
  markup). Start with ONE x402 tool (e.g. a web-scrape) on testnet, verify the credit debit,
  then mainnet with a small funded wallet.

**v3 — A2A (later):** ERC-8004 agent identity + agents paying agents via x402 (one agent hires
another). Future R&D; the same credit/x402 rail enables it.
