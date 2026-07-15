'use client';

import { useEffect } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function MarketplaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[marketplace] route error', error);
  }, [error]);

  return (
    <MainLayout>
      <section className="container mx-auto max-w-3xl px-4 py-16 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-destructive" aria-hidden />
        <h1 className="text-2xl font-bold mt-4">Что-то сломалось</h1>
        <p className="text-muted-foreground mt-2">
          Не удалось загрузить каталог. Попробуйте ещё раз — это помогает чаще,
          чем кажется.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground mt-2 font-mono">
            ID: {error.digest}
          </p>
        )}
        <Alert className="mt-6 text-start">
          <AlertDescription>
            Если ошибка повторяется — напишите нам в Telegram{' '}
            <a
              href="https://t.me/aiaggregatorsupport"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              @aiaggregatorsupport
            </a>
            . Укажите ID ошибки, если он есть.
          </AlertDescription>
        </Alert>
        <Button onClick={reset} className="mt-6" leftIcon={<RotateCcw className="h-4 w-4" />}>
          Попробовать снова
        </Button>
      </section>
    </MainLayout>
  );
}
