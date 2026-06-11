'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';

type Status =
  | 'idle'
  | 'creating'
  | 'awaiting_signature'
  | 'submitted'
  | 'polling'
  | 'confirmed'
  | 'error';

interface InitResp {
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
  const [amount, setAmount] = useState<number>(500);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [init, setInit] = useState<InitResp | null>(null);

  const tonEquivalent = useMemo(
    () => (init ? nanoToTon(init.amount_nano_ton) : null),
    [init],
  );

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
        body: JSON.stringify({ amount_credits: amount, wallet_address: userAddress }),
      });
      const j = await r.json();
      if (!r.ok) {
        setStatus('error');
        setErrorMsg(j.message || j.error || 'Не удалось создать инвойс');
        return;
      }
      setInit(j as InitResp);

      setStatus('awaiting_signature');
      await tonConnectUI.sendTransaction((j as InitResp).transaction);
      setStatus('submitted');

      pollCheck((j as InitResp).topup_id);
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'tx_rejected';
      setErrorMsg(/UserReject/i.test(msg) ? 'Транзакция отменена.' : msg);
    }
  }

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <p className="tma-card-text">Загрузка…</p>
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

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <Link href="/profile" className="tma-card-text">
            ← Профиль
          </Link>
          <h1 className="tma-title">Пополнение через TON</h1>
          <p className="tma-subtitle">
            Курс актуален 1 минуту. Зачислим после подтверждения сети (1–3 мин).
          </p>
        </header>

        <section className="tma-card">
          <div className="tma-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`tma-btn ${amount === p ? 'tma-btn--primary' : ''}`}
                onClick={() => setAmount(p)}
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
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
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
          {tonEquivalent && (
            <div className="tma-row" style={{ marginTop: 8 }}>
              <span className="tma-card-text">≈</span>
              <span className="tma-mono">{tonEquivalent} TON</span>
            </div>
          )}
        </section>

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
                <Link href="/profile" className="tma-btn tma-btn--primary">
                  В профиль
                </Link>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="tma-btn tma-btn--primary"
              onClick={handlePay}
              disabled={
                status === 'creating' ||
                status === 'awaiting_signature' ||
                status === 'submitted' ||
                status === 'polling'
              }
            >
              {status === 'creating' && 'Создаём инвойс…'}
              {status === 'awaiting_signature' && 'Подтвердите в кошельке…'}
              {status === 'submitted' && 'Отправлено, ждём блок…'}
              {status === 'polling' && 'Ждём подтверждения сети…'}
              {(status === 'idle' || status === 'error') && `Оплатить ${fmtCredits(amount)} кр`}
            </button>
          )}

          {errorMsg && <div className="tma-error">{errorMsg}</div>}

          {init && status !== 'confirmed' && (
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
