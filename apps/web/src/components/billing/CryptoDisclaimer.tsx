import { AlertTriangle, Info } from 'lucide-react';

/**
 * TON-only billing notices (plan AG-TON-L task 5.2).
 * Disclaimer text awaits the owner's legal review (259-ФЗ deferred);
 * the sunset banner reassures existing fiat users about their balances.
 */
export function CryptoDisclaimer() {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
        <Info className="h-4 w-4" />
        Об оплате в Toncoin
      </div>
      <ul className="ms-6 list-disc space-y-1">
        <li>Оплата принимается только в Toncoin (TON); курс фиксируется на момент выставления счёта.</li>
        <li>Возвраты — по заявке в поддержку; возврат производится в TON по адресу отправителя платежа.</li>
        <li>Криптовалюта не является инвестицией; её курс может изменяться.</li>
      </ul>
    </div>
  );
}

export function FiatSunsetNotice() {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        Пополнение картой временно недоступно
      </div>
      Сейчас баланс пополняется только кошельком Toncoin. Действующие подписки
      доживают оплаченный период, остаток PAYG не сгорает и остаётся доступен.
    </div>
  );
}
