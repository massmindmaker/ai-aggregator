import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/ui/EmptyState';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Webhooks — AI-Aggregator' };

export default async function WebhooksPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/webhooks');

  return (
    <section className="container mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight mb-2">Webhooks</h1>
      <p className="text-muted-foreground mb-6">
        Получайте уведомления о событиях вашего аккаунта на свой URL: успешные платежи, готовые задачи, статусы моделей.
      </p>

      <div
        className="rounded-md border"
        style={{ borderColor: 'var(--line)' }}
      >
        <EmptyState
          illustration="webhooks"
          title="Скоро"
          description="Управление webhooks через UI готовится. Сейчас доступно через API — см. документацию, раздел «Subscriptions»."
          actionLabel="Открыть документацию"
          actionHref="/docs"
        />
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          События которые вы сможете подписать
        </h3>
        <ul className="text-sm space-y-2">
          {[
            ['payment.confirmed', 'Платёж подтверждён'],
            ['payment.refunded', 'Возврат средств'],
            ['model.approved', 'Ваша модель одобрена модератором'],
            ['model.frozen', 'Модель заморожена'],
            ['payout.paid', 'Выплата отправлена'],
          ].map(([code, label]) => (
            <li key={code} className="flex gap-3 items-baseline">
              <code className="text-xs font-mono text-[var(--accent)] flex-shrink-0">{code}</code>
              <span className="text-muted-foreground">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
