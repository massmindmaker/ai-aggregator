import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { NewCollectionForm } from '../NewCollectionForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Новая NFT-коллекция — AIAG Admin' };

export default function NewNftCollectionPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <h1 className="text-3xl font-bold mb-2">Новая NFT-коллекция</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Сначала создайте коллекцию в @startonus_bot, затем зарегистрируйте её здесь.
        Цена указывается в TON — будет сохранена как nano TON (×10⁹).
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Параметры</CardTitle>
        </CardHeader>
        <CardContent>
          <NewCollectionForm />
        </CardContent>
      </Card>
    </div>
  );
}
