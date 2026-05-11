# Phase 15 / Wave 05 — TON Connect: wallet linking + top-up TON→₽ + web fallback

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Реализовать привязку TON-кошелька через `ton-proof`, top-up flow TON→₽ (с conversion по CoinGecko/TonAPI), polling подтверждения транзакции через toncenter, fallback CTA «Оплатить картой» → web checkout.

**Architecture:** UI `/profile/wallet` использует `useTonConnectUI()` и `TonConnectButton`. Backend проверяет `ton-proof` payload (подпись wallet'а), сохраняет в `ton_wallets`. Top-up: client запрашивает invoice → backend генерит unique comment (`AIAG-INV-<uuid>`) и rate-lock на 5 min → wallet шлёт TX → backend полит toncenter `getTransactions` → match по comment → `settle_charge` (см. spec §4.1 mermaid).

**Tech stack:** `@tonconnect/ui-react`, `@ton/core` (для парсинга proof), HTTP toncenter API, существующий `packages/billing.settle_charge`.

**Prereq:** Waves 01, 02 (auth работает).

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `packages/database/migrations/0017_ton_wallets.sql` | ton_wallets + payments cols |
| Create | `packages/database/src/schema/ton-wallets.ts` | Drizzle schema |
| Create | `apps/tg-miniapp/src/lib/ton-proof.ts` | verify ton-proof signature |
| Create | `apps/tg-miniapp/src/lib/ton-rate.ts` | TON/RUB rate fetcher (5-min cache) |
| Create | `apps/tg-miniapp/src/lib/toncenter.ts` | toncenter HTTP client |
| Create | `apps/tg-miniapp/app/api/tma/ton/proof-payload/route.ts` | GET nonce payload |
| Create | `apps/tg-miniapp/app/api/tma/ton/link-wallet/route.ts` | POST verify + save |
| Create | `apps/tg-miniapp/app/api/tma/ton/create-invoice/route.ts` | POST → invoice |
| Create | `apps/tg-miniapp/app/api/tma/ton/verify-tx/route.ts` | POST → poll & settle |
| Create | `apps/tg-miniapp/app/(app)/profile/wallet/page.tsx` | Wallet linking UI |
| Create | `apps/tg-miniapp/app/(app)/profile/balance/page.tsx` | Topup screen with fallback |

---

## Task 1: Migration

- [ ] **Step 1: `0017_ton_wallets.sql`** — копировать DDL из spec §7 (`ton_wallets` + `ALTER payments ADD ton_tx_hash, ton_invoice_uuid + UNIQUE INDEX`).
- [ ] **Step 2:** Drizzle schema.

---

## Task 2: TON proof payload + verify

- [ ] **Step 1:** `/api/tma/ton/proof-payload` — генерит `payload = randomHex(32)`, сохраняет в Redis `tonproof:<uid> -> payload` TTL 5 min, возвращает `{ tonProof: payload }`. Client передаёт в `tonConnectUI.setConnectRequestParameters({ state: 'ready', value: { tonProof: payload } })`.
- [ ] **Step 2:** `src/lib/ton-proof.ts` — проверка по [TON Connect proof spec](https://docs.ton.org/develop/dapps/ton-connect/sign): hash domain + timestamp + payload + state_init → verify Ed25519 через `@ton/crypto`.
- [ ] **Step 3:** `/api/tma/ton/link-wallet` body `{ address, network, proof }` → resolve payload → verify → INSERT `ton_wallets` (UNIQUE on user_id+address).

---

## Task 3: Rate + toncenter clients

- [ ] **Step 1: `src/lib/ton-rate.ts`**

```ts
let cache: { ts: number; rub: number } | null = null;
export async function tonToRub(): Promise<number> {
  if (cache && Date.now() - cache.ts < 5*60*1000) return cache.rub;
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub');
  const j = await r.json();
  const rub = j['the-open-network'].rub as number;
  cache = { ts: Date.now(), rub };
  return rub;
}
```

- [ ] **Step 2: `toncenter.ts`** — `getTransactions(address, limit=20)` через `https://toncenter.com/api/v2/getTransactions`, header `X-API-Key: $TONCENTER_API_KEY`. Fallback на tonapi.io при 5xx.

---

## Task 4: Create invoice + verify-tx

- [ ] **Step 1: `/create-invoice`** body `{ amountRub }` → calc `amountTon = amountRub / rate`, gen `invoiceUuid`, comment `AIAG-INV-${uuid.slice(0,8)}`, INSERT `payments (method='ton', status='pending', ton_invoice_uuid, amount_rub)` → return `{ to: $RECEIVER_ADDRESS, amountNano, comment, invoiceId, expiresAt }`.
- [ ] **Step 2: Client** через `tonConnectUI.sendTransaction({ validUntil, messages:[{ address, amount: amountNano, payload: <encoded comment cell> }] })` → возвращает `boc` → POST `/verify-tx { invoiceId, boc }`.
- [ ] **Step 3: `/verify-tx`** — loop max 10 min (poll 5s): `getTransactions($RECEIVER_ADDRESS)` → match incoming TX where `in_msg.message == comment AND value >= amountNano*0.99 AND now-utime < 600`. При match → `UPDATE payments SET status='completed', ton_tx_hash=?` + `settle_charge(uid, amount_rub, 'ton', payment_id)` → return `{ balance_new }`. Timeout → `status='pending_review'` + Telegram alert.

---

## Task 5: UI screens

- [ ] **Step 1: `/profile/wallet/page.tsx`**

```tsx
'use client';
import { TonConnectButton, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react';
import { useEffect, useState } from 'react';

export default function WalletPage() {
  const wallet = useTonWallet();
  const [tonUI] = useTonConnectUI();
  const [linked, setLinked] = useState<string[]>([]);

  useEffect(() => {
    if (!wallet?.connectItems?.tonProof || !('proof' in wallet.connectItems.tonProof)) return;
    fetch('/tg/api/tma/ton/link-wallet', { method:'POST',
      headers:{ Authorization:`Bearer ${localStorage.getItem('aiag_jwt')}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        address: wallet.account.address, network: wallet.account.chain,
        proof: wallet.connectItems.tonProof.proof,
      }),
    }).then(r => r.json()).then(d => setLinked(prev => [...prev, d.address]));
  }, [wallet]);

  return <div><h1>Привязанный кошелёк</h1><TonConnectButton /></div>;
}
```

- [ ] **Step 2: `/profile/balance/page.tsx`** — input ₽, кнопка «Оплатить TON» → invoice → `sendTransaction` → poll `/verify-tx`. Под ней secondary CTA «Оплатить картой» → `window.Telegram.WebApp.openLink('https://ai-aggregator.ru/dashboard/billing?ref=tma')`.

Verification (testnet vs mainnet — pin `network='-239'` для mainnet, reject `-3` testnet в prod):

```bash
# 1. Подключить Tonkeeper testnet
# 2. На staging — рутить через tonapi testnet
# 3. Отправить 0.01 TON с comment AIAG-INV-xxx
# 4. Проверить payments.status='completed'
```

---

## Commit

```bash
git add packages/database apps/tg-miniapp
git commit -m "feat(tma): TON Connect wallet linking + TON→RUB topup with toncenter polling + web fallback"
```

## Done when

- Подключение Tonkeeper → wallet появляется в `ton_wallets`.
- Top-up 100₽ на staging завершается `settle_charge` и баланс растёт.
- Timeout (>10 min) переводит `payments.status='pending_review'` и шлёт alert через `packages/telegram-alerts`.
- Кнопка «Оплатить картой» открывает внешний URL.
