'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CreditCard, Wallet, Crown, Plus, Zap } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { TonWalletPanel } from '@/components/ton/TonWalletPanel';
import { CryptoDisclaimer, FiatSunsetNotice } from '@/components/billing/CryptoDisclaimer';

type ProviderId = 'tinkoff' | 'yookassa' | 'sbp';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  tinkoff: 'Тинькофф',
  yookassa: 'ЮKassa',
  sbp: 'СБП',
};

// yookassa/sbp webhooks are still a stub (TODO: persist + settle credits, see
// /api/subscriptions/webhook/[provider]) — a payment there takes the user's
// money but never credits the balance. Keep them visible (roadmap-honest) but
// disabled until that lands. Only tinkoff is a real, working money path.
const DISABLED_PROVIDERS: ReadonlySet<ProviderId> = new Set(['yookassa', 'sbp']);

interface PaymentRow {
  id: string;
  amount: string;
  currency: string;
  status: string;
  description: string | null;
  payment_method: string | null;
  created_at: string;
}

const TOPUP_PRESETS = [500, 1000, 2500, 5000, 10000];

// TON-only launch (plan task 5.1): card rails are the legacy path — the API
// answers 503 ton_only unless the deploy configures fiat env; the UI matches.
// Flip this back (with the fiat env) when card rails return.
const FIAT_ENABLED = false;

export default function BillingPage() {
  const [topupAmount, setTopupAmount] = useState<number>(1000);
  const [topupProvider, setTopupProvider] = useState<ProviderId>('tinkoff');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto top-up state
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoThreshold, setAutoThreshold] = useState('500');
  const [autoAmount, setAutoAmount] = useState('1000');
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);

  // Real payments fetched from /api/dashboard/billing/payments
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);

  // Real tier + gateway-spendable balance from /api/dashboard/billing/summary
  const [planName, setPlanName] = useState<string | null>(null);
  const [creditsLimit, setCreditsLimit] = useState<number | null>(null);
  const [balanceCredits, setBalanceCredits] = useState<number | null>(null);
  const [paygCredits, setPaygCredits] = useState(0);
  const [subscriptionCredits, setSubscriptionCredits] = useState(0);
  const [refundDebtCredits, setRefundDebtCredits] = useState(0);
  const [refundPending, setRefundPending] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/dashboard/billing/payments');
        if (!res.ok) return;
        const data = (await res.json()) as { payments?: PaymentRow[] };
        setPayments(data.payments ?? []);
      } finally {
        setPaymentsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/dashboard/billing/summary');
        if (!res.ok) {
          setSummaryStatus('error');
          return;
        }
        const data = (await res.json()) as {
          plan?: { name: string; creditsLimit: number | null };
          balance?: {
            paygCredits: number;
            subscriptionCredits: number;
            totalSpendableCredits: number;
            refundDebtCredits: number;
            refundPending: boolean;
          };
        };
        if (data.plan) {
          setPlanName(data.plan.name);
          setCreditsLimit(data.plan.creditsLimit);
        }
        if (data.balance) {
          setBalanceCredits(data.balance.totalSpendableCredits);
          setPaygCredits(data.balance.paygCredits);
          setSubscriptionCredits(data.balance.subscriptionCredits);
          setRefundDebtCredits(data.balance.refundDebtCredits);
          setRefundPending(data.balance.refundPending);
        }
        setSummaryStatus(data.plan && data.balance ? 'ready' : 'error');
      } catch {
        setSummaryStatus('error');
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/dashboard/billing/auto-topup');
        if (!res.ok) return;
        const data = await res.json();
        if (data?.autoTopup) {
          setAutoEnabled(!!data.autoTopup.enabled);
          if (data.autoTopup.thresholdRub != null)
            setAutoThreshold(String(data.autoTopup.thresholdRub));
          if (data.autoTopup.amountRub != null)
            setAutoAmount(String(data.autoTopup.amountRub));
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function saveAutoTopup() {
    setAutoSaving(true);
    setAutoMsg(null);
    try {
      const res = await fetch('/api/dashboard/billing/auto-topup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: autoEnabled,
          thresholdRub: autoEnabled ? Number(autoThreshold) : null,
          amountRub: autoEnabled ? Number(autoAmount) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAutoMsg(data.error || `HTTP ${res.status}`);
        return;
      }
      setAutoMsg('Сохранено');
    } catch (e) {
      setAutoMsg((e as Error).message);
    } finally {
      setAutoSaving(false);
    }
  }

  async function handleTopup() {
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/payments/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountRub: topupAmount, provider: topupProvider }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        paymentUrl?: string;
        qrPayload?: string;
        error?: { message: string };
      };
      if (!res.ok || !data.success) {
        setError(data.error?.message || `Ошибка ${res.status}`);
        return;
      }
      if (data.paymentUrl) window.location.href = data.paymentUrl;
      else if (data.qrPayload) window.location.href = data.qrPayload;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section className="container mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Биллинг</h1>
            <p className="mt-1 text-muted-foreground">
              Платежи, активная подписка и баланс PAYG.
            </p>
          </div>
        </div>

        {/* Top cards: subscription / PAYG balance */}
        {summaryStatus === 'loading' && (
          <div role="status" className="mb-8 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
            Загружаем данные биллинга…
          </div>
        )}
        {summaryStatus === 'error' && (
          <div role="alert" className="mb-8 rounded-2xl border border-destructive/40 bg-destructive/10 p-6 text-sm">
            Не удалось загрузить данные биллинга. Попробуйте обновить страницу позже.
          </div>
        )}
        {summaryStatus === 'ready' && (
          <div className="grid gap-4 md:grid-cols-2 mb-8">
          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Crown className="h-4 w-4 text-primary" />
              Активная подписка
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {planName ?? 'Free'}
              {creditsLimit != null && (
                <Badge variant="outline" className="ms-2 align-middle text-xs">
                  {creditsLimit.toLocaleString('ru-RU')} кредитов / мес
                </Badge>
              )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Пополните баланс кредитов для повышенных лимитов и приоритета
              в роутинге.
            </p>
            <Button asChild size="sm" className="mt-4">
              <a href="/pricing">
                Выбрать пакет <ArrowRight className="ms-2 h-4 w-4" />
              </a>
            </Button>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="h-4 w-4 text-primary" />
              Баланс PAYG
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {(balanceCredits ?? 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
              <span className="text-base text-muted-foreground">кр</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Pay-per-use списания за API-запросы сверх лимита подписки.
            </p>
            {(refundPending || refundDebtCredits > 0) && (
              <div className="mt-4 space-y-3" aria-label="Статус возврата средств">
                {refundPending && (
                  <div
                    role="status"
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                  >
                    <p className="font-medium">Возврат находится на сверке</p>
                    <p className="mt-1 text-muted-foreground">
                      Итог возврата ещё не подтверждён. До завершения сверки кредиты временно недоступны.
                    </p>
                  </div>
                )}
                {refundDebtCredits > 0 && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                  >
                    <p className="font-medium">Задолженность после возврата</p>
                    <p className="mt-1 text-muted-foreground">
                      Задолженность: {refundDebtCredits.toLocaleString('ru-RU', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      кр. Расходование кредитов приостановлено до погашения задолженности.
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Учтено до блокировки: PAYG{' '}
                  {paygCredits.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кр., подписка{' '}
                  {subscriptionCredits.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кр.
                </p>
              </div>
            )}
          </div>
          </div>
        )}

        {/* Top-up form — fiat card, hidden for the TON-only launch */}
        {FIAT_ENABLED && (
        <div className="rounded-2xl border border-border bg-card p-6 mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Plus className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Пополнить баланс</h2>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {TOPUP_PRESETS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setTopupAmount(amount)}
                className={cn(
                  'px-4 py-2 rounded-full border text-sm transition-colors',
                  topupAmount === amount
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:border-primary/40'
                )}
              >
                {amount.toLocaleString('ru-RU')} ₽
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-4 text-xs text-muted-foreground">
            <span>Способ оплаты:</span>
            {(['tinkoff', 'yookassa', 'sbp'] as ProviderId[]).map((p) => {
              const disabled = DISABLED_PROVIDERS.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  disabled={disabled}
                  onClick={() => !disabled && setTopupProvider(p)}
                  aria-disabled={disabled}
                  title={disabled ? 'Скоро' : undefined}
                  className={cn(
                    'px-3 py-1 rounded-full border transition-colors',
                    disabled
                      ? 'opacity-40 cursor-not-allowed border-border'
                      : topupProvider === p
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:border-primary/40'
                  )}
                >
                  {PROVIDER_LABELS[p]}
                  {disabled && <span className="ms-1">(скоро)</span>}
                </button>
              );
            })}
          </div>

          {error && (
            <div
              role="alert"
              className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button onClick={handleTopup} disabled={pending}>
            <CreditCard className="me-2 h-4 w-4" />
            {pending
              ? 'Перенаправляем…'
              : `Пополнить на ${topupAmount.toLocaleString('ru-RU')} ₽`}
          </Button>
        </div>
        )}

        <div className="mb-8">
          <TonWalletPanel mode="manage" showCheckout />
        </div>

        <div className="mb-8 space-y-3">
          <FiatSunsetNotice />
          <CryptoDisclaimer />
        </div>

        {/* Auto top-up — fiat card, hidden for the TON-only launch */}
        {FIAT_ENABLED && (
        <div className="rounded-2xl border border-border bg-card p-6 mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Автопополнение</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Когда баланс PAYG опустится ниже порога — мы автоматически спишем указанную сумму с привязанной карты.
          </p>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 mb-4">
            <Label htmlFor="auto-en" className="cursor-pointer">
              Включить автопополнение
            </Label>
            <Switch
              id="auto-en"
              checked={autoEnabled}
              onCheckedChange={setAutoEnabled}
            />
          </div>
          {autoEnabled && (
            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              <div>
                <Label htmlFor="auto-th">Порог (₽)</Label>
                <Input
                  id="auto-th"
                  inputMode="numeric"
                  value={autoThreshold}
                  onChange={(e) => setAutoThreshold(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="auto-am">Сумма пополнения (₽)</Label>
                <Input
                  id="auto-am"
                  inputMode="numeric"
                  value={autoAmount}
                  onChange={(e) => setAutoAmount(e.target.value)}
                />
              </div>
            </div>
          )}
          {autoMsg && (
            <p className="text-xs text-muted-foreground mb-2">{autoMsg}</p>
          )}
          <Button onClick={saveAutoTopup} disabled={autoSaving}>
            {autoSaving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
        )}

        {/* Payments table */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-semibold">История платежей</h2>
          </div>
          {paymentsLoading ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              Загрузка…
            </div>
          ) : payments.length === 0 ? (
            <EmptyState
              illustration="wallet"
              title="Платежей пока нет"
              description="Сделайте первое пополнение или подпишитесь на тариф."
              size="sm"
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground bg-muted/30">
                <tr>
                  <th className="px-6 py-3 text-left">Дата</th>
                  <th className="px-6 py-3 text-left">Описание</th>
                  <th className="px-6 py-3 text-left">Метод</th>
                  <th className="px-6 py-3 text-right">Сумма</th>
                  <th className="px-6 py-3 text-left">Статус</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-6 py-3 whitespace-nowrap font-mono text-xs">
                      {p.created_at?.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-6 py-3">{p.description ?? '—'}</td>
                    <td className="px-6 py-3 text-xs text-muted-foreground">
                      {p.payment_method ?? '—'}
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums">
                      {Number(p.amount).toLocaleString('ru-RU')} {p.currency}
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant="outline">{p.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
