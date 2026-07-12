import Link from 'next/link';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import { SearchX } from 'lucide-react';

export default function AgentMarketNotFound() {
  return (
    <MainLayout>
      <section className="container mx-auto max-w-3xl px-4 py-16 text-center">
        <SearchX className="mx-auto h-12 w-12 text-muted-foreground" aria-hidden />
        <h1 className="text-2xl font-bold mt-4">Агент не найден</h1>
        <p className="text-muted-foreground mt-2">
          Возможно, шаблон был снят с публикации или ссылка устарела.
        </p>
        <div className="mt-6 flex gap-2 justify-center">
          <Button asChild>
            <Link href="/agentmarket">К витрине агентов</Link>
          </Button>
        </div>
      </section>
    </MainLayout>
  );
}
