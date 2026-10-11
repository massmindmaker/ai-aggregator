# Agent Rail API — headless registration, TON topup, /v1 and /mcp

The agent rail is a **headless** onboarding path for AI agents: an agent with
nothing but a TON wallet registers itself, receives a gateway API key, tops up
its organization balance in Gram or USDT, sets its own routing policy, and then
uses the standard OpenAI-compatible inference surface — no browser, no human
UI, no email. Money is dual-rail: the ₽ subscription world of the web app stays
untouched; agent topups go through TON invoices (native Gram on testnet, USDT
jetton on a pinned mainnet master).

This guide documents the **actual implemented contract** (plan
2026-10-09 agentic-rail, Tasks 1–11). The source of truth for every shape below
lives in `packages/api-gateway/src/routes/v1/` and `packages/api-gateway/src/mcp/`;
when in doubt, trust the code.

- Base URL: `https://<gateway-host>` (env placeholder `$AIAG_BASE` below)
- Auth: `Authorization: Bearer $AIAG_KEY` on everything except
  `/v1/agent/challenge` and `/v1/agent/register`, which are public by design —
  the TON wallet proof **is** the authentication.
- Error envelope everywhere:
  ```json
  { "error": { "code": "SOME_CODE", "message": "human-readable" } }
  ```
  (`details` may be present; internals/SQL text are never echoed.)

## Contents

1. [Overview](#1-overview)
2. [Registration (wallet proof → first key)](#2-registration)
3. [Topup (TON invoice → credits)](#3-topup)
4. [Chat / inference (`/v1/chat/completions`)](#4-chat--inference)
5. [Keys (list / rotate / revoke / principal revoke / s2s mint)](#5-keys)
6. [Policy (routing + optional quotas)](#6-policy)
7. [MCP facade (`POST /mcp`)](#7-mcp-facade)
8. [Testnet contour and what is enabled](#8-testnet-contour-and-what-is-enabled)
9. [Endpoint summary](#9-endpoint-summary)

---

## 1. Overview

A registered agent is a normal gateway **organization** whose owner is the
service user (not a human account). The organization authenticates with
`sk_aiag_live_*` gateway keys and is billed from the same credit balance as
everyone else. What the rail adds on top:

```
TON wallet ──proof──▶ /v1/agent/register ──▶ org + first key sk_aiag_live_…
                                            │
                            /v1/agent/topup │ (gram | usdt invoice, paid from the wallet)
                                            ▼
                            org credit balance ──▶ /v1/chat/completions, /mcp, …
```

Key properties (each pinned by code, see the referenced files):

- **One wallet = one org = one bootstrap.** Re-registering the same wallet is a
  `409 AGENT_ALREADY_REGISTERED` (`routes/v1/agent-register.ts`).
- **The plaintext key exists exactly once**, in the register / rotate / mint
  response. Only its SHA-256 hash and a 20-char prefix are stored. No endpoint
  can return it again — a lost key is rotated or replaced, never looked up.
- **Money never flows through the API process**: topup creates an invoice; the
  wallet pays on-chain; reconciliation settles the invoice and credits the org.
- **Limits are voluntary.** An agent that never sets a quota is unlimited
  (`routes/v1/agent-policy.ts`).

## 2. Registration

Three steps: get a challenge, sign it with the wallet, exchange the proof for
org + key. The proof is the standard **Ton Connect `ton-proof-item-v2`**
signature; the canonical server-side reference for the exact accepted format is
[`packages/shared/src/ton-wallet-proof.ts`](../../packages/shared/src/ton-wallet-proof.ts).
Only workchain-0 raw addresses (`0:<64 hex>`), only network `-3` (testnet), and
only standard wallet contracts `v4r2` / `v5r1` (pinned by StateInit code hash)
are accepted.

### 2.1 `POST /v1/agent/challenge` (public)

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/challenge" \
  -H 'content-type: application/json' \
  -d '{"address":"0:a1b2...c3d4","network":"-3"}'
```

Response (challenge is single-use and lives **120 seconds**):

```json
{
  "challengeId": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
  "payload": "aiag:agent:register:-3:<64 hex chars>",
  "expiresIn": 120
}
```

- `address` — raw workchain-0 form `0:[0-9a-f]{64}`.
- The challenge payload must be signed against the **gateway host** you called
  (`domain` below = the host part of the URL, e.g. `api.example.com`).

Rate limits (Redis sliding windows, fail closed): 60 requests/min globally,
6 requests / 5 min per address → `429 RATE_LIMITED` with `Retry-After`.

### 2.2 Building the proof

The `proof` blob posted to `/register` is the Ton Connect proof item (shape:
`TonWalletProofInput` in `ton-wallet-proof.ts`):

| Field | Type / constraint |
|---|---|
| `address` | `0:[0-9a-f]{64}` — must equal the StateInit cell hash |
| `network` | literal `"-3"` |
| `publicKey` | 64 hex chars (Ed25519 public key) |
| `walletStateInit` | base64 BoC of the wallet's **initial** StateInit (≤12 KB, bounded cell DAG) |
| `proof.timestamp` | whole seconds since epoch, string or number (within challenge window) |
| `proof.domain.lengthBytes` | `Buffer.byteLength(domain, 'utf8')`, 1..300 |
| `proof.domain.value` | the gateway host you called — must match the challenge |
| `proof.payload` | the `payload` string from the challenge, byte-identical |
| `proof.signature` | base64, exactly 64 bytes |

Signing recipe (Ed25519, exactly what `verifyTonWalletProof` verifies —
reproduce with your wallet SDK / `@ton/crypto`; do not hand-roll if you can
avoid it):

```text
message = "ton-proof-item-v2"
        || int32_be(0)                      # workchain
        || hex_to_bytes(address[2:])        # 32 bytes of the account hash
        || uint32_le(domain.lengthBytes)
        || utf8(domain)
        || uint64_le(timestamp)
        || utf8(payload)

digest   = sha256( 0xFF 0xFF || "ton-connect" || sha256(message) )
signature = ed25519_sign(private_key, digest)   # 64 bytes → base64
```

Notes: `walletStateInit` must be the **clean initial state** (no plugins, no
deployed data) whose cell hash equals the address; `v5r1` wallets additionally
set the first data bit to `1`. Timestamp is checked against the challenge
issue/expiry window (issued + 120 s).

### 2.3 `POST /v1/agent/register` (public)

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/register" \
  -H 'content-type: application/json' \
  -d '{
    "challengeId": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
    "address": "0:a1b2...c3d4",
    "proof": {
      "address": "0:a1b2...c3d4",
      "network": "-3",
      "publicKey": "<64 hex>",
      "walletStateInit": "<base64 boc>",
      "proof": {
        "timestamp": "1760000000",
        "domain": { "lengthBytes": 15, "value": "api.example.com" },
        "payload": "aiag:agent:register:-3:<64 hex>",
        "signature": "<base64, 64 bytes>"
      }
    }
  }'
```

Response `201` — **the key is shown exactly once, persist it before anything
else**:

```json
{
  "principal_id": "…uuid…",
  "org_id": "…uuid…",
  "key": "sk_aiag_live_<22 base64url chars>",
  "key_prefix": "sk_aiag_live_XXXXX…"
}
```

The bootstrap key is minted as `agent-primary`: `rpm_limit 60`,
`batch_rpm_limit 10`, policies `{"kind":"agent","s2s_key_minting":true}`,
**no expiry**. The `kind: "agent"` marker is what makes the gateway attach the
machine-readable topup hint to 402 responses (§4).

Error codes: `409 AGENT_ALREADY_REGISTERED`, `400` (invalid proof/request —
`AGENT_PROOF_INVALID`, `AGENT_CHALLENGE_INVALID`, …), `410
AGENT_CHALLENGE_EXPIRED`, `429 AGENT_CHALLENGE_RATE_LIMIT`, `503
AGENT_AUTH_UNAVAILABLE`. Same sliding-window guards as the challenge.

## 3. Topup

`POST /v1/agent/topup` mints a TON invoice for **whole credits** (1 credit =
1000 microcredits = the unit `GET /v1/balance` reports). The minimum grant is
**100 credits**. The asset is either `gram` (native TON, testnet `tvm:-3`) or
`usdt` (jetton, pinned master, oracle-free peg **1 USDT = 100 credits**).

### 3.1 `POST /v1/agent/topup` (auth)

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/topup" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -d '{"asset":"gram","credits":"250","idempotencyKey":"topup-2026-10-11-001"}'
```

Body (strict):

| Field | Constraint |
|---|---|
| `asset` | `"gram"` \| `"usdt"` |
| `credits` | canonical decimal **string** of whole credits, `≥ "100"` (no fractions, no leading zeros) |
| `idempotencyKey` | `[A-Za-z0-9_-]{1,96}`, client-minted, one per logical topup |

Idempotency is **org-scoped**: replaying the same body (any sibling key of the
same org) returns the same invoice; a *different* body under a used key is
`409 TON_IDEMPOTENCY_CONFLICT`. Rate: 12 requests / 5 min per key.

Response `201`:

```json
{
  "invoiceId": "0d0f…uuid…",
  "network": "tvm:-3",
  "asset": { "network": "tvm:-3", "kind": "native", "decimals": 9 },
  "recipient": "0:<deposit wallet>",
  "amountAtomic": "125000000000",
  "reference": "aiag-ton:0d0f…uuid…",
  "grantMicrocredits": "250000",
  "expiresAt": "2026-10-11T12:34:56.789Z",
  "transferHint": { "mode": "native-comment" }
}
```

For `usdt` the asset is
`{"network":"tvm:-1","kind":"jetton","masterAddress":"0:b113a994…","decimals":6}`
and `transferHint` is:

```json
{
  "mode": "jetton-forward-payload",
  "masterAddress": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  "minForwardAtomic": "50000000"
}
```

`grantMicrocredits` is `credits × 1000`; `amountAtomic` is the on-chain amount
(gram: policy FX; usdt: exactly `grantMicrocredits × 10` by the peg). Pay
**before `expiresAt`** — the quote expires.

### 3.2 How to pay

Source: `transferHint` in `routes/v1/agent-topup.ts`; names are 1:1 with the
invoice JSON.

**gram** (`mode: "native-comment"`): a plain wallet transfer of
`amountAtomic` nanoTON to `recipient` with the invoice **`reference` string in
the comment**:

```bash
# toncli / ton console equivalent:
ton transfer 0:<deposit-wallet> 0.125 --comment "aiag-ton:0d0f…uuid…"
```

**usdt** (`mode: "jetton-forward-payload"`): a standard **jetton transfer
(TEP-74)** of `amountAtomic` minimal jetton units to `recipient` through the
jetton master `transferHint.masterAddress` (the invoice `asset.masterAddress`
is the same pinned master), with:

- `forward_payload` = the invoice `reference` **as text** — this is how the
  deposit watcher attributes the payment;
- `forward_ton_amount` **≥ `transferHint.minForwardAtomic`** (`50000000`
  nanoTON = 0.05 TON) so the receiving side can afford to parse the payload.

Send **from the wallet that registered** is not required (the reference
attributes the payment); sending the exact `amountAtomic` with the exact
reference text is.

### 3.3 `GET /v1/agent/invoices/:id` (auth)

```bash
curl -sS "$AIAG_BASE/v1/agent/invoices/0d0f…uuid…" \
  -H "authorization: Bearer $AIAG_KEY"
```

Response (while pending):

```json
{ "invoiceId": "0d0f…uuid…", "status": "pending", "grantMicrocredits": "250000" }
```

After settlement (`settledAt` appears only then):

```json
{
  "invoiceId": "0d0f…uuid…",
  "status": "settled",
  "grantMicrocredits": "250000",
  "settledAt": "2026-10-11T12:35:40.123Z"
}
```

Statuses: `pending → observed → confirmed → settled`; terminal alternatives
`expired`, `review_required`. Settlement is asynchronous — poll (the 402 hint's
`Retry-After` of 30 s is a reasonable cadence), or check
`GET /v1/balance`.

Topup error codes: `400` (invalid request / `AGENT_GRANT_TOO_SMALL` /
`TON_BALANCE_COMPATIBILITY_LIMIT`), `403 AGENT_NOT_AUTHORIZED`,
`404 AGENT_TOPUP_NOT_FOUND`, `409 TON_IDEMPOTENCY_CONFLICT` /
`TON_REFUND_BLOCKED`, `503` (`TON_ASSET_NOT_ALLOWLISTED`, `TON_CHECKOUT_FX_STALE`,
`TON_QUOTE_EXPIRED`, `AGENT_TOPUP_UNAVAILABLE`).

## 4. Chat / inference

The rail uses the ordinary gateway surface — OpenAI-compatible
`POST /v1/chat/completions` with `Authorization: Bearer $AIAG_KEY`:

```bash
curl -sS -X POST "$AIAG_BASE/v1/chat/completions" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "<slug from /v1/models>",
    "messages": [{"role":"user","content":"Say hi"}]
  }'
```

Optional extras: `"stream": true` (SSE), `"aiag_mode": "fastest"|"cheapest"|"balanced"|"ru-only"|"auto"`
(per-request routing override), header `x-aiag-session-id` (per-session budget),
header `x-upstream-key` (BYOK passthrough, billed a fixed credit fee).

Agent-relevant behaviours:

- **402 with a machine-readable topup hint.** When the org balance is
  insufficient, agent keys (`policies.kind = "agent"`) get:

  ```json
  {
    "error": {
      "code": "PAYMENT_REQUIRED",
      "message": "Insufficient funds",
      "topup": {
        "default_asset": "gram",
        "endpoint": "POST /v1/agent/topup",
        "min_credits": 100,
        "assets": ["gram", "usdt"]
      }
    }
  }
  ```

  plus a `Retry-After: 30` header (a freshly topped-up balance settles
  asynchronously). Human keys get the legacy body without `topup`. An agent
  should branch on `error.code === "PAYMENT_REQUIRED"`, run the topup flow of
  §3, then retry.

- **Expired key → `401` with `error.code: "KEY_EXPIRED"`.** Expiry is evaluated
  per request; an expired bearer must not be retried — mint/rotate a key
  instead (§5). The bootstrap `agent-primary` has no expiry.
- **Unsupported execution contract → 501.** `tools`, `tool_choice`,
  `functions`, `function_call`, `parallel_tool_calls`, `modalities`, `audio`,
  `input_audio` are **explicitly rejected** (`UNSUPPORTED_EXECUTION_CONTRACT`)
  before any provider is called — they are never silently dropped. Drive tool
  loops client-side.
- Billing telemetry headers on every response: `x-aiag-charged-usd-micro`,
  `x-aiag-upstream-cost-usd-micro`; `X-AIAG-Mode-Applied` echoes the routing
  mode used.

Companion reads (auth): `GET /v1/balance`
(`{subscription_credits, payg_credits, total_credits, …}`), `GET /v1/models`
(enabled catalog slugs), `GET /v1/catalog` (paginated catalog with invocation
contracts).

## 5. Keys

All key endpoints authorize by the **calling key** — org id never comes from
the request. The full lifecycle (`routes/v1/agent-keys.ts`):

### 5.1 `GET /v1/agent/keys`

```bash
curl -sS "$AIAG_BASE/v1/agent/keys" -H "authorization: Bearer $AIAG_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "…uuid…",
      "name": "agent-primary",
      "key_prefix": "sk_aiag_live_XXXXX",
      "expires_at": null,
      "created_at": "2026-10-11T10:00:00.000000Z",
      "last_used_at": "2026-10-11T11:00:00.000000Z",
      "revoked_at": null
    }
  ]
}
```

No plaintext, no hashes — ids, names, prefixes and ISO-8601 UTC timestamps
only. `expires_at` is nullable: `null` = the key never expires. (The TTL column
exists and is enforced — an expiring key starts answering `401 KEY_EXPIRED` at
its `expires_at` — but the bootstrap key and s2s-minted keys described below
are created without one.)

### 5.2 `POST /v1/agent/keys/:id/rotate` — atomic credential replacement

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/keys/<key uuid>/rotate" \
  -H "authorization: Bearer $AIAG_KEY" -H 'content-type: application/json' -d '{}'
```

```json
{ "id": "…uuid…", "key": "sk_aiag_live_<new>", "key_prefix": "sk_aiag_live_YYYYY" }
```

The new plaintext is returned **exactly once**; the old one is dead from this
response onward (single guarded `UPDATE … RETURNING`, no overlap window).
**Self-rotate is allowed and final** — if you rotate the very key you are
calling with, persist the response immediately: the next request with the old
bearer is a `401`. Rotation does not change `expires_at`. Foreign/dead ids →
`404` (indistinguishable from nonexistent).

### 5.3 `POST /v1/agent/keys/:id/revoke`

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/keys/<key uuid>/revoke" \
  -H "authorization: Bearer $AIAG_KEY" -H 'content-type: application/json' -d '{}'
```

```json
{ "id": "…uuid…", "revoked_at": "2026-10-11T12:00:00.000000Z" }
```

Self-revoke is allowed (this response is the last thing the bearer can do).
Idempotent-dead / foreign ids → `404`.

### 5.4 `POST /v1/agent/revoke` — kill the principal and every org key

```bash
curl -sS -X POST "$AIAG_BASE/v1/agent/revoke" \
  -H "authorization: Bearer $AIAG_KEY" -H 'content-type: application/json' \
  -d '{"confirm":true}'
```

Body: `{}` or `{"confirm":true}`. Response:

```json
{ "principal_id": "…uuid…", "revoked_at": "2026-10-11T12:00:00.000000Z", "keys_revoked": 2 }
```

Revokes the agent principal **and every live key of the org** in one
transaction — after this response the bearer itself is dead, and the wallet is
freed for a fresh `POST /v1/agent/register` (this closes the lock-out of a
compromised rail). Authentication is possession of any live key of the org; no
new wallet proof is required. Idempotent: an already-revoked principal returns
`200` with the stored fact. Errors: `403 AGENT_NOT_AUTHORIZED` (not an agent
org), `409 AGENT_PRINCIPAL_STATE_CONFLICT`, `503 AGENT_REVOKE_UNAVAILABLE`.

### 5.5 Minting sibling keys — `POST /v1/organization/keys` (s2s)

The bootstrap key carries `s2s_key_minting: true`, so an agent can mint
additional keys for **its own org** through the standard organization endpoint
(`routes/v1/organization-keys.ts`):

```bash
curl -sS -X POST "$AIAG_BASE/v1/organization/keys" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "worker-1",
    "model_whitelist": [],
    "cost_limit_monthly_rub": null,
    "ru_residency_only": false,
    "rpm_limit": 60,
    "batch_rpm_limit": 10
  }'
```

Response `201`: `{object:"gateway_api_key", id, name, key (shown once),
key_prefix, model_whitelist, cost_limit_monthly_rub, ru_residency_only,
rpm_limit, batch_rpm_limit, created_at}`. Every minted key is subordinate: its
whitelist/cap/rpm/residency cannot exceed the issuer's envelope. A key without
`s2s_key_minting` gets `403`. (Note: `cost_limit_monthly_rub` is measured in
**credits** since billing v2; it maps to the `monthly_credits` quota of §6.)

## 6. Policy

`GET/PUT /v1/agent/policy` (`routes/v1/agent-policy.ts`) is agent self-service
for routing and **optional** quotas. Founder decision: limits are opt-in — an
agent that never sets them is unlimited, and this endpoint never imposes a
default cap.

### 6.1 `GET /v1/agent/policy` (auth)

```bash
curl -sS "$AIAG_BASE/v1/agent/policy" -H "authorization: Bearer $AIAG_KEY"
```

```json
{
  "policies": { "default_mode": "auto" },
  "model_whitelist": [],
  "quotas": {
    "session_micro": null,
    "monthly_credits": null,
    "daily_org_usd_micro": null
  }
}
```

`quotas` values are decimal strings or `null` (no limit). Non-routing policy
flags (`kind`, `s2s_key_minting`) are never echoed.

### 6.2 `PUT /v1/agent/policy` (auth, PATCH semantics)

Every field is optional, but an empty body is a `400`. Per field: **absent —
unchanged; `null` — cleared; value — set.**

| Field | Type | Meaning |
|---|---|---|
| `default_mode` | `"auto"\|"fastest"\|"cheapest"\|"balanced"\|"ru-only"` | default routing mode for the key |
| `allowed_providers` | string[] (≤64) or null | allowlist of provider slugs |
| `blocked_providers` | string[] (≤64) or null | denylist of provider slugs |
| `forbid_non_ru` | boolean or null | route only to RU-resident providers |
| `allow_pii_transborder` | boolean or null | allow PII to leave RU jurisdiction |
| `model_whitelist` | string[] (≤200 slugs) or null | restrict the key to these model slugs (null → empty) |
| `session_micro_limit` | int ≤ 2^53-1 or null | per-session spend cap in microcredits (pair with `x-aiag-session-id`) |
| `monthly_credits_limit` | int ≤ 99 999 999 or null | monthly spend cap in whole credits |
| `daily_org_usd_micro_limit` | int ≤ 2^53-1 or null | org-wide daily upstream cost cap in USD-micro |

```bash
curl -sS -X PUT "$AIAG_BASE/v1/agent/policy" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -d '{"default_mode":"cheapest","monthly_credits_limit":5000}'
```

Response: the full state of §6.1 after the merge. A self-cap may be raised or
removed freely at any time. Rate: 30 requests/min per key. Errors: `403
AGENT_NOT_AUTHORIZED`, `400 AGENT_QUOTA_OUT_OF_RANGE` (generic 400 envelope),
`503 AGENT_POLICY_UNAVAILABLE`.

## 7. MCP facade

`POST /mcp` is a **Streamable HTTP, stateless** MCP server endpoint inside the
gateway (`mcp/server.ts`): every POST is self-contained (initialize /
tools/list / tools/call), answers are plain JSON-RPC over HTTP (no SSE), no
session id is issued. Auth is the same Bearer gateway key; `GET /mcp` is
`405`. Non-2xx route results surface inside the tool result
(`isError: true`, `structuredContent` = the gateway `{error:{code,message}}`
envelope 1:1) — auth failures never reach JSON-RPC at all (plain HTTP 401).

### 7.1 Initialize handshake

```bash
curl -sS -X POST "$AIAG_BASE/mcp" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "1.0.0" }
    }
  }'
```

Result: `serverInfo = {name: "aiag-gateway", version: "0.4.0"}` and a
supported `protocolVersion`. Because the transport is stateless, you do not
need to keep a session; send `notifications/initialized` if your client does,
then call methods directly.

### 7.2 The nine tools (`tools/list`)

Pinned by `mcp/tools.ts` (`AIAG_TOOL_NAMES`):

| Tool | Maps to | Input (essentials) |
|---|---|---|
| `aiag_list_models` | `GET /v1/models` | — |
| `aiag_get_balance` | `GET /v1/balance` | — |
| `aiag_create_topup_invoice` | `POST /v1/agent/topup` | `asset`, `credits` (string), `idempotencyKey` |
| `aiag_get_invoice_status` | `GET /v1/agent/invoices/:id` | `invoiceId` |
| `aiag_set_routing_policy` | `PUT /v1/agent/policy` | the patch fields of §6.2 |
| `aiag_list_keys` | `GET /v1/agent/keys` | — |
| `aiag_rotate_key` | `POST /v1/agent/keys/:id/rotate` | `keyId` |
| `aiag_revoke_key` | `POST /v1/agent/keys/:id/revoke` | `keyId` |
| `aiag_chat_completion` | `POST /v1/chat/completions` (non-streaming) | `model`, `messages[]`, optional `max_tokens` |

One resource is advertised: **`aiag://catalog`** — a one-page public catalog
snapshot (models, availability, invocation contracts, retail pricing) for the
calling key, same data as `GET /v1/catalog` (limit 100), MIME
`application/json`.

Tool calls return `structuredContent` (the gateway JSON body) plus a text
mirror; on failure `isError: true` with the exact gateway error envelope in
`structuredContent` — branch on `error.code` exactly as you would over HTTP.

```bash
curl -sS -X POST "$AIAG_BASE/mcp" \
  -H "authorization: Bearer $AIAG_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": {
      "name": "aiag_get_balance",
      "arguments": {}
    }
  }'
```

**Streaming chat is deliberately not a tool** — use `POST /v1/chat/completions`
with `"stream": true` directly (§4).

## 8. Testnet contour and what is enabled

Code-complete ≠ production-enabled. As of this writing:

- **Registration is testnet-only.** The challenge and proof accept only
  network `-3`; there is no mainnet registration path yet. Enabling mainnet is
  a separate owner decision (network allowlist + policy), not a client change.
- **gram invoices are testnet** (`tvm:-3`), exactly like the web storefront.
- **usdt is pinned to the TON mainnet USDT master**
  (`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, raw
  `0:b113a994…`, network `tvm:-1`) with a fixed peg of 1 USDT = 100 credits.
  Admission additionally runs through the `ton_asset_allowlist` table: the
  mainnet USDT row **is seeded by migration 0109**, so mainnet USDT invoices
  are admissible as soon as the rail is enabled. A **testnet** USDT master is
  NOT seeded — the operator confirms and seeds it (allowlist row + the
  `aiag.usdt_testnet_master` GUC) at testnet launch; until then testnet
  USDT answers `503 TON_ASSET_NOT_ALLOWLISTED`. Which USDT master is
  live (testnet or mainnet) is an operator-side setting, not a client choice.
- **Runtime settlement is not enabled in production.** On-chain payment
  observation and invoice settlement run only where the operator has enabled
  the TON runtime; a paid invoice may stay `pending` on a deployment without
  it. Production migrations 0104–0109 apply like any other migration.
- The **gram deposit wallet (`recipient`)** comes from the operator-managed
  `ton_checkout_policy` (admin setting with env fallback); if no policy is
  configured, topup answers `503` ("Topup pricing unavailable").

For local/agent development, treat everything above as the test contour: use a
testnet wallet, top up in gram, and expect usdt to be unavailable until the
operator turns it on.

## 9. Endpoint summary

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /v1/agent/challenge` | public | mint a 120 s registration challenge |
| `POST /v1/agent/register` | public | wallet proof → org + first `sk_aiag_live_*` key |
| `POST /v1/agent/topup` | Bearer | mint a gram/usdt credit invoice |
| `GET /v1/agent/invoices/:id` | Bearer | invoice status (`pending…settled`) |
| `GET /v1/agent/keys` | Bearer | org key inventory (no secrets) |
| `POST /v1/agent/keys/:id/rotate` | Bearer | atomic credential replacement |
| `POST /v1/agent/keys/:id/revoke` | Bearer | retire one key |
| `POST /v1/agent/revoke` | Bearer | revoke principal + all org keys |
| `GET /v1/agent/policy` | Bearer | routing policy + opt-in quotas |
| `PUT /v1/agent/policy` | Bearer | patch policy (absent=keep, null=clear) |
| `POST /v1/organization/keys` | Bearer (s2s) | mint a sibling key |
| `POST /v1/chat/completions` | Bearer | OpenAI-compatible chat (402 hint, KEY_EXPIRED) |
| `GET /v1/balance` · `GET /v1/models` · `GET /v1/catalog` | Bearer | balance / model catalog |
| `POST /mcp` | Bearer | stateless MCP Streamable HTTP facade (9 `aiag_*` tools + `aiag://catalog`) |

---

*Maintainer pointers: `packages/api-gateway/src/routes/v1/agent-{register,topup,keys,policy}.ts`,
`packages/api-gateway/src/mcp/{server,tools}.ts`,
`packages/shared/src/ton-wallet-proof.ts`,
`packages/database/src/agent-{auth,topup,policy}.ts`, migrations
`0104`–`0109` (`packages/database/migrations/`).*
