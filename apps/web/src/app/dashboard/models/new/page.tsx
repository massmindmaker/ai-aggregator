import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import SubmitModelForm from './SubmitModelForm';

export const metadata = { title: 'Предложить модель — AI-Aggregator' };

/**
 * Plan 07 Task 13: request-to-publish model flow.
 *
 * Simplified MVP: single-page form with 4 sections (Source, Metadata,
 * Technical, Terms). Submits a model in status='review' that admin will
 * approve in the moderation queue (Task 14).
 *
 * Multi-step version with dedicated Step1-4 components is tracked for Phase 2
 * when Path 1 (Fal host) is unblocked by FAL_PARTNER_ENABLED config.
 */
export default function SubmitModelPage() {
  return (
    <>
      <div className="container mx-auto px-4 py-10 max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight mb-2">
          Предложить модель
        </h1>
        <p className="text-muted-foreground mb-6">
          Заполните информацию о модели. После проверки админом модель
          появится в маркетплейсе. Revshare 70–85% в зависимости от типа
          хостинга.
        </p>

        <Card>
          <CardHeader>
            <CardTitle>Параметры модели</CardTitle>
          </CardHeader>
          <CardContent>
            <SubmitModelForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
