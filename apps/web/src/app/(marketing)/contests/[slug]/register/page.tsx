import * as React from 'react';
import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import RegisterForm from './RegisterForm';

export const metadata = { title: 'Регистрация на конкурс — AI-Aggregator' };

/**
 * Plan 07 Task 4: contest registration flow.
 *
 * Flow: user жмёт «Участвовать» → accept rules + 152-FZ consent → POST
 * /api/contests/[slug]/register → INSERT INTO contest_participants → redirect
 * to /contests/[slug]/submit.
 */
export default async function ContestRegisterPage({
  params: paramsPromise,
}: {
  params: Promise<{ slug: string }>;
}) {
  const params = await paramsPromise;
  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-10 max-w-2xl">
        <Link
          href={`/contests/${params.slug}`}
          className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block"
        >
          ← Вернуться к конкурсу
        </Link>

        <Card>
          <CardHeader>
            <CardTitle>Регистрация на конкурс</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 text-sm text-muted-foreground mb-6">
              <p>
                Подтвердите согласие с правилами конкурса. После регистрации вы
                получите доступ к датасету и сможете загружать submissions.
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Публикация результата на публичном leaderboard</li>
                <li>
                  При победе — обязательство подписать договор автора в течение
                  10 дней
                </li>
                <li>Соблюдение правил конкурса и тех. лимитов (20/день)</li>
              </ul>
            </div>

            <RegisterForm slug={params.slug} />
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
