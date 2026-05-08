# Phase 16 — x402 Protocol Implementation (Design)

**Status:** Design draft
**Author:** AIAG core
**Date:** 2026-05-08 (refined)
**Phase dir:** `.planning/phases/16-x402-protocol-design/`
**Wireframes:** `C:\Users\боб\brain\Projects\AIAG\Wireframes\p16-x402\`

---

## Changes 2026-05-08 (post-research)

Сводка после technical research (см. `docs/research/2026-05-08-x402-actuality.md`). Spec в целом актуален, но **3 critical-правки** уже применены ниже + остальные точечные дополнения:

### Critical (применено)
- **§1.1 References:** repo переехал в `github.com/x402-foundation/x402` (Coinbase fork — теперь dev). Обновлены canonical URLs, добавлены whitepaper + docs ссылки.
- **§10 Roadmap:** self-hosted facilitator передвинут из 16.3 → 16.1. Причина — 20-й пакет санкций ЕС (апрель 2026), Coinbase Europe не должен обслуживать РФ. Полагаться на CDP-rail = single point of failure. Self-host обязательная мера, не опциональная.
- **§3 / §10 TON:** explicit disclaimer — никто из facilitators (Coinbase, PayAI, Cloudflare, OpenZeppelin, Utexo) TON не поддерживает на май 2026. Phase 16.3 — реально greenfield, мы пишем спеку самостоятельно. После ship — предложить TON-extension в Foundation.

### Уточнения (применено в местах)
- **§1.1 Network IDs:** v2 рекомендует CAIP-2 (`eip155:8453` для Base, `solana:5eykt4...` для Solana). SDK принимают и старый формат, но `accepts[]` должен указывать CAIP-2 как primary.
- **§1.1 Wallet sessions (CAIP-122 / SIWx):** v2 ввёл новый pattern — kандидат для Phase 16.4 как альтернатива credit-mode для high-QPS агентов.

### Открытые вопросы (TODO в §12)
- **Facilitator-status РФ:** если self-hostим, AIAG потенциально подпадает под 161-ФЗ/259-ФЗ как «оператор иностранной электронной валюты». Нужна правовая экспертиза ДО запуска 16.1.
- **Stripe MPP coexistence:** запущен март 2026, OpenAI/ChatGPT-агенты идут через него (не x402). Поддерживаем ли вторым рельсом — Phase 16.5 candidate. См. §10.
- **Circle blacklist:** Circle (US-based) может flag нашу payTo address. Mitigation: rotation, multi-address sweeper. См. §9.

### Метрики экосистемы (для контекста)
- v2 launched 11 Dec 2025, non-breaking.
- Май 2026: 69k активных агентов / 165M tx / $50M cumulative volume.
- Главный конкурент: **Stripe MPP** (март 2026); OpenAI пошла в ACP+MPP, не x402.
- USDT-on-EVM теперь через Utexo facilitator (50ms settle, добавлено в Phase 16.2).

---

## Changes 2026-05-08 (refinement pass)

**Scope clarification — x402 is Mini-App + external only (NOT web human users):**

- ✅ **EXPOSED:**
  - Mini-App (TG): агенты внутри Mini-App могут использовать x402 для autonomous topup через TON
  - External agents: AI agents (Claude tool, GPT-4o-tools, LangChain agents) discover and pay our gateway via x402 from outside our app
- ❌ **NOT EXPOSED:**
  - Web app (`ai-aggregator.ru/dashboard`): traditional `Authorization: Bearer aiag_*` only, no x402
  - Web admin: no x402 controls in `/admin` (admin observability for x402 transactions remains visible at `/admin/x402-*` pages — read-only for compliance audit)

**Эффективно:** x402 — это *протокол поверхности* mini-app's agent runtime + external agents who choose to pay via it. **NOT** a payment method for human users on web.

Other refinements:
- Added § 2.5 "x402 inside Mini-App agents" — describes embedded TON wallet, agent budget integration, and Russian KYC threshold for x402 wallets ≥ 100k₽/mo equivalent.
- Wireframes recolored под dark/amber web палитру (см. Phase 15 §2.4).
- Wireframe 01 — header note added clarifying x402 не для web human users.
- Wireframe 04 — добавлен таб «Из Mini-App агентов» со ссылкой на Phase 15.
- Wireframe 05 — tooltip note that агент-инициатор может быть external или Mini-App.

## 0. TL;DR

x402 is an HTTP-native micropayments protocol revived from the long-dormant
**HTTP 402 Payment Required** status code. It lets a server demand a stablecoin
micropayment as a precondition to serving a resource, and it lets a client
(human, but more importantly an **autonomous AI agent**) settle that payment
inline, on-chain, without accounts, sessions, OAuth or API keys.

This phase designs the integration of x402 into the AIAG gateway so that:

- ChatGPT plugins, Claude tool-use agents, LangChain / CrewAI / autogen agents
  and arbitrary M2M clients can hit our OpenAI-compatible endpoints with
  **no human signup**, paying per request in USDC on Base / Solana, or
  USDT-TON.
- We accumulate an auditable on-chain trail of agent traffic.
- We support both **per-request settlement** (1 tx per call, simplest) and
  **bulk pre-pay credits** (off-chain debit against a deposited balance, fast).
- We preserve compatibility with our existing fiat (₽) billing pipeline:
  every x402 payment is converted to ₽ at the daily CBR rate and lands in the
  same `usage_events` ledger that powers ИП reporting.

### 0.1 Where x402 is exposed

| Surface | x402? | Auth/payment used | Notes |
|---------|-------|-------------------|-------|
| **Web (`ai-aggregator.ru/dashboard`)** | ❌ | `Authorization: Bearer aiag_*` | Юзеры платят картой (Tinkoff/YooKassa/СБП). x402 не виден в UI вообще. |
| **Web admin (`/admin`)** | observability only | — | Нет x402 controls для human users. Read-only view of x402 transactions for compliance audit (`/admin/x402-*` страницы). |
| **TG Mini App (агенты)** | ✅ | Embedded TON wallet (custodial, key derived from owner user_id) + опциональный tool `x402_pay` | Агенты внутри Mini-App используют x402 для autonomous topup через TON и оплаты внешних ресурсов |
| **Gateway (`api.ai-aggregator.ru`)** | ✅ | `PAYMENT-SIGNATURE` header (per-request) или credit-mode | Открыто для внешних AI-агентов (Claude tool, GPT-tools, LangChain, CrewAI). Эти flows originates **вне нашего UI** — мы для них endpoint, который умеет принимать x402 |

**Mental model:** x402 — это протокол поверхности **агентного слоя**. Web users не знают, что он существует. End-users mini-app узнают про него только если включают `x402_pay` tool в своём агенте. Главный потребитель — анонимные autonomous agents в open web.

We ship in three sub-phases:

| Sub-phase | Scope                                       | ETA   |
|-----------|---------------------------------------------|-------|
| 16.1      | Base USDC, exact scheme, per-request only   | 4 wk  |
| 16.2      | + Solana USDC, + bulk pre-pay credits       | +3 wk |
| 16.3      | + TON USDT-TON, + facilitator self-host     | +4 wk |

---

## 1. x402 protocol primer

### 1.1 References

- Landing: https://www.x402.org/
- **Whitepaper:** https://www.x402.org/x402-whitepaper.pdf
- **Canonical docs:** https://docs.x402.org
- **Reference impl + SDKs (canonical):** https://github.com/x402-foundation/x402 (репо переехало в Foundation сентября 2025; `coinbase/x402` теперь dev-fork — НЕ источник truth)
- v2 launch announcement (Dec 2025): https://www.x402.org/writing/x402-v2-launch
- Network & token support matrix: https://docs.x402.org/core-concepts/network-and-token-support
- Coinbase CDP docs (один из facilitators): https://docs.cdp.coinbase.com/x402/welcome
- `exact` scheme (EVM): `x402-foundation/x402/specs/schemes/exact/scheme_exact_evm.md`
- EIP-3009 (`transferWithAuthorization`): the gasless USDC primitive that
  makes x402 cheap on EVM.

The protocol is now governed by the **x402 Foundation** (founders: Coinbase, Cloudflare; members: Vercel, Visa, AWS, Circle, Anthropic, Google) with Coinbase as the reference implementer; the spec is at **v2 (launched 11 Dec 2025, non-breaking)** with `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` headers (the older `X-PAYMENT` / `X-PAYMENT-RESPONSE` aliases are still accepted by most facilitators for backward compat — we MUST honour both on ingress).

**Network IDs:** v2 рекомендует **CAIP-2** (`eip155:8453` для Base, `solana:5eykt4...` для Solana mainnet) вместо ad-hoc строк (`base`, `solana-mainnet`). Старые строки SDK всё ещё принимают, но в `accepts[]` указывайте CAIP-2 как primary, ad-hoc — fallback для legacy clients.

**Wallet sessions (CAIP-122 / SIWx):** v2 ввёл альтернативу per-request signing — wallet может один раз подписать session, дальше HTTP-запросы аутентифицируются session-key без on-chain checks. Для high-QPS агентов это альтернатива нашему `credit` mode. Кандидат для Phase 16.4.

### 1.2 Roles

```
+--------+   1. GET /resource          +--------+
| Client |  ------------------------>  | Server |
| (agent)|  <------------------------  |        |
+--------+   2. 402 + PaymentRequired  +--------+
    |                                       ^
    | 3. sign EIP-3009 / SPL transfer       | 5./8. /verify, /settle
    v                                       v
[wallet]                              +--------------+
    |                                 | Facilitator  |
    | 4. POST + PAYMENT-SIGNATURE     | (Coinbase or |
    +-------------------------------->| self-hosted) |
                                      +--------------+
                                             |
                                             | 9. broadcast tx
                                             v
                                       [Base / Solana / TON]
```

The **facilitator** is a stateless service that knows how to (a) verify the
signed authorisation against a chain RPC and (b) submit / settle the transfer.
We can (i) use Coinbase's hosted facilitator, (ii) self-host the open-source
one from `coinbase/x402`, or (iii) for TON, write our own thin shim because TON
has no canonical x402 facilitator yet.

### 1.3 Headers (v2)

| Header              | Direction | Encoding         | Body                        |
|---------------------|-----------|------------------|-----------------------------|
| `PAYMENT-REQUIRED`  | S → C     | base64(JSON)     | `PaymentRequired`           |
| `PAYMENT-SIGNATURE` | C → S     | base64(JSON)     | `PaymentPayload`            |
| `PAYMENT-RESPONSE`  | S → C     | base64(JSON)     | `SettleResponse`            |

Legacy aliases we accept on ingress (case-insensitive):
`X-Accept-Payment`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`.

### 1.4 `PaymentRequired` shape (server → client on 402)

```jsonc
{
  "x402Version": 2,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "1000",          // 0.001 USDC, 6 decimals
      "resource": "https://api.aiag.ru/v1/chat/completions",
      "description": "OpenAI-compatible chat completion (gpt-4o-mini)",
      "mimeType": "application/json",
      "payTo": "0xAIAG0000000000000000000000000000000000",
      "maxTimeoutSeconds": 60,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
      "outputSchema": null,
      "extra": {
        "name": "USD Coin",
        "version": "2"
      }
    },
    {
      "scheme": "exact",
      "network": "solana-mainnet",
      "maxAmountRequired": "1000",
      "resource": "https://api.aiag.ru/v1/chat/completions",
      "payTo": "AIAGsoLAna1111111111111111111111111111111",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "maxTimeoutSeconds": 60
    }
  ]
}
```

### 1.5 `PaymentPayload` shape (client → server on retry)

For the EVM `exact` scheme the payload wraps an EIP-3009
`transferWithAuthorization` signature:

```jsonc
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "base",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from":        "0xAGENT...",
      "to":          "0xAIAG...",
      "value":       "1000",
      "validAfter":  "1746700000",
      "validBefore": "1746700060",
      "nonce":       "0x9f...3e"
    }
  }
}
```

For Solana, `payload` carries a base58 partial-signed `VersionedTransaction`
that performs an SPL `Transfer` from the agent's ATA to ours. For TON, we
carry a signed external message + a `query_id` we generated in step 2.

### 1.6 `SettleResponse` shape (server → client on 200)

```jsonc
{
  "success": true,
  "transaction": "0xabc...def",       // tx hash
  "network": "base",
  "payer": "0xAGENT...",
  "x402Version": 2
}
```

This is base64-JSON-encoded and returned in the `PAYMENT-RESPONSE` header so
the agent can optionally cross-check on-chain.

---

## 2. Architecture

### 2.1 End-to-end flow

```
Step 1.  Agent → GET /v1/chat/completions
         (no Authorization, no PAYMENT-SIGNATURE)

Step 2.  AIAG gateway → 402 Payment Required
         PAYMENT-REQUIRED: <base64 PaymentRequired>
         body: { "x402Version": 2, "error": "...", "accepts": [...] }

Step 3.  Agent's wallet (Coinbase CDP / Privy / viem / web3.js / ton-core)
         picks the cheapest accepted entry, signs an EIP-3009 / SPL / TON
         authorisation for `maxAmountRequired`.

Step 4.  Agent → POST /v1/chat/completions
         PAYMENT-SIGNATURE: <base64 PaymentPayload>
         Authorization: (none — x402 replaces it)
         body: { OpenAI-compatible request }

Step 5a. Gateway middleware extracts and decodes PAYMENT-SIGNATURE.
Step 5b. Middleware → facilitator /verify   (sub-second)
         — checks signature, nonce uniqueness, value >= price, chain RPC
         confirms balance + EIP-3009 not yet consumed.

Step 6.  If /verify fails → respond 402 with new PaymentRequired
         (error="invalid_payment", reason=...).

Step 7.  Gateway *executes the LLM call* concurrently with /settle to keep
         end-to-end latency low. We hold the response body in a buffer until
         settlement confirms (one Base block, ≈ 2 s).

Step 8.  /settle → facilitator submits the tx, awaits 1 confirmation.
         On success: { success: true, transaction: "0x..." }.

Step 9.  Gateway returns 200 OK with:
         PAYMENT-RESPONSE: <base64 SettleResponse>
         X-Request-Id: <uuid>
         body: { OpenAI-compatible response }

         Failure modes:
         - settle fails after we already streamed bytes → log as "best
           effort", reconcile in cron, never charge user (it was already
           served, treat as a cost of doing business; rare on Base).
         - settle fails *before* we stream → return 402 + refundable hold
           released by EIP-3009 expiring.
```

For **bulk pre-pay credits** (sub-phase 16.2) the flow is shorter:

```
Step 1.  Agent → POST /v1/chat/completions
         PAYMENT-SIGNATURE: <base64 PaymentPayload kind="credit">
         payload.credit.pubkey: 0xAGENT...
         payload.credit.signature: ECDSA(message="aiag-credit-debit-{nonce}")
Step 2.  Gateway atomically `UPDATE x402_pubkey_credits
                              SET balance_usd = balance_usd - $price
                              WHERE pubkey = $pubkey AND balance_usd >= $price
                              RETURNING balance_usd`
Step 3.  If no row → 402 Insufficient Credit (with topup instructions).
Step 4.  Else → process LLM call → 200.
```

The deposit itself is a normal x402 settlement on a special
`/x402/topup` endpoint: agent pays, say, $10, we credit their pubkey, and the
on-chain tx is the receipt.

### 2.2 Where it lives in our stack

```
apps/gateway (Node/Hono or Next.js Edge)
└── middleware/x402.ts          ← NEW (sub-phase 16.1)
└── lib/x402-facilitator.ts     ← NEW (HTTP client to Coinbase or self-hosted)
└── lib/x402-pricing.ts         ← NEW (resource_id → USD price table)
└── lib/x402-credits.ts         ← NEW (16.2)
└── lib/cbr-rate.ts             ← reuse (₽/USD daily fetch)

packages/db
└── migrations/
    └── 20260512_x402_payments.sql        ← NEW
    └── 20260519_x402_pubkey_credits.sql  ← NEW (16.2)
    └── 20260519_usage_events_x402_fk.sql ← NEW

apps/admin (React)
└── routes/x402/settings.tsx   ← see wireframe 01
└── routes/x402/transactions.tsx ← wireframe 02
└── routes/x402/credits.tsx    ← wireframe 03

apps/docs (Next.js MDX)
└── content/x402-quickstart.mdx ← wireframe 04
```

Critically: **no change to the LLM-routing core**. x402 is a sibling of
`Authorization: Bearer sk-...` at the auth layer; once auth resolves to a
billable principal (either a `user_id` for fiat or a `pubkey` for x402), the
downstream pipeline is identical.

### 2.5 x402 inside Mini-App agents

When user creates an agent in Mini-App with `x402_pay` tool enabled:

- Agent has its own **embedded TON wallet** (custodial, key derived deterministically from owner `user_id` via HKDF — see Phase 15 §3 wallet derivation).
- Agent receives micropayments via x402 when external systems call its endpoint.
- Agent makes outbound x402 payments when it needs autonomous services (другой LLM, external API, etc).
- All x402 settle goes through the credit ladder:

  ```
  user.payg_credits  →  agent.budget  →  x402 outbound
                                          (or owner credit on inbound)
  ```

- Inbound x402 payments to an agent's endpoint are accumulated as `agent.income_ton` and converted to `user.payg_credits` on owner's balance after daily reconciliation (CBR rate at settle time).

**Compliance:**

- Agents created by Russian residents → KYC required for x402 wallet at ≥ **100k₽/mo equivalent** turnover (per 115-ФЗ identification thresholds for ЦФА). KYC flow uses Госуслуги / Tinkoff ID — same as Phase 15 §6.
- Daily limit per agent: `agent.daily_budget_rub` still applies — x402 outbound spend counts against it.
- Withdrawal: owner can withdraw agent's income to TON Connect-paired personal wallet via signed message, минус 0.5% gas fee (как §4.2).
- All x402 events (inbound + outbound + reconcile) logged to `audit_log` with `actor='agent:<agent_id>'` for ИП reporting.

This is the only path by which our **own users** participate in x402 — and only via the Mini-App's agent abstraction, never as direct human-on-web flow.

---

## 3. Network selection matrix

| Network             | Asset          | Confirm  | Median fee | Reason to support                | Verdict   |
|---------------------|----------------|----------|------------|----------------------------------|-----------|
| **Base** (L2)       | USDC (EIP-3009)| ~2 s     | ~$0.0001   | Coinbase-backed, lowest fee, broad agent SDK support, gasless via 3009 | **16.1**  |
| **Solana**          | USDC (SPL)     | ~400 ms  | ~$0.00025  | Fastest finality, big agent ecosystem (web3.js, Phantom), Coinbase x402 SDK has SVM support | **16.2**  |
| **TON**             | USDT-TON (jetton)| ~5 s    | ~$0.005    | Native fit for TG Mini App audience (phase 15); Russian-market crypto users skew TON | **16.3**  |
| Polygon PoS         | USDC           | ~2 s     | ~$0.001    | Crowded, no x402 advantage over Base | skip      |
| Arbitrum One        | USDC           | ~1 s     | ~$0.0003   | Good but Coinbase-CDP coverage weaker | skip v1 |
| Optimism            | USDC           | ~2 s     | ~$0.0002   | Similar to Base but smaller agent share | skip v1 |
| Stellar             | USDC           | ~5 s     | ~$0.00001  | Coinbase x402 SDK has it, but ~0 agents in 2026 | skip      |
| **Ethereum mainnet**| USDC           | ~12 s    | $1–$30     | Fees > price of request → economically nonsense | **NEVER** |
| Bitcoin / Lightning | sat            | varies   | varies     | No x402 spec; out of scope            | skip      |

Selection rule encoded in `lib/x402-pricing.ts`: server emits `accepts[]` in
descending order of "cheapest for the agent"; agent picks first by spec.

---

## 4. Pricing strategy

### 4.1 Per-request micropayments

Floor: **$0.0005** per call (anything below is dominated by gas + facilitator
overhead). Markup: **same 7–15%** band as fiat (rate card in
`lib/pricing.ts` is the source of truth — x402 path just reads `usd_price` and
multiplies by the `agent_markup` const, defaulting to 1.10).

| Resource (model)            | Wholesale  | x402 list  | Note                       |
|-----------------------------|------------|------------|----------------------------|
| `gpt-4o-mini` 1k tok        | $0.00015   | $0.0005    | floored                    |
| `gpt-4o`     1k tok         | $0.005     | $0.0058    | 16% markup (cap)           |
| `claude-3-5-haiku` 1k tok   | $0.0008    | $0.00092   | 15%                        |
| `claude-3-7-sonnet` 1k tok  | $0.003     | $0.00345   | 15%                        |
| `gemini-2.5-flash` 1k tok   | $0.0003    | $0.0005    | floored                    |
| `flux-pro-1.1` per image    | $0.04      | $0.046     | 15%                        |
| `kling-1.6` 5 s video       | $0.35      | $0.40      | 14%                        |
| `voice-elevenlabs` per sec  | $0.0003    | $0.0005    | floored                    |

Token-billed models charge a deposit equal to `max_tokens * unit_price` and
issue a partial **refund credit** to the agent's pubkey when actual usage is
lower. The refund accumulates and can be drawn by a future call (handled by
the same `x402_pubkey_credits` table).

### 4.2 Bulk pre-pay credits (sub-phase 16.2)

For agents that hammer the API hundreds of times per minute, paying on-chain
each time is wasteful. They can deposit, e.g., **$10 → balance** and then
sign cheap EdDSA messages to debit per call. Deposit lifecycle:

1. Agent calls `POST /x402/topup` with `PAYMENT-SIGNATURE` for $10.
2. Gateway settles, then `INSERT INTO x402_pubkey_credits ON CONFLICT (pubkey)
   DO UPDATE SET balance_usd = balance_usd + 10`.
3. Each subsequent request uses the credit-mode payload (see §2.1).
4. Withdrawal: agent signs `withdraw_request` → we send remaining balance back
   to their pubkey, minus a 0.5% withdraw fee (covers our gas).

Idle balances are **not interest-bearing** and are non-custodial in the
accounting sense — we mirror them in `x402_pubkey_credits` and reconcile
nightly against the on-chain ledger for the deposit address.

### 4.3 Comparison

| Mode             | Per-call latency | On-chain tx/call | Min commit | Best for                |
|------------------|------------------|------------------|------------|-------------------------|
| Per-request      | +2 s (Base)      | 1                | $0.0005    | infrequent agents, demos|
| Pre-pay credits  | +5 ms            | 0                | $5         | high-QPS production     |

---

## 5. Schema additions

```sql
-- 20260512_x402_payments.sql
CREATE TABLE x402_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash         text NOT NULL,
  network         text NOT NULL,        -- 'base'|'solana-mainnet'|'ton'
  asset           text NOT NULL,        -- contract / mint / jetton master
  amount_raw      numeric NOT NULL,     -- in smallest unit
  amount_usd      numeric(18,6) NOT NULL,
  amount_rub      numeric(18,4) NOT NULL,    -- snapshot at CBR daily rate
  cbr_rate_used   numeric(10,4) NOT NULL,
  agent_pubkey    text NOT NULL,
  resource_id     text NOT NULL,        -- e.g. 'chat-completions:gpt-4o'
  status          text NOT NULL,        -- 'pending'|'verified'|'settled'|'failed'|'refunded'
  facilitator     text NOT NULL,        -- 'coinbase'|'self'|'ton-shim'
  scheme          text NOT NULL DEFAULT 'exact',
  raw_payload     jsonb NOT NULL,       -- the b64-decoded PaymentPayload
  raw_settle      jsonb,                -- SettleResponse
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  settled_at      timestamptz,
  failed_reason   text,
  UNIQUE (network, tx_hash)
);
CREATE INDEX x402_payments_pubkey_idx     ON x402_payments (agent_pubkey, created_at DESC);
CREATE INDEX x402_payments_status_idx     ON x402_payments (status)
  WHERE status IN ('pending','verified');
CREATE INDEX x402_payments_resource_idx   ON x402_payments (resource_id, created_at DESC);

-- 20260519_x402_pubkey_credits.sql
CREATE TABLE x402_pubkey_credits (
  pubkey            text PRIMARY KEY,
  network           text NOT NULL,           -- the chain we'll refund on
  balance_usd       numeric(18,6) NOT NULL DEFAULT 0,
  lifetime_topup_usd numeric(18,6) NOT NULL DEFAULT 0,
  lifetime_spend_usd numeric(18,6) NOT NULL DEFAULT 0,
  last_topup_at     timestamptz,
  last_spend_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (balance_usd >= 0)
);

-- 20260519_usage_events_x402_fk.sql
ALTER TABLE usage_events
  ADD COLUMN x402_payment_id uuid REFERENCES x402_payments(id),
  ADD COLUMN agent_pubkey    text;
CREATE INDEX usage_events_x402_idx ON usage_events (x402_payment_id);
```

Atomic credit debit (rule from project CLAUDE.md — `UPDATE WHERE + RETURNING`):

```sql
UPDATE x402_pubkey_credits
   SET balance_usd       = balance_usd - $1,
       lifetime_spend_usd = lifetime_spend_usd + $1,
       last_spend_at     = now()
 WHERE pubkey      = $2
   AND balance_usd >= $1
RETURNING balance_usd;
```

If the row count is 0, return 402 — never trust an application-level check.

---

## 6. Gateway middleware design (TS pseudocode)

```ts
// apps/gateway/middleware/x402.ts
import { Hono } from 'hono';
import { verifyPayment, settlePayment } from '@/lib/x402-facilitator';
import { priceForResource }              from '@/lib/x402-pricing';
import { debitCredit, lookupCredit }     from '@/lib/x402-credits';
import { recordPayment }                 from '@/lib/x402-payments-repo';
import { rubFromUsd }                    from '@/lib/cbr-rate';

const ACCEPTED_NETWORKS = ['base', 'solana-mainnet', 'ton'] as const;

export async function x402Middleware(c, next) {
  // Bypass: traditional API-key auth wins if present
  if (c.req.header('authorization')) return next();

  const sig = c.req.header('payment-signature') ?? c.req.header('x-payment');
  const resourceId = resolveResourceId(c);            // route → 'chat-completions:gpt-4o'
  const priceUsd   = await priceForResource(resourceId, c.req); // may peek body for tokens

  if (!sig) {
    return c.json(buildPaymentRequired(resourceId, priceUsd), 402, {
      'PAYMENT-REQUIRED': base64(buildPaymentRequired(resourceId, priceUsd)),
    });
  }

  const payload = decodeB64Json(sig);
  if (payload.x402Version !== 2) return reject(c, 'unsupported_version');

  // ── credit-mode short circuit ──
  if (payload.scheme === 'credit') {
    const ok = await debitCredit(payload.payload.pubkey, priceUsd, payload.payload.signature);
    if (!ok) return reject(c, 'insufficient_credit');
    c.set('x402_principal', { pubkey: payload.payload.pubkey, mode: 'credit' });
    return next();
  }

  // ── per-request settle ──
  const verify = await verifyPayment(payload, { resourceId, priceUsd });
  if (!verify.isValid) return reject(c, verify.invalidReason);

  // Speculative execute + settle in parallel
  const settlePromise = settlePayment(payload).then(s => recordPayment({
    payload, settle: s, priceUsd, priceRub: rubFromUsd(priceUsd),
    resourceId, status: s.success ? 'settled' : 'failed',
  }));

  c.set('x402_principal', { pubkey: payload.payload.authorization.from, mode: 'per_request' });
  c.set('x402_settle_promise', settlePromise);

  await next();

  // After handler: ensure settle resolved before flushing response headers
  const settle = await c.get('x402_settle_promise');
  if (settle.success) {
    c.header('PAYMENT-RESPONSE', base64(settle));
  }
}

function buildPaymentRequired(resourceId: string, priceUsd: number) {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    accepts: ACCEPTED_NETWORKS.map(n => acceptForNetwork(n, resourceId, priceUsd)),
  };
}
```

Key invariants:

- Idempotent: same `nonce` is rejected by chain itself (EIP-3009) and by us
  via `UNIQUE (network, tx_hash)`.
- Streaming responses: for SSE / chunked, we **cannot** retroactively 402.
  Settle-before-stream policy: hold the first byte until settle resolves
  (Base ≈ 2 s; for Solana ≈ 400 ms — acceptable). For Kling video etc.
  where the full job takes minutes, settle once up front and treat the job as
  paid for.
- Concurrency: a single agent issuing N parallel signed authorisations is
  fine — each has a distinct nonce. We just need DB-level uniqueness.

---

## 7. Wallet integration plans

### 7.1 Coinbase CDP server wallet (Base, primary)

Use `@coinbase/cdp-sdk` server-side **only on the agent side** (never on
ours — we are the recipient). For our `payTo` address we generate a single
Base wallet from a hot key stored in `aws-kms` / `yc-kms`, with an automated
sweeper to a cold multisig once balance crosses 200 USDC. Because EIP-3009
goes from agent → us directly, we don't need any signing key for *receiving*.

### 7.2 Solana web3.js (16.2)

Agents use `@solana/web3.js` + a wallet adapter (Phantom for humans,
solana-keypair files for headless agents). Our gateway uses `@solana/web3.js`
+ `@solana/spl-token` for `verify` (we re-simulate the transaction to confirm
it would succeed) and `sendAndConfirmTransaction` for `settle`. RPC: Helius
mainnet, with a fallback to Triton.

### 7.3 TON Connect (16.3)

For Mini-App-paired agents (the TG bridge from phase 15), the agent uses
TON Connect 2 with a connected Tonkeeper / Telegram Wallet. For headless
agents we expose a `/x402/ton-payload-builder` endpoint that returns an
unsigned BOC the agent signs with `ton-core`. Verification: index Toncenter
v3 for jetton transfer events to our `payTo` address.

---

## 8. Compliance & валютный контроль (РФ)

Принимая USDC напрямую от агентов на наш Base/Solana адрес, ИП-резидент РФ
осуществляет **валютную операцию** (получение цифрового финансового актива в
обмен на услугу). Юридический фрейм 2026 года (после поправок к 173-ФЗ):

| Объём операций / год | Что нужно                                                |
|----------------------|----------------------------------------------------------|
| < экв. 600 000 ₽     | Достаточно отчёта в книге доходов УСН + конвертация по ЦБ |
| 600 000 – 6 000 000 ₽| ВЭД-договор (оферта на сайте), регистрация в банке-агенте, ежеквартальные справки о валютных операциях (СПД) |
| > 6 000 000 ₽        | Постановка контракта на учёт; уникальный номер контракта (УНК); банковский паспорт сделки; декларирование |

Конкретные шаги для запуска:

1. **Оферта на английском** (потому что контрагент — autonomous agent, не
   физлицо) с пунктом про оплату «in USDC on Base, settled per HTTP 402». Пункт
   о применимом праве — российское, юрисдикция АС г. Москвы. Резерв пункта о
   «электронной подписи через крипто-подпись адреса» (ст. 6 63-ФЗ).
2. **Банк-агент** — Тинькофф или Альфа открывают счёт ИП с возможностью приёма
   крипты через лицензированного провайдера (Bitbanker / на 2026 — несколько
   доступных). Альтернатива: оф-чейн settle через **Bybit OTC / OKX P2P** с
   автоматической конвертацией в ₽ при превышении порога.
3. **6 % УСН** считается от рублёвого эквивалента **на дату поступления** по
   курсу ЦБ. Поэтому в `x402_payments.amount_rub` мы фиксируем курс **дня
   settle, не дня verify**.
4. **Санкционный whitelist**: на старте принимаем платежи **только от
   адресов, чья история не помечена** как OFAC SDN / Tornado Cash / Lazarus
   на Chainalysis Free Sanctions Oracle (есть бесплатный on-chain oracle).
   Реализация — `lib/sanctions-screen.ts`, вызов перед `/verify`.

> **TODO для bookkeeper consultation** (consolidated):
>  - Уточнить, считается ли USDC ЦФА или иностранной валютой по разъяснениям
>    Минфина 2026 г. От этого зависит, попадаем ли в режим ст. 14 173-ФЗ.
>  - Согласовать с банком-агентом схему конвертации (через провайдера vs.
>    OTC) и режим хранения остатков (горячий кошелёк vs. сразу в ₽).
>  - Подтвердить порядок выставления чеков ККТ: онлайн-чек должен формироваться
>    в момент settle (фискальный документ — `usage_events.x402_payment_id`).
>  - Удержание НДС: услуги в адрес иностранного клиента (агент ≠ резидент РФ)
>    → НДС 0 % при наличии подтверждающих документов (но какие документы для
>    on-chain payer? — нужен ответ).

---

## 9. Risks & mitigations

| Risk                                          | Likelihood | Impact | Mitigation                                                 |
|-----------------------------------------------|------------|--------|------------------------------------------------------------|
| Base RPC outage during settle                 | M          | M      | 3-RPC fallback (Coinbase, Alchemy, QuickNode); on full failure → mark `pending`, refund via cron when chain returns |
| Stablecoin de-peg (USDC < $0.99)              | L          | H      | Daily peg check; auto-pause new x402 if peg < 0.97; require ₽-equivalent re-quote |
| Agent griefs by signing then never POSTing    | M          | L      | EIP-3009 has `validBefore` — funds aren't moved by signature alone; no cost to us |
| Replay attack (same nonce reused)             | L          | M      | Chain rejects (EIP-3009 nonce-bitmap); we additionally enforce DB UNIQUE |
| Sanctioned wallet pays us                     | L          | H      | Pre-verify against Chainalysis oracle; auto-quarantine + freeze + reverse |
| Markup arbitrage (agent farms $0.0001 calls)  | M          | L      | `min_billable = $0.0005`; per-pubkey rate limit |
| Russian regulator forbids crypto-for-services overnight | L | H | Architectural: `x402_enabled=false` flag stops new calls in <1 s; existing balances refundable on-chain |
| Facilitator (Coinbase) takes us down          | L          | H      | Self-host fork from `coinbase/x402` from day 1, dual-write |
| TON jetton scam tokens spoof USDT-TON         | M          | M      | Hard-code jetton master address; reject anything else      |
| Reorgs eat a settled tx                       | VL         | M      | Wait 1 confirmation on Base (deep enough; reorgs > 1 are extinct since 2024) |
| Cost: hosting facilitator + RPC bills         | H          | L      | Estimate $200/mo break-even at 5 USD/day x402 revenue      |

---

## 10. Roadmap

> **Reorder 2026-05-08 (post-research):** self-hosted facilitator передвинут из 16.3 → 16.1. Причина — 20-й пакет санкций ЕС (апрель 2026) запрещает EU-providers (включая Coinbase Europe) обслуживать РФ-зарегистрированных entities. Полагаться на Coinbase CDP с РФ-адреса = single point of failure. Строим self-host с самого начала; Coinbase facilitator используем только как fallback в Phase 16.1 (если successfully прошёл due-diligence) либо вообще не используем.

```
Phase 16.1 — Base USDC + Self-hosted facilitator    ▰▰▰▰▰▰▰▰▰▱  5 wk
   ├── DB migrations
   ├── Self-host fork from x402-foundation/x402 (день 1)
   ├── x402 middleware (verify/settle via own facilitator)
   ├── pricing.ts wiring
   ├── admin UI: settings + transactions
   ├── docs: quickstart + agent code samples
   ├── compliance: оферта EN, sanctions oracle (TRM Labs upgrade vs Chainalysis Free)
   └── legal: предварительная экспертиза статуса AIAG как facilitator (161-ФЗ/259-ФЗ)

Phase 16.2 — Solana + Bulk pre-pay credits + USDT   ▰▰▰▰▰▱▱▱▱▱  +3 wk
   ├── Solana facilitator integration (Coinbase SVM SDK или PayAI)
   ├── x402_pubkey_credits table + atomic debit
   ├── topup endpoint + admin UI for credits balances
   ├── Withdraw endpoint (signed message)
   └── USDT-on-EVM via Utexo facilitator (50ms settle)

Phase 16.3 — TON USDT-TON (greenfield)              ▰▰▰▱▱▱▱▱▱▱  +5 wk
   ├── ⚠️ TON НЕ поддерживается ни одним существующим facilitator — пишем спеку сами
   ├── TON jetton verify (Toncenter v3 indexing)
   ├── TON Connect 2 integration with TG Mini App (phase 15 bridge)
   ├── Sweeper / cold-storage automation
   └── (после 16.3 ship) предложить TON-extension в x402-foundation, чтобы не остаться единственными

Phase 16.4 (deferred) — Streaming subscriptions     ▱▱▱▱▱▱▱▱▱▱
   x402 'upto' / 'deferred' scheme variants для token-billed streaming;
   per-second billing for video gen. Кандидат: SIWx wallet sessions (CAIP-122)
   для high-QPS агентов вместо credit-mode.

Phase 16.5 (evaluate) — Stripe MPP coexistence      ▱▱▱▱▱▱▱▱▱▱
   Stripe Merchant Payments Protocol (март 2026) — конкурент x402,
   принят OpenAI/ChatGPT-агентами. Решение «поддерживаем оба рельса»
   политически выгодно, но требует Stripe Tempo интеграцию из РФ.
```

---

## 11. Agent integration examples

> The samples below assume sub-phase 16.1 is live (Base + per-request).

### 11.1 Python + httpx (per-request)

```python
import os, httpx, json, base64
from cdp import CdpClient                 # @coinbase/cdp-sdk Python port
from eth_account.messages import encode_typed_data

API     = "https://api.aiag.ru"
RESOURCE = "/v1/chat/completions"

cdp     = CdpClient(api_key=os.environ["CDP_API_KEY"])
wallet  = cdp.wallets.create_or_load("agent-main", network="base-mainnet")

def x402_post(path, body):
    r = httpx.post(API + path, json=body)
    if r.status_code != 402:
        return r

    pr   = json.loads(base64.b64decode(r.headers["PAYMENT-REQUIRED"]))
    pick = next(a for a in pr["accepts"] if a["network"] == "base")

    # Sign EIP-3009 transferWithAuthorization
    auth = wallet.sign_eip3009(
        token   = pick["asset"],
        to      = pick["payTo"],
        value   = int(pick["maxAmountRequired"]),
        valid_for_seconds = pick["maxTimeoutSeconds"],
    )

    payload = {
        "x402Version": 2,
        "scheme": "exact",
        "network": "base",
        "payload": { "signature": auth.signature, "authorization": auth.fields },
    }

    return httpx.post(API + path,
        json    = body,
        headers = { "PAYMENT-SIGNATURE": base64.b64encode(json.dumps(payload).encode()).decode() },
        timeout = 30.0,
    )

resp = x402_post(RESOURCE, {
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Привет!"}],
})
print(resp.json())
```

### 11.2 TypeScript + viem (bulk pre-pay)

```ts
import { createWalletClient, http, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount }                  from 'viem/accounts';
import { signEip3009 }                          from 'x402-viem';

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const wallet  = createWalletClient({ account, chain: base, transport: http() });

const API = 'https://api.aiag.ru';

// Step 1: top up $10
async function topup(amountUsd: number) {
  const pre  = await fetch(`${API}/x402/topup?amount=${amountUsd}`);
  const pr   = JSON.parse(atob(pre.headers.get('PAYMENT-REQUIRED')!));
  const pick = pr.accepts.find((a: any) => a.network === 'base');

  const sig  = await signEip3009(wallet, {
    token: pick.asset, to: pick.payTo,
    value: parseUnits(amountUsd.toString(), 6),
    validForSeconds: 60,
  });

  const r = await fetch(`${API}/x402/topup`, {
    method: 'POST',
    headers: { 'PAYMENT-SIGNATURE': btoa(JSON.stringify({
      x402Version: 2, scheme: 'exact', network: 'base',
      payload: { signature: sig.signature, authorization: sig.authorization },
    })) },
  });
  console.log('topup:', await r.json()); // { balance_usd: 10.0 }
}

// Step 2: spend with cheap signed-message credit-mode
async function chat(prompt: string) {
  const nonce = crypto.randomUUID();
  const msg   = `aiag-credit-debit-${nonce}`;
  const sig   = await account.signMessage({ message: msg });

  const r = await fetch(`${API}/v1/chat/completions`, {
    method:  'POST',
    headers: {
      'content-type'      : 'application/json',
      'PAYMENT-SIGNATURE' : btoa(JSON.stringify({
        x402Version: 2, scheme: 'credit', network: 'base',
        payload: { pubkey: account.address, signature: sig, nonce },
      })),
    },
    body: JSON.stringify({ model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }] }),
  });
  return r.json();
}

await topup(10);
console.log(await chat('Что такое x402?'));
```

### 11.3 LangChain custom Tool

```python
from langchain.tools import Tool
from typing import Any
import json

def make_aiag_tool(model: str = "gpt-4o-mini") -> Tool:
    def _call(prompt: str) -> str:
        # x402_post helper from §11.1
        r = x402_post("/v1/chat/completions",
                      {"model": model,
                       "messages": [{"role": "user", "content": prompt}]})
        if r.status_code != 200:
            raise RuntimeError(f"AIAG error: {r.status_code} {r.text}")
        return r.json()["choices"][0]["message"]["content"]

    return Tool(
        name        = f"aiag_{model.replace('-', '_')}",
        description = (
            f"Call the AIAG-routed {model} model. Pays per request in USDC on "
            f"Base via x402 — no API key needed, but the agent's wallet must "
            f"hold ~$0.001 per call."
        ),
        func        = _call,
    )

# Usage in an agent:
from langchain.agents import initialize_agent, AgentType
from langchain_openai import ChatOpenAI            # only the *outer* planner uses keys

planner = ChatOpenAI(model="gpt-4o", temperature=0)
tools   = [make_aiag_tool("gpt-4o-mini"),
           make_aiag_tool("claude-3-5-haiku")]
agent   = initialize_agent(tools, planner,
            agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION)
agent.run("Resume this paper in Russian using gpt-4o-mini, then translate "
          "to English using claude-3-5-haiku.")
```

---

## 12. Open questions / explicit non-goals

- **Refunds for failed LLM calls:** if the upstream provider returns 5xx
  *after* we've settled, do we refund? Proposal: yes, automatically credit
  the agent's pubkey via `x402_pubkey_credits`. *Decision: confirm in 16.1
  kickoff.*
- **Privacy:** every x402 payment links a wallet to a model usage pattern.
  We publish only `tx_hash + amount + network` in the admin UI; we do *not*
  expose `resource_id` or completion text on-chain. The agent's wallet
  pseudonymity is its own responsibility.
- **No Lightning Network in v1.** Hard requirement: stablecoin only. BTC
  volatility breaks the per-request pricing math.
- **No fiat-on-chain bridges in v1.** Agents are expected to arrive
  pre-funded.

---

## 13. Wireframes

Stored at `C:\Users\боб\brain\Projects\AIAG\Wireframes\p16-x402\`:

| File                                  | Purpose                                                |
|---------------------------------------|--------------------------------------------------------|
| `01-admin-x402-settings.html`         | Admin: enable/disable x402, network toggles, markup %  |
| `02-admin-x402-transactions.html`     | Admin: list of x402 payments, on-chain explorer links  |
| `03-admin-x402-pubkey-credits.html`   | Admin: agents' pre-pay balances, topup / spend history |
| `04-docs-x402-quickstart.html`        | Public docs: code examples for agents                  |
| `05-agent-flow-diagram.html`          | Interactive 5-step illustration of the request flow    |
| `06-x402-pricing-table.html`          | Public per-model $-pricing table for agents            |

---

## 14. Acceptance for Phase 16.1

- [ ] Migrations applied to staging.
- [ ] `POST /v1/chat/completions` with no auth + no payment returns 402 with
      a valid base64 `PaymentRequired` and at least one `accepts[]` for `base`.
- [ ] Round-trip: `x402-fetch` reference client (from `coinbase/x402`)
      successfully pays $0.001 USDC on Base Sepolia → receives a 200 OK +
      `PAYMENT-RESPONSE` with a real tx hash.
- [ ] `x402_payments` row written with `status='settled'`, `amount_rub`
      filled at the day's CBR rate.
- [ ] Admin UI lists the payment within 5 s of settle.
- [ ] Sanctions oracle blocks a known-bad address (testnet smoke test).
- [ ] Agent SDK example (Python httpx version) runs end-to-end against
      production with a $0.10 cap.
