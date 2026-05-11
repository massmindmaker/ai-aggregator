import * as React from 'react';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import DirectSubmitForm from './DirectSubmitForm';

export const metadata = { title: 'Загрузка submission — AI-Aggregator' };

/**
 * Wave 3 Task 6: submission upload page.
 *
 * Posts FormData directly to /api/contests/[slug]/submit (Task 4).
 * params is a Promise in Next.js 15 App Router.
 */
export default async function ContestSubmitPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-2xl">
        <Link
          href={`/contests/${slug}`}
          className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block"
        >
          ← Вернуться к конкурсу
        </Link>

        <Card>
          <CardHeader>
            <CardTitle>Загрузить submission</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm text-muted-foreground mb-6">
              <p>
                Загрузите файл с предсказаниями. Максимум 50 MB.
              </p>
              <p className="text-xs">
                Результат появится в{' '}
                <Link
                  href={`/contests/${slug}/leaderboard`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  leaderboard
                </Link>{' '}
                и на странице «Мои submissions».
              </p>
            </div>

            <DirectSubmitForm slug={slug} />
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
