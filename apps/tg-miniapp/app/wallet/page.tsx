'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  TonConnectButton,
  useTonAddress,
  useTonConnectUI,
  useTonWallet,
} from '@tonconnect/ui-react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';
import { fmtCredits } from '@/lib/credits';
import { haptic } from '@/lib/haptics';

interface WalletRow {
  id: string;
  address: string;
  is_verified: boolean;
  linked_at: string;
  last_seen_at: string;
}

interface TopupRow {
  id: string;
  amount_credits: string;
  status: string;
  comment_tag: string;
  created_at: string;
  confirmed_at: string | null;
}

interface LedgerRow {
  id: string;
  kind: string;
  delta_credits: string;
  created_at: string;
}

// P1-9: русские подписи видов движения (леджер D-1).
const LEDGER_LABEL: Record<string, string> = {
  topup: 'Пополнение',
  run_debit: 'Прогон агента',
  rent_debit: 'Аренда шаблона',
  rent_credit: 'Доход с аренды',
  transfer_debit: 'Покупка агента',
  transfer_credit: 'Продажа агента',
};

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function WalletPage() {
  const { token, loading: authLoading, error: authError } = useAuth();
  const userAddress = useTonAddress();
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [balance, setBalance] = useState<string>('0');
  const [topups, setTopups] = useState<TopupRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);

  // R2.1-A2: before the wallet connects, arm TON Connect with OUR ton_proof
  // challenge so the wallet signs it at connect time. Without this the link
  // stays advisory (is_verified=false), as before.
  useEffect(() => {
    if (!token || userAddress) return; // proof is only obtainable at connect time
    tonConnectUI.setConnectRequestParameters({ state: 'loading' });
    fetch('/tg/api/tma/wallet/proof-payload', {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((j: { payload?: string }) => {
        if (j?.payload) {
          tonConnectUI.setConnectRequestParameters({
            state: 'ready',
            value: { tonProof: j.payload },
          });
        } else {
          tonConnectUI.setConnectRequestParameters(null);
        }
      })
      .catch(() => tonConnectUI.setConnectRequestParameters(null));
  }, [token, userAddress, tonConnectUI]);

  // Auto-link wallet on connect — with the signed ton_proof when the wallet
  // returned one (then the server verifies strictly and sets is_verified).
  useEffect(() => {
    if (!token || !userAddress) return;
    const acct = wallet?.account as
      | { publicKey?: string; walletStateInit?: string }
      | undefined;
    const tonProofItem = (
      wallet as unknown as {
        connectItems?: {
          tonProof?: {
            proof?: {
              timestamp: number;
              domain: { lengthBytes: number; value: string };
              payload: string;
              signature: string;
            };
          };
        };
      }
    )?.connectItems?.tonProof;
    const proof = tonProofItem?.proof ?? null;

    fetch('/tg/api/tma/wallet/link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        address: userAddress,
        public_key: acct?.publicKey ?? null,
        ...(proof && acct?.walletStateInit
          ? { wallet_state_init: acct.walletStateInit, proof }
          : {}),
      }),
    })
      .then((r) => r.json())
      .then(() => refreshWallets())
      .catch((e) => setLinkError(e instanceof Error ? e.message : 'link_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, userAddress]);

  async function refreshWallets() {
    if (!token) return;
    const r = await fetch('/tg/api/tma/wallet', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { wallets: WalletRow[]; balance_credits: string };
    setWallets(j.wallets ?? []);
    setBalance(j.balance_credits ?? '0');
  }

  async function refreshTopups() {
    if (!token) return;
    const r = await fetch('/tg/api/tma/topup', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { topups: TopupRow[] };
    setTopups(j.topups ?? []);
  }

  async function refreshLedger() {
    if (!token) return;
    const r = await fetch('/tg/api/tma/ledger', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { entries: LedgerRow[] };
    setLedger(j.entries ?? []);
  }

  useEffect(() => {
    if (!token) return;
    refreshWallets();
    refreshTopups();
    refreshLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (authLoading) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card" aria-hidden>
          <div className="aiag-skeleton" style={{ height: 14, width: '40%' }} />
          <div className="aiag-skeleton" style={{ height: 24, width: '60%' }} />
          <div className="aiag-skeleton" style={{ height: 44, width: '50%' }} />
        </section>
        <section className="tma-card" aria-hidden>
          <div className="aiag-skeleton" style={{ height: 14, width: '50%' }} />
          <div className="aiag-skeleton" style={{ height: 14, width: '70%' }} />
        </section>
        <BottomNav />
      </main>
    );
  }

  if (authError) {
    return (
      <main className="tma-shell tma-shell--with-nav">
        <section className="tma-card">
          <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
          <p className="tma-card-text">Кошелёк доступен только в Telegram Mini App.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header aiag-fade-up">
          <span className="tma-eyebrow">Кошелёк</span>
          <h1 className="tma-title">Баланс</h1>
          <p className="tma-subtitle">
            Привяжите TON-кошелёк, пополните счёт в кредитах через TON.
          </p>
        </header>

        <section className="tma-card aiag-fade-up">
          <div className="tma-row">
            <span className="tma-card-text">Баланс</span>
            <span className="tma-mono">{fmtCredits(balance)} кр</span>
          </div>
          <div className="tma-cta" style={{ marginTop: 12 }}>
            <Link
              href="/profile/topup"
              className="tma-btn tma-btn--primary"
              onClick={() => haptic.impact('medium')}
            >
              Пополнить
            </Link>
          </div>
        </section>

        <section className="tma-card">
          <h2 className="tma-card-title">TON-кошелёк</h2>
          {!userAddress ? (
            <>
              <p className="tma-card-text">
                Подключите кошелёк (Tonkeeper, Tonhub и др.).
              </p>
              <div className="tma-cta">
                <TonConnectButton />
              </div>
            </>
          ) : (
            <>
              <div className="tma-row">
                <span className="tma-card-text">Активный</span>
                <span className="tma-mono">{shortAddr(userAddress)}</span>
              </div>
              <div className="tma-cta" style={{ marginTop: 8 }}>
                <TonConnectButton />
              </div>
            </>
          )}
          {linkError && <div className="tma-error">{linkError}</div>}
        </section>

        {wallets.length > 0 && (
          <section className="tma-card">
            <h2 className="tma-card-title">Привязанные кошельки</h2>
            {wallets.map((w) => (
              <div className="tma-row" key={w.id}>
                <span className="tma-mono">{shortAddr(w.address)}</span>
                <span
                  className="tma-card-text"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  <span
                    className={`tma-pill ${w.is_verified ? 'tma-pill--ok' : 'tma-pill--muted'}`}
                  >
                    {w.is_verified ? '✓ проверен' : '◷ без подписи'}
                  </span>
                  {new Date(w.linked_at).toLocaleDateString('ru-RU')}
                </span>
              </div>
            ))}
          </section>
        )}

        {/* P1-9: единая лента движения средств (леджер D-1). Подтверждённые
            пополнения живут в леджере (kind=topup) — отдельно показываем только
            НЕзачисленные топапы (ожидает/expired), чтобы не дублировать. */}
        <section className="tma-card" id="история">
          <h2 className="tma-card-title">История средств</h2>
          {topups
            .filter((t) => t.status !== 'confirmed')
            .map((t) => (
              <div className="tma-row" key={t.id}>
                <span className="tma-mono">+{fmtCredits(t.amount_credits)} кр</span>
                <span
                  className="tma-card-text"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  <span
                    className={`tma-pill ${
                      t.status === 'pending' ? 'tma-pill--run' : 'tma-pill--muted'
                    }`}
                  >
                    {t.status === 'pending' ? '◷ ожидает' : `✕ ${t.status}`}
                  </span>
                  {new Date(t.created_at).toLocaleDateString('ru-RU')}
                </span>
              </div>
            ))}
          {ledger.length === 0 && topups.length === 0 ? (
            <p className="tma-card-text">
              Пока пусто. Пополните баланс и запустите агента.
            </p>
          ) : (
            ledger.map((e) => {
              const delta = Number(e.delta_credits);
              const positive = delta > 0;
              return (
                <div className="tma-row" key={e.id}>
                  <span
                    className="tma-mono"
                    style={{ color: positive ? 'var(--success)' : 'var(--ink)' }}
                  >
                    {positive ? '+' : '−'}
                    {fmtCredits(String(Math.abs(delta)))} кр
                  </span>
                  <span
                    className="tma-card-text"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                  >
                    {LEDGER_LABEL[e.kind] ?? e.kind}
                    <span className="tma-text-small" style={{ color: 'var(--ink-faint)' }}>
                      {new Date(e.created_at).toLocaleDateString('ru-RU')}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </section>
      </main>
      <BottomNav />
    </>
  );
}
