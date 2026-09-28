import Link from 'next/link';

/**
 * Plan 08 — Общий shell для всех legal-страниц.
 * Content передаётся children'ами, в футер автоматом кладётся версия документа.
 */
export function LegalPageShell({
  title,
  version,
  publishedAt,
  children,
}: {
  title: string;
  version?: string;
  publishedAt?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <nav className="mb-8 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            ← На главную
          </Link>
        </nav>
        <article className="prose prose-invert max-w-none">
          <h1 className="text-3xl font-bold mb-4">{title}</h1>
          {(version || publishedAt) && (
            <p className="mb-6 text-sm text-muted-foreground">
              {publishedAt && <>Редакция: {publishedAt}</>}
              {publishedAt && version && ' · '}
              {version && <>Версия: <code>{version}</code></>}
            </p>
          )}
          {children}
        </article>
        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          По вопросам обработки персональных данных:{' '}
          <a
            href={`mailto:${process.env.NEXT_PUBLIC_DPO_EMAIL ?? 'dpo@ai-aggregator.ru'}`}
            className="underline"
          >
            {process.env.NEXT_PUBLIC_DPO_EMAIL ?? 'dpo@ai-aggregator.ru'}
          </a>
        </footer>
      </div>
    </main>
  );
}
