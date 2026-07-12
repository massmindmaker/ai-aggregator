'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { useAuth } from '@/hooks/useAuth';
import { haptic } from '@/lib/haptics';
import { MEMBERSHIP_TIERS, type MembershipTier } from '@/lib/membership';

// sessionStorage flag set by "продолжить бесплатно" (skip) so this screen shows once
// per app session for a non-member, not on every /agents navigation — see app/page.tsx.
const SEEN_KEY = 'aiag_membership_seen';

type PurchaseStatus =
  | 'idle'
  | 'creating'
  | 'awaiting_signature'
  | 'submitted'
  | 'settled'
  | 'failed'
  | 'error';

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 45; // ~3 min

const TIER_ORDER: MembershipTier[] = ['creator', 'builder', 'studio'];

export default function MembershipPage() {
  const router = useRouter();
  const { token, loading: authLoading, error: authError } = useAuth();
  const userAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();

  const [busyTier, setBusyTier] = useState<MembershipTier | null>(null);
  const [status, setStatus] = useState<PurchaseStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Safety net: if the caller already holds a membership (e.g. navigated back to this
  // URL directly), don't show the purchase screen at all — proves "пропускается при
  // наличии членства" independent of the app/page.tsx entry gate.
  useEffect(() => {
    if (authLoading || !token) return;
    let cancelled = false;
    fetch('/tg/api/tma/membership', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .catch(() => ({}))
      .then((j) => {
        if (!cancelled && j?.is_member) router.replace('/agents');
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, token, router]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function skip() {
    haptic.impact('light');
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    router.replace('/agents');
  }

  function pollStatus(id: string) {
    let attempts = 0;
    pollTimer.current = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch(
          `/tg/api/tma/membership/purchase/status?charge_id=${encodeURIComponent(id)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.terminal) {
          if (pollTimer.current) clearInterval(pollTimer.current);
          if (body.status === 'settled') {
            setStatus('settled');
            haptic.notify('success');
            try {
              sessionStorage.removeItem(SEEN_KEY);
            } catch {
              /* ignore */
            }
            router.replace('/agents');
          } else {
            setStatus('failed');
            setErrorMsg('Минт не подтверждён. Средства не списаны при отмене.');
          }
          return;
        }
      } catch {
        // transient poll failure — keep trying
      }
      if (attempts >= POLL_MAX_ATTEMPTS && pollTimer.current) {
        clearInterval(pollTimer.current);
        setStatus('error');
        setErrorMsg('Подтверждение занимает дольше обычного. Проверьте позже.');
      }
    }, POLL_INTERVAL_MS);
  }

  async function buy(tier: MembershipTier) {
    if (!token) {
      setErrorMsg('Откройте через @aiag_bot для авторизации.');
      return;
    }
    if (!userAddress) {
      setErrorMsg('Сначала подключите TON-кошелёк.');
      return;
    }
    haptic.impact('medium');
    setErrorMsg(null);
    setBusyTier(tier);
    setStatus('creating');
    try {
      // The recipient is NOT sent: the server mints onto the caller's ton-proof-verified
      // wallet, read server-side from ton_wallets (HIGH-A). A client-supplied address is
      // ignored by the route.
      const res = await fetch('/tg/api/tma/membership/purchase', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tier }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('error');
        if (res.status === 409 && j.error === 'purchase_pending') {
          setErrorMsg('Покупка уже запрошена. Подождите подтверждения.');
        } else if (res.status === 403 && j.error === 'wallet_not_verified') {
          setErrorMsg('Подтвердите владение кошельком (подпись ton-proof), затем повторите.');
        } else if (res.status === 503 && j.error === 'minter_not_configured') {
          setErrorMsg('Покупка членства временно недоступна.');
        } else {
          setErrorMsg(j.error ?? `HTTP ${res.status}`);
        }
        return;
      }
      setStatus('awaiting_signature');
      await tonConnectUI.sendTransaction(j.transaction);
      setStatus('submitted');
      pollStatus(j.charge_id);
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'tx_rejected';
      setErrorMsg(/UserReject/i.test(msg) ? 'Транзакция отменена.' : msg);
    } finally {
      setBusyTier(null);
    }
  }

  const inFlight = status === 'creating' || status === 'awaiting_signature' || status === 'submitted';

  return (
    <main className="tma-shell">
      <div className="tma-section-head">
        <h1 className="tma-title">Членство создателя</h1>
      </div>
      <p className="tma-card-text" style={{ fontSize: 13, opacity: 0.8, marginBottom: 4 }}>
        Купите один из трёх уровней (on-chain, оплата TON — не списание кредитов), чтобы
        создавать собственных агентов с нуля. Без членства каталог и найм остаются
        полностью доступны.
      </p>

      {authLoading && <p className="tma-card-text">Загрузка…</p>}
      {!authLoading && authError && (
        <div className="tma-card">
          <p className="tma-card-text">Откройте через @aiag_bot в Telegram</p>
        </div>
      )}

      {!authLoading && !authError && (
        <>
          {!userAddress && (
            <div className="tma-card" style={{ marginBottom: 12 }}>
              <p className="tma-card-text" style={{ marginBottom: 12 }}>
                Подключите TON-кошелёк, чтобы купить членство.
              </p>
              <div className="tma-cta">
                <TonConnectButton />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {TIER_ORDER.map((tier) => {
              const t = MEMBERSHIP_TIERS[tier];
              const busy = busyTier === tier && inFlight;
              return (
                <section key={tier} className="tma-card" style={{ padding: 16 }}>
                  <h2 className="tma-card-title">{t.label}</h2>
                  <p className="tma-card-text tma-text-small" style={{ marginBottom: 8 }}>
                    {t.agentLimit} {t.agentLimit === 1 ? 'агент' : 'агентов'}
                    {t.revSharePct > 0 ? ` · rev-share ${t.revSharePct}%` : ' · 0% rev-share'}
                  </p>
                  <div className="tma-cta">
                    <button
                      type="button"
                      className="tma-btn tma-btn--primary tma-btn--block"
                      disabled={!userAddress || inFlight}
                      onClick={() => buy(tier)}
                    >
                      {busy ? 'Ждём подпись…' : `Купить за ${t.priceTon} TON`}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>

          {status === 'submitted' && (
            <div className="tma-card-text" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <span
                className="aiag-pulse-dot"
                aria-hidden
                style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }}
              />
              <span>Подтверждаем покупку… право появится после минта (~1–3 мин).</span>
            </div>
          )}
          {errorMsg && (
            <div className="tma-error" style={{ marginTop: 12 }}>
              {errorMsg}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button type="button" className="tma-btn tma-btn--ghost tma-btn--block" onClick={skip} disabled={inFlight}>
              Продолжить бесплатно →
            </button>
          </div>
        </>
      )}
    </main>
  );
}
