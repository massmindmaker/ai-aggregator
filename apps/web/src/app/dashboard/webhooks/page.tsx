import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

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
        className="rounded-md border p-12 text-center"
        style={{ borderColor: 'var(--line)' }}
      >
        <h2 className="text-xl font-semibold mb-2">Скоро</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Управление webhooks через UI готовится. Сейчас доступно через{' '}
          <Link href="/docs" className="text-[var(--accent)] hover:underline">
            API
          </Link>{' '}
          (см. документацию, раздел «Subscriptions»).
        </p>
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
            ['contest.win', 'Победа в конкурсе'],
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
