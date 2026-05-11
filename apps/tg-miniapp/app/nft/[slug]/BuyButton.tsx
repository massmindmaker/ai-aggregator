'use client';

import { useState } from 'react';
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  collectionSlug: string;
  priceTon: string;
}

type Status = 'idle' | 'preparing' | 'awaiting_signature' | 'submitted' | 'error';

export function BuyButton({ collectionSlug, priceTon }: Props) {
  const { token, loading: authLoading, error: authError } = useAuth();
  const userAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [purchaseId, setPurchaseId] = useState<string | null>(null);

  async function handleBuy() {
    setErrorMsg(null);
    if (!token) {
      setErrorMsg('Откройте через @aiag_bot для авторизации.');
      return;
    }
    if (!userAddress) {
      setErrorMsg('Сначала подключите TON-кошелёк.');
      return;
    }

    setStatus('preparing');
    try {
      const res = await fetch('/tg/api/tma/nft/purchase', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          collection_slug: collectionSlug,
          recipient_address: userAddress,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('error');
        setErrorMsg(body.message || body.error || 'Не удалось создать инвойс');
        return;
      }

      setPurchaseId(body.purchase_id);
      setStatus('awaiting_signature');

      await tonConnectUI.sendTransaction(body.transaction);
      setStatus('submitted');
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'tx_rejected';
      setErrorMsg(/UserReject/i.test(msg) ? 'Транзакция отменена.' : msg);
    }
  }

  if (authLoading) {
    return <section className="tma-card"><p className="tma-card-text">Загрузка…</p></section>;
  }
  if (authError) {
    return (
      <section className="tma-card">
        <p className="tma-card-text">Откройте Mini App через @aiag_bot для покупки.</p>
      </section>
    );
  }

  return (
    <section className="tma-card">
      {!userAddress ? (
        <>
          <p className="tma-card-text">Подключите TON-кошелёк, чтобы купить.</p>
          <div className="tma-cta">
            <TonConnectButton />
          </div>
        </>
      ) : (
        <>
          <div className="tma-row">
            <span className="tma-card-text">Кошелёк</span>
            <span className="tma-mono">{shortAddr(userAddress)}</span>
          </div>

          {status === 'submitted' ? (
            <div className="tma-success">
              ✓ Транзакция отправлена. NFT поступит на кошелёк после подтверждения (~1–3 мин).
              {purchaseId && (
                <div className="tma-mono tma-text-small tma-mt-1">id: {purchaseId.slice(0, 8)}…</div>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="tma-btn tma-btn--primary"
              onClick={handleBuy}
              disabled={status === 'preparing' || status === 'awaiting_signature'}
            >
              {status === 'preparing' && 'Создаём инвойс…'}
              {status === 'awaiting_signature' && 'Подтвердите в кошельке…'}
              {(status === 'idle' || status === 'error') && `Купить за ${priceTon} TON`}
            </button>
          )}

          {errorMsg && <div className="tma-error">{errorMsg}</div>}
        </>
      )}
    </section>
  );
}

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
