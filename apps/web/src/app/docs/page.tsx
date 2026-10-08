'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu, BookOpen, ExternalLink } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/Button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/Sheet';
import { cn } from '@/lib/utils';

const sections = [
  { id: 'quick-start', title: 'Быстрый старт' },
  { id: 'api-reference', title: 'API Reference' },
  { id: 'authentication', title: 'Аутентификация' },
  { id: 'models', title: 'Модели' },
  { id: 'examples', title: 'Примеры' },
  { id: 'sdk', title: 'SDK' },
];

function CodeBlock({
  children,
  lang = 'bash',
}: {
  children: string;
  lang?: string;
}) {
  return (
    <div className="my-4 rounded-lg border border-border bg-[hsl(var(--muted))] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/40 text-xs font-mono text-muted-foreground">
        <span>{lang}</span>
      </div>
      <pre className="p-4 text-sm overflow-x-auto font-mono leading-relaxed text-foreground/90">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Sidebar({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Навигация документации" className="flex flex-col">
      <div className="flex items-center gap-2 mb-4 text-primary">
        <BookOpen className="h-4 w-4" />
        <span className="text-sm font-semibold uppercase tracking-wide">
          Документация
        </span>
      </div>
      <ul className="space-y-1">
        {sections.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              className={cn(
                'w-full text-start rounded-md px-3 py-2 text-sm transition-colors',
                active === s.id
                  ? 'bg-primary/10 text-primary font-medium border-s-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
            >
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function DocsPage() {
  const [active, setActive] = useState('quick-start');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const scrollTo = (id: string) => {
    setActive(id);
    setDrawerOpen(false);
    const el = document.getElementById(id);
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  };

  return (
    <MainLayout>
      <section className="container mx-auto max-w-7xl px-4 py-10 md:py-12">
        {/* Mobile drawer trigger */}
        <div className="lg:hidden mb-4">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" leftIcon={<Menu className="h-4 w-4" />}>
                Разделы
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[280px]">
              <SheetHeader>
                <SheetTitle>Документация</SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                <Sidebar active={active} onSelect={scrollTo} />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        <div className="grid lg:grid-cols-[240px_1fr] gap-10">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
            <Sidebar active={active} onSelect={scrollTo} />
          </aside>

          {/* Content */}
          <article className="prose prose-invert max-w-none">
            <header className="mb-8">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
                Документация AIAG API
              </h1>
              <p className="mt-3 text-lg text-muted-foreground">
                Единый OpenAI-совместимый API ко всем моделям платформы.
                Подключайтесь за 2 минуты, оплачивайте в Gram (TON), без VPN.
              </p>
            </header>

            <section id="quick-start" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">Быстрый старт</h2>
              <p className="text-muted-foreground">
                Получите API-ключ в{' '}
                <Link href="/dashboard" className="text-primary hover:underline">
                  личном кабинете
                </Link>{' '}
                и сделайте первый запрос:
              </p>
              <CodeBlock lang="curl">
{`curl https://api.ai-aggregator.ru/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $AIAG_KEY" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "user", "content": "Привет!"}
    ]
  }'`}
              </CodeBlock>

              <h3 className="text-xl font-semibold mt-6 mb-2">На Python</h3>
              <CodeBlock lang="python">
{`from openai import OpenAI

client = OpenAI(
    base_url="https://api.ai-aggregator.ru/v1",
    api_key=os.environ["AIAG_KEY"],
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Привет!"}],
)
print(resp.choices[0].message.content)`}
              </CodeBlock>
            </section>

            <section id="api-reference" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">API Reference</h2>
              <p className="text-muted-foreground">
                Базовый URL:{' '}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm">
                  https://api.ai-aggregator.ru/v1
                </code>
              </p>

              <h3 className="text-xl font-semibold mt-6 mb-2">
                POST /chat/completions
              </h3>
              <p className="text-muted-foreground">
                Создаёт ответ модели на массив сообщений. Совместимо с OpenAI
                SDK.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                <li>
                  <code className="font-mono text-primary">model</code> —
                  идентификатор модели (обязательно)
                </li>
                <li>
                  <code className="font-mono text-primary">messages</code> —
                  массив сообщений (обязательно)
                </li>
                <li>
                  <code className="font-mono text-primary">temperature</code> —
                  0…2, по умолчанию 1
                </li>
                <li>
                  <code className="font-mono text-primary">max_tokens</code> —
                  верхняя граница токенов в ответе
                </li>
                <li>
                  <code className="font-mono text-primary">stream</code> —
                  всегда{' '}
                  <code className="font-mono text-primary">false</code>.
                  Потоковая выдача (SSE) в текущем контракте не поддерживается:
                  ответ приходит одним JSON-объектом
                </li>
                <li>
                  <code className="font-mono text-primary">Idempotency-Key</code> —
                  обязательный заголовок, чтобы повтор запроса не списывал
                  кредиты дважды
                </li>
              </ul>
            </section>

            <section id="authentication" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">Аутентификация</h2>
              <p className="text-muted-foreground">
                В заголовок Authorization добавьте Bearer-токен:
              </p>
              <CodeBlock lang="http">
{`Authorization: Bearer YOUR_API_KEY`}
              </CodeBlock>
              <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
                <strong className="text-primary">Важно: </strong>
                <span className="text-foreground/90">
                  Все запросы должны идти по HTTPS. Запросы по HTTP будут
                  отклонены.
                </span>
              </div>
            </section>

            <section id="models" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">Модели</h2>
              <p className="text-muted-foreground">
                Полный каталог — на странице{' '}
                <Link
                  href="/marketplace"
                  className="text-primary hover:underline inline-flex items-center"
                >
                  Маркетплейс <ExternalLink className="ms-1 h-3.5 w-3.5" />
                </Link>
                . Популярные группы:
              </p>
              <ul className="mt-3 space-y-3">
                <li>
                  <div className="font-semibold text-primary font-mono">
                    gpt-4o, gpt-4o-mini
                  </div>
                  <p className="text-sm text-muted-foreground">
                    OpenAI через защищённый прокси. Универсальный chat.
                  </p>
                </li>
                <li>
                  <div className="font-semibold text-primary font-mono">
                    claude-sonnet-4-6, claude-opus-4-8
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Anthropic. Для длинного контекста и кода.
                  </p>
                </li>
                <li>
                  <div className="font-semibold text-primary font-mono">
                    yandexgpt-pro, gigachat-pro
                  </div>
                  <p className="text-sm text-muted-foreground">
                    RU-residency. Для 152-ФЗ-критичных задач.
                  </p>
                </li>
                <li>
                  <div className="font-semibold text-primary font-mono">
                    flux-pro-1-1, stable-diffusion-3-5
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Картинки. Медиа-модели вызываются своими эндпоинтами, а не
                    <code className="font-mono"> /v1/chat/completions</code>.
                  </p>
                </li>
              </ul>
            </section>

            <section id="examples" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">Примеры</h2>
              <h3 className="text-xl font-semibold mt-4 mb-2">
                Обычный запрос
              </h3>
              <CodeBlock lang="python">
{`resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Расскажи историю"}],
)
print(resp.choices[0].message.content)`}
              </CodeBlock>
              <p className="text-sm text-muted-foreground">
                Стриминг в текущем контракте не поддерживается: параметр{' '}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                  stream
                </code>{' '}
                жёстко зафиксирован на{' '}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                  false
                </code>
                , и запрос с ним будет отклонён.
              </p>
            </section>

            <section id="sdk" className="scroll-mt-24 mb-12">
              <h2 className="text-2xl font-semibold mb-3">SDK</h2>
              <p className="text-muted-foreground">
                Используйте официальный OpenAI SDK — достаточно поменять{' '}
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm">
                  baseURL
                </code>
                :
              </p>
              <CodeBlock lang="typescript">
{`import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.ai-aggregator.ru/v1',
  apiKey: process.env.AIAG_KEY,
});

const resp = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Привет!' }],
});

console.log(resp.choices[0].message.content);`}
              </CodeBlock>
              <p className="text-muted-foreground mt-4">
                Нужны вебхуки, batch-API или BYOK? Напишите{' '}
                <a
                  href="mailto:team@ai-aggregator.ru"
                  className="text-primary hover:underline"
                >
                  team@ai-aggregator.ru
                </a>
                .
              </p>
            </section>
          </article>
        </div>
      </section>
    </MainLayout>
  );
}
