'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';
import { haptic } from '@/lib/haptics';
import { resolveJettonWallet } from '@/lib/jetton';

type Status =
  | 'idle'
  | 'creating'
  | 'awaiting_signature'
  | 'submitted'
  | 'polling'
  | 'confirmed'
  | 'error';

type Asset = 'TON' | 'USDT';

interface TonInitResp {
  topup_id: string;
  amount_credits: number;
  amount_nano_ton: string;
  rate_usd_cents_per_ton: number;
  comment: string;
  comment_tag: string;
  transaction: {
    validUntil: number;
    messages: { address: string; amount: string; payload: string }[];
  };
}

interface UsdtInitResp {
  topup_id: string;
  asset: 'USDT';
  amount_credits: number;
  amount_usdt: string; // "N.NN"
  jetton_units: string;
  jetton_master: string;
  jetton_decimals: number;
  receiver: string;
  comment: string;
  comment_tag: string;
  transaction: {
    validUntil: number;
    gas_nano_ton: string;
    payload: string;
  };
}

type InitResp = TonInitResp | UsdtInitResp;

function isUsdtInit(i: InitResp): i is UsdtInitResp {
  return (i as UsdtInitResp).asset === 'USDT';
}

// D-1: amounts are integer credits (US cents, 1 credit = $0.01).
// Presets = $2 / $5 / $10 / $20. MIN 100 cr ($1), MAX 50 000 cr ($500).
const PRESETS = [200, 500, 1000, 2000];
const MIN = 100;
const MAX = 50_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120; // 10 min

// Format integer cents as "N.NN" credits for display.
function fmtCredits(cents: number): string {
  return (cents / 100).toFixed(2);
}

function nanoToTon(nano: string): string {
  try {
    const n = BigInt(nano);
    const int = n / 1_000_000_000n;
    const frac = n % 1_000_000_000n;
    if (frac === 0n) return int.toString();
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    return `${int}.${fracStr.slice(0, 4)}`;
  } catch {
    return '?';
  }
}

export default function TopupPage() {
  const { token, loading: authLoading, error: authError } = useAuth();
  const userAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const [asset, setAsset] = useState<Asset>('TON');
  const [usdtAvailable, setUsdtAvailable] = useState(true);
  const [amount, setAmount] = useState<number>(500);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [init, setInit] = useState<InitResp | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const tonEquivalent = useMemo(
    () => (init && !isUsdtInit(init) ? nanoToTon(init.amount_nano_ton) : null),
    [init],
  );

  function selectAsset(next: Asset) {
    if (next === asset) return;
    if (next === 'USDT' && !usdtAvailable) return;
    haptic.select();
    setAsset(next);
    // Reset any in-flight invoice so instructions/state can't mismatch the asset.
    setInit(null);
    setStatus('idle');
    setErrorMsg(null);
    setCopied(null);
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      haptic.impact('light');
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    } catch {
      // clipboard blocked — no-op, the value is still visible on screen
    }
  }

  async function pollCheck(topupId: string) {
    if (!token) return;
    setStatus('polling');
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const r = await fetch(`/tg/api/tma/topup/check/${topupId}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        const j = await r.json().catch(() => ({}));
        if (j.status === 'confirmed') {
          setStatus('confirmed');
          haptic.notify('success');
          return;
        }
      } catch {
        // ignore transient errors and keep polling
      }
    }
    setStatus('error');
    setErrorMsg('Транзакция не подтверждена за 10 минут. Проверьте позже в истории.');
  }

  async function handlePay() {
    haptic.impact('medium');
    setErrorMsg(null);
    if (!token) {
      setErrorMsg('Откройте через @aiag_bot для авторизации.');
      return;
    }
    if (!userAddress) {
      setErrorMsg('Сначала подключите TON-кошелёк.');
      return;
    }
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX) {
      setErrorMsg(`Сумма должна быть от ${fmtCredits(MIN)} до ${fmtCredits(MAX)} кр`);
      return;
    }

    setStatus('creating');
    try {
      const r = await fetch('/tg/api/tma/topup/init', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          amount_credits: amount,
          wallet_address: userAddress,
          asset,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        // USDT not provisioned on the server — soft-degrade to TON, keep the screen alive.
        if (j.error === 'usdt_not_configured') {
          setUsdtAvailable(false);
          setAsset('TON');
          setStatus('idle');
          setErrorMsg('Пополнение в USDT скоро — пока доступен TON.');
          return;
        }
        setStatus('error');
        setErrorMsg(j.message || j.error || 'Не удалось создать инвойс');
        return;
      }

      const resp = j as InitResp;
      setInit(resp);
      setStatus('awaiting_signature');

      if (isUsdtInit(resp)) {
        // TEP-74 jetton transfer: the message must target the SENDER's OWN jetton
        // wallet (resolved from the master), carrying the server-built transfer body.
        let jettonWallet: string;
        try {
          jettonWallet = await resolveJettonWallet(resp.jetton_master, userAddress);
        } catch {
          setStatus('error');
          setErrorMsg('Не удалось определить USDT-кошелёк. Попробуйте ещё раз или выберите TON.');
          return;
        }
        await tonConnectUI.sendTransaction({
          validUntil: resp.transaction.validUntil,
          messages: [
            {
              address: jettonWallet,
              amount: resp.transaction.gas_nano_ton,
              payload: resp.transaction.payload,
            },
          ],
        });
      } else {
        await tonConnectUI.sendTransaction(resp.transaction);
      }

      setStatus('submitted');
      pollCheck(resp.topup_id);
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'tx_rejected';
      setErrorMsg(/UserReject/i.test(msg) ? 'Транзакция отменена.' : msg);
    }
  }

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header" aria-hidden>
          <div className="aiag-skeleton tma-skel-block tma-skel-block--title" />
          <div className="aiag-skeleton tma-skel-block tma-skel-block--wide" />
        </header>
        <section className="tma-skel-card" aria-hidden>
          <div className="aiag-skeleton tma-skel-block tma-skel-block--mid" />
          <div className="aiag-skeleton tma-skel-block tma-skel-block--wide" />
        </section>
        <section className="tma-skel-card" aria-hidden>
          <div className="aiag-skeleton tma-skel-block tma-skel-block--btn" />
        </section>
        <BottomNav />
      </main>
    );
  }
  if (authError) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card">
          <p className="tma-card-text">Откройте через @aiag_bot.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  const usdtInit = init && isUsdtInit(init) ? init : null;
  // #5: сумма в допустимом диапазоне? (пусто/NaN/вне границ → CTA отключаем).
  const amountValid = Number.isFinite(amount) && amount >= MIN && amount <= MAX;

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <Link href="/wallet" className="tma-card-text">
            ← К кошельку
          </Link>
          <h1 className="tma-title">Пополнение баланса</h1>
          <p className="tma-subtitle">
            {asset === 'USDT'
              ? 'USDT-on-TON · 1 USDT = 100 кр. Зачислим после подтверждения сети (1–3 мин).'
              : 'Курс актуален 1 минуту. Зачислим после подтверждения сети (1–3 мин).'}
          </p>
        </header>

        {/* Asset selector — segment per DESIGN.md (pill, amber active). */}
        <section className="tma-card">
          <div
            className="tma-segment"
            role="radiogroup"
            aria-label="Актив для пополнения"
          >
            <button
              type="button"
              role="radio"
              aria-checked={asset === 'TON'}
              className={`tma-segment-btn ${asset === 'TON' ? 'is-active' : ''}`}
              onClick={() => selectAsset('TON')}
            >
              TON
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={asset === 'USDT'}
              disabled={!usdtAvailable}
              className={`tma-segment-btn ${asset === 'USDT' ? 'is-active' : ''}`}
              onClick={() => selectAsset('USDT')}
            >
              USDT{!usdtAvailable ? ' · скоро' : ''}
            </button>
          </div>
        </section>

        <section className="tma-card">
          <div className="tma-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`tma-btn ${amount === p ? 'tma-btn--primary' : ''}`}
                onClick={() => {
                  haptic.select();
                  setAmount(p);
                }}
              >
                {fmtCredits(p)} кр
              </button>
            ))}
          </div>
          <div className="tma-row" style={{ marginTop: 12 }}>
            <span className="tma-card-text">Своя сумма</span>
            <input
              type="number"
              min={MIN}
              max={MAX}
              value={Number.isFinite(amount) ? amount : ''}
              onChange={(e) => {
                // #5: пустое поле → NaN (а не 0) — отключит CTA и покажет подсказку,
                // вместо «NaN кр»/тихого нуля.
                const raw = e.target.value.trim();
                setAmount(raw === '' ? NaN : Number(raw));
              }}
              className="tma-mono"
              style={{
                background: 'transparent',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 8,
                padding: '4px 8px',
                width: 100,
                textAlign: 'right',
              }}
            />
          </div>
          {asset === 'TON' && tonEquivalent && (
            <div className="tma-row" style={{ marginTop: 8 }}>
              <span className="tma-card-text">≈</span>
              <span className="tma-mono">{tonEquivalent} TON</span>
            </div>
          )}
          {asset === 'USDT' && amountValid && (
            <div className="tma-row" style={{ marginTop: 8 }}>
              <span className="tma-card-text">≈</span>
              <span className="tma-mono">{fmtCredits(amount)} USDT</span>
            </div>
          )}
          {/* #5: инлайн-подсказка по диапазону вместо «NaN кр» в CTA. */}
          {!amountValid && (
            <p className="tma-card-text tma-text-small" style={{ marginTop: 8, color: 'var(--warning)' }}>
              Сумма — от <span className="tma-mono">{fmtCredits(MIN)}</span> до{' '}
              <span className="tma-mono">{fmtCredits(MAX)}</span> кр
            </p>
          )}
        </section>

        {/* USDT payment instructions — shown once the invoice exists. */}
        {usdtInit && status !== 'confirmed' && (
          <section className="tma-card">
            <p className="tma-card-title">Реквизиты USDT-on-TON</p>
            <p className="tma-card-text" style={{ fontSize: '0.85em', marginTop: 4 }}>
              Курс: <span className="tma-mono">1 USDT = 100 кр</span>. Перевод уйдёт через
              ваш кошелёк — обязательно с меткой ниже.
            </p>

            <div className="tma-row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
              <span className="tma-card-text">Сумма</span>
              <span className="tma-mono">{usdtInit.amount_usdt} USDT</span>
            </div>

            <div className="tma-row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
              <span className="tma-card-text">Адрес</span>
              <button
                type="button"
                className="tma-btn tma-btn--ghost tma-mono"
                style={{ maxWidth: '60%', overflowWrap: 'anywhere', textAlign: 'right' }}
                onClick={() => copy(usdtInit.receiver, 'addr')}
              >
                {copied === 'addr' ? 'Скопировано ✓' : usdtInit.receiver}
              </button>
            </div>

            <div className="tma-row" style={{ marginTop: 8, alignItems: 'flex-start' }}>
              <span className="tma-card-text">Метка (memo)</span>
              <button
                type="button"
                className="tma-btn tma-btn--ghost tma-mono"
                onClick={() => copy(usdtInit.comment, 'memo')}
              >
                {copied === 'memo' ? 'Скопировано ✓' : usdtInit.comment}
              </button>
            </div>

            <p className="tma-card-text" style={{ fontSize: '0.8em', marginTop: 10 }}>
              Без метки <span className="tma-mono">{usdtInit.comment}</span> платёж не
              зачислится автоматически.
            </p>
          </section>
        )}

        <section className="tma-card">
          {!userAddress ? (
            <>
              <p className="tma-card-text">Подключите TON-кошелёк для оплаты.</p>
              <div className="tma-cta">
                <TonConnectButton />
              </div>
            </>
          ) : status === 'confirmed' ? (
            <div className="tma-success">
              ✓ Зачислено {init ? fmtCredits(init.amount_credits) : '0,00'} кр на ваш баланс.
              <div className="tma-cta" style={{ marginTop: 12 }}>
                <Link href="/wallet" className="tma-btn tma-btn--primary">
                  К кошельку
                </Link>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="tma-btn tma-btn--primary"
              onClick={handlePay}
              disabled={
                !amountValid ||
                status === 'creating' ||
                status === 'awaiting_signature' ||
                status === 'submitted' ||
                status === 'polling'
              }
            >
              {status === 'creating' && 'Создаём инвойс…'}
              {status === 'awaiting_signature' && 'Подтвердите в кошельке…'}
              {status === 'submitted' && 'Отправлено, ждём блок…'}
              {status === 'polling' && 'Ждём подтверждения в сети…'}
              {(status === 'idle' || status === 'error') &&
                (amountValid
                  ? `Оплатить ${fmtCredits(amount)} кр${asset === 'USDT' ? ' в USDT' : ''}`
                  : 'Укажите сумму')}
            </button>
          )}

          {errorMsg && <div className="tma-error">{errorMsg}</div>}

          {init && status !== 'confirmed' && !usdtInit && (
            <p className="tma-card-text" style={{ marginTop: 12, fontSize: '0.85em' }}>
              Метка: <span className="tma-mono">{init.comment}</span>
            </p>
          )}
        </section>
      </main>
      <BottomNav />
    </>
  );
}
