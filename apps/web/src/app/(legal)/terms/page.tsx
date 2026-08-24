import Link from 'next/link';
import { LegalLayout } from '@/components/legal/LegalLayout';

export const metadata = { title: 'Условия использования — AI-Aggregator' };

const TOC = [
  { id: 'subject', label: '1. Предмет оферты' },
  { id: 'full-text', label: '2. Полная редакция' },
  { id: 'privacy-link', label: '3. Связь с ПДн' },
];

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <LegalLayout
        title="Условия использования (оферта)"
        updated="2026-04-18"
        toc={TOC}
      >
        <p className="mb-6 text-muted-foreground">
          Редакция от 2026-04-18. Оператор: ИП Боборов, [ОГРНИП: заполняет основатель],
          [ИНН: заполняет основатель].
        </p>

        <h2 id="subject" className="text-xl font-semibold mt-8 mb-3">
          1. Предмет оферты
        </h2>
        <p className="mb-4">
          Использование сервиса AI-Aggregator (далее — «Сервис») для доступа
          к API моделей искусственного интеллекта означает безоговорочное
          принятие условий настоящей оферты.
        </p>

        <h2 id="full-text" className="text-xl font-semibold mt-8 mb-3">
          2. Полная редакция оферты
        </h2>
        <p className="mb-4">
          Полный текст публичной оферты будет опубликован в Plan 08 после
          юридической экспертизы. Текущая редакция — стартовая заглушка
          для покрытия требований 152-ФЗ и согласия пользователя на этапе
          регистрации.
        </p>

        <h2 id="privacy-link" className="text-xl font-semibold mt-8 mb-3">
          3. Связь с политикой обработки ПДн
        </h2>
        <p className="mb-4">
          Условия обработки персональных данных регулируются{' '}
          <Link
            href="/privacy"
            className="text-primary underline-offset-4 hover:underline"
          >
            Политикой обработки ПДн
          </Link>
          , которая является неотъемлемой частью настоящей оферты.
        </p>

        <p className="mt-10 text-xs text-muted-foreground">
          Эта страница — стартовая версия. Финальная оферта — Plan 08.
        </p>
      </LegalLayout>
    </main>
  );
}
