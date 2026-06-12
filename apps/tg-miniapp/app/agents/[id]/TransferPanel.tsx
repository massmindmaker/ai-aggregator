'use client';

import { useState } from 'react';
import { TonConnectButton, useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { fmtCredits, parseCreditsInput } from '@/lib/credits';

// TransferPanel — owner controls + acquirer TON Connect initiate.
//
// isOwner MUST be a prop driven by the actual surface (owner detail page → true;
// public offer page → false). NEVER hardcode true inside this component.
//
// The two halves are MUTUALLY EXCLUSIVE:
//   isOwner === true  → owner controls + share link. No acquire CTA.
//   isOwner === false → acquirer CTA (TON Connect). No owner controls.
//
// Disambiguation: transfer = MOVE the single instance (original disappears).
// This is NOT cloning (COPY, original survives) and NOT rent (time-limited copy).

interface Props {
  agentId: string;
  isOwner: boolean;
  transferable: boolean;
  transferPriceCredits: string | null;
  agentName?: string;
  agentRole?: string;
  mintFeeTon?: string;
  token?: string | null;
  onChanged?: () => void;
}

type TransferStatus = 'idle' | 'preparing' | 'awaiting_signature' | 'submitted' | 'error';

const editInputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg-surface)',
  color: 'var(--ink)',
  fontSize: 14,
  outline: 'none',
};

// ── Owner half ──────────────────────────────────────────────────────────────
function OwnerControls({
  agentId,
  transferable,
  transferPriceCredits,
  token,
  onChanged,
}: {
  agentId: string;
  transferable: boolean;
  transferPriceCredits: string | null;
  token?: string | null;
  onChanged?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState(transferPriceCredits ?? '');
  const [copied, setCopied] = useState(false);

  const shareLink =
    typeof window !== 'undefined'
      ? `${window.location.origin}/tg/agents/${agentId}/offer`
      : `/tg/agents/${agentId}/offer`;

  async function toggle(enable: boolean) {
    if (!token) {
      setErr('Нет авторизации. Откройте через @aiag_bot.');
      return;
    }
    setSaving(true);
    setErr(null);
    // P0-1: ввод в КРЕДИТАХ (дробь допустима) → хранение в центах.
    let price: number | null = null;
    if (enable && priceInput.trim()) {
      const parsed = parseCreditsInput(priceInput, 1000);
      if (parsed === undefined || parsed === null) {
        setErr('Цена — число от 0,01 до 1 000 кр (или оставьте пусто для дарения).');
        setSaving(false);
        return;
      }
      price = parsed;
    }
    try {
      const res = await fetch(`/tg/api/tma/agents/${agentId}/make-transferable`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transferable: enable,
          price_credits: enable ? price : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr('Не удалось скопировать ссылку.');
    }
  }

  return (
    <section className="tma-card" style={{ padding: 16 }}>
      <h2 className="tma-card-title">Передать / продать агента</h2>
      <p className="tma-card-text tma-text-small" style={{ marginBottom: 12 }}>
        Передача — это перемещение{' '}
        <strong>одного экземпляра</strong>: агент пропадёт у вас и появится у получателя.
        Это{' '}
        <strong>не клонирование</strong> (копия, оригинал сохраняется) и{' '}
        <strong>не аренда</strong> (повременная копия).
      </p>

      {!transferable ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="tma-card-text">Цена продажи, кр (пусто = только дарение)</span>
            <input
              type="number"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              min={0.01}
              max={1000}
              step={0.01}
              placeholder="бесплатно / дарение"
              style={editInputStyle}
            />
          </label>
          {err && <div className="tma-error">{err}</div>}
          <p className="tma-card-text tma-text-small" style={{ opacity: 0.7 }}>
            Минт iNFT ≈ {mintFeeTon ?? '1'} TON (списывается из кошелька TON при подтверждении).
          </p>
          <button
            type="button"
            className="tma-btn tma-btn--primary"
            onClick={() => toggle(true)}
            disabled={saving}
          >
            {saving ? 'Сохранение…' : 'Сделать передаваемым'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="tma-pill tma-pill--ok">передаваемый</span>
            {transferPriceCredits ? (
              <span className="tma-card-text tma-text-small">
                цена:{' '}
                <span className="tma-mono">{fmtCredits(transferPriceCredits)}</span> кр
              </span>
            ) : (
              <span className="tma-card-text tma-text-small">только дарение</span>
            )}
          </div>

          {/* Share link — the delivery hand-off (resolves CONTEXT Q#4) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="tma-card-text tma-text-small">
              Отправьте эту ссылку получателю — он примет агента в дар или купит его.
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                readOnly
                value={shareLink}
                style={{ ...editInputStyle, flex: 1, fontSize: 12, color: 'var(--ink-muted)' }}
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                className="tma-btn"
                onClick={copyLink}
                style={{ whiteSpace: 'nowrap', minWidth: 120 }}
              >
                {copied ? '✓ Скопировано' : 'Скопировать ссылку'}
              </button>
            </div>
          </div>

          {err && <div className="tma-error">{err}</div>}
          <button
            type="button"
            className="tma-btn"
            onClick={() => toggle(false)}
            disabled={saving}
          >
            {saving ? 'Сохранение…' : 'Отменить передачу'}
          </button>
        </div>
      )}

      {/* Honest D-5 flag — PRODUCT.md UI=reality */}
      <p
        className="tma-card-text tma-text-small"
        style={{ marginTop: 12, opacity: 0.7, borderTop: '1px solid var(--line)', paddingTop: 10 }}
      >
        Сейчас переезжают настройки, персона и скиллы; личная история стирается.
        Перенос обученной памяти появится позже (D-5).
      </p>
    </section>
  );
}

// ── Acquirer half ────────────────────────────────────────────────────────────
function AcquirerInitiate({
  agentId,
  transferPriceCredits,
  agentName,
  agentRole,
  mintFeeTon,
}: {
  agentId: string;
  transferPriceCredits: string | null;
  agentName?: string;
  agentRole?: string;
  mintFeeTon?: string;
}) {
  const userAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const [status, setStatus] = useState<TransferStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mintDisplay = mintFeeTon ?? '0.1';
  const ctaLabel =
    transferPriceCredits == null
      ? `Принять в дар (минт ~${mintDisplay} TON)`
      : `Купить за ${fmtCredits(transferPriceCredits)} кр + минт ~${mintDisplay} TON`;

  async function handleAcquire() {
    if (!userAddress) return;
    setErrorMsg(null);
    setStatus('preparing');
    try {
      const res = await fetch(`/tg/api/tma/agents/${agentId}/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient_address: userAddress }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('error');
        if (res.status === 409 && body.error === 'transfer_pending') {
          setErrorMsg('Передача уже запрошена. Попробуйте позже.');
        } else if (res.status === 403 && body.error === 'self_deal') {
          setErrorMsg('Нельзя принять собственного агента.');
        } else {
          setErrorMsg(body.message ?? body.error ?? `HTTP ${res.status}`);
        }
        return;
      }

      setStatus('awaiting_signature');
      await tonConnectUI.sendTransaction(body.transaction);
      setStatus('submitted');
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : 'tx_rejected';
      setErrorMsg(/UserReject/i.test(msg) ? 'Транзакция отменена.' : msg);
    }
  }

  return (
    <section className="tma-card" style={{ padding: 16 }}>
      {agentName && <h2 className="tma-card-title">{agentName}</h2>}
      {agentRole && (
        <p className="tma-card-text tma-text-small" style={{ marginBottom: 8 }}>
          {agentRole}
        </p>
      )}

      {!userAddress ? (
        <>
          <p className="tma-card-text" style={{ marginBottom: 12 }}>
            Подключите TON-кошелёк, чтобы принять агента.
          </p>
          <div className="tma-cta">
            <TonConnectButton />
          </div>
        </>
      ) : (
        <>
          {status === 'submitted' ? (
            <div className="tma-success">
              ✓ Запрос отправлен. Право на агента перейдёт после подтверждения минта (~1–3 мин).
            </div>
          ) : (
            <button
              type="button"
              className="tma-btn tma-btn--primary"
              onClick={handleAcquire}
              disabled={status === 'preparing' || status === 'awaiting_signature'}
            >
              {status === 'preparing' && 'Создаём запрос…'}
              {status === 'awaiting_signature' && 'Подтвердите в кошельке…'}
              {(status === 'idle' || status === 'error') && ctaLabel}
            </button>
          )}
          {errorMsg && <div className="tma-error" style={{ marginTop: 8 }}>{errorMsg}</div>}
        </>
      )}
    </section>
  );
}

// ── Public export ────────────────────────────────────────────────────────────
export function TransferPanel({
  agentId,
  isOwner,
  transferable,
  transferPriceCredits,
  agentName,
  agentRole,
  mintFeeTon,
  token,
  onChanged,
}: Props) {
  if (isOwner) {
    return (
      <OwnerControls
        agentId={agentId}
        transferable={transferable}
        transferPriceCredits={transferPriceCredits}
        token={token}
        onChanged={onChanged}
      />
    );
  }
  return (
    <AcquirerInitiate
      agentId={agentId}
      transferPriceCredits={transferPriceCredits}
      agentName={agentName}
      agentRole={agentRole}
      mintFeeTon={mintFeeTon}
    />
  );
}
