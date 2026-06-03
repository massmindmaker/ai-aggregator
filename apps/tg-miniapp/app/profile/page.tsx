'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TonConnectButton, useTonAddress, useTonWallet } from '@tonconnect/ui-react';
import { BottomNav } from '@/components/BottomNav';
import { useAuth } from '@/hooks/useAuth';

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

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// D-1: balances/amounts are integer US cents (1 credit = $0.01). Display as
// "N.NN cr" — store/compute in cents, never expose the raw integer.
function fmtCredits(s: string): string {
  const cents = Number(s);
  if (!Number.isFinite(cents)) return s;
  return (cents / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ProfilePage() {
  const { token, loading: authLoading, error: authError } = useAuth();
  const userAddress = useTonAddress();
  const wallet = useTonWallet();
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [balance, setBalance] = useState<string>('0');
  const [topups, setTopups] = useState<TopupRow[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Auto-link wallet on connect.
  useEffect(() => {
    if (!token || !userAddress) return;
    const publicKey =
      (wallet?.account as { publicKey?: string } | undefined)?.publicKey ?? null;
    fetch('/tg/api/tma/wallet/link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ address: userAddress, public_key: publicKey }),
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

  useEffect(() => {
    if (!token) return;
    refreshWallets();
    refreshTopups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
          <h2 className="tma-card-title">Откройте через @aiag_bot</h2>
          <p className="tma-card-text">Профиль доступен только в Telegram Mini App.</p>
        </section>
        <BottomNav />
      </main>
    );
  }

  return (
    <>
      <main className="tma-shell tma-shell--with-nav">
        <header className="tma-header">
          <span className="tma-badge">Профиль</span>
          <h1 className="tma-title">Кошелёк и баланс</h1>
          <p className="tma-subtitle">
            Привяжите TON-кошелёк, пополните счёт в кредитах через TON.
          </p>
        </header>

        <section className="tma-card">
          <div className="tma-row">
            <span className="tma-card-text">Баланс</span>
            <span className="tma-mono">{fmtCredits(balance)} cr</span>
          </div>
          <div className="tma-cta" style={{ marginTop: 12 }}>
            <Link href="/profile/topup" className="tma-btn tma-btn--primary">
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
                <span className="tma-card-text">
                  {new Date(w.linked_at).toLocaleDateString('ru-RU')}
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="tma-card">
          <h2 className="tma-card-title">История пополнений</h2>
          {topups.length === 0 ? (
            <p className="tma-card-text">Пока пусто.</p>
          ) : (
            topups.map((t) => (
              <div className="tma-row" key={t.id}>
                <span className="tma-mono">{fmtCredits(t.amount_credits)} cr</span>
                <span className="tma-card-text">
                  {t.status === 'confirmed' ? '✓' : t.status === 'pending' ? '…' : t.status}{' '}
                  {new Date(t.created_at).toLocaleDateString('ru-RU')}
                </span>
              </div>
            ))
          )}
        </section>
      </main>
      <BottomNav />
    </>
  );
}
